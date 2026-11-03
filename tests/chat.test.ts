import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { Store } from '../src/main/database'
import { Chat, CHAT_IDLE_MS, CHAT_TOMBSTONE_TTL_MS, type ChatPush } from '../src/main/chat'
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
      { id: device.id, name: 'local-mac', self: true, online: true }
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
  const chatA = new Chat(store, () => a, { now })
  const chatB = new Chat(storeB, () => b, { now })
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
