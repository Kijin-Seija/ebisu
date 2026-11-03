import { z } from 'zod'
import type { Store } from './database'
import type { DeviceIdentity } from '../shared/lan'
import type { ChatChannel, ChatChannelSummary, ChatDevice, ChatMessage } from '../shared/chat'
import { SkillError } from './skills'

/** 单条消息正文上限；大文件应通过 git 或附件链接传递。 */
export const MAX_CHAT_BODY = 32 * 1024
/** 单次同步响应的消息条数上限，超过时返回 more=true 由调用方继续拉取。 */
const SYNC_BATCH = 200
/** 长轮询上限，需小于各终端单条命令的超时时间。 */
export const MAX_WAIT_SECONDS = 900
const uuid = z.string().uuid()
export const channelIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/, '频道标识只能包含字母、数字和 ._/-')
export const memberSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._@/:-]{0,127}$/, '参与者名称只能包含字母、数字和 ._@/:-')
const typeSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/)
const bodySchema = z
  .string()
  .min(1)
  .refine((value) => Buffer.byteLength(value) <= MAX_CHAT_BODY, '消息正文超过 32 KiB')

export const createChannelSchema = z
  .object({
    id: channelIdSchema,
    title: z.string().trim().max(200).optional(),
    devices: z.array(z.string().min(1).max(200)).max(32).optional(),
    members: z.array(memberSchema).max(64).optional()
  })
  .strict()
export const postSchema = z
  .object({
    channel: channelIdSchema,
    from: memberSchema,
    to: memberSchema.nullable().optional(),
    type: typeSchema.optional(),
    body: bodySchema,
    replyTo: z.string().max(200).nullable().optional(),
    clientId: z.string().min(1).max(200).nullable().optional()
  })
  .strict()
/** 线上传输的频道定义；接收方按并集合并，不信任对端的本机字段。 */
const wireChannel = z
  .object({
    id: channelIdSchema,
    title: z.string().max(200),
    devices: z.array(uuid).min(1).max(32),
    members: z.array(memberSchema).max(256),
    createdBy: uuid,
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative()
  })
  .strip()
const wireMessage = z
  .object({
    channel: channelIdSchema,
    origin: uuid,
    counter: z.number().int().positive(),
    from: memberSchema,
    to: memberSchema.nullable(),
    type: typeSchema,
    body: bodySchema,
    replyTo: z.string().max(200).nullable(),
    clientId: z.string().max(200).nullable(),
    createdAt: z.number().int().nonnegative()
  })
  .strip()
export const pushSchema = z
  .object({
    channels: z.array(wireChannel).max(1000),
    messages: z.array(wireMessage).max(SYNC_BATCH * 2)
  })
  .strict()
/** 同步请求：频道 -> 来源设备 -> 已连续持有的最大计数。 */
export const syncSchema = z
  .object({
    channels: z.record(channelIdSchema, z.record(uuid, z.number().int().nonnegative()))
  })
  .strict()
export type ChatPush = z.infer<typeof pushSchema>
export type ChatSync = z.infer<typeof syncSchema>

interface ChannelRow {
  id: string
  title: string
  devices: string
  members: string
  createdBy: string
  createdAt: number
  updatedAt: number
}
interface MessageRow {
  seq: number
  channel: string
  origin: string
  counter: number
  sender: string
  recipient: string | null
  type: string
  body: string
  replyTo: string | null
  clientId: string | null
  createdAt: number
  receivedAt: number
}
/** 设备目录由 LAN 层提供；未开启局域网时只有本机。 */
export interface ChatDirectory {
  list(): ChatDevice[]
  /** 按设备 ID 或名称（忽略大小写和 .local 后缀）解析设备 ID。 */
  resolve(value: string): string | null
}
interface Options {
  now?: () => number
  changed?: () => void
  /** 本机写入后立即推送给频道内其他设备；失败由周期同步补齐。 */
  push?: (devices: string[], payload: ChatPush) => void
}
export interface WaitInput {
  member: string
  /** 频道列表；包含 * 时表示该参与者加入的所有频道。 */
  channels: string[]
  timeout: number
  /** true 时同时返回发给其他参与者的消息。 */
  all?: boolean
  /** true 时只读取不推进游标。 */
  peek?: boolean
  signal?: AbortSignal
}

/**
 * 对话存储与复制。消息只追加不修改，因此多设备并发写入没有冲突；
 * 每台设备按（频道, 来源设备）维护连续计数，同步时用版本向量精确补齐缺失消息。
 */
export class Chat {
  private readonly now: () => number
  private readonly changed: () => void
  private readonly waiters = new Set<() => void>()
  private push?: Options['push']
  private directory: ChatDirectory

  constructor(
    private readonly store: Store,
    private readonly localDevice: () => DeviceIdentity,
    options: Options = {}
  ) {
    this.now = options.now ?? Date.now
    this.changed = options.changed ?? (() => {})
    this.push = options.push
    this.directory = {
      list: () => {
        const self = this.localDevice()
        return [{ id: self.id, name: self.name, self: true, online: true }]
      },
      resolve: (value) => {
        const self = this.localDevice()
        return matchesDevice(value, self.id, self.name) ? self.id : null
      }
    }
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_channels (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, devices TEXT NOT NULL, members TEXT NOT NULL,
        createdBy TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL, origin TEXT NOT NULL, counter INTEGER NOT NULL,
        sender TEXT NOT NULL, recipient TEXT, type TEXT NOT NULL, body TEXT NOT NULL,
        replyTo TEXT, clientId TEXT, createdAt INTEGER NOT NULL, receivedAt INTEGER NOT NULL,
        UNIQUE(channel, origin, counter)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_client
        ON chat_messages(channel, origin, clientId) WHERE clientId IS NOT NULL;
      CREATE INDEX IF NOT EXISTS chat_messages_channel ON chat_messages(channel, seq);
      CREATE TABLE IF NOT EXISTS chat_cursors (
        member TEXT NOT NULL, channel TEXT NOT NULL, seq INTEGER NOT NULL,
        PRIMARY KEY (member, channel)
      );
    `)
  }

  /** LAN 层初始化后注入设备目录与推送通道。 */
  attach(directory: ChatDirectory, push: NonNullable<Options['push']>): void {
    this.directory = directory
    this.push = push
  }

  devices(): ChatDevice[] {
    return this.directory.list()
  }

  channel(id: string): ChatChannel | null {
    const row = this.store.db.prepare('SELECT * FROM chat_channels WHERE id=?').get(id) as
      | ChannelRow
      | undefined
    return row ? channelFromRow(row) : null
  }

  summaries(): ChatChannelSummary[] {
    const rows = this.store.db
      .prepare('SELECT * FROM chat_channels ORDER BY updatedAt DESC LIMIT 200')
      .all() as ChannelRow[]
    const count = this.store.db.prepare(
      'SELECT COUNT(*) AS count, MAX(seq) AS last FROM chat_messages WHERE channel=?'
    )
    const bySeq = this.store.db.prepare('SELECT * FROM chat_messages WHERE seq=?')
    return rows.map((row) => {
      const stats = count.get(row.id) as { count: number; last: number | null }
      const last = stats.last ? (bySeq.get(stats.last) as MessageRow) : undefined
      return {
        ...channelFromRow(row),
        count: stats.count,
        last: last ? messageFromRow(last) : null
      }
    })
  }

  /** 创建或合并频道；已有频道时设备与参与者取并集，重复调用幂等。 */
  createChannel(input: z.input<typeof createChannelSchema>): ChatChannel {
    const data = createChannelSchema.parse(input)
    const self = this.localDevice().id
    const devices = new Set([self])
    for (const value of data.devices ?? []) {
      const id = this.directory.resolve(value)
      if (!id) throw new SkillError(400, `未找到已配对设备：${value}`)
      devices.add(id)
    }
    const now = this.now()
    const channel = this.merge({
      id: data.id,
      title: data.title || data.id,
      devices: [...devices],
      members: data.members ?? [],
      createdBy: self,
      createdAt: now,
      updatedAt: now
    })
    this.changed()
    this.broadcast(channel, [])
    return channel
  }

  /** 本机写入一条消息并立即推送；clientId 相同则返回已存在的消息。 */
  post(input: z.input<typeof postSchema>): ChatMessage {
    const data = postSchema.parse(input)
    const origin = this.localDevice().id
    const message = this.store.db.transaction(() => {
      const channel = this.channel(data.channel)
      if (!channel) throw new SkillError(404, '频道不存在，请先创建')
      if (data.clientId) {
        const existing = this.store.db
          .prepare('SELECT * FROM chat_messages WHERE channel=? AND origin=? AND clientId=?')
          .get(data.channel, origin, data.clientId) as MessageRow | undefined
        if (existing) return { message: messageFromRow(existing), created: false }
      }
      const next =
        (
          this.store.db
            .prepare('SELECT MAX(counter) AS max FROM chat_messages WHERE channel=? AND origin=?')
            .get(data.channel, origin) as { max: number | null }
        ).max ?? 0
      const now = this.now()
      const row = this.insert({
        channel: data.channel,
        origin,
        counter: next + 1,
        from: data.from,
        to: data.to ?? null,
        type: data.type ?? 'text',
        body: data.body,
        replyTo: data.replyTo ?? null,
        clientId: data.clientId ?? null,
        createdAt: now
      })!
      this.addMembers(channel, [data.from, ...(data.to ? [data.to] : [])])
      return { message: row, created: true }
    })()
    if (message.created) {
      this.notify()
      this.broadcast(this.channel(data.channel)!, [message.message])
    }
    return message.message
  }

  history(channel: string, since = 0, limit = 500): ChatMessage[] {
    channelIdSchema.parse(channel)
    const rows = this.store.db
      .prepare(
        `SELECT * FROM (SELECT * FROM chat_messages WHERE channel=? AND seq>? ORDER BY seq DESC LIMIT ?)
         ORDER BY seq`
      )
      .all(channel, since, Math.min(Math.max(limit, 1), 2000)) as MessageRow[]
    return rows.map(messageFromRow)
  }

  /** 读取参与者尚未处理的消息；不包括自己发出的消息。 */
  pending(member: string, channels: string[], all = false): ChatMessage[] {
    const ids = this.resolveChannels(member, channels)
    if (!ids.length) return []
    const rows = this.store.db
      .prepare(
        `SELECT m.* FROM chat_messages m
         WHERE m.channel IN (${ids.map(() => '?').join(',')})
           AND m.seq > COALESCE((SELECT c.seq FROM chat_cursors c WHERE c.member=? AND c.channel=m.channel), 0)
           AND m.sender != ?
           AND (? OR m.recipient IS NULL OR m.recipient = ?)
         ORDER BY m.seq LIMIT ${SYNC_BATCH}`
      )
      .all(...ids, member, member, all ? 1 : 0, member) as MessageRow[]
    return rows.map(messageFromRow)
  }

  /**
   * 长轮询：有未读消息立即返回，否则等到新消息或超时。
   * 默认返回即视为已投递并推进游标；需要可靠处理的调用方可以 peek 后用 ack 推进。
   */
  async wait(input: WaitInput): Promise<ChatMessage[]> {
    const member = memberSchema.parse(input.member)
    const channels = input.channels.length ? input.channels : ['*']
    for (const channel of channels) if (channel !== '*') channelIdSchema.parse(channel)
    // 显式等待某个频道即表示加入，`*` 才能覆盖到这个频道。
    for (const id of channels) {
      const channel = id === '*' ? null : this.channel(id)
      if (channel) this.addMembers(channel, [member])
    }
    const deadline = this.now() + Math.min(Math.max(input.timeout, 0), MAX_WAIT_SECONDS) * 1000
    for (;;) {
      const messages = this.pending(member, channels, input.all)
      if (messages.length) {
        if (!input.peek) this.ack(member, messages)
        return messages
      }
      const remaining = deadline - this.now()
      if (remaining <= 0 || input.signal?.aborted) return []
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          this.waiters.delete(done)
          input.signal?.removeEventListener('abort', done)
          resolve()
        }
        const timer = setTimeout(done, remaining)
        this.waiters.add(done)
        input.signal?.addEventListener('abort', done)
      })
    }
  }

  /** 推进参与者在各频道的游标，只前进不后退。 */
  ack(member: string, messages: Pick<ChatMessage, 'channel' | 'seq'>[]): void {
    memberSchema.parse(member)
    const upsert = this.store.db.prepare(
      `INSERT INTO chat_cursors(member, channel, seq) VALUES(?,?,?)
       ON CONFLICT(member, channel) DO UPDATE SET seq=MAX(seq, excluded.seq)`
    )
    const latest = new Map<string, number>()
    for (const message of messages)
      latest.set(message.channel, Math.max(latest.get(message.channel) ?? 0, message.seq))
    this.store.db.transaction(() => {
      for (const [channel, seq] of latest) upsert.run(member, channel, seq)
    })()
  }

  /** 构造发给指定设备的同步请求：只包含双方共同持有的频道。 */
  syncRequest(deviceId: string): ChatSync {
    const channels: ChatSync['channels'] = {}
    for (const channel of this.channelsFor(deviceId)) channels[channel.id] = this.vector(channel.id)
    return { channels }
  }

  /** 回答对端同步请求：返回对端有权持有的频道定义与其缺失的消息。 */
  answerSync(deviceId: string, input: unknown): ChatPush & { more: boolean } {
    const request = syncSchema.parse(input)
    const channels = this.channelsFor(deviceId)
    const messages: ChatPush['messages'] = []
    let more = false
    const select = this.store.db.prepare(
      'SELECT * FROM chat_messages WHERE channel=? AND origin=? AND counter>? ORDER BY counter LIMIT ?'
    )
    const origins = this.store.db.prepare(
      'SELECT DISTINCT origin FROM chat_messages WHERE channel=?'
    )
    outer: for (const channel of channels) {
      const known = request.channels[channel.id] ?? {}
      for (const { origin } of origins.all(channel.id) as { origin: string }[]) {
        const rows = select.all(
          channel.id,
          origin,
          known[origin] ?? 0,
          SYNC_BATCH - messages.length + 1
        ) as MessageRow[]
        for (const row of rows) {
          if (messages.length >= SYNC_BATCH) {
            more = true
            break outer
          }
          messages.push(wireFromRow(row))
        }
      }
    }
    return { channels: channels.map(wireChannelOf), messages, more }
  }

  /**
   * 接收对端推送或同步响应。频道定义必须同时包含本机和对端；
   * 消息只接受本机已持有、且来源设备与发送设备都在成员中的频道。
   */
  ingest(deviceId: string, input: unknown): number {
    const payload = pushSchema.parse(input)
    const self = this.localDevice().id
    let inserted = 0
    let channelsChanged = false
    this.store.db.transaction(() => {
      for (const definition of payload.channels) {
        if (!definition.devices.includes(self) || !definition.devices.includes(deviceId)) continue
        const before = this.channel(definition.id)
        const after = this.merge(definition)
        if (!before || JSON.stringify(before) !== JSON.stringify(after)) channelsChanged = true
      }
      for (const message of payload.messages) {
        const channel = this.channel(message.channel)
        if (
          !channel ||
          !channel.devices.includes(deviceId) ||
          !channel.devices.includes(message.origin)
        )
          continue
        if (this.insert(message)) {
          inserted++
          this.addMembers(channel, [message.from, ...(message.to ? [message.to] : [])])
        }
      }
    })()
    if (inserted) this.notify()
    else if (channelsChanged) this.changed()
    return inserted
  }

  /** 关闭时唤醒所有长轮询，避免请求挂到超时。 */
  close(): void {
    for (const waiter of [...this.waiters]) waiter()
  }

  private resolveChannels(member: string, channels: string[]): string[] {
    const ids = new Set<string>()
    for (const id of channels) {
      if (id === '*') {
        for (const row of this.store.db
          .prepare('SELECT id, members FROM chat_channels')
          .all() as Pick<ChannelRow, 'id' | 'members'>[])
          if ((JSON.parse(row.members) as string[]).includes(member)) ids.add(row.id)
      } else ids.add(id)
    }
    return [...ids]
  }

  private channelsFor(deviceId: string): ChatChannel[] {
    return (this.store.db.prepare('SELECT * FROM chat_channels').all() as ChannelRow[])
      .map(channelFromRow)
      .filter((channel) => channel.devices.includes(deviceId))
  }

  /** 每个来源设备已连续持有的最大计数；中间有缺口时只算到缺口之前。 */
  private vector(channel: string): Record<string, number> {
    const rows = this.store.db
      .prepare(
        `SELECT origin, MAX(counter) AS counter FROM (
           SELECT origin, counter, ROW_NUMBER() OVER (PARTITION BY origin ORDER BY counter) AS rank
           FROM chat_messages WHERE channel=?
         ) WHERE counter = rank GROUP BY origin`
      )
      .all(channel) as { origin: string; counter: number }[]
    return Object.fromEntries(rows.map((row) => [row.origin, row.counter]))
  }

  private merge(incoming: ChatChannel): ChatChannel {
    const current = this.channel(incoming.id)
    const merged: ChatChannel = current
      ? {
          ...current,
          title: incoming.updatedAt > current.updatedAt ? incoming.title : current.title,
          devices: union(current.devices, incoming.devices),
          members: union(current.members, incoming.members),
          createdAt: Math.min(current.createdAt, incoming.createdAt),
          updatedAt: Math.max(current.updatedAt, incoming.updatedAt)
        }
      : { ...incoming, devices: union([], incoming.devices), members: union([], incoming.members) }
    this.store.db
      .prepare('INSERT OR REPLACE INTO chat_channels VALUES(?,?,?,?,?,?,?)')
      .run(
        merged.id,
        merged.title,
        JSON.stringify(merged.devices),
        JSON.stringify(merged.members),
        merged.createdBy,
        merged.createdAt,
        merged.updatedAt
      )
    return merged
  }

  private addMembers(channel: ChatChannel, members: string[]): void {
    const next = union(channel.members, members)
    if (next.length === channel.members.length) return
    channel.members = next
    this.store.db
      .prepare('UPDATE chat_channels SET members=?, updatedAt=MAX(updatedAt, ?) WHERE id=?')
      .run(JSON.stringify(next), this.now(), channel.id)
  }

  /** 写入一条消息；已存在（同一来源计数）时返回 null。 */
  private insert(message: ChatPush['messages'][number]): ChatMessage | null {
    const result = this.store.db
      .prepare(
        `INSERT OR IGNORE INTO chat_messages
         (channel, origin, counter, sender, recipient, type, body, replyTo, clientId, createdAt, receivedAt)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        message.channel,
        message.origin,
        message.counter,
        message.from,
        message.to,
        message.type,
        message.body,
        message.replyTo,
        message.clientId,
        message.createdAt,
        this.now()
      )
    if (!result.changes) return null
    return messageFromRow(
      this.store.db
        .prepare('SELECT * FROM chat_messages WHERE seq=?')
        .get(result.lastInsertRowid) as MessageRow
    )
  }

  private notify(): void {
    this.changed()
    for (const waiter of [...this.waiters]) waiter()
  }

  private broadcast(channel: ChatChannel, messages: ChatMessage[]): void {
    const self = this.localDevice().id
    const targets = channel.devices.filter((id) => id !== self)
    if (!targets.length || !this.push) return
    try {
      this.push(targets, { channels: [wireChannelOf(channel)], messages: messages.map(wireOf) })
    } catch {
      /* 推送失败不影响本机写入，周期同步会补齐。 */
    }
  }
}

export function matchesDevice(value: string, id: string, name: string): boolean {
  const normalize = (text: string) =>
    text
      .trim()
      .toLowerCase()
      .replace(/\.local$/, '')
  return value === id || normalize(value) === normalize(name)
}
function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])]
}
function channelFromRow(row: ChannelRow): ChatChannel {
  return {
    id: row.id,
    title: row.title,
    devices: JSON.parse(row.devices),
    members: JSON.parse(row.members),
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}
function wireChannelOf(channel: ChatChannel): ChatPush['channels'][number] {
  return { ...channel }
}
function messageFromRow(row: MessageRow): ChatMessage {
  return {
    seq: row.seq,
    id: `${row.origin}:${row.counter}`,
    channel: row.channel,
    origin: row.origin,
    counter: row.counter,
    from: row.sender,
    to: row.recipient,
    type: row.type,
    body: row.body,
    replyTo: row.replyTo,
    clientId: row.clientId,
    createdAt: row.createdAt,
    receivedAt: row.receivedAt
  }
}
function wireOf(message: ChatMessage): ChatPush['messages'][number] {
  return {
    channel: message.channel,
    origin: message.origin,
    counter: message.counter,
    from: message.from,
    to: message.to,
    type: message.type,
    body: message.body,
    replyTo: message.replyTo,
    clientId: message.clientId,
    createdAt: message.createdAt
  }
}
function wireFromRow(row: MessageRow): ChatPush['messages'][number] {
  return wireOf(messageFromRow(row))
}
