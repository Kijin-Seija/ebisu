import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { Store } from '../src/main/database'
import {
  Chat,
  CHAT_IDLE_MS,
  CHAT_TOMBSTONE_TTL_MS,
  MAX_CHAT_IMAGE_BYTES,
  type ChatPush
} from '../src/main/chat'
import { startServer } from '../src/main/server'

let root: string
let store: Store
let chat: Chat
const device = { id: randomUUID(), name: 'local-mac', protocol: 1 }
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'ebisu-chat-'))
  store = new Store(path.join(root, 'state.sqlite'))
  chat = new Chat(store, () => device)
})
afterEach(() => {
  chat.close()
  store.close()
  rmSync(root, { recursive: true, force: true })
})

it('频道创建幂等，消息计数连续，clientId 去重', () => {
  const first = chat.createChannel({ id: 'bug/STRATEGY-1', title: 'Bug 1', members: ['a/claude'] })
  const again = chat.createChannel({ id: 'bug/STRATEGY-1', members: ['b/qoder'] })
  expect(first.devices).toEqual([device.id])
  expect(again.members).toEqual(['a/claude', 'b/qoder'])
  expect(again.title).toBe('Bug 1')
  const one = chat.post({ channel: 'bug/STRATEGY-1', from: 'a/claude', body: 'hello' })
  const two = chat.post({ channel: 'bug/STRATEGY-1', from: 'b/qoder', body: 'hi', clientId: 'x' })
  const dup = chat.post({ channel: 'bug/STRATEGY-1', from: 'b/qoder', body: 'hi', clientId: 'x' })
  expect([one.counter, two.counter]).toEqual([1, 2])
  expect(dup.seq).toBe(two.seq)
  expect(chat.history('bug/STRATEGY-1').map((m) => m.body)).toEqual(['hello', 'hi'])
  expect(() => chat.post({ channel: 'missing', from: 'a/claude', body: 'x' })).toThrow('频道不存在')
  expect(() => chat.createChannel({ id: 'x', devices: ['unknown-host'] })).toThrow('未找到')
  // 本机名称解析忽略大小写与 .local 后缀
  expect(chat.createChannel({ id: 'y', devices: ['LOCAL-MAC.local'] }).devices).toEqual([device.id])
})

it('wait 立即返回未读、排除自己、按 to 过滤，并推进游标', async () => {
  chat.createChannel({ id: 'control', members: ['main', 'w1', 'w2'] })
  chat.post({ channel: 'control', from: 'main', to: 'w1', body: 'task for w1' })
  chat.post({ channel: 'control', from: 'main', to: 'w2', body: 'task for w2' })
  chat.post({ channel: 'control', from: 'w1', body: 'self' })
  const w1 = await chat.wait({ member: 'w1', channels: ['*'], timeout: 1 })
  expect(w1.map((m) => m.body)).toEqual(['task for w1'])
  expect(await chat.wait({ member: 'w1', channels: ['control'], timeout: 0 })).toEqual([])
  const all = await chat.wait({
    member: 'w3',
    channels: ['control'],
    timeout: 0,
    all: true,
    peek: true
  })
  expect(all).toHaveLength(3)
  // peek 不推进游标
  expect(
    await chat.wait({ member: 'w3', channels: ['control'], timeout: 0, all: true })
  ).toHaveLength(3)
  // 显式等待即加入频道
  expect(chat.channel('control')!.members).toContain('w3')
})

it('wait 阻塞直到新消息到达，超时返回空，中止立即返回', async () => {
  chat.createChannel({ id: 'c' })
  const started = Date.now()
  const pending = chat.wait({ member: 'w', channels: ['c'], timeout: 5 })
  setTimeout(() => chat.post({ channel: 'c', from: 'main', body: 'wake' }), 100)
  const messages = await pending
  expect(messages.map((m) => m.body)).toEqual(['wake'])
  expect(Date.now() - started).toBeLessThan(2000)
  const t0 = Date.now()
  expect(await chat.wait({ member: 'w', channels: ['c'], timeout: 0.2 })).toEqual([])
  expect(Date.now() - t0).toBeGreaterThanOrEqual(150)
  const controller = new AbortController()
  const aborted = chat.wait({
    member: 'w',
    channels: ['c'],
    timeout: 30,
    signal: controller.signal
  })
  setTimeout(() => controller.abort(), 50)
  expect(await aborted).toEqual([])
})

it('版本向量只计算连续部分，ingest 校验频道成员', () => {
  const peer = randomUUID()
  const other = randomUUID()
  chat.ingest(peer, {
    channels: [
      {
        id: 'shared',
        title: 'shared',
        devices: [peer, device.id],
        members: [],
        createdBy: peer,
        createdAt: 1,
        updatedAt: 1
      },
      // 不包含本机的频道不会被接收
      {
        id: 'foreign',
        title: 'foreign',
        devices: [peer, other],
        members: [],
        createdBy: peer,
        createdAt: 1,
        updatedAt: 1
      }
    ],
    messages: []
  })
  expect(chat.channel('foreign')).toBeNull()
  const wire = (counter: number, origin = peer) => ({
    channel: 'shared',
    origin,
    counter,
    from: 'peer/qoder',
    to: null,
    type: 'text',
    body: `m${counter}`,
    replyTo: null,
    clientId: null,
    createdAt: counter
  })
  // 来源设备不在频道内的消息被丢弃；1、3 到达而 2 缺失
  expect(chat.ingest(peer, { channels: [], messages: [wire(1), wire(3), wire(1, other)] })).toBe(2)
  expect(chat.syncRequest(peer)).toEqual({ channels: { shared: { [peer]: 1 } } })
  expect(chat.ingest(peer, { channels: [], messages: [wire(2), wire(3)] })).toBe(1)
  expect(chat.syncRequest(peer).channels.shared[peer]).toBe(3)
  const answer = chat.answerSync(peer, { channels: { shared: { [peer]: 1 } } })
  expect(answer.messages.map((m) => m.counter)).toEqual([2, 3])
  expect(answer.more).toBe(false)
  expect(chat.answerSync(other, { channels: {} }).channels).toEqual([])
})

it('本机 HTTP 接口与 report --chat 命令行', async () => {
  const runtimeFile = path.join(root, 'runtime.json')
  const server = await startServer(store, runtimeFile, () => {}, undefined, chat)
  try {
    const { port, token } = JSON.parse(readFileSync(runtimeFile, 'utf8'))
    const base = `http://127.0.0.1:${port}`
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    const unauthorized = await fetch(`${base}/v1/chat/channels`)
    expect(unauthorized.status).toBe(401)
    const created = await fetch(`${base}/v1/chat/channels`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'bug/STRATEGY-9', members: ['main'] })
    })
    expect(created.status).toBe(200)
    // 长轮询超过服务端 requestTimeout(3s) 仍能正常返回
    const waiting = fetch(`${base}/v1/chat/wait?member=w&channel=bug/STRATEGY-9&timeout=10`, {
      headers
    }).then((response) => response.json())
    await new Promise((resolve) => setTimeout(resolve, 3500))
    const posted = await fetch(`${base}/v1/chat/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ channel: 'bug/STRATEGY-9', from: 'main', body: '请修复' })
    })
    expect(posted.status).toBe(200)
    const woke = await waiting
    expect(woke.messages.map((m: { body: string }) => m.body)).toEqual(['请修复'])
    const bad = await fetch(`${base}/v1/chat/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ channel: 'bug/STRATEGY-9', from: 'bad name', body: 'x' })
    })
    expect(bad.status).toBe(400)

    // 命令行：stdin 正文、wait、history
    const cli = path.join(__dirname, '../resources/integration/report.cjs')
    const run = (args: string[], input?: string) =>
      new Promise<Record<string, any>>((resolve, reject) => {
        const child = spawn(process.execPath, [cli, '--runtime', runtimeFile, ...args], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
        })
        let out = ''
        child.stdout.on('data', (chunk) => (out += chunk))
        child.once('error', reject)
        child.once('close', (code) => {
          expect(code).toBe(0)
          resolve(JSON.parse(out))
        })
        child.stdin.end(input ?? '')
      })
    const body = '多行\n正文 $(rm -rf /) `x` "q"'
    const sent = await run(
      ['--chat', 'post', '--channel', 'bug/STRATEGY-9', '--member', 'w', '--body-file', '-'],
      body
    )
    expect(sent.message.body).toBe(body)
    const file = path.join(root, 'body.md')
    writeFileSync(file, 'from file')
    await run([
      '--chat',
      'post',
      '--channel',
      'bug/STRATEGY-9',
      '--member',
      'w',
      '--body-file',
      file
    ])
    const received = await run([
      '--chat',
      'wait',
      '--channel',
      'bug/STRATEGY-9',
      '--member',
      'main',
      '--timeout',
      '2'
    ])
    expect(received.messages.map((m: { body: string }) => m.body)).toEqual([body, 'from file'])
    const empty = await run(['--chat', 'wait', '--member', 'main', '--timeout', '0'])
    expect(empty).toMatchObject({ ok: true, timeout: true, messages: [] })
    const history = await run(['--chat', 'history', '--channel', 'bug/STRATEGY-9'])
    expect(history.messages).toHaveLength(3)
    expect(await run(['--chat', 'nope'])).toEqual({ ok: false, reason: 'unknown-chat-command' })
    const devices = await run(['--chat', 'devices'])
    expect(devices.devices).toEqual([
      { id: device.id, name: 'local-mac', self: true, online: true, metrics: null }
    ])
  } finally {
    await server.close()
  }
}, 20000)

it('chat 客户端：派单、认领竞争、回复、完成标记、绑定会话与超时重派', async () => {
  const runtimeFile = path.join(root, 'runtime.json')
  const server = await startServer(store, runtimeFile, () => {}, undefined, chat)
  const cli = path.join(__dirname, '../resources/integration/chat.cjs')
  const run = (args: string[], input?: string) =>
    new Promise<{ code: number; out: Record<string, any> }>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, '--runtime', runtimeFile, ...args], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      })
      let out = ''
      child.stdout.on('data', (chunk) => (out += chunk))
      child.once('error', reject)
      child.once('close', (code) => resolve({ code: code ?? 0, out: JSON.parse(out) }))
      child.stdin.end(input ?? '')
    })
  const as = (who: string) => ['--terminal', 'claude', '--member', who]
  try {
    expect((await run(['--terminal', 'qoder', 'whoami'])).out.member).toBe('local-mac/qoder')
    await run(['create', ...as('main'), '--channel', 'bug/S-1', '--title', 'Bug 1'])
    const task = (
      await run(
        ['send', ...as('main'), '--channel', 'bug/S-1', '--to', 'w/qoder', '--body-file', '-'],
        '修复 S-1 `$(x)`'
      )
    ).out.message
    // 定向消息让接收者自动成为频道参与者，inbox 无需事先加入
    let inbox = (await run(['inbox', ...as('w/qoder')])).out
    expect(inbox.tasks.map((t: { id: string }) => t.id)).toEqual([task.id])
    expect(inbox.tasks[0]).toMatchObject({ body: '修复 S-1 `$(x)`', from: 'main', binding: null })
    const first = (
      await run([
        'claim',
        ...as('w/qoder'),
        '--channel',
        'bug/S-1',
        '--id',
        task.id,
        '--session',
        's1'
      ])
    ).out
    const second = (
      await run([
        'claim',
        ...as('w/qoder'),
        '--channel',
        'bug/S-1',
        '--id',
        task.id,
        '--session',
        's2'
      ])
    ).out
    expect([first.won, second.won]).toEqual([true, false])
    inbox = (await run(['inbox', ...as('w/qoder')])).out
    expect(inbox.tasks).toEqual([])
    expect(inbox.inProgress[0].claim.session).toBe('s1')
    // 超时的认领重新出现在待处理列表
    inbox = (await run(['inbox', ...as('w/qoder'), '--stale-minutes', '0'])).out
    expect(inbox.tasks[0].staleClaim.session).toBe('s1')
    expect(
      (await run(['binding', ...as('w/qoder'), '--channel', 'bug/S-1'])).out.binding.session
    ).toBe('s1')
    await run([
      'progress',
      ...as('w/qoder'),
      '--channel',
      'bug/S-1',
      '--id',
      task.id,
      '--body',
      '50%'
    ])
    const reply = (
      await run(
        ['reply', ...as('w/qoder'), '--channel', 'bug/S-1', '--id', task.id, '--body-file', '-'],
        '已修复'
      )
    ).out.message
    expect(reply).toMatchObject({ to: 'main', type: 'result', replyTo: task.id })
    expect((await run(['inbox', ...as('w/qoder'), '--stale-minutes', '0'])).out.tasks).toEqual([])
    // 主控收到结果；标记完成后不再出现
    const controller = (await run(['inbox', ...as('main')])).out
    expect(controller.tasks.map((t: { body: string }) => t.body)).toEqual(['已修复'])
    await run(['done', ...as('main'), '--channel', 'bug/S-1', '--id', reply.id])
    expect((await run(['inbox', ...as('main')])).out.tasks).toEqual([])
    // 错误以 ok:false 与非零退出码返回
    const missing = await run([
      'reply',
      ...as('main'),
      '--channel',
      'bug/S-1',
      '--id',
      'nope',
      '--body',
      'x'
    ])
    expect(missing.code).toBe(1)
    expect(missing.out).toMatchObject({ ok: false, reason: 'message not found' })
    expect((await run(['send', ...as('main'), '--channel', 'bug/S-1'])).out.reason).toBe(
      'missing --to'
    )
    // 对话完成后删除频道；再次删除返回 ok:false
    const deleted = await run(['delete', ...as('main'), '--channel', 'bug/S-1'])
    expect(deleted.code).toBe(0)
    expect(deleted.out).toMatchObject({
      ok: true,
      deleted: { id: 'bug/S-1', devices: [device.id] }
    })
    expect((await run(['channels', ...as('main')])).out.channels).toEqual([])
    const again = await run(['delete', ...as('main'), '--channel', 'bug/S-1'])
    expect(again.code).toBe(1)
    expect(again.out).toMatchObject({ ok: false, reason: '频道不存在' })
  } finally {
    await server.close()
  }
}, 30000)

it('chat 客户端：处理会话未传 --member 时沿用本设备认领者身份回复', async () => {
  const runtimeFile = path.join(root, 'runtime.json')
  const server = await startServer(store, runtimeFile, () => {}, undefined, chat)
  const cli = path.join(__dirname, '../resources/integration/chat.cjs')
  const run = (args: string[], input?: string) =>
    new Promise<{ code: number; out: Record<string, any> }>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, '--runtime', runtimeFile, ...args], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      })
      let out = ''
      child.stdout.on('data', (chunk) => (out += chunk))
      child.once('error', reject)
      child.once('close', (code) => resolve({ code: code ?? 0, out: JSON.parse(out) }))
      child.stdin.end(input ?? '')
    })
  const main = ['--terminal', 'claude', '--member', 'ctl/claude']
  try {
    await run(['create', ...main, '--channel', 'bug/S-9'])
    const send = async (to: string, body: string) =>
      (await run(['send', ...main, '--channel', 'bug/S-9', '--to', to, '--body', body])).out.message
    const task = await send('local-mac/dsh', '修复 S-9')
    // 轮询会话以 --terminal dsh 认领
    expect(
      (
        await run([
          '--terminal',
          'dsh',
          'claim',
          '--channel',
          'bug/S-9',
          '--id',
          task.id,
          '--session',
          'sub-1'
        ])
      ).out.won
    ).toBe(true)
    // 处理会话（子会话）没有 --terminal，自身身份是 local-mac/agent
    expect((await run(['whoami'])).out.member).toBe('local-mac/agent')
    const progress = await run(['progress', '--channel', 'bug/S-9', '--id', task.id, '--body', 'x'])
    expect(progress.out).toMatchObject({ member: 'local-mac/dsh' })
    expect(progress.out.message.from).toBe('local-mac/dsh')
    const reply = (
      await run(['reply', '--channel', 'bug/S-9', '--id', task.id, '--body', '需要主控决策'])
    ).out
    expect(reply.member).toBe('local-mac/dsh')
    expect(reply.message).toMatchObject({ from: 'local-mac/dsh', to: 'ctl/claude' })
    // 原消息对轮询身份而言已处理；主控的后续回复进入 /dsh 的 inbox
    expect((await run(['--terminal', 'dsh', 'inbox'])).out.tasks).toEqual([])
    const approve = (
      await run([
        'reply',
        ...main,
        '--channel',
        'bug/S-9',
        '--id',
        reply.message.id,
        '--type',
        'approve',
        '--body',
        'ok'
      ])
    ).out.message
    expect(approve.to).toBe('local-mac/dsh')
    const inbox = (await run(['--terminal', 'dsh', 'inbox'])).out
    expect(inbox.tasks.map((t: { id: string }) => t.id)).toEqual([approve.id])
    expect(inbox.tasks[0].binding.session).toBe('sub-1')
    expect((await run(['inbox'])).out.tasks).toEqual([])
    // 未被认领的消息不继承；显式 --member 不被改写；其他设备的参与者不继承
    const unclaimed = await send('local-mac/dsh', '未认领')
    expect((await run(['done', '--channel', 'bug/S-9', '--id', unclaimed.id])).out.member).toBe(
      'local-mac/agent'
    )
    const explicit = await send('local-mac/qoder', '显式')
    await run(['--terminal', 'qoder', 'claim', '--channel', 'bug/S-9', '--id', explicit.id])
    expect(
      (
        await run([
          'done',
          '--member',
          'local-mac/other',
          '--channel',
          'bug/S-9',
          '--id',
          explicit.id
        ])
      ).out.member
    ).toBe('local-mac/other')
    const remote = await send('peer-mac/dsh', '其他设备')
    await run(['claim', '--member', 'peer-mac/dsh', '--channel', 'bug/S-9', '--id', remote.id])
    expect((await run(['done', '--channel', 'bug/S-9', '--id', remote.id])).out.member).toBe(
      'local-mac/agent'
    )
  } finally {
    await server.close()
  }
}, 30000)

it('本机删除频道：清除频道、消息与游标，写入删除标记并推送', async () => {
  const pushes: { devices: string[]; payload: ChatPush }[] = []
  const peer = randomUUID()
  chat.attach(
    {
      list: () => [],
      resolve: (value) => (value === peer ? peer : value === device.id ? device.id : null)
    },
    (devices, payload) => pushes.push({ devices, payload })
  )
  chat.createChannel({ id: 'bug/S-2', devices: [peer] })
  chat.createChannel({ id: 'keep' })
  chat.post({ channel: 'bug/S-2', from: 'main', to: 'w', body: 'task' })
  expect(await chat.wait({ member: 'w', channels: ['bug/S-2'], timeout: 0 })).toHaveLength(1)
  const count = (sql: string) => (store.db.prepare(sql).get('bug/S-2') as { n: number }).n
  expect(count('SELECT COUNT(*) AS n FROM chat_cursors WHERE channel=?')).toBe(1)
  pushes.length = 0
  const tombstone = chat.deleteChannel('bug/S-2')
  expect(tombstone).toMatchObject({ id: 'bug/S-2', deletedBy: device.id })
  expect([...tombstone.devices].sort()).toEqual([device.id, peer].sort())
  expect(chat.channel('bug/S-2')).toBeNull()
  expect(chat.history('bug/S-2')).toEqual([])
  expect(count('SELECT COUNT(*) AS n FROM chat_messages WHERE channel=?')).toBe(0)
  expect(count('SELECT COUNT(*) AS n FROM chat_cursors WHERE channel=?')).toBe(0)
  expect(chat.channel('keep')).not.toBeNull()
  expect(chat.tombstone('bug/S-2')).toEqual(tombstone)
  // 删除标记只推送给其他持有副本的设备
  expect(pushes).toEqual([
    { devices: [peer], payload: { channels: [], messages: [], deleted: [tombstone] } }
  ])
  // 同步应答携带删除标记，无关设备收不到
  expect(chat.answerSync(peer, { channels: {} }).deleted).toEqual([tombstone])
  expect(chat.answerSync(randomUUID(), { channels: {} }).deleted).toBeUndefined()
  expect(() => chat.deleteChannel('bug/S-2')).toThrow('频道不存在')
})

/** 两台设备互相直推的复制环境；offline 时 A→B 的推送被丢弃，只能靠同步补齐。 */
function pair() {
  const a = { id: randomUUID(), name: 'mac-a', protocol: 1 }
  const b = { id: randomUUID(), name: 'mac-b', protocol: 1 }
  const state = { clock: 1_000_000, offline: false }
  const now = () => state.clock
  const storeB = new Store(path.join(root, 'b.sqlite'))
  // 两台设备的数据库在同一临时目录，图片目录必须分开，模拟各自独立的本机存储。
  const chatA = new Chat(store, () => a, { now, filesDirectory: path.join(root, 'files-a') })
  const chatB = new Chat(storeB, () => b, { now, filesDirectory: path.join(root, 'files-b') })
  const directory = {
    list: () => [],
    resolve: (value: string) => [a.id, b.id].find((id) => id === value) ?? null
  }
  const copy = (payload: ChatPush) => JSON.parse(JSON.stringify(payload))
  chatA.attach(directory, (_devices, payload) => {
    if (!state.offline) chatB.ingest(a.id, copy(payload))
  })
  chatB.attach(directory, (_devices, payload) => {
    if (!state.offline) chatA.ingest(b.id, copy(payload))
  })
  /** 与 lan.ts 的 syncChat 一致：to 向 from 拉取一次，去掉应答中的 more 后写入。 */
  const pull = (to: Chat, toId: string, from: Chat, fromId: string) => {
    const { more: _more, ...answer } = from.answerSync(toId, to.syncRequest(fromId))
    return to.ingest(fromId, copy(answer))
  }
  /** 模拟一轮双向同步（各自向对方拉取）。 */
  const sync = () => {
    pull(chatA, a.id, chatB, b.id)
    pull(chatB, b.id, chatA, a.id)
  }
  const close = () => {
    chatA.close()
    chatB.close()
    storeB.close()
  }
  return { a, b, chatA, chatB, state, pull, sync, close }
}

it('删除标记传播到对端；离线对端的旧副本推送不会复活频道，上线同步后收敛', () => {
  const { a, b, chatA, chatB, state, pull, sync, close } = pair()
  try {
    chatA.createChannel({ id: 'control', devices: [b.id] })
    chatA.post({ channel: 'control', from: 'a/main', to: 'b/w', body: 'one' })
    expect(chatB.history('control').map((m) => m.body)).toEqual(['one'])
    // 在线：删除立即传播
    chatA.deleteChannel('control')
    expect(chatB.channel('control')).toBeNull()
    expect(chatB.history('control')).toEqual([])
    expect(chatB.tombstone('control')?.deletedBy).toBe(a.id)

    // 离线：B 没收到删除，继续写入并推送旧副本
    state.clock += 1000
    chatA.createChannel({ id: 'bug/S-3', devices: [b.id] })
    chatA.post({ channel: 'bug/S-3', from: 'a/main', body: 'old' })
    state.offline = true
    state.clock += 1000
    chatA.deleteChannel('bug/S-3')
    expect(chatB.channel('bug/S-3')).not.toBeNull()
    state.offline = false
    state.clock += 1000
    chatB.post({ channel: 'bug/S-3', from: 'b/w', body: 'late' })
    expect(chatA.channel('bug/S-3')).toBeNull()
    // A 先向 B 拉取：旧频道定义与消息都被忽略；B 再向 A 拉取时收到删除标记
    pull(chatA, a.id, chatB, b.id)
    expect(chatA.channel('bug/S-3')).toBeNull()
    sync()
    expect(chatB.channel('bug/S-3')).toBeNull()
    expect(chatB.history('bug/S-3')).toEqual([])
    expect(chatA.channel('bug/S-3')).toBeNull()
    expect(chatA.tombstone('bug/S-3')?.devices.sort()).toEqual([a.id, b.id].sort())
  } finally {
    close()
  }
})

it('删除后可重建同名频道；仍持有旧副本的对端先删旧副本再接收新频道', () => {
  const { a, b, chatA, chatB, state, pull, sync, close } = pair()
  try {
    chatA.createChannel({ id: 'control', devices: [b.id] })
    chatA.post({ channel: 'control', from: 'a/main', body: 'old-1' })
    chatA.post({ channel: 'control', from: 'a/main', body: 'old-2' })
    state.offline = true
    const tombstone = chatA.deleteChannel('control')
    // 同一毫秒内重建：创建时间被抬到删除时间之后
    const recreated = chatA.createChannel({ id: 'control', devices: [b.id] })
    expect(recreated.createdAt).toBeGreaterThan(tombstone.deletedAt)
    const fresh = chatA.post({ channel: 'control', from: 'a/main', body: 'new-1' })
    expect(fresh.counter).toBe(1)
    expect(fresh.createdAt).toBeGreaterThan(tombstone.deletedAt)
    expect(chatB.history('control').map((m) => m.body)).toEqual(['old-1', 'old-2'])
    // B 的旧副本推送/同步不会把旧消息带回重建后的频道
    pull(chatA, a.id, chatB, b.id)
    expect(chatA.history('control').map((m) => m.body)).toEqual(['new-1'])
    expect(chatA.channel('control')!.createdAt).toBe(recreated.createdAt)
    // 恢复在线：A 的新消息推送附带删除标记，B 删除旧副本后接收新频道
    state.offline = false
    chatA.post({ channel: 'control', from: 'a/main', body: 'new-2' })
    expect(chatB.history('control').map((m) => m.body)).toEqual(['new-2'])
    expect(chatB.channel('control')!.createdAt).toBe(recreated.createdAt)
    // 离线期间的 new-1 由同步补齐；A 收到 B 回传的删除标记也不会删掉重建后的频道
    sync()
    const bodies = (target: Chat) =>
      target
        .history('control')
        .map((m) => m.body)
        .sort()
    expect(bodies(chatA)).toEqual(['new-1', 'new-2'])
    expect(bodies(chatB)).toEqual(['new-1', 'new-2'])
  } finally {
    close()
  }
})

it('自动清理只删除闲置超过 8 小时的频道，并清除过期删除标记', () => {
  let clock = 0
  const local = new Chat(store, () => device, { now: () => clock })
  try {
    local.createChannel({ id: 'old' })
    local.post({ channel: 'old', from: 'main', body: 'x' })
    local.createChannel({ id: 'empty-old' })
    clock = 2 * 60 * 60 * 1000
    local.createChannel({ id: 'fresh-empty' })
    local.createChannel({ id: 'active' })
    clock = CHAT_IDLE_MS
    local.post({ channel: 'active', from: 'main', body: 'still working' })
    // 恰好 8 小时不删除，超过才删除
    expect(local.cleanup()).toEqual([])
    clock = CHAT_IDLE_MS + 1
    expect(local.cleanup().sort()).toEqual(['empty-old', 'old'])
    expect(
      local
        .summaries()
        .map((c) => c.id)
        .sort()
    ).toEqual(['active', 'fresh-empty'])
    expect(local.tombstone('old')).not.toBeNull()
    clock = CHAT_IDLE_MS + 1 + CHAT_TOMBSTONE_TTL_MS + 1
    local.cleanup()
    expect(local.tombstone('old')).toBeNull()
    expect(local.summaries()).toEqual([])
  } finally {
    local.close()
  }
})

it('自动清理定时器：启动后延迟执行一次，之后按周期执行，close 后停止', () => {
  vi.useFakeTimers()
  const local = new Chat(store, () => device, {
    cleanupDelayMs: 1000,
    cleanupIntervalMs: 5000
  })
  try {
    const cleanup = vi.spyOn(local, 'cleanup')
    local.startCleanup()
    local.startCleanup()
    vi.advanceTimersByTime(999)
    expect(cleanup).toHaveBeenCalledTimes(0)
    vi.advanceTimersByTime(1)
    expect(cleanup).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10000)
    expect(cleanup).toHaveBeenCalledTimes(3)
    local.close()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(60000)
    expect(cleanup).toHaveBeenCalledTimes(3)
  } finally {
    local.close()
    vi.useRealTimers()
  }
})

/** 最小的“图片”：只需文件头魔数正确，服务端不解码像素。 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const png = (seed: string) => Buffer.concat([PNG_SIGNATURE, Buffer.from(seed)])
const jpeg = (seed: string) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(seed)])
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')
const upload = (target: Chat, channel: string, data: Buffer, name = 'shot.png') =>
  target.uploadFile({ channel, name, data: data.toString('base64') })

it('图片上传：魔数识别类型、大小与数量上限、只能引用本频道已上传的图片', () => {
  chat.createChannel({ id: 'img' })
  chat.createChannel({ id: 'other' })
  // 内容不是支持的图片格式（扩展名不可信）
  expect(() => upload(chat, 'img', Buffer.from('not an image'), 'fake.png')).toThrow('仅支持')
  // 声明类型与内容不一致
  expect(() =>
    chat.uploadFile({
      channel: 'img',
      name: 'a.jpg',
      mime: 'image/jpeg',
      data: png('x').toString('base64')
    })
  ).toThrow('不一致')
  // 超过 4 MiB
  const huge = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(MAX_CHAT_IMAGE_BYTES)])
  expect(() => upload(chat, 'img', huge)).toThrow()
  expect(() => upload(chat, 'missing', png('x'))).toThrow('频道不存在')
  expect(() => chat.uploadFile({ channel: 'img', name: 'x.png', data: '!!!' })).toThrow('base64')

  const first = upload(chat, 'img', png('one'), '../../etc/one.png')
  expect(first).toMatchObject({ hash: sha(png('one')), mime: 'image/png', size: png('one').length })
  // 文件名只用于展示，路径分隔符被替换；存储路径由哈希决定
  expect(first.name).not.toContain('/')
  expect(first.path).toBe(path.join(root, 'chat-files', `${first.hash}.png`))
  expect(readFileSync(first.path!)).toEqual(png('one'))
  const photo = upload(chat, 'img', jpeg('two'), 'photo.jpg')
  expect(photo.path!.endsWith('.jpg')).toBe(true)
  // 重复上传幂等
  expect(upload(chat, 'img', png('one')).hash).toBe(first.hash)

  // 未上传的哈希、其他频道上传的图片都不能引用
  expect(() =>
    chat.post({ channel: 'img', from: 'a', body: 'x', attachments: [{ hash: 'f'.repeat(64) }] })
  ).toThrow('图片未上传')
  const foreign = upload(chat, 'other', png('foreign'))
  expect(() =>
    chat.post({ channel: 'img', from: 'a', body: 'x', attachments: [{ hash: foreign.hash }] })
  ).toThrow('图片未上传')
  // 最多 4 张
  const five = ['1', '2', '3', '4', '5'].map((seed) => ({
    hash: upload(chat, 'img', png(seed)).hash
  }))
  expect(() => chat.post({ channel: 'img', from: 'a', body: 'x', attachments: five })).toThrow()

  const message = chat.post({
    channel: 'img',
    from: 'a',
    body: '截图',
    attachments: [{ hash: first.hash }, { hash: photo.hash }, { hash: first.hash }]
  })
  // 重复引用同一图片只保留一次，元数据以上传记录为准
  expect(message.attachments).toEqual([first, photo])
  expect(chat.history('img')[0].attachments!.map((file) => file.path)).toEqual([
    first.path,
    photo.path
  ])
  // 无附件的消息不带 attachments 字段
  expect(chat.post({ channel: 'img', from: 'a', body: 'plain' })).not.toHaveProperty('attachments')
  // 同步应答只带附件元数据，不泄露本机路径
  const peer = randomUUID()
  store.db
    .prepare('UPDATE chat_channels SET devices=? WHERE id=?')
    .run(JSON.stringify([device.id, peer]), 'img')
  const wire = chat.answerSync(peer, { channels: {} }).messages
  expect(wire[0].attachments).toEqual([
    { hash: first.hash, name: first.name, mime: 'image/png', size: first.size },
    { hash: photo.hash, name: 'photo.jpg', mime: 'image/jpeg', size: photo.size }
  ])
  expect(wire[1]).not.toHaveProperty('attachments')
  expect(chat.summaries().find((c) => c.id === 'img')!.pendingFiles).toBe(0)
})

it('图片随频道删除：共享图片在仍被引用时保留，闲置清理同样删除，启动时清理孤儿文件', () => {
  chat.createChannel({ id: 'a' })
  chat.createChannel({ id: 'b' })
  const shared = upload(chat, 'a', png('shared'))
  upload(chat, 'b', png('shared'))
  const only = upload(chat, 'a', png('only-a'))
  chat.post({
    channel: 'a',
    from: 'x',
    body: 'img',
    attachments: [{ hash: shared.hash }, { hash: only.hash }]
  })
  chat.post({ channel: 'b', from: 'x', body: 'img', attachments: [{ hash: shared.hash }] })
  const files = () =>
    (
      store.db.prepare('SELECT channel, hash FROM chat_files ORDER BY channel').all() as {
        channel: string
      }[]
    ).map((row) => row.channel)
  chat.deleteChannel('a')
  expect(existsSync(only.path!)).toBe(false)
  expect(existsSync(shared.path!)).toBe(true)
  expect(chat.imageFile(only.hash)).toBeNull()
  expect(chat.imageFile(shared.hash)).toEqual({ path: shared.path, mime: 'image/png' })
  expect(files()).toEqual(['b'])
  chat.deleteChannel('b')
  expect(existsSync(shared.path!)).toBe(false)
  expect(files()).toEqual([])

  // 闲置清理走同一删除路径
  let clock = 0
  const local = new Chat(store, () => device, { now: () => clock })
  try {
    local.createChannel({ id: 'old' })
    const stale = upload(local, 'old', png('stale'))
    local.post({ channel: 'old', from: 'x', body: 'img', attachments: [{ hash: stale.hash }] })
    clock = CHAT_IDLE_MS + 1
    expect(local.cleanup()).toEqual(['old'])
    expect(existsSync(stale.path!)).toBe(false)

    // 孤儿文件（无引用的图片、写入中断的临时文件）在新实例启动时删除，被引用的保留
    local.createChannel({ id: 'keep' })
    const kept = upload(local, 'keep', png('kept'))
    const directory = path.join(root, 'chat-files')
    mkdirSync(directory, { recursive: true })
    const orphan = path.join(directory, `${sha(png('orphan'))}.png`)
    const temporary = path.join(directory, `${kept.hash}.png.123.tmp`)
    writeFileSync(orphan, png('orphan'))
    writeFileSync(temporary, 'partial')
    const restarted = new Chat(store, () => device)
    restarted.close()
    expect(existsSync(orphan)).toBe(false)
    expect(existsSync(temporary)).toBe(false)
    expect(existsSync(kept.path!)).toBe(true)
  } finally {
    local.close()
  }
})

it('跨设备图片：接收端登记缺失文件、按哈希校验后落盘，非成员不可读取，删除标记同步删除图片', () => {
  const { a, b, chatA, chatB, close } = pair()
  try {
    chatA.createChannel({ id: 'bug/S-9', devices: [b.id] })
    const image = upload(chatA, 'bug/S-9', png('remote'))
    chatA.post({
      channel: 'bug/S-9',
      from: 'a/main',
      body: '看图',
      attachments: [{ hash: image.hash }]
    })
    // B 收到消息但图片尚未拉取：path 为 null 且 pending
    const pending = chatB.history('bug/S-9')[0].attachments!
    expect(pending).toEqual([
      {
        hash: image.hash,
        name: 'shot.png',
        mime: 'image/png',
        size: image.size,
        path: null,
        pending: true
      }
    ])
    expect(chatB.summaries()[0].pendingFiles).toBe(1)
    expect(chatB.missingFiles()).toEqual([
      { channel: 'bug/S-9', hash: image.hash, size: image.size, devices: [a.id] }
    ])
    // 非频道设备不能读取；频道成员可以
    expect(() => chatA.readFileFor(randomUUID(), 'bug/S-9', image.hash)).toThrow('无权')
    expect(() => chatA.readFileFor(b.id, 'bug/S-9', 'a'.repeat(64))).toThrow('图片不存在')
    const served = chatA.readFileFor(b.id, 'bug/S-9', image.hash)
    // 篡改的数据被拒绝，不落盘
    expect(() => chatB.storeFile('bug/S-9', image.hash, png('tampered'))).toThrow('校验失败')
    expect(chatB.storeFile('bug/S-9', image.hash, Buffer.from(served.data, 'base64'))).toBe(true)
    const local = chatB.history('bug/S-9')[0].attachments![0]
    expect(local.path).toBe(path.join(root, 'files-b', `${image.hash}.png`))
    expect(sha(readFileSync(local.path!))).toBe(image.hash)
    expect(chatB.missingFiles()).toEqual([])
    // 未登记到频道的哈希不会被写入
    expect(chatB.storeFile('bug/S-9', sha(png('x')), png('x'))).toBe(false)
    // A 删除频道：删除标记传播到 B，B 的图片同步删除
    chatA.deleteChannel('bug/S-9')
    expect(chatB.channel('bug/S-9')).toBeNull()
    expect(existsSync(local.path!)).toBe(false)
    expect(existsSync(image.path!)).toBe(false)
  } finally {
    close()
  }
})

it('chat 客户端 --image：上传后随消息发送，history/inbox 输出本机路径，非图片被拒绝', async () => {
  const runtimeFile = path.join(root, 'runtime.json')
  const server = await startServer(store, runtimeFile, () => {}, undefined, chat)
  const cli = path.join(__dirname, '../resources/integration/chat.cjs')
  const run = (args: string[], input?: string) =>
    new Promise<{ code: number; out: Record<string, any> }>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, '--runtime', runtimeFile, ...args], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      })
      let out = ''
      child.stdout.on('data', (chunk) => (out += chunk))
      child.once('error', reject)
      child.once('close', (code) => resolve({ code: code ?? 0, out: JSON.parse(out) }))
      child.stdin.end(input ?? '')
    })
  const as = (who: string) => ['--terminal', 'claude', '--member', who]
  try {
    await run(['create', ...as('main'), '--channel', 'bug/S-7'])
    const first = path.join(root, 'first.png')
    const second = path.join(root, 'second.jpeg')
    writeFileSync(first, png('cli-1'))
    writeFileSync(second, jpeg('cli-2'))
    const sent = await run([
      'send',
      ...as('main'),
      '--channel',
      'bug/S-7',
      '--to',
      'w',
      '--body',
      '看这两张图',
      '--image',
      first,
      '--image',
      second
    ])
    expect(sent.code).toBe(0)
    const attachments = sent.out.message.attachments as {
      hash: string
      path: string
      name: string
    }[]
    expect(attachments.map((file) => [file.name, file.hash])).toEqual([
      ['first.png', sha(png('cli-1'))],
      ['second.jpeg', sha(jpeg('cli-2'))]
    ])
    expect(readFileSync(attachments[1].path)).toEqual(jpeg('cli-2'))
    const history = (await run(['history', ...as('main'), '--channel', 'bug/S-7'])).out
    expect(history.messages[0].attachments.map((file: { path: string }) => file.path)).toEqual(
      attachments.map((file) => file.path)
    )
    const inbox = (await run(['inbox', ...as('w')])).out
    expect(inbox.tasks[0].attachments[0]).toMatchObject({
      hash: sha(png('cli-1')),
      mime: 'image/png'
    })
    // 只有图片时正文可省略
    const imageOnly = await run([
      'progress',
      ...as('w'),
      '--channel',
      'bug/S-7',
      '--id',
      sent.out.message.id,
      '--image',
      first
    ])
    expect(imageOnly.out.message).toMatchObject({ body: '[图片]', type: 'progress' })
    // 扩展名伪装的文本文件、超过 4 张均被拒绝
    const fake = path.join(root, 'fake.png')
    writeFileSync(fake, 'plain text')
    const rejected = await run([
      'send',
      ...as('main'),
      '--channel',
      'bug/S-7',
      '--to',
      'w',
      '--image',
      fake
    ])
    expect(rejected.code).toBe(1)
    expect(rejected.out.reason).toContain('unsupported image')
    const tooMany = await run([
      'send',
      ...as('main'),
      '--channel',
      'bug/S-7',
      '--to',
      'w',
      ...Array.from({ length: 5 }, () => ['--image', first]).flat()
    ])
    expect(tooMany.out.reason).toContain('too many images')
    // 删除频道后图片文件随之删除
    await run(['delete', ...as('main'), '--channel', 'bug/S-7'])
    for (const file of attachments) expect(existsSync(file.path)).toBe(false)
  } finally {
    await server.close()
  }
}, 30000)

it('消息携带或从活跃会话自动推断发送者 model，并随同步复制', () => {
  const folder = path.join(root, 'repo')
  mkdirSync(folder, { recursive: true })
  store.addFolder(folder)
  store.activity({
    path: folder,
    terminal: 'qoder',
    sessionId: 'sess-qoder-1',
    action: 'enter',
    model: 'anthropic/claude-opus-4-6'
  })
  chat.createChannel({ id: 'model-test', members: ['local-mac/qoder', 'local-mac/codex'] })
  const explicit = chat.post({
    channel: 'model-test',
    from: 'local-mac/codex',
    model: 'openai/gpt-5',
    body: 'explicit model'
  })
  expect(explicit.model).toBe('openai/gpt-5')
  // 未传 model 时，从本机活跃会话自动推断
  const inferred = chat.post({
    channel: 'model-test',
    from: 'local-mac/qoder',
    body: 'inferred model'
  })
  expect(inferred.model).toBe('anthropic/claude-opus-4-6')
  expect(chat.history('model-test').map((m) => m.model)).toEqual([
    'openai/gpt-5',
    'anthropic/claude-opus-4-6'
  ])
})

it('changes 变更信号：版本不同立即返回，否则等到下一次变更或超时', async () => {
  chat.createChannel({ id: 'c' })
  const first = await chat.changes({ after: -1, timeout: 5 })
  expect(first.changed).toBe(true)
  const started = Date.now()
  const pending = chat.changes({ after: first.revision, timeout: 5 })
  setTimeout(() => chat.post({ channel: 'c', from: 'main', body: 'wake' }), 100)
  const woke = await pending
  expect(woke).toEqual({ revision: first.revision + 1, changed: true })
  expect(Date.now() - started).toBeLessThan(2000)
  expect(await chat.changes({ after: woke.revision, timeout: 0.1 })).toEqual({
    revision: woke.revision,
    changed: false
  })
})

/** 启动 chat 客户端子进程，逐行收集 stdout，便于测试常驻的 watch 与阻塞的 wait。 */
function launch(runtimeFile: string, args: string[]) {
  const cli = path.join(__dirname, '../resources/integration/chat.cjs')
  const child = spawn(process.execPath, [cli, '--runtime', runtimeFile, ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  const lines: Record<string, any>[] = []
  let buffer = ''
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buffer.slice(0, index)))
      buffer = buffer.slice(index + 1)
    }
  })
  child.stdin.end()
  const exited = new Promise<number>((resolve) => child.once('close', (code) => resolve(code ?? 0)))
  /** 等到收集到至少 count 行输出。 */
  const until = async (count: number, ms = 8000) => {
    const deadline = Date.now() + ms
    while (lines.length < count) {
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${count} lines: ${lines}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return lines
  }
  return { child, lines, exited, until }
}

it('chat 客户端 wait：无消息超时返回，新消息到达立即唤醒，--new-only 忽略已有消息，未运行时报错', async () => {
  const runtimeFile = path.join(root, 'runtime.json')
  const server = await startServer(store, runtimeFile, () => {}, undefined, chat)
  const as = (who: string) => ['--terminal', 'claude', '--member', who]
  try {
    chat.createChannel({ id: 'control', members: ['main', 'w/claude'] })
    // 无待处理消息：按 --timeout-seconds 超时
    let started = Date.now()
    let run = launch(runtimeFile, ['wait', ...as('w/claude'), '--timeout-seconds', '1'])
    expect(await run.exited).toBe(0)
    expect(run.lines).toEqual([{ ok: true, timeout: true }])
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    // 阻塞中收到定向消息立即唤醒，输出与 inbox 相同格式；超过服务端 requestTimeout(3s) 仍有效
    started = Date.now()
    run = launch(runtimeFile, ['wait', ...as('w/claude'), '--timeout-seconds', '30'])
    await new Promise((resolve) => setTimeout(resolve, 3500))
    const task = chat.post({ channel: 'control', from: 'main', to: 'w/claude', body: '修复 A' })
    expect(await run.exited).toBe(0)
    expect(Date.now() - started).toBeLessThan(8000)
    expect(run.lines).toHaveLength(1)
    expect(run.lines[0]).toMatchObject({ ok: true, member: 'w/claude', inProgress: [] })
    expect(run.lines[0].tasks.map((t: { id: string }) => t.id)).toEqual([task.id])
    // tasks 非空时默认立即返回；--new-only 只在出现启动时没有的消息时返回
    run = launch(runtimeFile, ['wait', ...as('w/claude'), '--timeout-seconds', '5'])
    expect(await run.exited).toBe(0)
    expect(run.lines[0].tasks).toHaveLength(1)
    run = launch(runtimeFile, ['wait', ...as('w/claude'), '--new-only', '--timeout-seconds', '1'])
    expect(await run.exited).toBe(0)
    expect(run.lines).toEqual([{ ok: true, timeout: true }])
    run = launch(runtimeFile, ['wait', ...as('w/claude'), '--new-only', '--timeout-seconds', '30'])
    await new Promise((resolve) => setTimeout(resolve, 300))
    // 发给别人的消息与非定向消息不会唤醒
    chat.post({ channel: 'control', from: 'main', to: 'other', body: 'x' })
    chat.post({ channel: 'control', from: 'main', body: 'broadcast' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(run.lines).toEqual([])
    const second = chat.post({ channel: 'control', from: 'main', to: 'w/claude', body: '修复 B' })
    expect(await run.exited).toBe(0)
    expect(run.lines[0].tasks.map((t: { id: string }) => t.id)).toEqual([task.id, second.id])
  } finally {
    await server.close()
  }
  // Ebisu 未运行（端口无人监听）：与其他命令一致返回 ok:false 与非零退出码
  const stale = path.join(root, 'stale-runtime.json')
  writeFileSync(stale, JSON.stringify({ port: 1, token: 'x' }))
  const down = launch(stale, ['wait', '--terminal', 'claude', '--member', 'w/claude'])
  expect(await down.exited).toBe(1)
  expect(down.lines).toEqual([{ ok: false, reason: 'ebisu-not-running' }])
}, 40000)

it('chat 客户端 watch：先输出已有待处理消息，按 id 去重推送新消息，断开时非零退出', async () => {
  const runtimeFile = path.join(root, 'runtime.json')
  const server = await startServer(store, runtimeFile, () => {}, undefined, chat)
  let closed = false
  const run = (() => {
    chat.createChannel({ id: 'control', members: ['main', 'w/claude'] })
    chat.post({ channel: 'control', from: 'main', to: 'w/claude', body: 'x'.repeat(300) })
    return launch(runtimeFile, ['watch', '--terminal', 'claude', '--member', 'w/claude'])
  })()
  try {
    const [initial] = await run.until(1)
    expect(initial).toMatchObject({ channel: 'control', from: 'main', type: 'text' })
    expect(Object.keys(initial).sort()).toEqual(
      ['body', 'channel', 'createdAt', 'from', 'id', 'type'].sort()
    )
    expect(initial.body).toBe(`${'x'.repeat(200)}…`)
    const next = chat.post({ channel: 'control', from: 'main', to: 'w/claude', body: '第二条' })
    const lines = await run.until(2)
    expect(lines[1]).toMatchObject({ id: next.id, body: '第二条' })
    // 无关变更（自己的进展标记、其他人的消息）不会重复输出
    chat.post({
      channel: 'control',
      from: 'w/claude',
      type: 'progress',
      replyTo: next.id,
      body: '…'
    })
    chat.post({ channel: 'control', from: 'main', to: 'other', body: 'y' })
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(run.lines).toHaveLength(2)
    await server.close()
    closed = true
    expect(await run.exited).toBe(1)
    expect(run.lines[2]).toMatchObject({ ok: false })
  } finally {
    if (!closed) await server.close()
    run.child.kill()
  }
}, 30000)

it('chat 客户端 wait：主进程没有 changes 接口（旧版本）时退化为间隔查询', async () => {
  const runtimeFile = path.join(root, 'runtime.json')
  const server = await startServer(store, runtimeFile, () => {}, undefined, chat)
  const { port, token } = JSON.parse(readFileSync(runtimeFile, 'utf8'))
  // 模拟旧版主进程：/v1/chat/changes 返回 404，其余请求转发到真实服务
  const { createServer, request } = await import('node:http')
  const proxy = createServer((req, res) => {
    if (req.url?.startsWith('/v1/chat/changes')) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: '接口不存在' }))
      return
    }
    const upstream = request(
      { host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers },
      (response) => {
        res.writeHead(response.statusCode ?? 500, response.headers)
        response.pipe(res)
      }
    )
    req.pipe(upstream)
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', () => resolve()))
  const legacy = path.join(root, 'legacy-runtime.json')
  writeFileSync(legacy, JSON.stringify({ port: (proxy.address() as { port: number }).port, token }))
  try {
    chat.createChannel({ id: 'control', members: ['main', 'w/claude'] })
    const run = launch(legacy, [
      'wait',
      '--terminal',
      'claude',
      '--member',
      'w/claude',
      '--timeout-seconds',
      '20',
      '--poll-ms',
      '100'
    ])
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(run.lines).toEqual([])
    const started = Date.now()
    const task = chat.post({ channel: 'control', from: 'main', to: 'w/claude', body: 'legacy' })
    expect(await run.exited).toBe(0)
    expect(Date.now() - started).toBeLessThan(3000)
    expect(run.lines[0].tasks.map((t: { id: string }) => t.id)).toEqual([task.id])
  } finally {
    proxy.closeAllConnections()
    await new Promise<void>((resolve) => proxy.close(() => resolve()))
    await server.close()
  }
}, 30000)
