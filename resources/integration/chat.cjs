#!/usr/bin/env node
/* Ebisu Agent 对话客户端：只连接本机已认证服务，token 不出现在输出中。
 * 处理状态全部记录在对话里（claim / progress / 回复消息的 replyTo），各设备界面可见，
 * 不依赖客户端本地状态，定时任务每次新开会话也能接续。
 */
'use strict'
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')

const PROTOCOL = `Ebisu chat protocol v1
Usage: chat --terminal <terminal> <command> [options]     (输出单行 JSON；失败时 ok:false 且退出码非零)
  protocol
  whoami                                   本终端参与者名称（短主机名/终端），--member 可覆盖
  devices                                  本机与已配对设备
  channels                                 频道摘要
  create  --channel <id> [--title t] [--devices a,b]      创建/合并频道（设备可写名称）
  send    --channel <id> --to <member> [--type task] (--body t | --body-file <file|->)
                                           发起一条定向消息（派单、审核意见等）
  inbox   [--stale-minutes 240]            待本参与者处理的消息：发给我、我尚未回复、且没有未过期的认领
  claim   --channel <id> --id <messageId> [--session <sessionId>]
                                           认领一条消息并绑定处理会话；返回 won=false 表示已被本参与者的其他会话抢先认领
  progress --channel <id> --id <messageId> (--body t | --body-file -)   处理中进展，同时刷新认领
  reply   --channel <id> --id <messageId> [--type result] (--body t | --body-file -)
                                           回复原发送者并标记该消息已处理
  done    --channel <id> --id <messageId> [--body t]                   不回复对方，仅标记已处理
  history --channel <id> [--limit 200]     频道历史
  binding --channel <id>                   本参与者在该频道最近绑定的会话
认领、进展和完成标记都通过 replyTo 指向原消息；inbox 只依据对话内容计算，可在任意会话重复调用。
`
/** 只作为状态标记、不需要对方处理的消息类型。 */
const MARKERS = new Set(['claim', 'progress', 'done'])

function args(argv) {
  const result = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) {
      result._.push(argv[i])
      continue
    }
    const [key, inline] = argv[i].slice(2).split('=', 2)
    result[key] = inline ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true)
  }
  return result
}
function fail(reason, extra) {
  const error = new Error(reason)
  error.extra = extra
  throw error
}
function need(options, key) {
  if (typeof options[key] !== 'string' || !options[key]) fail(`missing --${key}`)
  return options[key]
}
function body(options, required = true) {
  let text = ''
  if (options['body-file'] === '-' || options.body === '-') text = fs.readFileSync(0, 'utf8')
  else if (typeof options['body-file'] === 'string')
    text = fs.readFileSync(options['body-file'], 'utf8')
  else if (typeof options.body === 'string') text = options.body
  if (required && !text.trim()) fail('missing --body or --body-file')
  return text
}
/**
 * 参与者名称默认取 Ebisu 设备名（配对时双方看到的稳定名称），而不是 os.hostname()：
 * macOS 的 hostname 会随网络变化（如 xxx-45），身份漂移会导致收不到发给自己的消息。
 */
async function member(options, runtime) {
  if (typeof options.member === 'string') return options.member
  let host = os.hostname()
  try {
    const self = (await api(runtime, 'GET', '/v1/chat/devices')).devices.find((d) => d.self)
    if (self?.name) host = self.name
  } catch {
    /* 服务不可用时由后续请求报告错误 */
  }
  return `${host.replace(/\.local$/, '')}/${options.terminal || 'agent'}`.replace(
    /[^A-Za-z0-9._@/:-]/g,
    '-'
  )
}
function api(runtime, method, route, data) {
  return new Promise((resolve, reject) => {
    const payload = data === undefined ? undefined : JSON.stringify(data)
    const req = http.request(
      {
        host: '127.0.0.1',
        port: runtime.port,
        path: route,
        method,
        headers: {
          Authorization: `Bearer ${runtime.token}`,
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
        },
        timeout: 15000
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          let parsed
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            return reject(new Error(`http-${response.statusCode}`))
          }
          if (response.statusCode !== 200)
            return reject(
              Object.assign(new Error(parsed.error || `http-${response.statusCode}`), {
                extra: parsed.details
              })
            )
          resolve(parsed)
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', (error) =>
      reject(error.code === 'ECONNREFUSED' ? new Error('ebisu-not-running') : error)
    )
    req.end(payload)
  })
}
const history = async (runtime, channel, limit = 2000) =>
  (
    await api(
      runtime,
      'GET',
      `/v1/chat/messages?${new URLSearchParams({ channel, limit: String(limit) })}`
    )
  ).messages
const post = (runtime, message) => api(runtime, 'POST', '/v1/chat/messages', message)

/** 本参与者针对某条消息的状态：已处理、有效认领（含绑定会话）或未处理。 */
function stateOf(messages, me, id, staleMs, now) {
  const mine = messages.filter((m) => m.from === me && m.replyTo === id)
  if (mine.some((m) => !MARKERS.has(m.type) || m.type === 'done')) return { handled: true }
  const claims = mine.filter((m) => m.type === 'claim')
  if (!claims.length) return { handled: false, claim: null }
  // 同一参与者的多个会话可能并发认领：本机写入顺序（seq）最早的认领胜出。
  const winner = claims.reduce((a, b) => (a.seq < b.seq ? a : b))
  const lastTouch = Math.max(...mine.map((m) => m.createdAt))
  return {
    handled: false,
    claim: { messageId: winner.id, session: parseSession(winner), at: lastTouch },
    stale: now - lastTouch > staleMs
  }
}
function parseSession(message) {
  try {
    return JSON.parse(message.body).session ?? null
  } catch {
    return null
  }
}
/** 频道内本参与者最近一次认领绑定的会话。 */
function bindingOf(messages, me) {
  // 每条原消息只算胜出的（seq 最早的）认领，竞争失败的会话不能成为绑定会话。
  const winners = new Map()
  for (const m of messages)
    if (m.from === me && m.type === 'claim' && parseSession(m)) {
      const current = winners.get(m.replyTo)
      if (!current || m.seq < current.seq) winners.set(m.replyTo, m)
    }
  const latest = [...winners.values()].sort((a, b) => b.seq - a.seq)[0]
  return latest ? { session: parseSession(latest), since: latest.createdAt } : null
}

async function main() {
  const argv = process.argv.slice(2)
  const options = args(argv)
  const command = options._[0]
  if (command === 'protocol' || !command) {
    process.stdout.write(PROTOCOL)
    return
  }
  const runtime = JSON.parse(fs.readFileSync(String(options.runtime), 'utf8'))
  const me = await member(options, runtime)
  let result
  switch (command) {
    case 'whoami':
      result = { ok: true, member: me }
      break
    case 'devices':
      result = await api(runtime, 'GET', '/v1/chat/devices')
      break
    case 'channels':
      result = await api(runtime, 'GET', '/v1/chat/channels')
      break
    case 'create':
      result = await api(runtime, 'POST', '/v1/chat/channels', {
        id: need(options, 'channel'),
        ...(typeof options.title === 'string' ? { title: options.title } : {}),
        ...(typeof options.devices === 'string'
          ? {
              devices: options.devices
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            }
          : {}),
        members: [me]
      })
      break
    case 'send':
      result = await post(runtime, {
        channel: need(options, 'channel'),
        from: me,
        to: need(options, 'to'),
        type: typeof options.type === 'string' ? options.type : 'task',
        body: body(options)
      })
      break
    case 'inbox': {
      const staleMs = Number(options['stale-minutes'] ?? 240) * 60000
      const now = Date.now()
      const { channels } = await api(runtime, 'GET', '/v1/chat/channels')
      const tasks = []
      const inProgress = []
      for (const channel of channels.filter((c) => c.members.includes(me))) {
        const messages = await history(runtime, channel.id)
        const binding = bindingOf(messages, me)
        for (const message of messages) {
          if (message.to !== me || message.from === me || MARKERS.has(message.type)) continue
          const state = stateOf(messages, me, message.id, staleMs, now)
          if (state.handled) continue
          const item = {
            channel: channel.id,
            title: channel.title,
            id: message.id,
            from: message.from,
            type: message.type,
            body: message.body,
            createdAt: message.createdAt,
            binding
          }
          if (state.claim && !state.stale) inProgress.push({ ...item, claim: state.claim })
          else tasks.push(state.claim ? { ...item, staleClaim: state.claim } : item)
        }
      }
      result = { ok: true, member: me, tasks, inProgress }
      break
    }
    case 'claim': {
      const channel = need(options, 'channel')
      const id = need(options, 'id')
      const session = typeof options.session === 'string' ? options.session : null
      const sent = await post(runtime, {
        channel,
        from: me,
        type: 'claim',
        replyTo: id,
        body: JSON.stringify({ session })
      })
      const messages = await history(runtime, channel)
      const state = stateOf(messages, me, id, Infinity, Date.now())
      const won = !!state.claim && state.claim.messageId === sent.message.id
      result = { ok: true, won, claim: state.claim, handled: state.handled }
      break
    }
    case 'progress':
      result = await post(runtime, {
        channel: need(options, 'channel'),
        from: me,
        type: 'progress',
        replyTo: need(options, 'id'),
        body: body(options)
      })
      break
    case 'reply':
    case 'done': {
      const channel = need(options, 'channel')
      const id = need(options, 'id')
      const original = (await history(runtime, channel)).find((m) => m.id === id)
      if (!original) fail('message not found')
      result = await post(runtime, {
        channel,
        from: me,
        ...(command === 'reply' ? { to: original.from } : {}),
        type:
          command === 'reply'
            ? typeof options.type === 'string'
              ? options.type
              : 'result'
            : 'done',
        replyTo: id,
        body: command === 'reply' ? body(options) : body(options, false) || '已处理'
      })
      break
    }
    case 'history':
      result = {
        ok: true,
        messages: await history(runtime, need(options, 'channel'), Number(options.limit ?? 200))
      }
      break
    case 'binding':
      result = {
        ok: true,
        binding: bindingOf(await history(runtime, need(options, 'channel')), me)
      }
      break
    default:
      fail(`unknown command: ${command}`)
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (require.main === module)
  main().catch((error) => {
    process.stdout.write(
      `${JSON.stringify({ ok: false, reason: error.message, ...(error.extra ? { details: error.extra } : {}) })}\n`
    )
    process.exitCode = 1
  })
module.exports = { stateOf, bindingOf }
