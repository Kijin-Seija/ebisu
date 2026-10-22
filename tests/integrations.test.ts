import { beforeEach, afterEach, expect, it } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  chmodSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import path from 'node:path'
import TOML from '@iarna/toml'
import { Store } from '../src/main/database'
import { Integrations } from '../src/main/integrations'
import { startServer } from '../src/main/server'
import type { TerminalId } from '../src/shared/types'

let root: string
let home: string
let data: string
let bin: string
let apps: string
let store: Store
let integrations: Integrations
let server: Awaited<ReturnType<typeof startServer>> | undefined
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'ebisu-integrations-'))
  home = path.join(root, 'home')
  data = path.join(root, 'data')
  bin = path.join(root, 'bin')
  apps = path.join(root, 'Applications')
  for (const dir of [home, data, bin, apps]) mkdirSync(dir)
  store = new Store(path.join(data, 'state.sqlite'))
  integrations = new Integrations(store, {
    home,
    dataDirectory: data,
    resources: path.resolve('resources'),
    executable: process.execPath,
    pathEnv: bin,
    appDirectories: [apps]
  })
})
afterEach(async () => {
  await server?.close()
  server = undefined
  store.close()
  rmSync(root, { recursive: true, force: true })
})
function file(name: string, content: string) {
  const target = path.join(home, name)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, content)
  return target
}
function binary(name: string) {
  const target = path.join(bin, name)
  writeFileSync(target, '#!/bin/sh\nexit 0\n')
  chmodSync(target, 0o700)
}
function text(name: string) {
  return readFileSync(path.join(home, name), 'utf8')
}
/** 通过真正安装的 wrapper 上报，保留 runtime 与 HTTP 全链路。 */
function report(
  terminal: TerminalId,
  input: unknown,
  extra: Record<string, string> = {}
): Promise<string> {
  return bridge(['--terminal', terminal, '--hook'], input, extra)
}
/** 手动 skill 与原生 hook 使用同一真实 wrapper；清除宿主身份以隔离每个测试会话。 */
function bridge(
  args: string[],
  input: unknown = {},
  extra: Record<string, string> = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }
    for (const key of [
      'CODEX_THREAD_ID',
      'CODEX_SESSION_ID',
      'GROK_SESSION_ID',
      'GROK_HOOK_EVENT',
      'WORKBUDDY_SESSION_ID',
      'CODEBUDDY_SESSION_ID',
      'QODER_PROJECT_DIR',
      'QODER_SESSION_ID',
      'CLAUDE_SESSION_ID'
    ])
      delete env[key]
    const child = spawn(integrations.bridge, args, {
      env: { ...env, ...extra }
    })
    let stderr = ''
    let stdout = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr))))
    child.stdin.end(JSON.stringify(input))
  })
}
it('Qoder 只有配置残留时不算已安装；可执行文件与应用均可作为安装证据', () => {
  file('.qoder/AGENTS.md', 'residual')
  expect(integrations.detect('qoder')).toEqual([])
  expect(() => integrations.install('qoder')).toThrow('尚未安装')
  binary('qodercli')
  expect(integrations.detect('qoder')).toContain(path.join(bin, 'qodercli'))
  mkdirSync(path.join(apps, 'WorkBuddy.app/Contents'), { recursive: true })
  writeFileSync(path.join(apps, 'WorkBuddy.app/Contents/Info.plist'), '<plist/>')
  expect(integrations.detect('workbuddy')).toContain(path.join(apps, 'WorkBuddy.app'))
})
it('上报宿主的真实任务标题，手动参数可更新，不能把工具标题或提示词当任务', async () => {
  integrations.prepareBridge()
  const folder = store.addFolder(root)
  server = await startServer(store, path.join(data, 'runtime.json'), () => {})
  await report('claude', {
    hook_event_name: 'PreToolUse',
    session_id: 'task',
    cwd: root,
    session_title: '修复登录问题',
    tool_input: { title: '不要使用工具标题' }
  })
  expect(store.sessions(folder.id)[0].taskTitle).toBe('修复登录问题')
  await bridge([
    '--terminal',
    'claude',
    '--session',
    'task',
    '--path',
    root,
    '--task-title',
    '新任务名称'
  ])
  expect(store.sessions(folder.id)[0].taskTitle).toBe('新任务名称')
  await report('claude', {
    hook_event_name: 'PreToolUse',
    session_id: 'other',
    cwd: root,
    title: '不是会话标题',
    prompt: '不能读取提示词'
  })
  expect(store.sessions(folder.id).find((s) => s.sessionId === 'other')?.taskTitle).toBeNull()
})
it.each(['CODEX_THREAD_ID', 'CODEX_SESSION_ID'])(
  'Codex %s 下申请 ID、手动上报与原生 hook 共用真实身份，Stop 后立即释放',
  async (key) => {
    const folder = store.addFolder(root)
    integrations.prepareBridge()
    server = await startServer(store, path.join(data, 'runtime.json'), () => {})
    const env = { [key]: 'real-codex-session' }
    const id = await bridge(['--terminal', 'codex', '--new-session'], {}, env)
    expect(id).toBe('real-codex-session')
    await bridge(
      ['--terminal', 'codex', '--session', id, '--path', root, '--action', 'enter'],
      {},
      env
    )
    await report(
      'codex',
      {
        hook_event_name: 'PostToolUse',
        session_id: id,
        cwd: root,
        model: 'gpt-6.1-sol'
      },
      env
    )
    expect(store.sessions(folder.id)).toMatchObject([{ sessionId: id, model: 'gpt-6.1-sol' }])
    expect(store.sessions(folder.id)).toHaveLength(1)
    await report('codex', { hook_event_name: 'Stop', session_id: id, cwd: root }, env)
    expect(store.sessions(folder.id)).toHaveLength(0)
  }
)
it('旧规则传入 local- 时按宿主真实 ID 归一，迁移跨目录记录，取消不残留也不合并其他会话', async () => {
  const first = store.addFolder(root)
  const second = store.addFolder(home)
  integrations.prepareBridge()
  server = await startServer(store, path.join(data, 'runtime.json'), () => {})
  for (const folder of [first, second])
    store.activity({
      path: folder.path,
      terminal: 'codex',
      sessionId: 'local-legacy',
      action: 'enter'
    })
  await report('codex', {
    hook_event_name: 'PreToolUse',
    session_id: 'real-one',
    cwd: root,
    model: 'gpt-6.1-sol'
  })
  await report('codex', { hook_event_name: 'PreToolUse', session_id: 'real-two', cwd: root })
  await bridge(
    ['--terminal', 'codex', '--session', 'local-legacy', '--path', root, '--action', 'enter'],
    {},
    { CODEX_THREAD_ID: 'real-one' }
  )
  expect(
    store
      .sessions(first.id)
      .map((session) => session.sessionId)
      .sort()
  ).toEqual(['real-one', 'real-two'])
  expect(store.sessions(first.id).find((session) => session.sessionId === 'real-one')?.model).toBe(
    'gpt-6.1-sol'
  )
  expect(store.sessions(second.id)).toMatchObject([{ sessionId: 'real-one' }])
  await report('codex', { hook_event_name: 'Interrupt', session_id: 'real-one', cwd: root })
  expect(store.sessions(first.id)).toMatchObject([{ sessionId: 'real-two' }])
  expect(store.sessions(second.id)).toHaveLength(0)
  // 没有原生环境的旧进程仍可通过持久化别名释放真实会话。
  await bridge([
    '--terminal',
    'codex',
    '--session',
    'local-legacy',
    '--path',
    root,
    '--action',
    'enter'
  ])
  await bridge([
    '--terminal',
    'codex',
    '--session',
    'local-legacy',
    '--path',
    root,
    '--action',
    'exit',
    '--scope',
    'session'
  ])
  expect(store.sessions(first.id)).toMatchObject([{ sessionId: 'real-two' }])
})
it('确实没有真实身份时仍可申请独立临时 ID，显式真实子会话不被父环境覆盖', async () => {
  const folder = store.addFolder(root)
  integrations.prepareBridge()
  server = await startServer(store, path.join(data, 'runtime.json'), () => {})
  const first = await bridge(['--terminal', 'codex', '--new-session'])
  const second = await bridge(['--terminal', 'codex', '--new-session'])
  expect(first).toMatch(/^local-[0-9a-f-]{36}$/)
  expect(second).not.toBe(first)
  await bridge(
    ['--terminal', 'codex', '--session', 'real-child', '--path', root, '--action', 'enter'],
    {},
    { CODEX_THREAD_ID: 'real-parent' }
  )
  expect(store.sessions(folder.id)).toMatchObject([{ sessionId: 'real-child' }])
})
it('重复安装不重复添加 hook，卸载保留原规则、环境变量和后来追加的 hook', () => {
  binary('claude')
  file('.claude/rules/ebisu-activity.md', '原有自定义规则\n')
  file(
    '.claude/settings.json',
    JSON.stringify({
      env: { USER_OPTION: 'keep' },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-original' }] }] }
    })
  )
  integrations.install('claude')
  integrations.install('claude')
  const config = JSON.parse(text('.claude/settings.json'))
  expect(config.hooks.Stop).toHaveLength(2)
  expect(config.env.USER_OPTION).toBe('keep')
  expect(text('.claude/rules/ebisu-activity.md')).toContain('原有自定义规则')
  config.hooks.Stop.push({ hooks: [{ type: 'command', command: 'user-later' }] })
  file('.claude/settings.json', JSON.stringify(config))
  integrations.uninstall('claude')
  const after = JSON.parse(text('.claude/settings.json'))
  expect(after.hooks.Stop.map((group: any) => group.hooks[0].command)).toEqual([
    'user-original',
    'user-later'
  ])
  expect(after.env.USER_OPTION).toBe('keep')
  expect(text('.claude/rules/ebisu-activity.md').trim()).toBe('原有自定义规则')
  expect(existsSync(path.join(home, '.claude/skills/ebisu-claude/SKILL.md'))).toBe(false)
})
it('畸形配置导致安装失败时，已写入的文件全部回滚', () => {
  binary('workbuddy')
  file('.workbuddy/AGENTS.md', '现有规则\n')
  file('.workbuddy/settings.json', '{broken')
  expect(() => integrations.install('workbuddy')).toThrow()
  expect(text('.workbuddy/AGENTS.md')).toBe('现有规则\n')
  expect(text('.workbuddy/settings.json')).toBe('{broken')
  expect(existsSync(path.join(home, '.workbuddy/skills/ebisu-workbuddy/SKILL.md'))).toBe(false)
  expect(store.integration('workbuddy')?.manifest).toBeFalsy()
})
it('Codex hook 开关保留 TOML 注释，卸载仅撤销自己添加的开关', () => {
  binary('codex')
  file('.codex/config.toml', '# 原有注释\nmodel = "test"\n[features]\nother = true\n')
  integrations.install('codex')
  expect(text('.codex/config.toml')).toContain('# 原有注释')
  expect((TOML.parse(text('.codex/config.toml')).features as any).hooks).toBe(true)
  integrations.uninstall('codex')
  expect((TOML.parse(text('.codex/config.toml')).features as any).hooks).toBeUndefined()
  expect(text('.codex/config.toml')).toContain('other = true')
})
it('不覆盖用户明确禁用的 hook，并显示能力受限', () => {
  binary('codex')
  file('.codex/config.toml', '[features]\nhooks=false\n')
  integrations.install('codex')
  expect(integrations.views().find((view) => view.id === 'codex')?.health).toBe('limited')
  expect(text('.codex/config.toml')).toContain('hooks=false')
})
it('支持带行尾注释的 features 表，特殊行内表保持原样而不写出重复 TOML', () => {
  binary('codex')
  file('.codex/config.toml', '[features] # 保留注释\nother = true\n')
  integrations.install('codex')
  expect((TOML.parse(text('.codex/config.toml')).features as any).hooks).toBe(true)
  expect(text('.codex/config.toml')).toContain('# 保留注释')
  integrations.uninstall('codex')
  file('.codex/config.toml', 'features = { other = true }\n')
  integrations.install('codex')
  expect(text('.codex/config.toml')).toBe('features = { other = true }\n')
  expect(integrations.views().find((view) => view.id === 'codex')?.health).toBe('limited')
})
it('被用户修改的 skill 不会被卸载或重新安装覆盖', () => {
  binary('grok')
  integrations.install('grok')
  file('.grok/skills/ebisu-grok/SKILL.md', '用户改写')
  expect(() => integrations.uninstall('grok')).toThrow('手动修改')
  expect(() => integrations.install('grok')).toThrow('已有同名')
  expect(text('.grok/skills/ebisu-grok/SKILL.md')).toBe('用户改写')
})
it('五种终端完成真实 wrapper→HTTP→SQLite 通知链路；检查不伪造健康', async () => {
  const folder = store.addFolder(root)
  server = await startServer(store, path.join(data, 'runtime.json'), () => {})
  for (const terminal of ['codex', 'workbuddy', 'claude', 'grok', 'qoder'] as const) {
    binary(terminal)
    integrations.install(terminal)
    expect(integrations.views().find((view) => view.id === terminal)?.health).toBe('restart')
    expect(await integrations.check(terminal)).toContain('本机通知链路正常')
    expect(integrations.views().find((view) => view.id === terminal)?.health).toBe('restart')
    await report(terminal, {
      hook_event_name: 'UserPromptSubmit',
      session_id: terminal,
      cwd: root,
      model: 'gpt-6'
    })
    expect(
      store.sessions(folder.id).find((session) => session.terminal === terminal)?.sessionId
    ).toBe(terminal)
    expect(integrations.views().find((view) => view.id === terminal)?.health).toBe('healthy')
    await report(terminal, {
      hook_event_name: 'PermissionRequest',
      session_id: terminal,
      cwd: root
    })
    await report(terminal, { hook_event_name: 'Stop', session_id: terminal, cwd: root })
    expect(store.sessions(folder.id).find((session) => session.terminal === terminal)?.phase).toBe(
      'waiting'
    )
    await report(terminal, {
      hook_event_name: 'PreToolUse',
      session_id: terminal,
      cwd: root,
      tool_name: 'Read'
    })
    await report(terminal, { hook_event_name: 'Stop', session_id: terminal, cwd: root })
    expect(
      store.sessions(folder.id).find((session) => session.terminal === terminal)
    ).toBeUndefined()
  }
})
it('Grok 兼容加载 Claude hook 时不会伪造 Claude 会话', async () => {
  const folder = store.addFolder(root)
  integrations.prepareBridge()
  server = await startServer(store, path.join(data, 'runtime.json'), () => {})
  const input = { hook_event_name: 'PreToolUse', session_id: 'grok-session', cwd: root }
  await report('claude', input, { GROK_SESSION_ID: 'grok-session' })
  expect(store.sessions(folder.id)).toHaveLength(0)
  await report('grok', input, { GROK_SESSION_ID: 'grok-session' })
  expect(store.sessions(folder.id)).toMatchObject([{ terminal: 'grok', sessionId: 'grok-session' }])
})

it.each(['codex', 'workbuddy', 'claude', 'grok', 'qoder'] as const)(
  '%s 无身份环境变量时，原生工具事件绑定 skill 临时 ID；等待、跨目录退出及并发不产生幽灵会话',
  async (terminal) => {
    const first = store.addFolder(root)
    const secondPath = path.join(root, 'second')
    mkdirSync(secondPath)
    const second = store.addFolder(secondPath)
    integrations.prepareBridge()
    server = await startServer(store, path.join(data, 'runtime.json'), () => {})
    const local = await bridge(['--terminal', terminal, '--new-session'])
    const native = 'native-session'
    await report(terminal, {
      hook_event_name: 'UserPromptSubmit',
      session_id: native,
      cwd: root,
      model: 'deepseek'
    })
    await report(terminal, {
      hook_event_name: 'PreToolUse',
      session_id: 'concurrent-session',
      cwd: root
    })
    const command = `'${integrations.bridge}' --terminal ${terminal} --session '${local}' --path '${root}' --action enter`
    // pre 先登记绑定，因此随后执行的 skill 请求也不会短暂创建第二个头像。
    await report(terminal, {
      hook_event_name: 'PreToolUse',
      session_id: native,
      cwd: root,
      tool_input: { command }
    })
    for (const directory of [root, secondPath])
      await bridge([
        '--terminal',
        terminal,
        '--session',
        local,
        '--path',
        directory,
        '--action',
        'enter',
        '--phase',
        'waiting'
      ])
    await report(terminal, {
      hook_event_name: 'PostToolUse',
      session_id: native,
      cwd: root,
      tool_input: { command }
    })
    expect(store.sessions(first.id)).toHaveLength(2)
    expect(store.sessions(first.id).find((s) => s.sessionId === native)).toMatchObject({
      phase: 'waiting',
      model: 'deepseek'
    })
    expect(store.sessions(second.id)).toMatchObject([{ sessionId: native, phase: 'waiting' }])
    await report(terminal, { hook_event_name: 'Stop', session_id: native, cwd: root })
    expect(store.sessions(second.id)).toHaveLength(1)
    await report(terminal, {
      hook_event_name: 'PreToolUse',
      session_id: native,
      cwd: root,
      tool_input: { path: root }
    })
    expect(store.sessions(second.id)[0].phase).toBe('executing')
    await report(terminal, { hook_event_name: 'Stop', session_id: native, cwd: root })
    // 迟到的通知工具 PostToolUse 只确认身份，不能复活已结束的会话。
    await report(terminal, {
      hook_event_name: 'PostToolUse',
      session_id: native,
      cwd: root,
      tool_input: { command }
    })
    expect(store.sessions(first.id)).toMatchObject([{ sessionId: 'concurrent-session' }])
    expect(store.sessions(second.id)).toHaveLength(0)
  }
)

it('旧临时记录由 PostToolUse 迁移，保留等待和租约，不绑定其他终端或真实会话 ID', async () => {
  const folder = store.addFolder(root)
  integrations.prepareBridge()
  server = await startServer(store, path.join(data, 'runtime.json'), () => {})
  store.activity({
    path: root,
    terminal: 'qoder',
    sessionId: 'local-old',
    action: 'enter',
    phase: 'waiting'
  })
  const previous = store.sessions(folder.id)[0].lastSeen
  await report('qoder', {
    hook_event_name: 'PostToolUse',
    session_id: 'native',
    cwd: root,
    toolInput: {
      command: `'${integrations.bridge}' --terminal=qoder --session=local-old --phase waiting`
    }
  })
  expect(store.sessions(folder.id)).toMatchObject([
    { sessionId: 'native', phase: 'waiting', lastSeen: previous }
  ])
  for (const command of [
    `'${integrations.bridge}' --terminal codex --session local-unrelated`,
    `'${integrations.bridge}' --terminal qoder --session real-unrelated`,
    '/another/report --terminal qoder --session local-unrelated'
  ]) {
    await report('qoder', {
      hook_event_name: 'PostToolUse',
      session_id: 'native',
      cwd: root,
      tool_input: { command }
    })
  }
  expect(store.db.prepare('SELECT alias FROM session_aliases').all()).toEqual([
    { alias: 'local-old' }
  ])
})

it.each([
  ['workbuddy', 'WORKBUDDY_SESSION_ID'],
  ['workbuddy', 'CODEBUDDY_SESSION_ID'],
  ['claude', 'CLAUDE_SESSION_ID'],
  ['grok', 'GROK_SESSION_ID'],
  ['qoder', 'QODER_SESSION_ID']
] as const)('%s 识别 %s 原生身份，环境明确时不被父 Codex 误归属', async (terminal, key) => {
  const folder = store.addFolder(root)
  integrations.prepareBridge()
  server = await startServer(store, path.join(data, 'runtime.json'), () => {})
  const env = { [key]: 'real-host', CODEX_THREAD_ID: 'parent-codex' }
  expect(await bridge(['--terminal', terminal, '--new-session'], {}, env)).toBe('real-host')
  await bridge(
    ['--terminal', terminal, '--session', 'local-old', '--path', root, '--action', 'enter'],
    {},
    env
  )
  await report(terminal, { hook_event_name: 'PreToolUse', session_id: 'real-host', cwd: root }, env)
  expect(store.sessions(folder.id)).toMatchObject([{ terminal, sessionId: 'real-host' }])
  expect(store.sessions(folder.id)).toHaveLength(1)
  await report(terminal, { hook_event_name: 'Stop', session_id: 'real-host', cwd: root }, env)
  expect(store.sessions(folder.id)).toHaveLength(0)
})

it('没有会话身份时不按共享宿主进程猜测，避免串联桌面端多个任务', async () => {
  const folder = store.addFolder(root)
  integrations.prepareBridge()
  server = await startServer(store, path.join(data, 'runtime.json'), () => {})
  await bridge(['--terminal', 'qoder', '--path', root, '--action', 'enter'])
  await report('qoder', { hook_event_name: 'PreToolUse', cwd: root })
  expect(store.sessions(folder.id)).toHaveLength(0)
})

it.each(['workbuddy', 'claude', 'grok', 'qoder'] as const)(
  '%s 的原生 hook 不会因继承父 Codex 变量而被跳过或误报',
  async (terminal) => {
    const folder = store.addFolder(root)
    integrations.prepareBridge()
    server = await startServer(store, path.join(data, 'runtime.json'), () => {})
    await report(
      terminal,
      { hook_event_name: 'PreToolUse', session_id: 'child', cwd: root },
      { CODEX_THREAD_ID: 'parent' }
    )
    expect(store.sessions(folder.id)).toMatchObject([{ terminal, sessionId: 'child' }])
  }
)
it('上报命令自己的 PostToolUse 不会清除主动上报的问题待确认状态', async () => {
  const folder = store.addFolder(root)
  integrations.prepareBridge()
  server = await startServer(store, path.join(data, 'runtime.json'), () => {})
  store.activity({
    path: root,
    terminal: 'codex',
    sessionId: 'one',
    action: 'enter',
    phase: 'waiting'
  })
  await report('codex', {
    hook_event_name: 'PostToolUse',
    session_id: 'one',
    cwd: root,
    tool_name: 'exec_command',
    tool_input: {
      cmd: `'${integrations.bridge}' --terminal codex --path '${root}' --phase waiting`
    }
  })
  expect(store.sessions(folder.id)[0].phase).toBe('waiting')
  await report('codex', {
    hook_event_name: 'PostToolUse',
    session_id: 'one',
    cwd: root,
    tool_name: 'Read',
    tool_input: { path: root }
  })
  expect(store.sessions(folder.id)[0].phase).toBe('executing')
})
it('Qoder 安装夹具可安装并卸载全局规则、skill 与文档支持的 hook，等待真实验证', () => {
  binary('qodercli')
  integrations.install('qoder')
  expect(text('.qoder/skills/ebisu-qoder/SKILL.md')).toContain('name: ebisu-qoder')
  expect(integrations.views().find((view) => view.id === 'qoder')?.health).toBe('restart')
  expect(JSON.parse(text('.qoder/settings.json')).hooks.PermissionRequest).toHaveLength(1)
  integrations.uninstall('qoder')
  expect(text('.qoder/AGENTS.md').trim()).toBe('')
})
