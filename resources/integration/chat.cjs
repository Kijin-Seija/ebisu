#!/usr/bin/env node
/* Ebisu Agent 对话客户端：只连接本机已认证服务，token 不出现在输出中。
 * 处理状态全部记录在对话里（claim / progress / 回复消息的 replyTo），各设备界面可见，
 * 不依赖客户端本地状态，定时任务每次新开会话也能接续。
 */
'use strict'
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const PROTOCOL = `Ebisu chat protocol v1
Usage: chat --terminal <terminal> <command> [options]     (输出单行 JSON；失败时 ok:false 且退出码非零)
  protocol
  whoami                                   本终端参与者名称（短主机名/终端），--member 可覆盖
  devices                                  本机与已配对设备 {id,name,self,online,metrics}
  metrics [--device <名称或ID>]            只看负载：{devices:[{id,name,self,online,metrics}]}，--device 过滤单台设备
  channels                                 频道摘要
  create  --channel <id> [--title t] [--devices a,b]      创建/合并频道（设备可写名称）
  send    --channel <id> --to <member> [--type task] (--body t | --body-file <file|->) [--image <png|jpg|gif|webp>]...
                                           发起一条定向消息（派单、审核意见等）
  inbox   [--stale-minutes 240]            待本参与者处理的消息：发给我、我尚未回复、且没有未过期的认领
  wait    [--timeout-seconds N] [--new-only] 阻塞到 inbox 的 tasks 非空（--new-only：出现启动时没有的新消息 id）
                                           立即输出与 inbox 相同的单行 JSON 并退出 0；超时输出 {"ok":true,"timeout":true}；
                                           不传 --timeout-seconds 则一直等待
  watch                                    常驻：每出现一条新的待处理消息（按 id 去重，启动时已有的先各输出一次）输出一行
                                           {channel,id,from,type,createdAt,body(截断 200 字)}，不退出；
                                           与 Ebisu 断开时输出一行 ok:false 并以非零退出，调用方重新挂起即可
  claim   --channel <id> --id <messageId> [--session <sessionId>]
                                           认领一条消息并绑定处理会话；返回 won=false 表示已被本参与者的其他会话抢先认领
  progress --channel <id> --id <messageId> (--body t | --body-file -) [--image <file>]...
                                           处理中进展，同时刷新认领（不进入对方 inbox；需要对方决策时用 reply）
  reply   --channel <id> --id <messageId> [--type result] (--body t | --body-file -) [--image <file>]...
                                           回复原发送者并标记该消息已处理
  done    --channel <id> --id <messageId> [--body t]                   不回复对方，仅标记已处理
  history --channel <id> [--limit 200]     频道历史
  binding --channel <id>                   本参与者在该频道最近绑定的会话
  delete  --channel <id>                   删除频道及全部消息；本机与其他持有副本的设备都会删除
认领、进展和完成标记都通过 replyTo 指向原消息；inbox 只依据对话内容计算，可在任意会话重复调用。
wait / watch 只是“叫醒信号”，不认领、不回复、不推进任何游标；收到后仍按 inbox → claim → reply 处理。
  有变更时由 Ebisu 主进程立即推送（/v1/chat/changes 长轮询）；主进程为旧版本时自动改为每 1.5 秒查询一次本机 inbox。
  认领超时（--stale-minutes）属于时间触发，最迟 60 秒内被发现。
身份继承：progress / reply / done 未显式传 --member 时，若原消息发给本设备上的另一参与者且已被其认领，
  自动以该认领者身份发出（处理会话与轮询会话的 --terminal 不一致时也能回到同一参与者）；输出带 member 字段。
图片：--image 可重复，每条消息最多 4 张，仅 PNG/JPEG/GIF/WebP（按文件内容识别），单张不超过 4 MiB；
  只有图片时正文可省略。history / inbox 中的消息带 attachments[]：{hash,name,mime,size,path}，
  path 为本机图片绝对路径，可直接读取查看；对端图片尚未同步完成时 path 为 null 且 pending:true，稍后重试。
  图片随频道一起删除（delete、对端删除、8 小时闲置清理），需要长期保留的图片请另行保存。
负载 metrics（每台设备主进程每 30 秒采集，随设备同步传播；对端没有数据或为旧版本时为 null）：
  at                      采集时间（毫秒时间戳）；对端离线时保留最后一次数据，请按 at 判断是否过期
  cpu.cores / load1 / load5 / load15   逻辑核数与 1/5/15 分钟平均负载；load1 持续高于 cores 表示 CPU 饱和
  memory.totalGB          物理内存总量
  memory.freePct          可用内存百分比（macOS 同 memory_pressure 的 free percentage）；拿不到为 null
  memory.pressure         macOS 内存压力：normal / warn / critical；拿不到为 null
  memory.swapUsedMB       已用 swap（MB）；持续增长说明内存不足
  disk.path / freeGB / totalGB / usedPct   数据卷（/System/Volumes/Data 或 /）剩余与总量；读取失败时 disk 为 null
  procs                   重任务进程数 {prePush,pixel,vitest,devServer,tsc,eslint}；ps 失败为 null
  任一项采集失败只把该项置为 null；Ebisu 只采集与展示，不会清理、终止进程或限流。派单前优先选择
  pressure=normal、disk.freeGB 充足、load1/cores 较低的设备。
频道对话全部完成后（主控确认结果、无待处理消息）应执行 delete 删除该频道；删除后可用同名 create 重新创建。
每台设备每 8 小时自动删除最近 8 小时内没有新消息的频道，长期任务请定期 progress 保持活跃。
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
    const value = inline ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true)
    // --image 可重复出现，收集为数组；其余参数后出现的覆盖先出现的。
    if (key === 'image') (result.image ??= []).push(value)
    else result[key] = value
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
/** 与服务端一致的限制；服务端仍会按文件内容再次校验。 */
const MAX_IMAGES = 4
const MAX_IMAGE_BYTES = 4 * 1024 * 1024
/** 按文件头魔数识别图片类型，不信任扩展名。 */
function imageMime(data) {
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
    return 'image/jpeg'
  const head = data.subarray(0, 6).toString('latin1')
  if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif'
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('latin1') === 'RIFF' &&
    data.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp'
  return null
}
/** 读取 --image 指定的本地图片并逐张上传到频道，返回消息可引用的附件列表。 */
async function images(options, runtime, channel) {
  const files = options.image ?? []
  if (files.some((file) => typeof file !== 'string' || !file)) fail('missing --image path')
  if (files.length > MAX_IMAGES) fail(`too many images (max ${MAX_IMAGES})`)
  const attachments = []
  for (const file of files) {
    const data = fs.readFileSync(file)
    if (data.length > MAX_IMAGE_BYTES) fail(`image too large (max 4 MiB): ${file}`)
    const mime = imageMime(data)
    if (!mime) fail(`unsupported image (png/jpeg/gif/webp only): ${file}`)
    const { file: uploaded } = await api(runtime, 'POST', '/v1/chat/files', {
      channel,
      name: path.basename(file),
      mime,
      data: data.toString('base64')
    })
    attachments.push({ hash: uploaded.hash })
  }
  return attachments
}
/** 带图片的消息正文可省略，此时用占位文本满足非空正文要求。 */
function bodyWith(options, attachments) {
  const text = body(options, !attachments.length)
  return text.trim() ? text : '[图片]'
}
const withAttachments = (attachments) => (attachments.length ? { attachments } : {})
const withModel = (options) =>
  typeof options.model === 'string' && options.model.trim() ? { model: options.model.trim() } : {}

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
function api(runtime, method, route, data, timeoutMs = 15000) {
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
        timeout: timeoutMs
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          let parsed
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            return reject(
              Object.assign(new Error(`http-${response.statusCode}`), {
                status: response.statusCode
              })
            )
          }
          if (response.statusCode !== 200)
            return reject(
              Object.assign(new Error(parsed.error || `http-${response.statusCode}`), {
                extra: parsed.details,
                status: response.statusCode
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

/** 参与者名称的设备部分（`设备名/终端` 中 `/` 之前），用于判断是否同一台设备。 */
const deviceOf = (name) => String(name).split('/')[0]
/**
 * 处理会话回复时使用的参与者身份。
 * 轮询会话以 ME 认领后把任务派给处理会话；处理会话可能以不同的 --terminal（或缺省的 agent）运行，
 * 若直接用自身名称回复，结果会发自另一个参与者，对方的后续回复也会路由错。
 * 规则：显式 --member 优先；否则当原消息发给本设备上的另一参与者、且该参与者已认领这条消息时，沿用该参与者。
 * 其他设备的参与者或未被认领的消息不继承，避免冒用。
 */
function senderFor(messages, me, id, explicit) {
  if (explicit) return me
  const original = messages.find((m) => m.id === id)
  const owner = original?.to
  if (!owner || owner === me || deviceOf(owner) !== deviceOf(me)) return me
  const claimed = messages.some((m) => m.from === owner && m.type === 'claim' && m.replyTo === id)
  return claimed ? owner : me
}
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

const staleOf = (options) => Number(options['stale-minutes'] ?? 240) * 60000
/**
 * 计算参与者的待处理视图：tasks 为发给我、我尚未回复且没有未过期认领的消息；
 * inProgress 为已被我某个会话认领且认领未过期的消息。只读，不写入任何状态。
 */
async function inbox(runtime, me, staleMs) {
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
        ...(message.attachments ? { attachments: message.attachments } : {}),
        createdAt: message.createdAt,
        binding
      }
      if (state.claim && !state.stale) inProgress.push({ ...item, claim: state.claim })
      else tasks.push(state.claim ? { ...item, staleClaim: state.claim } : item)
    }
  }
  return { ok: true, member: me, tasks, inProgress }
}

/** 主进程没有变更事件时（旧版本），每隔多久重新计算一次本机 inbox。 */
const POLL_MS = 1500
/** 即使没有变更事件也定期重算，覆盖认领超时这类只随时间变化的状态。 */
const RECHECK_MS = 60000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/**
 * 对话变更信号。优先使用主进程 /v1/chat/changes 长轮询（有变更立即返回）；
 * 接口返回 404（主进程为旧版本）时退化为固定间隔，本地调用不消耗模型 token。
 * next(maxMs) 在“可能有变更”或 maxMs 到期时返回，调用方随后重算 inbox。
 */
function changeFeed(runtime, options) {
  let revision = -1
  let push = true
  const pollMs = Number(options['poll-ms'] ?? POLL_MS)
  return {
    async next(maxMs) {
      if (push) {
        try {
          const query = new URLSearchParams({
            after: String(revision),
            timeout: String(Math.max(0, maxMs) / 1000)
          })
          // HTTP 超时需长于服务端等待时间，留出余量。
          const result = await api(
            runtime,
            'GET',
            `/v1/chat/changes?${query}`,
            undefined,
            maxMs + 15000
          )
          revision = result.revision
          return
        } catch (error) {
          if (error.status !== 404) throw error
          push = false
          return
        }
      }
      await sleep(Math.max(0, Math.min(pollMs, maxMs)))
    }
  }
}

/** wait：tasks 非空（或 --new-only 时出现启动时没有的消息 id）即返回 inbox 结果，超时返回 timeout:true。 */
async function waitFor(runtime, me, options) {
  const staleMs = staleOf(options)
  const seconds = options['timeout-seconds']
  const deadline =
    seconds === undefined || seconds === true ? Infinity : Date.now() + Number(seconds) * 1000
  if (Number.isNaN(deadline)) fail('invalid --timeout-seconds')
  const feed = changeFeed(runtime, options)
  // 先取当前版本号，再计算 inbox：两者之间发生的变更会让下一次 next 立即返回，不会漏掉。
  await feed.next(0)
  let baseline = null
  for (;;) {
    const view = await inbox(runtime, me, staleMs)
    if (options['new-only']) {
      if (!baseline) baseline = new Set(view.tasks.map((t) => t.id))
      else if (view.tasks.some((t) => !baseline.has(t.id))) return view
    } else if (view.tasks.length) return view
    const remaining = deadline - Date.now()
    if (remaining <= 0) return { ok: true, timeout: true }
    await feed.next(Math.min(remaining, RECHECK_MS))
  }
}

/** 正文截断到 200 个字符（按 Unicode 码点，避免截断代理对）。 */
function brief(text, limit = 200) {
  const chars = Array.from(String(text ?? ''))
  return chars.length > limit ? `${chars.slice(0, limit).join('')}…` : chars.join('')
}

/** watch：常驻输出新的待处理消息，每条消息 id 只输出一次；出错时抛出由入口处理。 */
async function watch(runtime, me, options) {
  const staleMs = staleOf(options)
  const feed = changeFeed(runtime, options)
  const seen = new Set()
  await feed.next(0)
  for (;;) {
    const view = await inbox(runtime, me, staleMs)
    for (const task of view.tasks) {
      if (seen.has(task.id)) continue
      seen.add(task.id)
      const line = {
        channel: task.channel,
        id: task.id,
        from: task.from,
        type: task.type,
        createdAt: task.createdAt,
        body: brief(task.body)
      }
      process.stdout.write(`${JSON.stringify(line)}\n`)
    }
    await feed.next(RECHECK_MS)
  }
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
    case 'metrics':
      result = await api(
        runtime,
        'GET',
        `/v1/chat/metrics${typeof options.device === 'string' && options.device ? `?${new URLSearchParams({ device: options.device })}` : ''}`
      )
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
    case 'send': {
      const channel = need(options, 'channel')
      const to = need(options, 'to')
      const attachments = await images(options, runtime, channel)
      result = await post(runtime, {
        channel,
        from: me,
        to,
        type: typeof options.type === 'string' ? options.type : 'task',
        body: bodyWith(options, attachments),
        ...withModel(options),
        ...withAttachments(attachments)
      })
      break
    }
    case 'inbox':
      result = await inbox(runtime, me, staleOf(options))
      break
    case 'wait':
      result = await waitFor(runtime, me, options)
      break
    case 'watch':
      // watch 不会正常返回；断开或出错时抛出，由入口输出 ok:false 并以非零退出。
      await watch(runtime, me, options)
      return
    case 'claim': {
      const channel = need(options, 'channel')
      const id = need(options, 'id')
      const session = typeof options.session === 'string' ? options.session : null
      const sent = await post(runtime, {
        channel,
        from: me,
        type: 'claim',
        replyTo: id,
        body: JSON.stringify({ session }),
        ...withModel(options)
      })
      const messages = await history(runtime, channel)
      const state = stateOf(messages, me, id, Infinity, Date.now())
      const won = !!state.claim && state.claim.messageId === sent.message.id
      result = { ok: true, won, claim: state.claim, handled: state.handled }
      break
    }
    case 'progress': {
      const channel = need(options, 'channel')
      const id = need(options, 'id')
      const messages = await history(runtime, channel)
      if (!messages.some((m) => m.id === id)) fail('message not found')
      const from = senderFor(messages, me, id, typeof options.member === 'string')
      const attachments = await images(options, runtime, channel)
      result = await post(runtime, {
        channel,
        from,
        type: 'progress',
        replyTo: id,
        body: bodyWith(options, attachments),
        ...withModel(options),
        ...withAttachments(attachments)
      })
      result = { ...result, member: from }
      break
    }
    case 'reply':
    case 'done': {
      const channel = need(options, 'channel')
      const id = need(options, 'id')
      const messages = await history(runtime, channel)
      const original = messages.find((m) => m.id === id)
      if (!original) fail('message not found')
      const from = senderFor(messages, me, id, typeof options.member === 'string')
      // done 只是完成标记，不携带图片。
      const attachments = command === 'reply' ? await images(options, runtime, channel) : []
      result = await post(runtime, {
        channel,
        from,
        ...(command === 'reply' ? { to: original.from } : {}),
        type:
          command === 'reply'
            ? typeof options.type === 'string'
              ? options.type
              : 'result'
            : 'done',
        replyTo: id,
        body:
          command === 'reply' ? bodyWith(options, attachments) : body(options, false) || '已处理',
        ...withModel(options),
        ...withAttachments(attachments)
      })
      result = { ...result, member: from }
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
    case 'delete':
      result = await api(runtime, 'POST', '/v1/chat/channels/delete', {
        id: need(options, 'channel')
      })
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
module.exports = { stateOf, bindingOf, senderFor, brief }
