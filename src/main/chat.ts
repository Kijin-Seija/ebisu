import { z } from 'zod'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import type { Store } from './database'
import type { DeviceIdentity } from '../shared/lan'
import {
  chatImageMimes,
  type ChatAttachment,
  type ChatChannel,
  type ChatChannelSummary,
  type ChatDevice,
  type ChatImageMime,
  type ChatMessage,
  type ChatTombstone
} from '../shared/chat'
import { SkillError } from './skills'

/** 单条消息正文上限；大文件应通过 git 或附件链接传递。 */
export const MAX_CHAT_BODY = 32 * 1024
/** 单张图片附件上限。 */
export const MAX_CHAT_IMAGE_BYTES = 4 * 1024 * 1024
/** 单条消息最多携带的图片数量。 */
export const MAX_CHAT_ATTACHMENTS = 4
/** 图片按 mime 决定的文件扩展名；带扩展名便于 agent 工具按图片读取。 */
const IMAGE_EXTENSIONS: Record<ChatImageMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
}
/** 单次同步响应的消息条数上限，超过时返回 more=true 由调用方继续拉取。 */
const SYNC_BATCH = 200
/** 长轮询上限，需小于各终端单条命令的超时时间。 */
export const MAX_WAIT_SECONDS = 900
/** 频道最近活动超过该时长即视为闲置，由自动清理删除。 */
export const CHAT_IDLE_MS = 8 * 60 * 60 * 1000
/** 自动清理周期。 */
export const CHAT_CLEANUP_INTERVAL_MS = 8 * 60 * 60 * 1000
/** 启动后首次清理的延迟，避免与启动阶段的同步、建窗争用资源。 */
export const CHAT_CLEANUP_DELAY_MS = 60 * 1000
/** 删除标记保留时长；超过后清除，离线更久的设备可能重新带回旧频道。 */
export const CHAT_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** 单次同步/推送携带的删除标记上限。 */
const MAX_TOMBSTONES = 1000
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
export const chatHashSchema = z.string().regex(/^[a-f0-9]{64}$/, '图片哈希无效')
/** 附件文件名只用于展示：去掉路径分隔符与控制字符，不参与本机存储路径。 */
const fileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  // eslint-disable-next-line no-control-regex
  .transform((value) => value.replace(/[\\\/\u0000-\u001f\u007f]/g, '_'))
const mimeSchema = z.enum(chatImageMimes)
/** 线上传输的附件元数据；文件内容由接收方按哈希另行拉取。 */
const wireAttachment = z
  .object({
    hash: chatHashSchema,
    name: fileNameSchema,
    mime: mimeSchema,
    size: z.number().int().positive().max(MAX_CHAT_IMAGE_BYTES)
  })
  .strip()
type WireAttachment = z.infer<typeof wireAttachment>
/** 本机上传图片：data 为 base64；mime 可省略，始终以文件头魔数识别结果为准。 */
export const uploadSchema = z
  .object({
    channel: channelIdSchema,
    name: fileNameSchema,
    mime: mimeSchema.optional(),
    data: z
      .string()
      .min(1)
      .max(Math.ceil(MAX_CHAT_IMAGE_BYTES / 3) * 4 + 8)
  })
  .strict()

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
    model: z.string().trim().min(1).max(200).nullable().optional(),
    to: memberSchema.nullable().optional(),
    type: typeSchema.optional(),
    body: bodySchema,
    replyTo: z.string().max(200).nullable().optional(),
    clientId: z.string().min(1).max(200).nullable().optional(),
    /** 只能引用已通过 uploadFile 上传到该频道的图片；其余字段以上传记录为准。 */
    attachments: z
      .array(z.object({ hash: chatHashSchema }).strip())
      .max(MAX_CHAT_ATTACHMENTS)
      .optional()
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
    model: z.string().trim().min(1).max(200).optional(),
    to: memberSchema.nullable(),
    type: typeSchema,
    body: bodySchema,
    replyTo: z.string().max(200).nullable(),
    clientId: z.string().max(200).nullable(),
    createdAt: z.number().int().nonnegative(),
    /** 可选字段：旧版本对端 strip 后丢弃，不影响消息本身的复制。 */
    attachments: z.array(wireAttachment).max(MAX_CHAT_ATTACHMENTS).optional()
  })
  .strip()
/** 线上传输的频道删除标记；devices 为删除时持有副本的设备，用于限定传播范围。 */
const wireTombstone = z
  .object({
    id: channelIdSchema,
    deletedAt: z.number().int().nonnegative(),
    deletedBy: uuid,
    devices: z.array(uuid).min(1).max(32)
  })
  .strip()
/**
 * deleted 为可选字段：旧版本对端的同步响应不含该字段仍可解析；
 * 本机只在确有删除标记时才附带，尽量不影响只认识旧格式（strict）的对端。
 */
export const pushSchema = z
  .object({
    channels: z.array(wireChannel).max(1000),
    messages: z.array(wireMessage).max(SYNC_BATCH * 2),
    deleted: z.array(wireTombstone).max(MAX_TOMBSTONES).optional()
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
interface TombstoneRow {
  id: string
  deletedAt: number
  deletedBy: string
  devices: string
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
  /** 附件元数据 JSON；无附件时为 NULL。 */
  attachments: string | null
  /** 发送者模型标识；未知时为 NULL。 */
  model: string | null
}
interface FileRow {
  channel: string
  hash: string
  name: string
  mime: ChatImageMime
  size: number
}
/** 本机缺失、需要从频道内其他设备拉取的图片。 */
export interface MissingChatFile {
  channel: string
  hash: string
  size: number
  /** 频道持有副本的设备，按来源设备优先排列。 */
  devices: string[]
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
  /** 闲置阈值、清理周期、首次清理延迟与删除标记保留时长，测试时可缩短。 */
  idleMs?: number
  cleanupIntervalMs?: number
  cleanupDelayMs?: number
  tombstoneTtlMs?: number
  /** 图片附件目录；默认与数据库同目录下的 chat-files。 */
  filesDirectory?: string
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
  private readonly idleMs: number
  private readonly cleanupIntervalMs: number
  private readonly cleanupDelayMs: number
  private readonly tombstoneTtlMs: number
  /** 自动清理的首次延迟与周期定时器；close 时清除。 */
  private cleanupTimers: {
    delay?: ReturnType<typeof setTimeout>
    interval?: ReturnType<typeof setInterval>
  } = {}
  /** 图片按 sha256 内容寻址存放的目录，同一图片在多个频道间共享一份文件。 */
  readonly filesDirectory: string
  /** purge 释放引用的图片；事务结束后再检查引用并删除文件，避免回滚后文件已丢失。 */
  private released = new Set<string>()

  constructor(
    private readonly store: Store,
    private readonly localDevice: () => DeviceIdentity,
    options: Options = {}
  ) {
    this.now = options.now ?? Date.now
    this.changed = options.changed ?? (() => {})
    this.push = options.push
    this.idleMs = options.idleMs ?? CHAT_IDLE_MS
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? CHAT_CLEANUP_INTERVAL_MS
    this.cleanupDelayMs = options.cleanupDelayMs ?? CHAT_CLEANUP_DELAY_MS
    this.tombstoneTtlMs = options.tombstoneTtlMs ?? CHAT_TOMBSTONE_TTL_MS
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
      CREATE TABLE IF NOT EXISTS chat_deleted_channels (
        id TEXT PRIMARY KEY, deletedAt INTEGER NOT NULL, deletedBy TEXT NOT NULL,
        devices TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_files (
        channel TEXT NOT NULL, hash TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL,
        size INTEGER NOT NULL, PRIMARY KEY (channel, hash)
      );
      CREATE INDEX IF NOT EXISTS chat_files_hash ON chat_files(hash);
    `)
    // 旧版本数据库原地追加附件列；INSERT 使用显式列名，不受物理列顺序影响。
    const columns = store.db.prepare('PRAGMA table_info(chat_messages)').all() as {
      name: string
    }[]
    if (!columns.some((column) => column.name === 'attachments'))
      store.db.exec('ALTER TABLE chat_messages ADD COLUMN attachments TEXT')
    if (!columns.some((column) => column.name === 'model'))
      store.db.exec('ALTER TABLE chat_messages ADD COLUMN model TEXT')
    this.filesDirectory =
      options.filesDirectory ?? path.join(path.dirname(store.db.name), 'chat-files')
    try {
      this.sweepFiles()
    } catch (error) {
      console.warn('对话图片孤儿文件清理失败:', String(error))
    }
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
    const files = this.store.db.prepare('SELECT hash, mime FROM chat_files WHERE channel=?')
    return rows.map((row) => {
      const stats = count.get(row.id) as { count: number; last: number | null }
      const last = stats.last ? (bySeq.get(stats.last) as MessageRow) : undefined
      return {
        ...channelFromRow(row),
        count: stats.count,
        last: last ? this.messageOf(last) : null,
        pendingFiles: (files.all(row.id) as Pick<FileRow, 'hash' | 'mime'>[]).filter(
          (file) => !existsSync(this.filePath(file.hash, file.mime))
        ).length
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
    // 频道曾被删除时，新建时间必须晚于删除时间，否则会被各设备的删除标记再次过滤。
    const tombstone = this.tombstone(data.id)
    const now = Math.max(this.now(), tombstone ? tombstone.deletedAt + 1 : 0)
    const existing = this.channel(data.id)
    const channel = this.merge({
      id: data.id,
      // 未提供标题的重复创建不能用默认标题覆盖已有标题。
      title: data.title || existing?.title || data.id,
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

  /**
   * 删除频道：本机立即删除频道、消息与游标，并写入删除标记推送给其他持有副本的设备。
   * 删除标记会随同步传播，离线设备上线后同样删除；之后旧副本的推送不会让频道复活。
   */
  deleteChannel(id: string): ChatTombstone {
    channelIdSchema.parse(id)
    const transaction = this.store.db.transaction(() => {
      const channel = this.channel(id)
      if (!channel) throw new SkillError(404, '频道不存在')
      const latest = (
        this.store.db
          .prepare('SELECT MAX(createdAt) AS latest FROM chat_messages WHERE channel=?')
          .get(id) as { latest: number | null }
      ).latest
      // 删除时间取本机时间与频道内所有时间戳的最大值：对端时钟偏快时，
      // 其写入的频道/消息时间仍不晚于删除时间，保证在所有设备上都被覆盖。
      const deletedAt = Math.max(this.now(), channel.createdAt, channel.updatedAt, latest ?? 0)
      const value: ChatTombstone = {
        id,
        deletedAt,
        deletedBy: this.localDevice().id,
        devices: channel.devices
      }
      this.saveTombstone(value)
      this.purge(id)
      return value
    })
    let tombstone: ChatTombstone
    try {
      tombstone = transaction()
    } finally {
      this.releaseFiles()
    }
    this.notify()
    this.pushTombstone(tombstone)
    return tombstone
  }

  /** 读取频道删除标记；不存在时返回 null。 */
  tombstone(id: string): ChatTombstone | null {
    const row = this.store.db.prepare('SELECT * FROM chat_deleted_channels WHERE id=?').get(id) as
      | TombstoneRow
      | undefined
    return row ? tombstoneFromRow(row) : null
  }

  /**
   * 闲置清理：最近活动（最后一条消息时间与频道更新时间取较大者）早于 now - idleMs 的频道被删除，
   * 同时清除超过保留期的删除标记。各设备按同一规则独立执行，删除经删除标记传播。
   * 返回本次删除的频道 ID。
   */
  cleanup(): string[] {
    const now = this.now()
    const rows = this.store.db
      .prepare(
        `SELECT c.id, MAX(c.updatedAt, COALESCE(MAX(m.createdAt), 0)) AS active
         FROM chat_channels c LEFT JOIN chat_messages m ON m.channel = c.id
         GROUP BY c.id`
      )
      .all() as { id: string; active: number }[]
    const removed: string[] = []
    for (const row of rows) {
      if (now - row.active <= this.idleMs) continue
      try {
        this.deleteChannel(row.id)
        removed.push(row.id)
      } catch {
        /* 并发删除等情况下跳过该频道，下一轮再处理。 */
      }
    }
    this.store.db
      .prepare('DELETE FROM chat_deleted_channels WHERE deletedAt < ?')
      .run(now - this.tombstoneTtlMs)
    return removed
  }

  /** 启动自动清理：延迟 cleanupDelayMs 执行一次，之后每 cleanupIntervalMs 执行一次；重复调用无副作用。 */
  startCleanup(): void {
    if (this.cleanupTimers.delay || this.cleanupTimers.interval) return
    const run = () => {
      try {
        this.cleanup()
      } catch (error) {
        console.warn('对话频道自动清理失败:', String(error))
      }
    }
    this.cleanupTimers.delay = setTimeout(() => {
      this.cleanupTimers.delay = undefined
      run()
      this.cleanupTimers.interval = setInterval(run, this.cleanupIntervalMs)
      this.cleanupTimers.interval.unref?.()
    }, this.cleanupDelayMs)
    this.cleanupTimers.delay.unref?.()
  }

  /** 停止自动清理定时器。 */
  stopCleanup(): void {
    clearTimeout(this.cleanupTimers.delay)
    clearInterval(this.cleanupTimers.interval)
    this.cleanupTimers = {}
  }

  /** 本机写入一条消息并立即推送；clientId 相同则返回已存在的消息。 */
  post(input: z.input<typeof postSchema>): ChatMessage {
    const data = postSchema.parse(input)
    const origin = this.localDevice().id
    const message = this.store.db.transaction(() => {
      const channel = this.channel(data.channel)
      if (!channel) throw new SkillError(404, '频道不存在，请先创建')
      // 本机时钟落后于删除时间时，新消息会被各设备当作删除前的旧消息过滤，这里抬高到删除时间之后。
      const tombstone = this.tombstone(data.channel)
      if (data.clientId) {
        const existing = this.store.db
          .prepare('SELECT * FROM chat_messages WHERE channel=? AND origin=? AND clientId=?')
          .get(data.channel, origin, data.clientId) as MessageRow | undefined
        if (existing) return { message: this.messageOf(existing), created: false }
      }
      const next =
        (
          this.store.db
            .prepare('SELECT MAX(counter) AS max FROM chat_messages WHERE channel=? AND origin=?')
            .get(data.channel, origin) as { max: number | null }
        ).max ?? 0
      const now = Math.max(this.now(), tombstone ? tombstone.deletedAt + 1 : 0)
      const attachments = this.resolveAttachments(data.channel, data.attachments ?? [])
      const model =
        data.model ?? this.resolveSenderModel(data.channel, data.from, data.type, data.body)
      const row = this.insert({
        channel: data.channel,
        origin,
        counter: next + 1,
        from: data.from,
        ...(model ? { model } : {}),
        to: data.to ?? null,
        type: data.type ?? 'text',
        body: data.body,
        replyTo: data.replyTo ?? null,
        clientId: data.clientId ?? null,
        createdAt: now,
        ...(attachments.length ? { attachments } : {})
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
    return rows.map((row) => this.messageOf(row))
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
    return rows.map((row) => this.messageOf(row))
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
    const deleted = this.tombstonesFor(deviceId)
    return {
      channels: channels.map(wireChannelOf),
      messages,
      more,
      ...(deleted.length ? { deleted } : {})
    }
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
    const transaction = this.store.db.transaction(() => {
      // 先处理删除标记：同一批中重建的频道定义与新消息排在其后，不会被误删。
      for (const tombstone of payload.deleted ?? []) {
        if (!tombstone.devices.includes(self) || !tombstone.devices.includes(deviceId)) continue
        if (this.applyTombstone(tombstone, deviceId)) channelsChanged = true
      }
      for (const definition of payload.channels) {
        if (!definition.devices.includes(self) || !definition.devices.includes(deviceId)) continue
        // 删除之前创建的频道定义来自旧副本，忽略以免复活。
        if (this.deletedBefore(definition.id, definition.createdAt)) continue
        const before = this.channel(definition.id)
        const after = this.merge(definition)
        if (!before || JSON.stringify(before) !== JSON.stringify(after)) channelsChanged = true
      }
      for (const message of payload.messages) {
        const channel = this.channel(message.channel)
        if (
          !channel ||
          !channel.devices.includes(deviceId) ||
          !channel.devices.includes(message.origin) ||
          this.deletedBefore(message.channel, message.createdAt)
        )
          continue
        if (this.insert(message)) {
          inserted++
          this.addMembers(channel, [message.from, ...(message.to ? [message.to] : [])])
        }
      }
    })
    try {
      transaction()
    } finally {
      // 删除标记可能清除了频道，事务提交（或回滚）后再按引用删除图片文件。
      this.releaseFiles()
    }
    if (inserted || channelsChanged) this.notify()
    return inserted
  }

  /** 关闭时停止自动清理并唤醒所有长轮询，避免请求挂到超时。 */
  close(): void {
    this.stopCleanup()
    for (const waiter of [...this.waiters]) waiter()
  }

  /** 时间戳不晚于该频道删除时间时返回 true，表示属于已删除的旧副本。 */
  private deletedBefore(channel: string, createdAt: number): boolean {
    const tombstone = this.tombstone(channel)
    return !!tombstone && createdAt <= tombstone.deletedAt
  }

  /**
   * 合并删除标记：删除时间取较大值、设备取并集。本机副本创建时间不晚于删除时间、
   * 且发送方确实持有该频道时删除本机副本；删除后重建的新频道（创建时间更晚）保留。
   * 返回是否删除了本机频道。
   */
  private applyTombstone(incoming: ChatTombstone, deviceId: string): boolean {
    const current = this.tombstone(incoming.id)
    const merged: ChatTombstone =
      current && current.deletedAt >= incoming.deletedAt
        ? { ...current, devices: union(current.devices, incoming.devices) }
        : { ...incoming, devices: union(current?.devices ?? [], incoming.devices) }
    this.saveTombstone(merged)
    const channel = this.channel(incoming.id)
    if (!channel || !channel.devices.includes(deviceId)) return false
    if (channel.createdAt > merged.deletedAt) return false
    this.purge(incoming.id)
    return true
  }

  private saveTombstone(tombstone: ChatTombstone): void {
    this.store.db
      .prepare('INSERT OR REPLACE INTO chat_deleted_channels VALUES(?,?,?,?)')
      .run(
        tombstone.id,
        tombstone.deletedAt,
        tombstone.deletedBy,
        JSON.stringify(tombstone.devices)
      )
  }

  /**
   * 删除本机频道副本：频道定义、全部消息、各参与者游标与图片引用。
   * 本地删除、对端删除标记与闲置清理都经过这里；图片文件在事务结束后由 releaseFiles 按引用删除。
   */
  private purge(id: string): void {
    for (const { hash } of this.store.db
      .prepare('SELECT hash FROM chat_files WHERE channel=?')
      .all(id) as { hash: string }[])
      this.released.add(hash)
    this.store.db.prepare('DELETE FROM chat_files WHERE channel=?').run(id)
    this.store.db.prepare('DELETE FROM chat_messages WHERE channel=?').run(id)
    this.store.db.prepare('DELETE FROM chat_cursors WHERE channel=?').run(id)
    this.store.db.prepare('DELETE FROM chat_channels WHERE id=?').run(id)
  }

  /** 发给指定设备的删除标记：只包含删除时该设备持有副本的频道，按时间倒序截断。 */
  private tombstonesFor(deviceId: string): ChatTombstone[] {
    return (
      this.store.db
        .prepare('SELECT * FROM chat_deleted_channels ORDER BY deletedAt DESC')
        .all() as TombstoneRow[]
    )
      .map(tombstoneFromRow)
      .filter((tombstone) => tombstone.devices.includes(deviceId))
      .slice(0, MAX_TOMBSTONES)
  }

  private pushTombstone(tombstone: ChatTombstone): void {
    const self = this.localDevice().id
    const targets = tombstone.devices.filter((id) => id !== self)
    if (!targets.length || !this.push) return
    try {
      this.push(targets, { channels: [], messages: [], deleted: [tombstone] })
    } catch {
      /* 推送失败由周期同步补齐。 */
    }
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

  /**
   * 推断本机发送者当前使用的模型：优先匹配该频道认领绑定的会话 ID，
   * 其次回退到该终端在本机最近活跃会话上报的模型。
   */
  private resolveSenderModel(
    channel: string,
    sender: string,
    type?: string,
    body?: string
  ): string | undefined {
    const terminal = sender.split('/').pop()?.toLowerCase()
    if (!terminal) return undefined
    let sessionId = type === 'claim' && body ? parseClaimSession(body) : undefined
    if (!sessionId) {
      const claims = this.store.db
        .prepare(
          "SELECT body FROM chat_messages WHERE channel=? AND sender=? AND type='claim' ORDER BY seq DESC LIMIT 5"
        )
        .all(channel, sender) as { body: string }[]
      for (const claim of claims) {
        sessionId = parseClaimSession(claim.body)
        if (sessionId) break
      }
    }
    if (sessionId) {
      const bound = this.store.db
        .prepare(
          "SELECT model FROM activities WHERE terminal=? AND sessionId=? AND model IS NOT NULL AND model != '' ORDER BY lastSeen DESC LIMIT 1"
        )
        .get(terminal, sessionId) as { model: string } | undefined
      if (bound?.model) return bound.model
    }
    const latest = this.store.db
      .prepare(
        "SELECT model FROM activities WHERE terminal=? AND model IS NOT NULL AND model != '' ORDER BY active DESC, lastSeen DESC LIMIT 1"
      )
      .get(terminal) as { model: string } | undefined
    return latest?.model
  }

  /**
   * 写入一条消息；已存在（同一来源计数）时返回 null。
   * 带附件时同时登记频道图片引用：本机缺失的文件由 LAN 层按 missingFiles 异步拉取。
   */
  private insert(message: ChatPush['messages'][number]): ChatMessage | null {
    const attachments = message.attachments ?? []
    const result = this.store.db
      .prepare(
        `INSERT OR IGNORE INTO chat_messages
         (channel, origin, counter, sender, recipient, type, body, replyTo, clientId, createdAt, receivedAt, attachments, model)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
        this.now(),
        attachments.length ? JSON.stringify(attachments) : null,
        message.model ?? null
      )
    if (!result.changes) return null
    const link = this.store.db.prepare('INSERT OR IGNORE INTO chat_files VALUES(?,?,?,?,?)')
    for (const file of attachments)
      link.run(message.channel, file.hash, file.name, file.mime, file.size)
    return this.messageOf(
      this.store.db
        .prepare('SELECT * FROM chat_messages WHERE seq=?')
        .get(result.lastInsertRowid) as MessageRow
    )
  }

  /** 行转消息：附件补充本机文件路径；文件尚未下载时 path 为 null 并标记 pending。 */
  private messageOf(row: MessageRow): ChatMessage {
    const attachments = parseAttachments(row.attachments)
    return {
      ...messageFromRow(row),
      ...(attachments.length
        ? { attachments: attachments.map((file) => this.localAttachment(file)) }
        : {})
    }
  }

  private localAttachment(file: WireAttachment): ChatAttachment {
    const target = this.filePath(file.hash, file.mime)
    return existsSync(target) ? { ...file, path: target } : { ...file, path: null, pending: true }
  }

  /** 图片在本机的存储路径；文件名由哈希与 mime 决定，不使用调用方提供的文件名。 */
  filePath(hash: string, mime: ChatImageMime): string {
    return path.join(this.filesDirectory, `${chatHashSchema.parse(hash)}.${IMAGE_EXTENSIONS[mime]}`)
  }

  /**
   * 校验 post 引用的附件：必须已上传到同一频道（chat_files 有记录）且本机文件存在。
   * 重复的哈希只保留一次；元数据以上传记录为准。
   */
  private resolveAttachments(channel: string, input: { hash: string }[]): WireAttachment[] {
    const select = this.store.db.prepare('SELECT * FROM chat_files WHERE channel=? AND hash=?')
    const result: WireAttachment[] = []
    for (const hash of new Set(input.map((item) => item.hash))) {
      const row = select.get(channel, hash) as FileRow | undefined
      if (!row || !existsSync(this.filePath(row.hash, row.mime)))
        throw new SkillError(400, `图片未上传到该频道：${hash}`)
      result.push({ hash: row.hash, name: row.name, mime: row.mime, size: row.size })
    }
    return result
  }

  /**
   * 本机上传图片：校验 base64、大小与文件头魔数，按 sha256 写入内容寻址目录并登记频道引用。
   * 声明的 mime 与实际内容不一致时拒绝；重复上传同一内容幂等。
   */
  uploadFile(input: z.input<typeof uploadSchema>): ChatAttachment {
    const data = uploadSchema.parse(input)
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data.data))
      throw new SkillError(400, '图片数据不是有效的 base64')
    const buffer = Buffer.from(data.data, 'base64')
    if (!buffer.length) throw new SkillError(400, '图片内容为空')
    if (buffer.length > MAX_CHAT_IMAGE_BYTES) throw new SkillError(413, '图片超过 4 MiB')
    const mime = detectImageMime(buffer)
    if (!mime) throw new SkillError(415, '仅支持 PNG、JPEG、GIF、WebP 图片')
    if (data.mime && data.mime !== mime)
      throw new SkillError(400, `图片内容（${mime}）与声明的类型（${data.mime}）不一致`)
    if (!this.channel(data.channel)) throw new SkillError(404, '频道不存在，请先创建')
    const hash = sha256(buffer)
    this.writeFile(hash, mime, buffer)
    this.store.db
      .prepare('INSERT OR IGNORE INTO chat_files VALUES(?,?,?,?,?)')
      .run(data.channel, hash, data.name, mime, buffer.length)
    const row = this.store.db
      .prepare('SELECT * FROM chat_files WHERE channel=? AND hash=?')
      .get(data.channel, hash) as FileRow
    // 只返回附件元数据，不把内部的 channel 列带给调用方
    return this.localAttachment({ hash: row.hash, name: row.name, mime: row.mime, size: row.size })
  }

  /**
   * 保存从对端拉取的图片：只接受本机频道已登记的哈希，并校验大小、sha256 与魔数。
   * 频道在下载期间被删除时丢弃数据并返回 false。
   */
  storeFile(channel: string, hash: string, data: Buffer): boolean {
    const row = this.store.db
      .prepare('SELECT * FROM chat_files WHERE channel=? AND hash=?')
      .get(channel, hash) as FileRow | undefined
    if (!row) return false
    if (data.length !== row.size || sha256(data) !== hash || detectImageMime(data) !== row.mime)
      throw new SkillError(400, '图片校验失败')
    if (existsSync(this.filePath(hash, row.mime))) return true
    this.writeFile(hash, row.mime, data)
    this.notify()
    return true
  }

  /**
   * 回答对端的图片拉取：请求设备必须持有该频道副本，且该频道引用了此哈希、本机文件存在。
   */
  readFileFor(
    deviceId: string,
    channel: string,
    hash: string
  ): { data: string; mime: ChatImageMime; size: number } {
    channelIdSchema.parse(channel)
    chatHashSchema.parse(hash)
    const definition = this.channel(channel)
    if (!definition || !definition.devices.includes(deviceId))
      throw new SkillError(403, '无权访问该频道图片')
    const row = this.store.db
      .prepare('SELECT * FROM chat_files WHERE channel=? AND hash=?')
      .get(channel, hash) as FileRow | undefined
    const target = row && this.filePath(row.hash, row.mime)
    if (!row || !target || !existsSync(target)) throw new SkillError(404, '图片不存在')
    return { data: readFileSync(target).toString('base64'), mime: row.mime, size: row.size }
  }

  /** 界面显示用：任一频道引用了该哈希且本机文件存在时返回路径与类型。 */
  imageFile(hash: string): { path: string; mime: ChatImageMime } | null {
    if (!chatHashSchema.safeParse(hash).success) return null
    const row = this.store.db
      .prepare('SELECT mime FROM chat_files WHERE hash=? LIMIT 1')
      .get(hash) as Pick<FileRow, 'mime'> | undefined
    if (!row) return null
    const target = this.filePath(hash, row.mime)
    return existsSync(target) ? { path: target, mime: row.mime } : null
  }

  /** 本机已登记但文件缺失的图片，供 LAN 层从频道内其他设备拉取；同一哈希只返回一次。 */
  missingFiles(limit = 64): MissingChatFile[] {
    const rows = this.store.db.prepare('SELECT * FROM chat_files ORDER BY rowid').all() as FileRow[]
    const seen = new Set<string>()
    const result: MissingChatFile[] = []
    const origins = this.store.db.prepare(
      `SELECT DISTINCT origin FROM chat_messages WHERE channel=? AND attachments LIKE ?`
    )
    for (const row of rows) {
      if (result.length >= limit) break
      if (seen.has(row.hash) || existsSync(this.filePath(row.hash, row.mime))) continue
      const channel = this.channel(row.channel)
      if (!channel) continue
      seen.add(row.hash)
      // 优先向引用该图片的消息来源设备拉取，其次是频道内其他设备。
      const preferred = (origins.all(row.channel, `%${row.hash}%`) as { origin: string }[]).map(
        (item) => item.origin
      )
      const self = this.localDevice().id
      result.push({
        channel: row.channel,
        hash: row.hash,
        size: row.size,
        devices: union(preferred, channel.devices).filter((id) => id !== self)
      })
    }
    return result
  }

  /**
   * 清理孤儿文件：目录中没有任何频道引用的图片与写入中断留下的临时文件。
   * 启动时执行一次；正常删除路径由 releaseFiles 即时处理。
   */
  sweepFiles(): number {
    if (!existsSync(this.filesDirectory)) return 0
    const referenced = this.store.db.prepare('SELECT 1 FROM chat_files WHERE hash=? LIMIT 1')
    let removed = 0
    for (const name of readdirSync(this.filesDirectory)) {
      const match = /^([a-f0-9]{64})\.(png|jpg|gif|webp)$/.exec(name)
      if (match && referenced.get(match[1])) continue
      rmSync(path.join(this.filesDirectory, name), { force: true, recursive: true })
      removed++
    }
    return removed
  }

  /** 删除 purge 释放、且已不被任何频道引用的图片文件；共享同一图片的其他频道保留文件。 */
  private releaseFiles(): void {
    if (!this.released.size) return
    const hashes = [...this.released]
    this.released.clear()
    const referenced = this.store.db.prepare('SELECT 1 FROM chat_files WHERE hash=? LIMIT 1')
    for (const hash of hashes) {
      if (referenced.get(hash)) continue
      for (const extension of Object.values(IMAGE_EXTENSIONS))
        try {
          rmSync(path.join(this.filesDirectory, `${hash}.${extension}`), { force: true })
        } catch (error) {
          console.warn('删除对话图片失败:', String(error))
        }
    }
  }

  /** 原子写入图片文件：先写临时文件再重命名，已存在时跳过。 */
  private writeFile(hash: string, mime: ChatImageMime, data: Buffer): void {
    const target = this.filePath(hash, mime)
    if (existsSync(target)) return
    mkdirSync(this.filesDirectory, { recursive: true, mode: 0o700 })
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, data, { mode: 0o600 })
      renameSync(temporary, target)
    } finally {
      rmSync(temporary, { force: true })
    }
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
      // 重建过的频道附带删除标记，让仍持有旧副本的设备先删除旧副本再接收新频道。
      const tombstone = this.tombstone(channel.id)
      this.push(targets, {
        channels: [wireChannelOf(channel)],
        messages: messages.map(wireOf),
        ...(tombstone ? { deleted: [tombstone] } : {})
      })
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
function tombstoneFromRow(row: TombstoneRow): ChatTombstone {
  return {
    id: row.id,
    deletedAt: row.deletedAt,
    deletedBy: row.deletedBy,
    devices: JSON.parse(row.devices)
  }
}
function wireChannelOf(channel: ChatChannel): ChatPush['channels'][number] {
  return { ...channel }
}
function messageFromRow(row: MessageRow): Omit<ChatMessage, 'attachments'> {
  return {
    seq: row.seq,
    id: `${row.origin}:${row.counter}`,
    channel: row.channel,
    origin: row.origin,
    counter: row.counter,
    from: row.sender,
    ...(row.model ? { model: row.model } : {}),
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
  // 附件只传元数据（去掉本机 path/pending）；无附件时不带该字段，保持旧格式。
  const attachments = (message.attachments ?? []).map(({ hash, name, mime, size }) => ({
    hash,
    name,
    mime,
    size
  }))
  return {
    channel: message.channel,
    origin: message.origin,
    counter: message.counter,
    from: message.from,
    ...(message.model ? { model: message.model } : {}),
    to: message.to,
    type: message.type,
    body: message.body,
    replyTo: message.replyTo,
    clientId: message.clientId,
    createdAt: message.createdAt,
    ...(attachments.length ? { attachments } : {})
  }
}
function parseClaimSession(body: string): string | undefined {
  try {
    const session = JSON.parse(body)?.session
    return typeof session === 'string' && session.trim() ? session.trim() : undefined
  } catch {
    return undefined
  }
}
function wireFromRow(row: MessageRow): ChatPush['messages'][number] {
  const attachments = parseAttachments(row.attachments)
  return wireOf({ ...messageFromRow(row), attachments: attachments.map(withoutPath) })
}
function withoutPath(file: WireAttachment): ChatAttachment {
  return { ...file, path: null }
}
/** 解析库内附件 JSON；损坏或不合法时视为无附件，不影响消息读取。 */
function parseAttachments(value: string | null): WireAttachment[] {
  if (!value) return []
  try {
    const parsed = z.array(wireAttachment).max(MAX_CHAT_ATTACHMENTS).safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}
/** 按文件头魔数识别图片类型；不是支持的图片格式时返回 null。 */
export function detectImageMime(data: Buffer): ChatImageMime | null {
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
    return 'image/jpeg'
  if (data.length >= 6) {
    const head = data.subarray(0, 6).toString('latin1')
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif'
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('latin1') === 'RIFF' &&
    data.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp'
  return null
}
export function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}
