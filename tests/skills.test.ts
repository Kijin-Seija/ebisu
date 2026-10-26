import { afterEach, beforeEach, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Store } from '../src/main/database'
import { Skills } from '../src/main/skills'
import { Integrations } from '../src/main/integrations'
import { startServer } from '../src/main/server'
import { adapters } from '../src/main/terminal-adapters'
import { terminalIds } from '../src/shared/types'
import type { SkillPackage } from '../src/shared/skills'

const execute = promisify(execFile)
let root: string
let home: string
let store: Store
let skills: Skills
let integrations: Integrations
let decrypted: string[]
let server: Awaited<ReturnType<typeof startServer>> | undefined
let first: ReturnType<Store['addFolder']>
let second: ReturnType<Store['addFolder']>
const resources = path.resolve('resources')
const pkg = (): SkillPackage => ({
  version: 1,
  name: 'sample-skill',
  description: '演示技能',
  files: {
    'SKILL.md': {
      content:
        '---\nname: sample-skill\ndescription: 演示技能\n---\n不可变初始指导 ${HOST}\n${#IF codex#}Codex 分支${#ELSE#}其他分支${#END#}'
    },
    'scripts/check.cjs': {
      content:
        '#!/usr/bin/env node\nconsole.log(JSON.stringify({cwd:process.cwd(),setting:process.env.DEMO_VALUE,project:process.env.EBISU_PROJECT_ROOT,args:process.argv.slice(2)}))\n',
      executable: true
    },
    'references/help.md': { content: '文档 ${SKILL_DIR}' }
  },
  variables: [
    {
      name: 'DEMO_VALUE',
      description: '测试值',
      type: 'string',
      required: false,
      sensitive: false,
      scopes: ['skill', 'terminal', 'project'],
      defaultValue: 'base'
    }
  ]
})
beforeEach(() => {
  decrypted = []
  root = mkdtempSync(path.join(tmpdir(), 'ebisu skills-'))
  home = path.join(root, 'home')
  mkdirSync(home)
  store = new Store(path.join(root, 'state.sqlite'))
  for (const name of ['first', 'second']) mkdirSync(path.join(root, name))
  first = store.addFolder(path.join(root, 'first'))
  second = store.addFolder(path.join(root, 'second'))
  integrations = new Integrations(store, {
    home,
    dataDirectory: root,
    resources,
    executable: process.execPath,
    appDirectories: [],
    pathEnv: path.join(root, 'bin')
  })
  skills = new Skills(store, {
    home,
    dataDirectory: root,
    resources,
    client: integrations.skillsClient,
    secrets: {
      encrypt: (value) => Buffer.from(`encrypted:${value}`),
      decrypt: (value) => {
        const result = value.toString().slice('encrypted:'.length)
        decrypted.push(result)
        return result
      }
    }
  })
  for (const terminal of terminalIds) store.saveManifest(terminal, { installedAt: 1, owned: [] })
})
afterEach(async () => {
  await server?.close()
  server = undefined
  store.close()
  rmSync(root, { recursive: true, force: true })
})
const create = () => skills.create(pkg(), 'request-one')

it('创建不可变中央副本；重试去重且不同载荷冲突，升级后保留用户数据', () => {
  const result = create()
  expect(create().id).toBe(result.id)
  expect(skills.list()).toHaveLength(1)
  expect(readFileSync(path.join(skills.root, result.id, 'SKILL.md'), 'utf8')).toContain(
    '不可变初始指导'
  )
  expect(() => skills.create({ ...pkg(), description: '另一个载荷' }, 'request-one')).toThrow(
    '不同技能包'
  )
  expect(() => skills.create(pkg(), 'request-two')).toThrow('同名技能')
  expect(() => skills.create({ ...pkg(), name: 'ebisu-reserved' }, 'reserved')).toThrow()
  expect(store.db.pragma('user_version', { simple: true })).toBe(4)
  store.close()
  store = new Store(path.join(root, 'state.sqlite'))
  expect(store.folders()).toHaveLength(2)
})
it('拒绝相对路径越界、反斜杠、符号链接和无效 frontmatter', () => {
  for (const relative of ['../escape', '/absolute', 'nested/../../escape', 'scripts\\escape']) {
    expect(() =>
      skills.create({ ...pkg(), files: { ...pkg().files, [relative]: { content: 'x' } } }, relative)
    ).toThrow()
  }
  expect(() =>
    skills.create({ ...pkg(), files: { 'SKILL.md': { content: 'not a skill' } } }, 'bad')
  ).toThrow('frontmatter')
  create()
  const terminalRoot = path.join(home, '.claude')
  mkdirSync(terminalRoot)
  symlinkSync(first.path, path.join(terminalRoot, 'skills'))
  expect(() => skills.install('sample-skill', 'claude')).toThrow('符号链接')
})
it('五种终端只安装轻量入口，卸载不删除中央脚本、经验或配置', () => {
  const result = create()
  const experience = skills.addExperience({
    skillId: result.id,
    content: '有效经验',
    evidence: '本次已复现并修复'
  })
  for (const terminal of terminalIds) {
    skills.install(result.id, terminal)
    const directory = path.join(home, adapters[terminal].skillRoot, result.name)
    expect(readdirSync(directory)).toEqual(['SKILL.md'])
    const entry = readFileSync(path.join(directory, 'SKILL.md'), 'utf8')
    expect(entry).toContain(path.join(root, '.ebisu', 'skills', result.id))
    expect(entry).not.toContain('不可变初始指导')
    expect(entry).not.toContain('console.log')
    expect(skills.runtime(result.id, terminal, first.path).experiences[0].id).toBe(experience.id)
    skills.uninstall(result.id, terminal)
  }
  expect(readFileSync(path.join(skills.root, result.id, 'scripts/check.cjs'), 'utf8')).toContain(
    'console.log'
  )
  expect(skills.detail(result.id).experiences).toHaveLength(1)
  expect(skills.variables(result.id, null)[0].global.value).toBe('base')
})
it('安装同名文件冲突、入口修改冲突和解绑失败均保留原文件及安装记录', () => {
  const result = create()
  skills.install(result.id, 'codex')
  skills.install(result.id, 'claude')
  const file = path.join(home, adapters.codex.skillRoot, result.name, 'SKILL.md')
  writeFileSync(file, '用户改动')
  expect(() => skills.install(result.id, 'codex')).toThrow('已被修改')
  expect(() => skills.uninstall(result.id, 'codex')).toThrow('已被修改')
  expect(() =>
    skills.unbind('claude', () => {
      throw new Error('模拟集成卸载失败')
    })
  ).toThrow('模拟')
  expect(skills.detail(result.id).installations).toHaveLength(2)
  expect(
    readFileSync(path.join(home, adapters.claude.skillRoot, result.name, 'SKILL.md'), 'utf8')
  ).toContain('sample-skill')
  expect(readFileSync(file, 'utf8')).toBe('用户改动')
})
it('经验跨终端共享、按技能及项目隔离；修改保留 ID 并检查修订号', () => {
  const result = create()
  skills.install(result.id, 'codex')
  skills.install(result.id, 'claude')
  const general = skills.addExperience({
    skillId: result.id,
    content: '通用经验',
    evidence: '验证 A'
  })
  const project = skills.addExperience({
    skillId: result.id,
    folderId: first.id,
    content: '项目经验',
    evidence: '验证 B'
  })
  expect(
    skills
      .runtime(result.id, 'codex', first.path)
      .experiences.map((item) => item.id)
      .sort()
  ).toEqual([general.id, project.id].sort())
  expect(
    skills
      .runtime(result.id, 'claude', first.path)
      .experiences.map((item) => item.id)
      .sort()
  ).toEqual([general.id, project.id].sort())
  expect(
    skills.runtime(result.id, 'claude', second.path).experiences.map((item) => item.id)
  ).toEqual([general.id])
  const modified = skills.updateExperience(general.id, 1, {
    content: '新经验',
    evidence: '重新验证'
  })
  expect(modified).toMatchObject({ id: general.id, revision: 2, content: '新经验' })
  expect(() =>
    skills.updateExperience(general.id, 1, { content: '迟到', evidence: '迟到请求' })
  ).toThrow('重新读取')
  expect(() => skills.deleteExperience(general.id, 1)).toThrow('重新读取')
  skills.deleteExperience(general.id, 2)
  expect(() => skills.experiences([general.id])).toThrow('经验不存在')
  expect(skills.detail(result.id).package.files['SKILL.md'].content).toContain('不可变初始指导')
})
it('全局/终端/项目层互相独立；项目优先于终端优先于全局，清除只影响当前层', () => {
  const result = create()
  skills.install(result.id, 'codex')
  skills.install(result.id, 'claude')
  skills.setVariable(result.id, 'DEMO_VALUE', { scope: 'terminal', terminal: 'codex' }, 'host')
  let view = skills.variables(result.id, null)[0]
  expect(view.global).toMatchObject({ value: 'base', hasValue: true })
  expect(view.terminals.find((item) => item.terminal === 'codex')).toMatchObject({
    value: 'host',
    hasValue: true
  })
  expect(view.terminals.find((item) => item.terminal === 'claude')).toMatchObject({
    value: null,
    hasValue: false
  })
  expect(view.project).toBeNull()
  expect(skills.runtime(result.id, 'codex', first.path).variables.DEMO_VALUE).toBe('host')
  expect(skills.runtime(result.id, 'claude', first.path).variables.DEMO_VALUE).toBe('base')
  skills.setVariable(result.id, 'DEMO_VALUE', { scope: 'project', folderId: first.id }, '')
  view = skills.variables(result.id, first.id)[0]
  expect(view.project).toMatchObject({ value: '', hasValue: true })
  expect(skills.runtime(result.id, 'codex', first.path).variables.DEMO_VALUE).toBe('')
  expect(skills.runtime(result.id, 'codex', second.path).variables.DEMO_VALUE).toBe('host')
  skills.setVariable(result.id, 'DEMO_VALUE', { scope: 'project', folderId: first.id }, null)
  expect(skills.variables(result.id, first.id)[0].project).toMatchObject({
    value: null,
    hasValue: false
  })
  expect(skills.runtime(result.id, 'codex', first.path).variables.DEMO_VALUE).toBe('host')
  skills.deleteVariable(result.id, 'DEMO_VALUE')
  expect(skills.variables(result.id, first.id)).toEqual([])
  expect(store.db.prepare('SELECT * FROM skill_values').all()).toEqual([])
})
it('敏感值加密持久化、不进入详情或遮罩接口，单独读取时解密', () => {
  const result = create()
  skills.addVariable(result.id, {
    name: 'SECRET_TOKEN',
    description: '凭据',
    type: 'string',
    sensitive: true,
    scopes: ['skill', 'project']
  })
  skills.setVariable(result.id, 'SECRET_TOKEN', { scope: 'skill' }, 'my-secret-value')
  const persisted = store.db
    .prepare('SELECT value,encrypted FROM skill_values WHERE name=?')
    .get('SECRET_TOKEN') as { value: string; encrypted: number }
  expect(persisted.encrypted).toBe(1)
  expect(persisted.value).not.toContain('my-secret-value')
  expect(JSON.stringify(skills.detail(result.id))).not.toContain('my-secret-value')
  expect(
    skills
      .variables(result.id, null)
      .find((item) => item.name === 'SECRET_TOKEN')
  ).toMatchObject({ global: { value: null, hasValue: true } })
  skills.addVariable(result.id, {
    name: 'OTHER_SECRET',
    description: '其他凭据',
    type: 'string',
    sensitive: true,
    scopes: ['skill']
  })
  skills.setVariable(result.id, 'OTHER_SECRET', { scope: 'skill' }, 'unrelated-secret')
  skills.install(result.id, 'codex')
  expect(skills.runtime(result.id, 'codex', first.path).variables).not.toHaveProperty(
    'SECRET_TOKEN'
  )
  expect(decrypted).toEqual([])
  expect(
    skills.variables(result.id, null, 'SECRET_TOKEN').find((item) => item.name === 'SECRET_TOKEN')
      ?.global.value
  ).toBe('my-secret-value')
  expect(new Set(decrypted)).toEqual(new Set(['my-secret-value']))
})
it('限制变量名称、类型和层级；无系统密钥服务时不保存敏感值', () => {
  const result = create()
  for (const name of ['HOME', 'PATH', 'EBISU_PROJECT_ROOT', 'NODE_OPTIONS'])
    expect(() =>
      skills.addVariable(result.id, { name, description: 'x', type: 'string', scopes: ['skill'] })
    ).toThrow()
  skills.addVariable(result.id, {
    name: 'LIMIT',
    description: '上限',
    type: 'number',
    scopes: ['skill']
  })
  expect(() =>
    skills.setVariable(result.id, 'LIMIT', { scope: 'project', folderId: first.id }, '2')
  ).toThrow('不支持')
  expect(() => skills.setVariable(result.id, 'LIMIT', { scope: 'skill' }, 'oops')).toThrow('类型')
  expect(() =>
    skills.create(
      {
        ...pkg(),
        variables: [
          {
            name: 'SECRET',
            description: '秘密',
            type: 'string',
            scopes: ['skill'],
            sensitive: true,
            defaultValue: 'leak'
          }
        ]
      },
      'secret'
    )
  ).toThrow()
  const unavailable = new Skills(store, {
    home,
    dataDirectory: root,
    resources,
    client: integrations.skillsClient
  })
  unavailable.addVariable(result.id, {
    name: 'SECRET',
    description: '秘密',
    type: 'string',
    scopes: ['skill'],
    sensitive: true
  })
  expect(() => unavailable.setVariable(result.id, 'SECRET', { scope: 'skill' }, 'secret')).toThrow(
    '未保存'
  )
})
it('变量按定义限定全局、终端、项目组合，未开放层级不可配置', () => {
  const result = create()
  skills.install(result.id, 'codex')
  skills.addVariable(result.id, {
    name: 'PROJECT_VALUE',
    description: '项目值',
    type: 'string',
    scopes: ['skill', 'project']
  })
  expect(() =>
    skills.setVariable(
      result.id,
      'PROJECT_VALUE',
      { scope: 'terminal', terminal: 'codex' },
      'x'
    )
  ).toThrow('层级')
  expect(() =>
    skills.addVariable(result.id, {
      name: 'NO_GLOBAL',
      description: '缺少全局层',
      type: 'string',
      scopes: ['terminal']
    })
  ).toThrow('全局层')
  skills.addVariable(result.id, {
    name: 'TERMINAL_VALUE',
    description: '终端值',
    type: 'string',
    scopes: ['skill', 'terminal']
  })
  expect(() =>
    skills.setVariable(result.id, 'TERMINAL_VALUE', { scope: 'project', folderId: first.id }, 'x')
  ).toThrow('层级')
  const view = skills.variables(result.id, first.id).find((item) => item.name === 'PROJECT_VALUE')!
  expect(view.terminals).toEqual([])
  expect(view.project).toMatchObject({ value: null, hasValue: false })
})
it('移除项目级联删除项目经验与覆盖，保留技能数据和其他项目', () => {
  const result = create()
  skills.addExperience({ skillId: result.id, content: '技能经验', evidence: '验证' })
  skills.addExperience({
    skillId: result.id,
    folderId: first.id,
    content: '项目经验',
    evidence: '验证'
  })
  skills.setVariable(result.id, 'DEMO_VALUE', { scope: 'project', folderId: first.id }, 'project')
  store.removeFolder(first.id)
  expect(skills.detail(result.id).experiences).toHaveLength(1)
  expect(store.db.prepare("SELECT * FROM skill_values WHERE scope='project'").all()).toHaveLength(0)
  expect(skills.list()).toHaveLength(1)
  expect(() => skills.variables(result.id, first.id)).toThrow('项目不存在')
})
it('上下文匹配最深项目，检测中央脚本被改动，未安装或未绑定终端不运行', () => {
  const result = create()
  skills.install(result.id, 'codex')
  mkdirSync(path.join(first.path, 'nested'))
  const nested = store.addFolder(path.join(first.path, 'nested'))
  expect(skills.runtime(result.id, 'codex', nested.path).folder?.id).toBe(nested.id)
  expect(skills.runtime(result.id, 'codex', first.path).instructions).toContain('Codex 分支')
  expect(skills.runtime(result.id, 'codex', first.path).instructions).not.toContain('其他分支')
  expect(() => skills.runtime(result.id, 'grok', first.path)).toThrow('尚未安装')
  store.saveManifest('grok', null)
  expect(() => skills.install(result.id, 'grok')).toThrow('已绑定')
  writeFileSync(path.join(skills.root, result.id, 'scripts/check.cjs'), 'external change')
  expect(() => skills.runtime(result.id, 'codex', first.path)).toThrow('外部修改')
})
it('内置九个包可独立登记和渲染，初始文件引用完整且无旧安装运行依赖', () => {
  skills.seed()
  skills.seed()
  expect(
    skills
      .list()
      .map((item) => item.name)
      .sort()
  ).toEqual(
    [
      'debug-auto',
      'debug-manual',
      'debug-steps',
      'explain-code',
      'grill-with-docs',
      'karpathy',
      'push-code',
      'reviewer',
      'vitest-safe'
    ].sort()
  )
  for (const skill of skills.list()) {
    const detail = skills.detail(skill.id)
    for (const host of terminalIds) {
      skills.install(skill.id, host)
      if (skill.name === 'push-code') continue
      const context = skills.runtime(skill.id, host, first.path)
      expect(context.instructions).not.toMatch(/\$\{#(?:IF|END|ELSE)/)
      expect(context.instructions).not.toContain('../chimata')
    }
    for (const relative of Object.keys(detail.package.files))
      expect(readFileSync(path.join(skills.root, skill.id, relative)).length).toBeGreaterThan(0)
  }
  const push = skills.detail('push-code')
  expect(Object.keys(push.package.files).join(' ')).not.toContain('monitor')
  expect(push.package.files['scripts/push-code-run.sh'].content).not.toContain(
    'register_mr_monitor'
  )
  expect(push.package.files['scripts/push-code-run.sh'].content).toContain('EBISU_PROJECT_ROOT')
  expect(push.package.files['scripts/push-code-run.sh'].content).toContain('wait-review')
  expect(push.package.variables?.some((item) => item.name.includes('MONITOR'))).toBe(false)
  expect(
    skills
      .detail('vitest-safe')
      .package.variables?.every((item) => item.scopes.join(',') === 'skill')
  ).toBe(true)
  expect(
    skills
      .detail('push-code')
      .package.variables?.find((item) => item.name === 'PUSH_CODE_GITLAB_API_TOKEN')?.scopes
  ).toEqual(['skill', 'project'])
})
it('真实客户端发现服务、创建/读取/执行脚本，参数与变量无 shell 展开', async () => {
  integrations.prepareBridge()
  const result = create()
  skills.install(result.id, 'codex')
  const value = 'spaces $HOME `printf unsafe` "quotes"'
  skills.setVariable(result.id, 'DEMO_VALUE', { scope: 'project', folderId: first.id }, value)
  server = await startServer(store, path.join(root, 'runtime.json'), () => {}, skills)
  const invoke = (...args: string[]) =>
    execute(integrations.skillsClient, ['--terminal', 'codex', ...args], {
      env: { ...process.env, HOME: home },
      timeout: 20000
    })
  const context = JSON.parse(
    (await invoke('context', '--skill', result.id, '--path', first.path)).stdout
  )
  expect(context.variables.DEMO_VALUE).toBe(value)
  const executed = JSON.parse(
    (
      await invoke(
        'run',
        '--skill',
        result.id,
        '--path',
        first.path,
        '--script',
        'scripts/check.cjs',
        '--',
        'a b',
        '$HOME'
      )
    ).stdout
  )
  expect(executed).toEqual({
    cwd: first.path,
    project: first.path,
    setting: value,
    args: ['a b', '$HOME']
  })
  expect(
    (await invoke('file', '--skill', result.id, '--file', 'references/help.md')).stdout
  ).toContain(path.join(skills.root, result.id))
  await expect(
    invoke('run', '--skill', result.id, '--path', first.path, '--script', '../outside')
  ).rejects.toThrow()
  await server.close()
  server = undefined
  await expect(invoke('context', '--skill', result.id, '--path', first.path)).rejects.toThrow()
})
it('HTTP 技能接口认证、请求校验、并发修订与初始内容不可写', async () => {
  const result = create()
  server = await startServer(store, path.join(root, 'runtime.json'), () => {}, skills)
  const runtime = JSON.parse(readFileSync(path.join(root, 'runtime.json'), 'utf8'))
  const send = (action: string, body: unknown, headers = {}) =>
    fetch(`http://127.0.0.1:${runtime.port}/v1/skills/${action}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${runtime.token}`,
        'Content-Type': 'application/json',
        ...headers
      },
      body: JSON.stringify({ terminal: 'codex', ...(body as object) })
    })
  expect((await send('list', {}, { Origin: 'https://evil.test' })).status).toBe(401)
  expect((await send('list', {}, { Authorization: 'Bearer wrong' })).status).toBe(401)
  expect((await send('context', { skillId: result.id, path: first.path })).status).toBe(409)
  expect((await send('file-update', { skillId: result.id, content: 'overwrite' })).status).toBe(404)
  const experience = await (
    await send('experience-add', { skillId: result.id, content: '经验', evidence: '验证' })
  ).json()
  const updates = await Promise.all([
    send('experience-update', {
      id: experience.id,
      revision: 1,
      content: '一',
      evidence: '验证一'
    }),
    send('experience-update', { id: experience.id, revision: 1, content: '二', evidence: '验证二' })
  ])
  expect(updates.map((item) => item.status).sort()).toEqual([200, 409])
  expect(
    (await send('variable-add', { skillId: result.id, variable: { name: 'bad key' } })).status
  ).toBe(400)
})

it('管理技能随五种集成绑定安装；旧绑定补齐且重复升级不改动配置', () => {
  mkdirSync(path.join(root, 'bin'))
  for (const binary of ['codex', 'claude', 'workbuddy', 'grok', 'qodercli'])
    writeFileSync(path.join(root, 'bin', binary), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  for (const host of terminalIds) {
    store.saveManifest(host, null)
    integrations.install(host)
    const directory = path.join(home, adapters[host].skillRoot)
    for (const name of ['ebisu-skill-create', 'ebisu-skill-discuss'])
      expect(readFileSync(path.join(directory, name, 'SKILL.md'), 'utf8')).toContain(
        '.ebisu/management/'
      )
    if (host === 'codex')
      expect(
        readFileSync(path.join(directory, 'ebisu-skill-create/agents/openai.yaml'), 'utf8')
      ).toContain('allow_implicit_invocation: false')
  }
  const before = readFileSync(path.join(home, '.codex/hooks.json'), 'utf8')
  const old = JSON.parse(store.integration('codex')!.manifest!)
  for (const file of old.owned.filter((item: { file: string }) =>
    item.file.includes('/ebisu-skill-')
  ))
    rmSync(file.file)
  old.owned = old.owned.filter((item: { file: string }) => !item.file.includes('/ebisu-skill-'))
  store.saveManifest('codex', old)
  integrations.upgradeSkills()
  integrations.upgradeSkills()
  expect(readFileSync(path.join(home, '.codex/hooks.json'), 'utf8')).toBe(before)
  expect(
    readFileSync(path.join(home, '.agents/skills/ebisu-skill-create/SKILL.md'), 'utf8')
  ).toContain('.ebisu/management/')
})
it('内置脚本能通过解释器检查，引用和模型参数不依赖旧安装位置', async () => {
  skills.seed()
  for (const item of skills.list()) {
    const detail = skills.detail(item.id)
    for (const [relative, file] of Object.entries(detail.package.files)) {
      const filename = path.join(skills.root, item.id, relative)
      if (!file.executable) continue
      if (relative.endsWith('.sh')) await execute('bash', ['-n', filename])
      else if (relative.endsWith('.py') || relative.endsWith('vitest-safe'))
        await execute('python3', [
          '-c',
          'import ast,sys;ast.parse(open(sys.argv[1]).read())',
          filename
        ])
    }
  }
})
it('Push Code 在真实客户端注入变量后只请求本地 GitLab fixture，轮询按超时收敛', async () => {
  const { createServer } = await import('node:http')
  skills.seed()
  integrations.prepareBridge()
  skills.install('push-code', 'codex')
  const observed: { url: string; auth: string | undefined }[] = []
  const fixture = createServer((request, response) => {
    observed.push({
      url: request.url!,
      auth: request.headers['private-token'] as string | undefined
    })
    let value: unknown = []
    if (request.url === '/api/v4/projects/11')
      value = {
        id: 11,
        path_with_namespace: 'fixture/project',
        default_branch: 'main',
        web_url: 'http://fixture/project'
      }
    else if (
      new URL(request.url!, 'http://fixture').pathname === '/api/v4/projects/11/merge_requests/2'
    )
      value = {
        iid: 2,
        state: 'opened',
        detailed_merge_status: 'checking',
        sha: 'abc',
        head_pipeline: { id: 1, sha: 'abc', status: 'running' },
        created_at: new Date().toISOString()
      }
    else if (request.url?.endsWith('/approvals')) value = { approvals_left: 1, approved_by: [] }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(value))
  })
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve))
  const address = fixture.address() as { port: number }
  try {
    for (const [name, value] of Object.entries({
      PUSH_CODE_GITLAB_BASE_URL: `http://127.0.0.1:${address.port}`,
      PUSH_CODE_PROJECT_ID: '11',
      PUSH_CODE_GITLAB_API_TOKEN: 'fixture-token',
      PUSH_CODE_GITLAB_INITIAL_REVIEW_GRACE_SECONDS: '0'
    }))
      skills.setVariable('push-code', name, { scope: 'project', folderId: first.id }, value)
    server = await startServer(store, path.join(root, 'runtime.json'), () => {}, skills)
    const invoke = (...args: string[]) =>
      execute(
        integrations.skillsClient,
        [
          '--terminal',
          'codex',
          'run',
          '--skill',
          'push-code',
          '--path',
          first.path,
          '--script',
          'scripts/push_code_webhook.py',
          '--',
          ...args
        ],
        { env: { ...process.env, HOME: home }, timeout: 15000 }
      )
    const checked = JSON.parse((await invoke('check-project', '--project-id', '11')).stdout)
    expect(checked.id).toBe(11)
    expect(observed[0].auth).toBe('fixture-token')
    await invoke(
      'wait-review',
      '--mr-id',
      '2',
      '--project-id',
      '11',
      '--review-timeout-seconds',
      '0',
      '--poll-interval-seconds',
      '1'
    ).then(
      () => {
        throw new Error('轮询应返回超时')
      },
      (error) => {
        expect(error.code, error.stderr + error.stdout).toBe(124)
      }
    )
    expect(observed.every((item) => item.url.startsWith('/api/v4/projects/11'))).toBe(true)
    const context = skills.runtime('push-code', 'codex', first.path)
    expect(JSON.stringify(context)).not.toContain('fixture-token')
    expect(
      skills.runtime('push-code', 'codex', first.path, true).variables.PUSH_CODE_GITLAB_API_TOKEN
    ).toBe('fixture-token')
  } finally {
    await new Promise<void>((resolve) => fixture.close(() => resolve()))
  }
})
it('中央测试队列在独立 HOME 使用相同锁，设置并发为 1 后串行执行两个客户端', async () => {
  skills.seed()
  integrations.prepareBridge()
  skills.install('vitest-safe', 'codex')
  skills.setVariable('vitest-safe', 'VITEST_SAFE_MAX_CONCURRENT', { scope: 'skill' }, '1')
  skills.setVariable(
    'vitest-safe',
    'VITEST_SAFE_LOCK_DIR',
    { scope: 'skill' },
    path.join(root, 'test-locks')
  )
  server = await startServer(store, path.join(root, 'runtime.json'), () => {}, skills)
  const logfile = path.join(root, 'queue-events')
  const snippet =
    'import sys,time; f=open(sys.argv[1],"a",buffering=1);f.write("start "+sys.argv[2]+"\\n");time.sleep(0.15);f.write("end "+sys.argv[2]+"\\n")'
  const invoke = (id: string) =>
    execute(
      integrations.skillsClient,
      [
        '--terminal',
        'codex',
        'run',
        '--skill',
        'vitest-safe',
        '--path',
        first.path,
        '--script',
        'scripts/vitest-safe',
        '--',
        '--',
        'python3',
        '-c',
        snippet,
        logfile,
        id
      ],
      {
        env: { ...process.env, HOME: home, VITEST_SAFE_STATE_DIR: path.join(root, 'queue-state') },
        timeout: 15000
      }
    )
  await Promise.all([invoke('a'), invoke('b')])
  const events = readFileSync(logfile, 'utf8').trim().split('\n')
  expect(events.map((line) => line.split(' ')[0])).toEqual(['start', 'end', 'start', 'end'])
  expect(events[0].split(' ')[1]).toBe(events[1].split(' ')[1])
  expect(events[2].split(' ')[1]).toBe(events[3].split(' ')[1])
})
it('Reviewer 外部模式显式传入项目目录，缺省不发送空模型参数，可配置模型且不运行真实模型', async () => {
  skills.seed()
  integrations.prepareBridge()
  skills.install('reviewer', 'qoder')
  await execute('git', ['init', '-b', 'fixture', first.path])
  const artifact = path.join(first.path, 'artifact.md'),
    review = path.join(first.path, 'review.md'),
    logfile = path.join(root, 'review-argv.json')
  writeFileSync(artifact, 'fixture artifact')
  writeFileSync(review, 'fixture review')
  const fake = path.join(root, 'fake-codex')
  writeFileSync(
    fake,
    '#!/usr/bin/env python3\nimport json,os,sys\nfrom pathlib import Path\nsys.stdin.read()\nPath(os.environ["FAKE_REVIEW_LOG"]).write_text(json.dumps({"args":sys.argv[1:],"cwd":os.getcwd()}))\nPath(sys.argv[sys.argv.index("-o")+1]).write_text("fixture report")\n',
    { mode: 0o700 }
  )
  skills.setVariable('reviewer', 'REVIEWER_CODEX_BIN', { scope: 'skill' }, fake)
  server = await startServer(store, path.join(root, 'runtime.json'), () => {}, skills)
  const invoke = () =>
    execute(
      integrations.skillsClient,
      [
        '--terminal',
        'qoder',
        'run',
        '--skill',
        'reviewer',
        '--path',
        first.path,
        '--script',
        'scripts/reviewer-run.sh',
        '--',
        'dispute',
        '--task',
        'fixture task',
        '--artifact-type',
        'doc',
        '--topic',
        'fixture',
        '--audit-round',
        '1',
        '--inner-iteration',
        '1',
        '--max-blind-audits',
        '1',
        '--latest-artifact',
        artifact,
        '--latest-review',
        review
      ],
      { env: { ...process.env, HOME: home, FAKE_REVIEW_LOG: logfile }, timeout: 15000 }
    )
  await invoke()
  const firstCall = JSON.parse(readFileSync(logfile, 'utf8'))
  expect(firstCall.cwd).toBe(first.path)
  expect(firstCall.args).not.toContain('-m')
  expect(
    readFileSync(path.join(first.path, '.qoder/plans/fixture/dispute-report.md'), 'utf8')
  ).toBe('fixture report')
  skills.setVariable(
    'reviewer',
    'REVIEWER_CODEX_REVIEW_MODEL',
    { scope: 'project', folderId: first.id },
    'fixture-model $literal'
  )
  await invoke()
  const nextCall = JSON.parse(readFileSync(logfile, 'utf8'))
  expect(nextCall.args[nextCall.args.indexOf('-m') + 1]).toBe('fixture-model $literal')
})

it('必填变量缺失时仍能读取指导和项目 ID，执行前阻止；targets 仅返回已有项目和已绑定终端', () => {
  skills.seed()
  skills.install('push-code', 'codex')
  const context = skills.runtime('push-code', 'codex', first.path)
  expect(context.folder?.id).toBe(first.id)
  expect(context.missingVariables).toContain('PUSH_CODE_GITLAB_API_TOKEN')
  expect(() => skills.runtime('push-code', 'codex', first.path, true)).toThrow('必填变量')
  store.saveManifest('grok', null)
  expect(skills.targets().terminals.map((item) => item.id)).not.toContain('grok')
  expect(skills.targets().projects.map((item) => item.id)).toContain(first.id)
  expect(() => skills.runtime('push-code', 'codex', path.join(root, 'missing'))).toThrow(
    '不存在或不可访问'
  )
})
