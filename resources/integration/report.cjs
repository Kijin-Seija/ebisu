#!/usr/bin/env node
/* Ebisu 通知桥：无第三方依赖，可在 Electron 的 Node 模式下运行。
 * 无论服务是否在线都以 0 退出，绝不能阻断宿主任务；--check 才输出诊断结果。
 * 手动调用返回 {"ok":...} 结论，原生 hook 调用保持 stdout 为空。
 */
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { homedir } = require('node:os')
const { performance } = require('node:perf_hooks')

/**
 * 手动上报必须给出确定结论：空输出会被模型误读成任务失败并中止。
 * hook 模式反过来必须保持 stdout 为空，否则会干扰宿主对 hook JSON 结果的解析。
 */
function manualStatus(args, ok, reason) {
  if (args.hook || args.check || args['new-session']) return
  process.stdout.write(ok ? '{"ok":true}\n' : `{"ok":false,"reason":"${reason}"}\n`)
}

/** 参数不经 eval 或 shell 展开，路径中的引号与命令替换只作为普通数据。 */
function argumentsMap(argv) {
  const result = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const [key, inline] = argv[i].slice(2).split('=', 2)
    result[key] = inline ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true)
  }
  return result
}

/** 原生事件优先，防止 Grok 的 Claude 兼容扫描把同一事件错报为两个终端。 */
function actualTerminal(configured) {
  // 子终端可能继承父终端的变量；自身身份明确时不能被父宿主抢占。
  if (environmentSession(configured)) return configured
  // 仅处理已确认的 Grok → Claude 兼容扫描。其他父宿主环境不能改写适配器身份。
  if (configured === 'claude' && (process.env.GROK_SESSION_ID || process.env.GROK_HOOK_EVENT))
    return 'grok'
  return configured
}

/** 只读取当前宿主的身份变量，不把父终端的 ID 误用于其他 agent。 */
function environmentSession(terminal) {
  switch (terminal) {
    case 'codex':
      return process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID
    case 'grok':
      return process.env.GROK_SESSION_ID
    // Qoder CN 与 Qoder 由同一代码基底提供 QODER_SESSION_ID，用户目录不同但身份变量一致。
    case 'qoder':
    case 'qodercn':
      return process.env.QODER_SESSION_ID
    case 'workbuddy':
      return process.env.WORKBUDDY_SESSION_ID || process.env.CODEBUDDY_SESSION_ID
    case 'claude':
      return process.env.CLAUDE_SESSION_ID
    case 'dsh':
      return process.env.DSH_SESSION_ID
    default:
      return undefined
  }
}

/** hook 的事件 ID 最权威；显式真实 ID 支持子会话，临时 ID 则必须让位于宿主真实 ID。 */
function sessionIdentity(args, input, terminal) {
  const explicit = typeof args.session === 'string' ? args.session : undefined
  const sessionId =
    input.session_id ||
    input.sessionId ||
    (explicit && !explicit.startsWith('local-') ? explicit : undefined) ||
    environmentSession(terminal) ||
    explicit
  // 仅在一次调用同时提供两种身份时声明别名，不按目录、时间或终端猜测会话关系。
  const sessionAliases =
    explicit?.startsWith('local-') && !sessionId.startsWith('local-') && explicit !== sessionId
      ? [explicit]
      : undefined
  return { sessionId, sessionAliases }
}

/**
 * 从通知工具调用中读取临时身份，不执行或展开 shell/JS。
 * hook 自带的真实 ID 与该工具调用处于同一会话，这是绑定依据；不使用项目或时间推断。
 * 只接受当前桥接路径、当前终端和完整 local- 参数，其他命令/真实 ID 不参与迁移。
 */
function reportingAliases(toolInput, bridges, terminal) {
  const aliases = new Set()
  for (const value of Object.values(toolInput)) {
    if (typeof value !== 'string') continue
    for (const bridge of bridges) {
      const spellings = [bridge, bridge.replaceAll("'", "'\\''")]
      for (const spelling of spellings) {
        let offset = 0
        while ((offset = value.indexOf(spelling, offset)) !== -1) {
          const tail = value.slice(offset + spelling.length).split(/[\n;&|]/, 1)[0]
          offset += spelling.length
          const host = tail.match(/--terminal(?:=|\s+)["']?([a-z]+)(?=["'\s,)}]|$)/)?.[1]
          if (host !== terminal) continue
          for (const match of tail.matchAll(
            /--session(?:=|\s+)["']?(local-[\w-]{1,506})(?=["'\s,)}]|$)/g
          ))
            aliases.add(match[1])
        }
      }
    }
  }
  return [...aliases].slice(0, 8)
}

/** 保留旧版模块导出供诊断工具使用；活动上报路径不会再自动调用它。 */
function fallbackSession(terminal) {
  return `local-${crypto
    .createHash('sha256')
    .update(`${terminal}:${process.ppid}`)
    .digest('hex')
    .slice(0, 20)}`
}

/** hook stdin 有体积与等待上限，错误输入不能拖住 agent。 */
function hookInput() {
  return new Promise((resolve) => {
    let text = ''
    let finished = false
    const done = () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      process.stdin.pause()
      try {
        resolve(JSON.parse(text || '{}'))
      } catch {
        resolve({})
      }
    }
    const timer = setTimeout(done, 250)
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      text += chunk
      if (text.length > 32768) done()
    })
    process.stdin.on('end', done)
    process.stdin.on('error', done)
  })
}

function request(runtime, method, route, data) {
  return new Promise((resolve) => {
    const body = data ? JSON.stringify(data) : undefined
    const req = http.request(
      {
        host: '127.0.0.1',
        port: runtime.port,
        path: route,
        method,
        headers: {
          Authorization: `Bearer ${runtime.token}`,
          'Content-Type': 'application/json',
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {})
        },
        timeout: 700
      },
      (response) => {
        let output = ''
        response.on('data', (chunk) => {
          if (output.length < 8192) output += chunk
        })
        response.on('end', () => resolve(response.statusCode === 200 ? output : ''))
        response.on('error', () => resolve(''))
      }
    )
    req.on('timeout', () => {
      req.destroy()
      resolve('')
    })
    req.on('error', () => resolve(''))
    req.end(body)
  })
}

/**
 * DSH 没有原生 hook，只能由模型主动调用上报命令；模型与标题从 DSH 会话投影缓存读取。
 * 只读取 modelSelection 与 title 两个元数据字段，不读对话正文；显式参数仍然优先，
 * 缓存缺失、格式变化或读取受限时静默省略，不影响活动上报。
 */
function dshSessionFacts(sessionId) {
  // 会话 ID 直接拼接为文件名，必须先拒绝路径分隔符与空值。
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return {}
  try {
    const home = process.env.DSH_HOME || path.join(homedir(), '.dsh')
    const file = path.join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'))?.record?.rows
    const selection = rows?.modelSelection?.val
    const model = selection?.lastUsed?.model ?? selection?.pending?.model
    const title = rows?.title?.val
    return {
      model: typeof model === 'string' && model.trim() ? model.trim().slice(0, 128) : undefined,
      taskTitle: typeof title === 'string' && title.trim() ? title.trim().slice(0, 512) : undefined
    }
  } catch {
    return {}
  }
}

/** 将文件参数转换为所在目录；新文件逐级回溯到已存在的父目录。 */
function directoryFor(input, cwd) {
  let candidate = path.resolve(cwd, input)
  while (candidate !== path.dirname(candidate)) {
    try {
      return fs.statSync(candidate).isDirectory() ? candidate : path.dirname(candidate)
    } catch {
      candidate = path.dirname(candidate)
    }
  }
  return candidate
}

async function main() {
  const args = argumentsMap(process.argv.slice(2))
  const terminal = actualTerminal(args.terminal)
  if (args['new-session']) {
    // 老规则会主动调用此参数。即使 agent 不知道环境变量，也不能再生成第二个身份。
    process.stdout.write(`${environmentSession(terminal) || `local-${crypto.randomUUID()}`}\n`)
    return
  }
  let runtime
  try {
    runtime = JSON.parse(fs.readFileSync(String(args.runtime), 'utf8'))
  } catch {
    // 服务发现文件缺失或损坏只说明 Ebisu 没在运行，不是任务失败。
    manualStatus(args, false, 'ebisu-not-running')
    return
  }
  if (
    !Number.isInteger(runtime.port) ||
    runtime.port < 1 ||
    runtime.port > 65535 ||
    typeof runtime.token !== 'string'
  ) {
    manualStatus(args, false, 'ebisu-not-running')
    return
  }
  if (args.check) {
    const output = await request(runtime, 'GET', '/v1/health')
    process.stdout.write(output || '{"ok":false}')
    return
  }
  // 不执行从其他宿主兼容加载的副本，原生适配器会处理同一事件。
  if (args.hook && terminal !== args.terminal) return
  const input = args.hook ? await hookInput() : {}
  const rawEvent =
    input.hook_event_name || input.hookEventName || input.event || process.env.GROK_HOOK_EVENT || ''
  const event = rawEvent.replace(/[_-]/g, '').toLowerCase()
  if (
    args.hook &&
    ![
      'userpromptsubmit',
      'pretooluse',
      'posttooluse',
      'posttoolusefailure',
      'permissionrequest',
      'notification',
      'stop',
      'sessionend',
      'interrupt',
      'stopcancelled',
      'stopfailure',
      'elicitation',
      'elicitationresult'
    ].includes(event)
  )
    return
  const { sessionId, sessionAliases } = sessionIdentity(args, input, terminal)
  // 缺少身份时不再以桌面进程生成共享 ID。先 --new-session 再显式复用返回值。
  if (!sessionId) {
    manualStatus(args, false, 'missing-session-id')
    return
  }
  const toolInput = input.tool_input || input.toolInput || {}
  // Node 可能把 /var 解析为 /private/var；同时接受安装命令使用的原始路径。
  const ownBridges = [
    __filename.replace(/\.cjs$/, ''),
    path.join(path.dirname(String(args.runtime)), 'integration', 'report')
  ]
  const isOwnCommand = (value) =>
    typeof value === 'string' &&
    ownBridges.some(
      (bridge) => value.includes(bridge) || value.includes(`'${bridge.replaceAll("'", "'\\''")}'`)
    )
  // 主动通知也是一次 agent 工具调用；其 PostToolUse 不能覆盖刚上报的 waiting/error/exit。
  // 包括 Bash command 和 Codex 编排工具的 code 字段，只检查实际字符串参数。
  if (
    args.hook &&
    ['pretooluse', 'posttooluse', 'posttoolusefailure'].includes(event) &&
    Object.values(toolInput).some(isOwnCommand)
  ) {
    const aliases = reportingAliases(toolInput, ownBridges, terminal)
    if (!sessionId.startsWith('local-') && aliases.length)
      await request(runtime, 'POST', '/v1/identity', {
        terminal,
        sessionId,
        sessionAliases: aliases
      })
    return
  }
  const cwd = String(
    args.path ||
      input.cwd ||
      input.workspaceRoot ||
      process.env.GROK_WORKSPACE_ROOT ||
      process.cwd()
  )
  let action = args.action || 'enter'
  let phase = args.phase || 'executing'
  let scope = args.scope || 'folder'
  let preserveWaiting = false
  // 旧规则可能把任务阻塞当成 error；没有宿主接口错误原文的手动故障通知不采纳。
  // 不扫描最终回答、工具输出或任务结果中的“失败/阻塞”等词语来推断执行故障。
  if (
    !args.hook &&
    action === 'enter' &&
    phase === 'error' &&
    (typeof args['model-error'] !== 'string' || !args['model-error'].trim())
  ) {
    manualStatus(args, false, 'error-report-needs-model-error')
    return
  }
  if (args.hook) {
    if (event === 'sessionstart') return
    if (event === 'stopfailure') {
      // StopFailure 是宿主报告的接口失败事件，任务结果由普通 Stop 结束。
      phase = 'error'
      scope = 'session'
    } else if (['stop', 'sessionend', 'interrupt', 'stopcancelled'].includes(event)) {
      action = 'exit'
      scope = 'session'
      preserveWaiting = event === 'stop'
    } else if (event === 'permissionrequest' || event === 'elicitation') {
      phase = 'waiting'
      scope = 'session'
    } else if (event === 'notification') {
      const kind = input.notification_type || input.notificationType || ''
      if (!['permission_prompt', 'elicitation_dialog', 'agent_needs_input'].includes(kind)) return
      phase = 'waiting'
      scope = 'session'
    } else {
      phase =
        /ask.?user|request.?user.?input|question|elicitation/i.test(
          String(input.tool_name || input.toolName || '')
        ) && event === 'pretooluse'
          ? 'waiting'
          : 'executing'
      scope = 'session'
    }
  }
  const paths = new Set([directoryFor(cwd, process.cwd())])
  if (args.hook && action === 'enter') {
    for (const key of ['file_path', 'filePath', 'path', 'target_file', 'workdir', 'cwd']) {
      if (typeof toolInput[key] === 'string' && toolInput[key])
        paths.add(directoryFor(toolInput[key], cwd))
    }
  }
  // 微秒序号在启动进程之间可比较；不参与服务端超时计算。
  const sequence = Math.floor(performance.timeOrigin * 1000)
  // DSH 的手动上报无法像原生 hook 一样携带模型；用会话投影补全，显式参数仍优先。
  const dshFacts = terminal === 'dsh' ? dshSessionFacts(sessionId) : {}
  const rawModel = args.model || input.model || dshFacts.model
  // 只接受宿主明确提供的标题字段；title/prompt/tool_input.title 不能代表会话自动标题。
  const rawTitle =
    args['task-title'] ||
    input.task_title ||
    input.taskTitle ||
    input.session_title ||
    input.sessionTitle ||
    dshFacts.taskTitle
  const taskTitle =
    typeof rawTitle === 'string' ? rawTitle.trim().slice(0, 512) || undefined : undefined
  let index = 0
  // 只要有一个目录写入成功就算上报成功；全部失败等价于 Ebisu 没在运行。
  let delivered = false
  for (const folder of paths) {
    if (
      await request(runtime, 'POST', '/v1/activity', {
        path: folder,
        terminal,
        sessionId,
        sessionAliases,
        action,
        phase,
        scope,
        preserveWaiting,
        sequence: sequence + index++,
        model: typeof rawModel === 'string' ? rawModel : undefined,
        taskTitle
      })
    )
      delivered = true
  }
  manualStatus(args, delivered, 'ebisu-not-running')
}

if (require.main === module)
  main().catch(() => {
    // 任何意外都不能变成非零退出，否则绑定终端会把上报失败当成任务中止。
    if (process.argv.includes('--check')) process.stdout.write('{"ok":false}')
    else manualStatus(argumentsMap(process.argv.slice(2)), false, 'ebisu-not-running')
  })
module.exports = {
  argumentsMap,
  actualTerminal,
  directoryFor,
  fallbackSession,
  sessionIdentity,
  reportingAliases
}
