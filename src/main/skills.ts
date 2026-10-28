import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { Store } from './database'
import { canonicalDirectory, deepestFolder } from './paths'
import { adapters, terminalNames } from './terminal-adapters'
import { FileChanges, safeFile } from './skill-files'
import { terminalIds, type TerminalId } from '../shared/types'
import type {
  SkillDetail,
  SkillExperience,
  SkillPackage,
  SkillRuntime,
  SkillSummary,
  SkillVariable,
  VariableLayerValue,
  VariableScope,
  VariableTarget,
  VariableView
} from '../shared/skills'

const scopeSchema = z.enum(['skill', 'terminal', 'project'])
export const targetSchema = z
  .object({
    scope: scopeSchema,
    terminal: z.enum(terminalIds).optional(),
    folderId: z.string().uuid().optional()
  })
  .strict()
export const variableSchema = z
  .object({
    name: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,127}$/)
      .refine(
        (name) =>
          !name.startsWith('EBISU_') &&
          !['HOME', 'PATH', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'CODEX_HOME'].includes(name),
        '保留的运行环境变量'
      ),
    description: z.string().trim().min(1).max(2048),
    type: z.enum(['string', 'number', 'boolean']),
    required: z.boolean().default(false),
    sensitive: z.boolean().default(false),
    scopes: z
      .array(scopeSchema)
      .min(1)
      .max(3)
      .refine((values) => values.includes('skill'), '全局层始终存在')
      .refine((values) => new Set(values).size === values.length, '层级不可重复'),
    defaultValue: z.string().max(65536).optional()
  })
  .strict()
  .refine(
    (value) => !value.sensitive || value.defaultValue === undefined,
    '敏感值通过独立变量接口设置'
  )
const fileSchema = z
  .object({
    content: z.string().max(4 * 1024 * 1024),
    encoding: z.enum(['utf8', 'base64']).optional(),
    executable: z.boolean().optional()
  })
  .strict()
export const packageSchema = z
  .object({
    version: z.literal(1),
    name: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(63)
      .refine((name) => !name.startsWith('ebisu-'), 'ebisu- 为管理技能保留'),
    description: z.string().trim().min(1).max(2048),
    files: z.record(z.string(), fileSchema),
    variants: z.partialRecord(z.enum(terminalIds), z.string()).optional(),
    variables: z.array(variableSchema).max(128).optional(),
    dependencies: z.array(z.string().max(512)).max(64).optional(),
    source: z.string().max(1024).optional()
  })
  .strict()
export class SkillError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}
const digest = (content: string | Buffer) => createHash('sha256').update(content).digest('hex')
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
interface SkillRow {
  id: string
  name: string
  description: string
  createdAt: number
  package: string
  requestId: string
  packageHash: string
}
interface ValueRow {
  value: string
  encrypted: number
}
interface InstallRow {
  skillId: string
  terminal: TerminalId
  installedAt: number
  files: string
}
interface Secrets {
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}
interface Options {
  dataDirectory: string
  home: string
  client: string
  resources: string
  secrets?: Secrets
}

/** 技能定义只有一个中央副本；宿主目录只存入口，经验和配置绝不渲染进入口文件。 */
export class Skills {
  readonly root: string
  readonly home: string
  constructor(
    private readonly store: Store,
    private readonly options: Options
  ) {
    this.root = path.join(options.dataDirectory, '.ebisu', 'skills')
    this.home = realpathSync(options.home)
    safeFile(options.dataDirectory, '.ebisu/skills')
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS skills(id TEXT PRIMARY KEY,name TEXT UNIQUE NOT NULL,description TEXT NOT NULL,createdAt INTEGER NOT NULL,package TEXT NOT NULL,requestId TEXT UNIQUE NOT NULL,packageHash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS skill_experiences(id TEXT PRIMARY KEY,skillId TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,folderId TEXT REFERENCES folders(id) ON DELETE CASCADE,content TEXT NOT NULL,evidence TEXT NOT NULL,revision INTEGER NOT NULL,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS experience_scope ON skill_experiences(skillId,folderId);
      CREATE TABLE IF NOT EXISTS skill_variables(skillId TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,name TEXT NOT NULL,definition TEXT NOT NULL,PRIMARY KEY(skillId,name));
      CREATE TABLE IF NOT EXISTS skill_values(skillId TEXT NOT NULL,name TEXT NOT NULL,scope TEXT NOT NULL,owner TEXT NOT NULL,folderId TEXT REFERENCES folders(id) ON DELETE CASCADE,value TEXT NOT NULL,encrypted INTEGER NOT NULL,PRIMARY KEY(skillId,name,scope,owner),FOREIGN KEY(skillId,name) REFERENCES skill_variables(skillId,name) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS skill_installations(skillId TEXT NOT NULL REFERENCES skills(id),terminal TEXT NOT NULL,installedAt INTEGER NOT NULL,files TEXT NOT NULL,PRIMARY KEY(skillId,terminal));
    `)
    store.db.pragma('user_version = 4')
  }
  private row(id: string): SkillRow {
    const row = this.store.db.prepare('SELECT * FROM skills WHERE id=? OR name=?').get(id, id) as
      | SkillRow
      | undefined
    if (!row) throw new SkillError(404, '技能不存在')
    return row
  }
  assertTerminal(terminal: TerminalId): void {
    if (!this.store.integration(terminal)?.manifest) throw new SkillError(409, '只能使用已绑定终端')
  }
  private target(input: VariableTarget): { target: VariableTarget; owner: string } {
    const target = targetSchema.parse(input)
    if (target.scope === 'terminal') {
      if (!target.terminal || target.folderId) throw new SkillError(400, '终端层需提供 terminal')
      this.assertTerminal(target.terminal)
      return { target, owner: target.terminal }
    }
    if (target.scope === 'project') {
      if (!target.folderId || target.terminal) throw new SkillError(400, '项目层需提供 folderId')
      if (!this.store.folders().some((folder) => folder.id === target.folderId))
        throw new SkillError(404, '项目不存在')
      return { target, owner: target.folderId }
    }
    if (target.folderId || target.terminal) throw new SkillError(400, '技能层不接受项目或终端')
    return { target, owner: '' }
  }
  targets(): {
    terminals: { id: TerminalId; name: string }[]
    projects: ReturnType<Store['folders']>
  } {
    return {
      terminals: terminalIds
        .filter((id) => !!this.store.integration(id)?.manifest)
        .map((id) => ({ id, name: terminalNames[id] })),
      projects: this.store.folders()
    }
  }
  list(): SkillSummary[] {
    return (
      this.store.db.prepare('SELECT * FROM skills ORDER BY createdAt,name').all() as SkillRow[]
    ).map((row) => this.summary(row))
  }
  private summary(row: SkillRow): SkillSummary {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      createdAt: row.createdAt,
      source: (JSON.parse(row.package) as SkillPackage).source ?? null,
      installations: this.store.db
        .prepare(
          'SELECT terminal,installedAt FROM skill_installations WHERE skillId=? ORDER BY terminal'
        )
        .all(row.id) as SkillSummary['installations']
    }
  }
  detail(id: string): SkillDetail {
    const row = this.row(id)
    const pkg = JSON.parse(row.package) as SkillPackage
    // 定义允许增删，初始文件不可变；不把初始默认值当作运行时配置来源。
    pkg.variables = this.definitions(row.id)
    return {
      ...this.summary(row),
      package: pkg,
      experiences: this.store.db
        .prepare('SELECT * FROM skill_experiences WHERE skillId=? ORDER BY createdAt,id')
        .all(row.id) as SkillExperience[]
    }
  }
  /** 导出只有可移植的源包；文件被外部改写时拒绝传播，不读取经验或任何变量取值。 */
  exportPackage(id: string): { skillId: string; package: SkillPackage } {
    const row = this.row(id)
    const pkg = JSON.parse(row.package) as SkillPackage
    for (const [relative, file] of Object.entries(pkg.files)) {
      const current = readFileSync(safeFile(this.directory(row), relative))
      if (digest(current) !== digest(Buffer.from(file.content, file.encoding ?? 'utf8')))
        throw new SkillError(409, '技能源文件已被外部修改，无法导出')
    }
    pkg.variables = this.definitions(row.id).map(
      ({ defaultValue: _default, ...definition }) => definition
    )
    return { skillId: row.id, package: pkg }
  }
  /** 返回技能源文件的绝对路径和字节内容，供复制路径、另存为和定位文件使用。 */
  sourceFile(id: string, relative: string): { path: string; name: string; content: Buffer } {
    const row = this.row(id)
    const file = (JSON.parse(row.package) as SkillPackage).files[relative]
    if (!file) throw new SkillError(404, '技能文件不存在')
    return {
      path: safeFile(this.directory(row), relative),
      name: path.basename(relative),
      content: Buffer.from(file.content, file.encoding ?? 'utf8')
    }
  }
  create(input: unknown, requestId: string): SkillDetail {
    z.string().min(1).max(256).parse(requestId)
    const pkg = packageSchema.parse(input) as SkillPackage
    const entries = Object.entries(pkg.files)
    if (
      !pkg.files['SKILL.md'] ||
      pkg.files['SKILL.md'].encoding === 'base64' ||
      !entries.length ||
      entries.length > 256
    )
      throw new SkillError(400, '需要 UTF-8 SKILL.md，文件最多 256 个')
    const entry = pkg.files['SKILL.md'].content
    if (
      !/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(entry) ||
      !new RegExp(`^name: ['"]?${pkg.name}['"]?\\s*$`, 'm').test(entry) ||
      !/^description:\s*\S/m.test(entry)
    )
      throw new SkillError(400, 'SKILL.md 需包含匹配的 name 和 description frontmatter')
    if (new Set(pkg.variables?.map((item) => item.name)).size !== (pkg.variables?.length ?? 0))
      throw new SkillError(400, '变量名称重复')
    for (const source of Object.values(pkg.variants ?? {}))
      if (!pkg.files[source] || pkg.files[source].encoding === 'base64')
        throw new SkillError(400, '终端变体文件不存在')
    const bytes = entries.reduce((sum, [, file]) => sum + Buffer.byteLength(file.content), 0)
    if (bytes > 8 * 1024 * 1024) throw new SkillError(413, '技能包超过 8 MiB')
    const serialized = JSON.stringify(pkg)
    const packageHash = digest(serialized)
    const old = this.store.db.prepare('SELECT * FROM skills WHERE requestId=?').get(requestId) as
      | SkillRow
      | undefined
    if (old) {
      if (old.packageHash !== packageHash) throw new SkillError(409, '重试标识已用于不同技能包')
      return this.detail(old.id)
    }
    if (this.store.db.prepare('SELECT id FROM skills WHERE name=?').get(pkg.name))
      throw new SkillError(409, '同名技能已存在')
    const id = randomUUID()
    const directory = safeFile(this.root, id)
    for (const [relative] of entries) safeFile(directory, relative)
    try {
      mkdirSync(directory, { mode: 0o700 })
      for (const [relative, file] of entries) {
        const destination = safeFile(directory, relative)
        mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
        writeFileSync(destination, Buffer.from(file.content, file.encoding ?? 'utf8'), {
          mode: file.executable ? 0o700 : 0o600
        })
      }
      this.store.db.transaction(() => {
        this.store.db
          .prepare('INSERT INTO skills VALUES(?,?,?,?,?,?,?)')
          .run(id, pkg.name, pkg.description, Date.now(), serialized, requestId, packageHash)
        for (const variable of pkg.variables ?? []) this.addVariable(id, variable)
      })()
    } catch (error) {
      rmSync(directory, { recursive: true, force: true })
      throw error
    }
    return this.detail(id)
  }
  seed(): void {
    const directory = path.join(this.options.resources, 'skills')
    if (!existsSync(directory)) return
    for (const name of readdirSync(directory).sort()) {
      const manifest = path.join(directory, name, 'ebisu.json')
      if (!existsSync(manifest)) continue
      const input = JSON.parse(readFileSync(manifest, 'utf8')) as Omit<SkillPackage, 'files'> & {
        files: Record<string, { executable?: boolean; encoding?: 'utf8' | 'base64' }>
      }
      if (this.store.db.prepare('SELECT id FROM skills WHERE name=?').get(input.name)) continue
      const files = Object.fromEntries(
        Object.entries(input.files).map(([relative, metadata]) => [
          relative,
          {
            ...metadata,
            content: readFileSync(safeFile(path.join(directory, name), relative)).toString(
              metadata.encoding ?? 'utf8'
            )
          }
        ])
      )
      this.create({ ...input, files }, `builtin:${input.name}:${input.version}`)
    }
  }
  private directory(row: SkillRow): string {
    return safeFile(this.root, row.id)
  }
  private readSource(row: SkillRow, relative: string): string {
    const pkg = JSON.parse(row.package) as SkillPackage
    const file = pkg.files[relative]
    if (!file || file.encoding === 'base64') throw new SkillError(404, '文本资源不存在')
    const current = readFileSync(safeFile(this.directory(row), relative))
    if (digest(current) !== digest(Buffer.from(file.content)))
      throw new SkillError(409, '初始技能文件已被外部修改，请先恢复源文件')
    return current.toString('utf8')
  }
  private render(row: SkillRow, terminal: TerminalId, text: string): string {
    const directory = this.directory(row)
    const hostRoot = path.join(this.home, adapters[terminal].root)
    const values: Record<string, string> = {
      SKILL_NAME: row.name,
      SKILL_DIR: directory,
      SKILLS_DIR: this.root,
      HOST: terminalNames[terminal],
      HOST_KEY: terminal,
      HOST_DIR: adapters[terminal].root,
      INVOKE_PREFIX: terminal === 'codex' ? '$' : terminal === 'workbuddy' ? '@skill:' : '/',
      INVOKE: `${terminal === 'codex' ? '$' : terminal === 'workbuddy' ? '@skill:' : '/'}${row.name}`,
      GLOBAL_HOME: hostRoot,
      GLOBAL_HOME_DEFAULT: hostRoot,
      PLANS_DIR: `${adapters[terminal].root}/plans`,
      FRONTMATTER_EXTRA: terminal === 'workbuddy' ? 'agent_created: true' : '',
      INSTRUCTIONS_FILE: terminal === 'claude' ? 'CLAUDE.md' : 'AGENTS.md',
      EBISU_CLIENT: quote(this.options.client)
    }
    text = text.replace(
      /\$\{#IF ([a-z]+)#\}([\s\S]*?)\$\{#END#\}/g,
      (_match, host: string, body: string) => {
        const [yes, no = ''] = body.split('${#ELSE#}')
        return host === terminal ? yes : no
      }
    )
    return text.replace(/\$\{([A-Z_]+)\}/g, (original, name: string) => values[name] ?? original)
  }
  file(id: string, terminal: TerminalId, relative: string): string {
    this.assertTerminal(terminal)
    const row = this.row(id)
    return this.render(row, terminal, this.readSource(row, relative))
  }
  private entry(row: SkillRow, terminal: TerminalId): string {
    const client = `${quote(this.options.client)} --terminal ${terminal}`
    return `---\nname: ${row.name}\ndescription: ${JSON.stringify(row.description)}\n${terminal === 'workbuddy' ? 'agent_created: true\n' : ''}---\n\n# ${row.name}\n\n本技能的唯一源文件位于 ${this.directory(row)}。此目录中的内容为不可变初始上下文和工具，不要直接修改，也不要把项目配置写进入口。\n\n开始使用时，通过终端执行：\n\n\`\`\`sh\n${client} context --skill ${row.id} --path "$PWD"\n\`\`\`\n\n读取返回的 instructions、技能经验及当前项目经验后执行任务。参考资料通过 ${client} file --skill ${row.id} --file references/文件名 读取。运行脚本通过 ${client} run --skill ${row.id} --path "$PWD" --script scripts/脚本名 -- 参数；变量只注入该子进程。服务不可用时明确报告，不使用过期配置执行相关脚本。\n\n经验沉淀是持久化动作，不是对话层面的“记住”：当用户说“记住”“以后都这样”“默认遵循”、明确提出长期规范/偏好，或本次验证得到值得复用的规则时，必须先成功执行 experience-add，再向用户确认已记住；如果写入失败，必须报告失败，不能只口头承诺。默认把当前项目路径传给 experience-add --path "$PWD"，由服务端写入当前项目经验；只有用户明确要求所有项目通用时才使用 experience-add --scope skill。未注册的当前路径不能静默降级为全局经验。用户明确指定的规范可以用该用户指令作为 evidence；模型自行总结的规则必须有实际验证依据。两类经验都不得记录推测、凭据或单纯任务流水账。修改/删除已有经验使用其 ID 和当前 revision；讨论指定经验时使用 ebisu-skill-discuss。\n\n用 ${client} protocol 查看接口、参数与示例。\n`
  }
  install(id: string, terminal: TerminalId): void {
    this.assertTerminal(terminal)
    const row = this.row(id)
    const root = safeFile(this.home, `${adapters[terminal].skillRoot}/${row.name}`)
    const files: Record<string, string> = { 'SKILL.md': this.entry(row, terminal) }
    const pkg = JSON.parse(row.package) as SkillPackage
    if (pkg.files['agents/openai.yaml'] && terminal === 'codex')
      files['agents/openai.yaml'] = this.readSource(row, 'agents/openai.yaml')
    const previous = this.installation(row.id, terminal)
    const owned = previous ? (JSON.parse(previous.files) as Record<string, string>) : {}
    for (const relative of new Set([...Object.keys(owned), ...Object.keys(files)])) {
      const file = safeFile(root, relative)
      if (existsSync(file) && (!owned[relative] || digest(readFileSync(file)) !== owned[relative]))
        throw new SkillError(409, `同名文件不属于 Ebisu 或已被修改：${file}`)
    }
    const changes = new FileChanges()
    try {
      const hashes: Record<string, string> = {}
      for (const [relative, content] of Object.entries(files)) {
        const file = safeFile(root, relative)
        if (existsSync(file)) {
          const backup = path.join(
            this.options.dataDirectory,
            'backups',
            `skill-${randomUUID()}`,
            relative
          )
          mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 })
          writeFileSync(backup, readFileSync(file), { mode: 0o600 })
        }
        changes.write(file, content)
        hashes[relative] = digest(content)
      }
      for (const relative of Object.keys(owned))
        if (!(relative in files)) changes.remove(safeFile(root, relative))
      this.store.db
        .prepare('INSERT OR REPLACE INTO skill_installations VALUES(?,?,?,?)')
        .run(row.id, terminal, Date.now(), JSON.stringify(hashes))
    } catch (error) {
      changes.rollback()
      throw error
    }
  }
  private installation(skillId: string, terminal: TerminalId): InstallRow | undefined {
    return this.store.db
      .prepare('SELECT * FROM skill_installations WHERE skillId=? AND terminal=?')
      .get(skillId, terminal) as InstallRow | undefined
  }
  private removeInstallation(installation: InstallRow, changes: FileChanges): void {
    const row = this.row(installation.skillId)
    const root = safeFile(this.home, `${adapters[installation.terminal].skillRoot}/${row.name}`)
    for (const [relative, hash] of Object.entries(
      JSON.parse(installation.files) as Record<string, string>
    )) {
      const file = safeFile(root, relative)
      if (existsSync(file) && digest(readFileSync(file)) !== hash)
        throw new SkillError(409, `入口已被修改，未卸载：${file}`)
      changes.remove(file)
    }
    this.store.db
      .prepare('DELETE FROM skill_installations WHERE skillId=? AND terminal=?')
      .run(row.id, installation.terminal)
  }
  uninstall(id: string, terminal: TerminalId): void {
    const installation = this.installation(this.row(id).id, terminal)
    if (!installation) return
    const changes = new FileChanges()
    try {
      this.store.db.transaction(() => this.removeInstallation(installation, changes))()
    } catch (error) {
      changes.rollback()
      throw error
    }
  }
  unbind(terminal: TerminalId, operation: () => void): void {
    const changes = new FileChanges()
    try {
      this.store.db.transaction(() => {
        const installations = this.store.db
          .prepare('SELECT * FROM skill_installations WHERE terminal=?')
          .all(terminal) as InstallRow[]
        for (const installation of installations) this.removeInstallation(installation, changes)
        operation()
      })()
    } catch (error) {
      changes.rollback()
      throw error
    }
  }
  addExperience(input: unknown): SkillExperience {
    const data = z
      .object({
        skillId: z.string(),
        folderId: z.string().uuid().optional(),
        content: z.string().trim().min(1).max(65536),
        evidence: z.string().trim().min(1).max(8192)
      })
      .strict()
      .parse(input)
    const skillId = this.row(data.skillId).id
    if (data.folderId) this.target({ scope: 'project', folderId: data.folderId })
    const at = Date.now()
    const id = randomUUID()
    this.store.db
      .prepare('INSERT INTO skill_experiences VALUES(?,?,?,?,?,1,?,?)')
      .run(id, skillId, data.folderId ?? null, data.content, data.evidence, at, at)
    return this.experiences([id])[0]
  }
  /** 根据调用方当前目录解析最深的已注册项目，避免模型手动猜测项目 ID。 */
  projectIdForPath(directory: string): string | undefined {
    let canonical: string
    try {
      canonical = canonicalDirectory(directory)
    } catch {
      throw new SkillError(404, '项目工作目录不存在或不可访问')
    }
    return deepestFolder(this.store.folders(), canonical)?.id
  }
  experiences(ids: string[]): SkillExperience[] {
    z.array(z.string().uuid()).min(1).max(100).parse(ids)
    return ids.map((id) => {
      const row = this.store.db.prepare('SELECT * FROM skill_experiences WHERE id=?').get(id) as
        | SkillExperience
        | undefined
      if (!row) throw new SkillError(404, `经验不存在：${id}`)
      return row
    })
  }
  updateExperience(id: string, revision: number, input: unknown): SkillExperience {
    const data = z
      .object({
        content: z.string().trim().min(1).max(65536),
        evidence: z.string().trim().min(1).max(8192)
      })
      .strict()
      .parse(input)
    z.number().int().positive().parse(revision)
    this.experiences([id])
    const result = this.store.db
      .prepare(
        'UPDATE skill_experiences SET content=?,evidence=?,revision=revision+1,updatedAt=? WHERE id=? AND revision=?'
      )
      .run(data.content, data.evidence, Date.now(), id, revision)
    if (!result.changes) throw new SkillError(409, '经验已更新，请重新读取后再修改')
    return this.experiences([id])[0]
  }
  deleteExperience(id: string, revision: number): void {
    z.number().int().positive().parse(revision)
    this.experiences([id])
    if (
      !this.store.db
        .prepare('DELETE FROM skill_experiences WHERE id=? AND revision=?')
        .run(id, revision).changes
    )
      throw new SkillError(409, '经验已更新，请重新读取后再删除')
  }
  private definitions(id: string): SkillVariable[] {
    return (
      this.store.db
        .prepare('SELECT definition FROM skill_variables WHERE skillId=? ORDER BY name')
        .all(id) as { definition: string }[]
    ).map((row) => JSON.parse(row.definition))
  }
  addVariable(id: string, input: unknown): void {
    const row = this.row(id)
    const variable = variableSchema.parse(input) as SkillVariable
    if (this.definitions(row.id).some((item) => item.name === variable.name))
      throw new SkillError(409, '变量已存在')
    if (variable.defaultValue !== undefined && !variable.scopes.includes('skill'))
      throw new SkillError(400, '默认值需要允许技能层')
    this.store.db.transaction(() => {
      const { defaultValue, ...definition } = variable
      this.store.db
        .prepare('INSERT INTO skill_variables VALUES(?,?,?)')
        .run(row.id, variable.name, JSON.stringify(definition))
      if (defaultValue !== undefined)
        this.setVariable(row.id, variable.name, { scope: 'skill' }, defaultValue)
    })()
  }
  deleteVariable(id: string, name: string): void {
    if (
      !this.store.db
        .prepare('DELETE FROM skill_variables WHERE skillId=? AND name=?')
        .run(this.row(id).id, name).changes
    )
      throw new SkillError(404, '变量不存在')
  }
  private decode(row: ValueRow | undefined): string | null {
    if (!row) return null
    if (!row.encrypted) return row.value
    if (!this.options.secrets) throw new SkillError(503, '系统密钥服务不可用')
    return this.options.secrets.decrypt(Buffer.from(row.value, 'base64'))
  }
  private value(
    skillId: string,
    name: string,
    scope: VariableScope,
    owner: string
  ): ValueRow | undefined {
    return this.store.db
      .prepare(
        'SELECT value,encrypted FROM skill_values WHERE skillId=? AND name=? AND scope=? AND owner=?'
      )
      .get(skillId, name, scope, owner) as ValueRow | undefined
  }
  /** 读取全局、已安装终端和指定项目的独立取值；敏感值只在显式读取时解密。 */
  variables(
    id: string,
    folderId: string | null = null,
    reveal: boolean | string = false
  ): VariableView[] {
    const row = this.row(id)
    const projectId = folderId === null ? null : z.string().uuid().parse(folderId)
    if (projectId && !this.store.folders().some((folder) => folder.id === projectId))
      throw new SkillError(404, '项目不存在')
    const installations = this.summary(row).installations.map((item) => item.terminal)
    return this.definitions(row.id).map((variable) => {
      const hide = variable.sensitive && reveal !== true && reveal !== variable.name
      const read = (scope: VariableScope, owner: string): VariableLayerValue => {
        const stored = variable.scopes.includes(scope)
          ? this.value(row.id, variable.name, scope, owner)
          : undefined
        return { value: hide ? null : this.decode(stored), hasValue: !!stored }
      }
      return {
        ...variable,
        global: read('skill', ''),
        terminals: variable.scopes.includes('terminal')
          ? installations.map((terminal) => ({ terminal, ...read('terminal', terminal) }))
          : [],
        project:
          projectId && variable.scopes.includes('project') ? read('project', projectId) : null
      }
    })
  }
  /** 读取单层已保存值；界面上的“显示”按钮只解密当前层。 */
  revealVariable(id: string, name: string, input: VariableTarget): string | null {
    const skillId = this.row(id).id
    const { target, owner } = this.target(input)
    const variable = this.definitions(skillId).find((item) => item.name === name)
    if (!variable) throw new SkillError(404, '变量不存在')
    if (!variable.scopes.includes(target.scope)) throw new SkillError(400, '变量不支持此层级')
    return this.decode(this.value(skillId, name, target.scope, owner))
  }
  /** 运行时按 全局 → 终端 → 项目 合并；未开放的层级不参与。 */
  private resolve(
    skillId: string,
    variable: SkillVariable,
    terminal: TerminalId,
    folderId?: string
  ): ValueRow | undefined {
    const layers: { scope: VariableScope; owner: string }[] = [{ scope: 'skill', owner: '' }]
    if (variable.scopes.includes('terminal')) layers.push({ scope: 'terminal', owner: terminal })
    if (variable.scopes.includes('project') && folderId)
      layers.push({ scope: 'project', owner: folderId })
    let effective: ValueRow | undefined
    for (const layer of layers) {
      const stored = this.value(skillId, variable.name, layer.scope, layer.owner)
      if (stored) effective = stored
    }
    return effective
  }
  setVariable(id: string, name: string, input: VariableTarget, value: string | null): void {
    const skillId = this.row(id).id
    const { target, owner } = this.target(input)
    const variable = this.definitions(skillId).find((item) => item.name === name)
    if (!variable) throw new SkillError(404, '变量不存在')
    if (!variable.scopes.includes(target.scope)) throw new SkillError(400, '变量不支持此层级')
    if (value === null) {
      this.store.db
        .prepare('DELETE FROM skill_values WHERE skillId=? AND name=? AND scope=? AND owner=?')
        .run(skillId, name, target.scope, owner)
      return
    }
    z.string().max(65536).parse(value)
    if (
      value.includes('\0') ||
      (variable.type === 'number' && (!value.trim() || !Number.isFinite(Number(value)))) ||
      (variable.type === 'boolean' && !['true', 'false'].includes(value))
    )
      throw new SkillError(400, '变量值不符合类型')
    if (variable.sensitive && !this.options.secrets)
      throw new SkillError(503, '系统密钥服务不可用，未保存敏感值')
    const encoded = variable.sensitive
      ? this.options.secrets!.encrypt(value).toString('base64')
      : value
    this.store.db
      .prepare('INSERT OR REPLACE INTO skill_values VALUES(?,?,?,?,?,?,?)')
      .run(
        skillId,
        name,
        target.scope,
        owner,
        target.scope === 'project' ? owner : null,
        encoded,
        variable.sensitive ? 1 : 0
      )
  }
  runtime(id: string, terminal: TerminalId, directory: string, forExecution = false): SkillRuntime {
    this.assertTerminal(terminal)
    const row = this.row(id)
    if (!this.installation(row.id, terminal)) throw new SkillError(409, '技能尚未安装到该终端')
    let canonical: string
    try {
      canonical = canonicalDirectory(directory)
    } catch {
      throw new SkillError(404, '项目工作目录不存在或不可访问')
    }
    const folder = deepestFolder(this.store.folders(), canonical)
    const variables: Record<string, string> = {}
    const missingVariables: string[] = []
    for (const variable of this.definitions(row.id)) {
      const stored = this.resolve(row.id, variable, terminal, folder?.id)
      const reveal = !variable.sensitive || forExecution
      const value = reveal ? this.decode(stored) : null
      if (variable.required && (!stored || (reveal && value === '')))
        missingVariables.push(variable.name)
      if (reveal && value !== null) variables[variable.name] = value
    }
    if (forExecution && missingVariables.length)
      throw new SkillError(409, `请先配置必填变量 ${missingVariables.join('、')}`)
    const pkg = JSON.parse(row.package) as SkillPackage
    return {
      skill: this.summary(row),
      missingVariables,
      folder: folder ? { id: folder.id, path: folder.path } : null,
      instructions: this.render(
        row,
        terminal,
        this.readSource(row, pkg.variants?.[terminal] ?? 'SKILL.md')
      ),
      experiences: this.detail(row.id).experiences.filter(
        (item) => item.folderId === null || item.folderId === folder?.id
      ),
      variables,
      configuration: this.variables(row.id, folder?.id ?? null),
      directory: this.directory(row),
      scripts: Object.entries(pkg.files)
        .filter(([relative, file]) => relative.startsWith('scripts/') && file.executable)
        .map(([relative]) => {
          this.readSource(row, relative)
          return relative
        })
    }
  }
}
