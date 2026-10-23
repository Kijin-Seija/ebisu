import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  rmSync,
  statSync
} from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import TOML from '@iarna/toml'
import type { Store } from './database'
import { terminalIds, type IntegrationView, type TerminalId } from '../shared/types'

const execute = promisify(execFile)
export const terminalNames: Record<TerminalId, string> = {
  codex: 'Codex',
  workbuddy: 'WorkBuddy',
  claude: 'Claude Code',
  grok: 'Grok',
  qoder: 'Qoder'
}
interface Adapter {
  commands: string[]
  apps: string[]
  root: string
  skillRoot: string
  rule: string
  hookFile?: string
  events: string[]
}
/** 不把 Claude 桌面聊天应用误识别成 Claude Code；后者需 CLI 或其专用应用。 */
const adapters: Record<TerminalId, Adapter> = {
  codex: {
    commands: ['codex'],
    apps: ['Codex.app', 'ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app'],
    root: '.codex',
    skillRoot: '.agents/skills',
    rule: '.codex/AGENTS.md',
    hookFile: '.codex/hooks.json',
    events: [
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PermissionRequest',
      'Stop',
      'Interrupt',
      'SessionEnd'
    ]
  },
  workbuddy: {
    commands: ['workbuddy'],
    apps: ['WorkBuddy.app'],
    root: '.workbuddy',
    skillRoot: '.workbuddy/skills',
    rule: '.workbuddy/AGENTS.md',
    hookFile: '.workbuddy/settings.json',
    events: [
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PermissionRequest',
      'Notification',
      'Stop',
      'StopFailure',
      'SessionEnd'
    ]
  },
  claude: {
    commands: ['claude'],
    apps: ['Claude Code.app'],
    root: '.claude',
    skillRoot: '.claude/skills',
    rule: '.claude/rules/ebisu-activity.md',
    hookFile: '.claude/settings.json',
    events: [
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PermissionRequest',
      'Notification',
      'Stop',
      'StopFailure',
      'SessionEnd'
    ]
  },
  grok: {
    commands: ['grok'],
    apps: ['Grok CLI.app'],
    root: '.grok',
    skillRoot: '.grok/skills',
    rule: '.grok/rules/ebisu-activity.md',
    hookFile: '.grok/hooks/ebisu.json',
    events: [
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PermissionRequest',
      'Notification',
      'Stop',
      'StopFailure',
      'StopCancelled',
      'SessionEnd'
    ]
  },
  // Qoder Desktop 与 CLI 共用 settings.json hook 协议，见 docs/INTEGRATIONS.md。
  qoder: {
    commands: ['qodercli', 'qoder'],
    apps: ['Qoder.app'],
    root: '.qoder',
    skillRoot: '.qoder/skills',
    rule: '.qoder/AGENTS.md',
    hookFile: '.qoder/settings.json',
    events: [
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PermissionRequest',
      'Notification',
      'Stop',
      'StopFailure',
      'SessionEnd',
      'Elicitation',
      'ElicitationResult'
    ]
  }
}
export interface IntegrationOptions {
  home?: string
  appDirectories?: string[]
  pathEnv?: string
  dataDirectory: string
  resources: string
  executable: string
}
interface OwnedFile {
  file: string
  hash: string
}
interface Manifest {
  version: 1
  installedAt: number
  owned: OwnedFile[]
  rule: string
  hookFile?: string
  backups: string
  codexFeatureAdded?: boolean
  codexFeatureLimited?: boolean
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : '')
/** hook command 必须经 shell 执行，所有动态路径都按 POSIX 单引号转义。 */
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const begin = '<!-- BEGIN EBISU ACTIVITY -->'
const end = '<!-- END EBISU ACTIVITY -->'
const managedBlock =
  /(?:\n)?<!-- BEGIN EBISU ACTIVITY -->[\s\S]*?<!-- END EBISU ACTIVITY -->(?:\n)?/g

/** 探测和配置操作都允许注入临时 HOME，便于隔离验收而不污染用户环境。 */
export class Integrations {
  readonly home: string
  readonly bridge: string
  private readonly appDirectories: string[]
  constructor(
    private readonly store: Store,
    private readonly options: IntegrationOptions
  ) {
    this.home = options.home ?? homedir()
    this.appDirectories = options.appDirectories ?? [
      '/Applications',
      path.join(this.home, 'Applications')
    ]
    this.bridge = path.join(options.dataDirectory, 'integration', 'report')
  }

  /** 分辨“确实安装了可执行程序”和“只有卸载后残留配置”。 */
  detect(id: TerminalId): string[] {
    const adapter = adapters[id]
    const searchDirectories = [
      ...(this.options.pathEnv ?? process.env.PATH ?? '').split(path.delimiter),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      path.join(this.home, '.local/bin'),
      path.join(this.home, adapter.root, 'bin')
    ]
    const evidence = new Set<string>()
    for (const directory of searchDirectories.filter(Boolean)) {
      for (const binary of adapter.commands) {
        const candidate = path.join(directory, binary)
        try {
          accessSync(candidate, constants.X_OK)
          if (statSync(candidate).isFile()) evidence.add(candidate)
        } catch {
          /* 未安装是正常探测结果。 */
        }
      }
    }
    for (const directory of this.appDirectories)
      for (const app of adapter.apps) {
        const candidate = path.join(directory, app)
        if (existsSync(path.join(candidate, 'Contents/Info.plist'))) evidence.add(candidate)
      }
    return [...evidence]
  }

  /** 共享桥接工具由应用维护，使用自带 Electron 的 Node 模式，不依赖 GUI 的 PATH。 */
  prepareBridge(): void {
    mkdirSync(path.dirname(this.bridge), { recursive: true, mode: 0o700 })
    copyFileSync(path.join(this.options.resources, 'integration/report.cjs'), `${this.bridge}.cjs`)
    const runtime = path.join(this.options.dataDirectory, 'runtime.json')
    writeFileSync(
      this.bridge,
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quote(this.options.executable)} ${quote(`${this.bridge}.cjs`)} --runtime ${quote(runtime)} "$@"\n`,
      { mode: 0o700 }
    )
    chmodSync(this.bridge, 0o700)
  }

  private ruleText(id: TerminalId): string {
    const command = `${quote(this.bridge)} --terminal ${id}`
    return `${begin}
## Ebisu 项目活动通知（始终适用）
当本会话涉及本机文件夹（包括阅读、规划、执行）时，先调用通知 skill ebisu-${id}。
使用本机终端工具执行 ${command} --session 本会话ID --path /绝对目录 --action enter，已注册目录及其子目录会被监控，其他目录自动忽略。
同一会话的每次上报必须复用真实会话 ID；可用时通过 --session 传入。上报工具会自动读取宿主的会话环境变量（Codex 为 CODEX_THREAD_ID 或 CODEX_SESSION_ID），不要因为不知道真实 ID 就另造临时身份。模型已知时用 --model 传入真实模型名，未知时省略。
需要获取上报 ID 时执行 ${command} --new-session；该命令优先返回宿主真实 ID，仅在确实缺失时生成 local- ID。只申请一次，保存并在本会话所有通知中用 --session 复用返回值，不要在不同会话之间共享，也不要将终端名或模型名用作会话 ID。已有 local- ID 时继续传入，原生工具 hook 会将该命令中的临时 ID 绑定到真实身份；不要自行换成另一个 ID。缺少 ID 的请求不会创建活动。
在涉及其他目录前也执行 enter；执行中至少每两分钟重复 enter 刷新心跳，长时间命令前后也刷新。
需要向用户提问或等待确认前，执行 enter 并加 --phase waiting；继续执行用 --phase executing。
遇到网络故障、额度上限等无法继续的问题时，执行 enter 并加 --phase error；该项目的故障状态会保留到下一次 executing 上报。
任务正常完成或取消时执行 --action exit --scope session，释放此会话涉及的目录；故障状态不因退出而清除。
上报工具失联时快速静默返回，不改变原任务，不自动启动 Ebisu。不要创建脱离会话持续运行的无限心跳进程。
此规则只负责本机活动上报，不授权提交、推送、发消息等其他操作。若同时加载了其他终端的 Ebisu 规则，只使用实际宿主终端对应的命令，勿重复执行。
${end}`
  }

  /** 所有改动先保存原文；失败时按逆序回滚，备份保留在应用数据目录。 */
  install(id: TerminalId): void {
    if (!this.detect(id).length) throw new Error(`${terminalNames[id]} 尚未安装`)
    this.prepareBridge()
    const adapter = adapters[id]
    const previous = this.store.integration(id)?.manifest
    const manifest: Manifest | undefined = previous ? JSON.parse(previous) : undefined
    const backupDirectory = path.join(
      this.options.dataDirectory,
      'backups',
      `${id}-${Date.now()}-${randomUUID().slice(0, 6)}`
    )
    const touched: { file: string; content: string | null; mode: number }[] = []
    const write = (file: string, content: string) => {
      const exists = existsSync(file)
      const original = exists ? read(file) : null
      if (original === content) return
      mkdirSync(backupDirectory, { recursive: true, mode: 0o700 })
      if (original !== null)
        writeFileSync(
          path.join(backupDirectory, `${touched.length}-${path.basename(file)}`),
          original,
          { mode: 0o600 }
        )
      touched.push({ file, content: original, mode: exists ? statSync(file).mode & 0o777 : 0o600 })
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, content, { mode: exists ? statSync(file).mode & 0o777 : 0o600 })
    }
    try {
      const skillFile = path.join(this.home, adapter.skillRoot, `ebisu-${id}`, 'SKILL.md')
      const skill = `---\nname: ebisu-${id}\ndescription: Notify the local Ebisu project dashboard when this ${terminalNames[id]} session reads, plans or works in a local folder; maintain activity, waiting and error state until the task finishes.\n---\n\n${this.ruleText(id)}\n`
      const oldOwned = manifest?.owned.find((owned) => owned.file === skillFile)
      if (
        existsSync(skillFile) &&
        read(skillFile) !== skill &&
        (!oldOwned || hash(read(skillFile)) !== oldOwned.hash)
      )
        throw new Error(`已有同名 skill 被修改，请先备份或移走：${skillFile}`)
      write(skillFile, skill)
      const ruleFile = path.join(this.home, adapter.rule)
      const ruleBefore = read(ruleFile)
      const ruleAfter = ruleBefore.includes(begin)
        ? ruleBefore.replace(
            /<!-- BEGIN EBISU ACTIVITY -->[\s\S]*?<!-- END EBISU ACTIVITY -->/,
            this.ruleText(id)
          )
        : `${ruleBefore}${ruleBefore && !ruleBefore.endsWith('\n') ? '\n' : ''}${ruleBefore ? '\n' : ''}${this.ruleText(id)}\n`
      write(ruleFile, ruleAfter)
      let hookFile: string | undefined
      if (adapter.hookFile) {
        hookFile = path.join(this.home, adapter.hookFile)
        const configuration = read(hookFile) ? JSON.parse(read(hookFile)) : {}
        if (
          typeof configuration !== 'object' ||
          Array.isArray(configuration) ||
          configuration === null
        )
          throw new Error('终端 hook 配置不是对象，未覆盖原配置')
        const hooks = configuration.hooks ?? {}
        if (typeof hooks !== 'object' || Array.isArray(hooks) || hooks === null)
          throw new Error('已有 hooks 配置格式不受支持')
        this.removeOwnedHooks(hooks, id)
        for (const event of adapter.events) {
          if (hooks[event] !== undefined && !Array.isArray(hooks[event]))
            throw new Error(`已有 ${event} hook 格式不受支持`)
          const entry: Record<string, unknown> = {
            hooks: [
              {
                type: 'command',
                command: `${quote(this.bridge)} --hook --terminal ${id} --ebisu-owner=${id}`,
                timeout: 2
              }
            ]
          }
          if (event === 'Notification')
            entry.matcher = 'permission_prompt|elicitation_dialog|agent_needs_input'
          hooks[event] ??= []
          hooks[event].push(entry)
        }
        configuration.hooks = hooks
        write(hookFile, `${JSON.stringify(configuration, null, 2)}\n`)
      }
      let codexFeatureAdded = manifest?.codexFeatureAdded ?? false
      let codexFeatureLimited = false
      if (id === 'codex') {
        const configFile = path.join(this.home, '.codex/config.toml')
        const config = read(configFile)
        const parsed = TOML.parse(config) as { features?: Record<string, unknown> }
        // 尊重显式 false 和旧别名；只给没有声明的配置添加有标记的开关。
        if (parsed.features?.hooks === undefined && parsed.features?.codex_hooks === undefined) {
          const featureLine = '# Ebisu managed lifecycle hooks\nhooks = true # ebisu-managed\n'
          const featureHeader =
            /^([\t ]*\[(?:features|"features"|'features')\][\t ]*(?:#[^\r\n]*)?)(?:\r?\n|$)/m
          if (parsed.features !== undefined && !featureHeader.test(config)) {
            // 行内表不能由后续 table 扩展；不为开启 hook 破坏合法的用户 TOML。
            codexFeatureLimited = true
          } else {
            const updated = featureHeader.test(config)
              ? config.replace(featureHeader, `$1\n${featureLine}`)
              : `${config}\n[features]\n${featureLine}`
            TOML.parse(updated)
            write(configFile, updated)
            codexFeatureAdded = true
          }
        }
      }
      this.store.saveManifest(id, {
        version: 1,
        installedAt: Date.now(),
        owned: [{ file: skillFile, hash: hash(skill) }],
        rule: ruleFile,
        hookFile,
        backups: backupDirectory,
        codexFeatureAdded,
        codexFeatureLimited
      } satisfies Manifest)
    } catch (error) {
      for (const item of touched.reverse()) {
        if (item.content === null) rmSync(item.file, { force: true })
        else writeFileSync(item.file, item.content, { mode: item.mode })
      }
      throw error
    }
  }

  /** 只移除带当前适配器标识的 handler，保留用户添加的同组其他 hook。 */
  private removeOwnedHooks(hooks: Record<string, any>, id: TerminalId): void {
    for (const event of Object.keys(hooks)) {
      if (!Array.isArray(hooks[event])) continue
      hooks[event] = hooks[event]
        .map((group: any) => {
          if (!Array.isArray(group?.hooks)) return group
          return {
            ...group,
            hooks: group.hooks.filter(
              (handler: any) => !String(handler?.command ?? '').endsWith(`--ebisu-owner=${id}`)
            )
          }
        })
        .filter((group: any) => !Array.isArray(group?.hooks) || group.hooks.length > 0)
      if (!hooks[event].length) delete hooks[event]
    }
  }

  uninstall(id: TerminalId): void {
    const row = this.store.integration(id)
    if (!row?.manifest) return
    const manifest = JSON.parse(row.manifest) as Manifest
    // 先解析配置，避免遇到用户损坏的 JSON 时卸载到一半。
    const hookConfig =
      manifest.hookFile && existsSync(manifest.hookFile)
        ? JSON.parse(read(manifest.hookFile))
        : undefined
    for (const owned of manifest.owned) {
      if (existsSync(owned.file) && hash(read(owned.file)) !== owned.hash)
        throw new Error(`skill 已被手动修改，保留文件：${owned.file}`)
    }
    if (hookConfig?.hooks) {
      this.removeOwnedHooks(hookConfig.hooks, id)
      if (!Object.keys(hookConfig.hooks).length) delete hookConfig.hooks
      writeFileSync(manifest.hookFile!, `${JSON.stringify(hookConfig, null, 2)}\n`)
    }
    if (existsSync(manifest.rule)) {
      const remaining = read(manifest.rule).replace(managedBlock, '\n')
      if (!remaining.trim() && adapters[id].rule.endsWith('rules/ebisu-activity.md'))
        rmSync(manifest.rule)
      else writeFileSync(manifest.rule, remaining)
    }
    if (manifest.codexFeatureAdded) {
      const configFile = path.join(this.home, '.codex/config.toml')
      if (existsSync(configFile)) {
        const remaining = read(configFile)
          .replace(/^# Ebisu managed lifecycle hooks\r?\n(?=hooks = true # ebisu-managed)/m, '')
          .replace(/^hooks = true # ebisu-managed\r?\n?/m, '')
        writeFileSync(configFile, remaining)
      }
    }
    for (const owned of manifest.owned) rmSync(owned.file, { force: true })
    this.store.saveManifest(id, null)
  }

  views(): IntegrationView[] {
    return terminalIds.map((id) => {
      const evidence = this.detect(id)
      const row = this.store.integration(id)
      let health: IntegrationView['health'] = 'absent'
      let detail = evidence.length ? '尚未安装通知集成' : '未检测到终端；安装后可重新探测'
      if (row?.manifest) {
        const manifest = JSON.parse(row.manifest) as Manifest
        const intact =
          manifest.owned.every(
            (owned) => existsSync(owned.file) && hash(read(owned.file)) === owned.hash
          ) && read(manifest.rule).includes(this.ruleText(id))
        let hookIntact = true
        if (manifest.hookFile) {
          try {
            const hooks = JSON.parse(read(manifest.hookFile)).hooks
            const expectedCommand = `${quote(this.bridge)} --hook --terminal ${id} --ebisu-owner=${id}`
            hookIntact = adapters[id].events.every((event) =>
              hooks?.[event]?.some((group: any) =>
                group.hooks?.some((handler: any) => handler.command === expectedCommand)
              )
            )
          } catch {
            hookIntact = false
          }
        }
        let disabled = false
        if (id === 'codex') {
          try {
            const config = TOML.parse(read(path.join(this.home, '.codex/config.toml'))) as {
              features?: Record<string, unknown>
            }
            disabled =
              config.features?.hooks === false ||
              (config.features?.hooks === undefined && config.features?.codex_hooks === false) ||
              (!!manifest.codexFeatureLimited && config.features?.hooks !== true)
          } catch {
            disabled = true
          }
        }
        if (!intact || !hookIntact || !existsSync(this.bridge)) {
          health = 'damaged'
          detail = '管理文件缺失或已修改；可重新安装修复'
        } else if (!evidence.length || disabled || !adapters[id].hookFile) {
          health = 'limited'
          detail = disabled
            ? manifest.codexFeatureLimited
              ? '已保留行内 TOML 配置；请手动在 features 中启用 hooks'
              : '终端已显式禁用 hook；保留规则与 skill，未覆盖该设置'
            : !evidence.length
              ? '终端已移走；集成文件仍保留'
              : '规则与 skill 已安装；此终端尚未验证原生 hook'
        } else if (
          row.lastSeen &&
          row.lastSeen >= manifest.installedAt &&
          Date.now() - row.lastSeen < 600000
        ) {
          health = 'healthy'
          detail = '近期已收到真实会话上报'
        } else {
          health = 'restart'
          detail = '配置已安装；请重启已有会话，等待真实上报验证'
        }
      }
      return {
        id,
        name: terminalNames[id],
        detected: evidence.length > 0,
        evidence,
        installed: !!row?.manifest,
        health,
        detail,
        lastSeen: row?.lastSeen ?? null
      }
    })
  }

  /** 连通性检查只验证桥接与 HTTP 服务，不伪造会话或提升终端健康状态。 */
  async check(id: TerminalId): Promise<string> {
    if (!this.store.integration(id)?.manifest) throw new Error('请先安装通知集成')
    const { stdout } = await execute(this.bridge, ['--check', '--terminal', id], {
      timeout: 3000,
      maxBuffer: 4096
    })
    if (!stdout.includes('"ok":true')) throw new Error('本机服务不可达，请重启 Ebisu 后重试')
    return '本机通知链路正常；终端是否加载配置需由真实会话上报确认'
  }
}
