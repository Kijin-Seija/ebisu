import { createServer, request, Agent, type Server, type RequestOptions } from 'node:https'
import { connect, type TLSSocket } from 'node:tls'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { hostname, networkInterfaces } from 'node:os'
import { isIP } from 'node:net'
import type { Duplex } from 'node:stream'
import path from 'node:path'
import { Bonjour, type Browser, type Service } from 'bonjour-service'
import { generate } from 'selfsigned'
import { z } from 'zod'
import type {
  DeviceIdentity,
  LanView,
  PairOutcome,
  SharedSnapshot,
  SkillExport
} from '../shared/lan'
import { activityPhases, terminalIds } from '../shared/types'
import { packageSchema, SkillError, type Skills } from './skills'
import type { Store } from './database'
import { SkillTransfer, packageHash } from './skill-transfer'

const PROTOCOL = 1
const MAX_BODY = 12 * 1024 * 1024
/** 配对请求与确认结果的有效期；过期后双方都必须重新发起。 */
const PAIR_TTL = 300_000
/** 单次 IPC 等待对方确认的时长；超时后后台仍会在有效期内继续完成配对。 */
const PAIR_WAIT = 60_000
/** 同时展示的待确认请求上限，避免发现到的设备批量占据界面。 */
const MAX_PAIR_REQUESTS = 8
const identitySchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  protocol: z.number().int().positive()
})
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/)
const addressSchema = z
  .string()
  .max(256)
  .refine((address) => {
    try {
      const url = new URL(`https://${address}`)
      const host = url.hostname.replace(/^\[|\]$/g, '')
      // 局域网功能不接受域名、凭据、路径和公网目标，避免配对信息成为通用网络代理。
      return (
        url.host === address &&
        !url.username &&
        !url.password &&
        isIP(host) !== 0 &&
        isLocalAddress(host)
      )
    } catch {
      return false
    }
  }, '请输入局域网 IP:端口')
export function isLocalAddress(host: string): boolean {
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number)
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    )
  }
  return isIP(host) === 6 && (host === '::1' || /^(fc|fd|fe[89ab])/i.test(host))
}
const sessionSchema = z.object({
  terminal: z.enum(terminalIds),
  sessionId: z.string().min(1).max(512),
  phase: z.enum(activityPhases),
  model: z.string().max(256).nullable(),
  taskTitle: z.string().max(512).nullable().optional(),
  lastSeen: z.number(),
  startedAt: z.number()
})
const summarySchema = z.object({
  id: z.string().uuid(),
  name: z.string().max(63),
  description: z.string().max(2048),
  createdAt: z.number(),
  source: z.string().max(1024).nullable(),
  installations: z
    .array(z.object({ terminal: z.enum(terminalIds), installedAt: z.number() }))
    .max(5)
})
const sharedSchema = z.object({
  device: identitySchema,
  folders: z
    .array(
      z.object({
        id: z.string().uuid(),
        path: z.string().max(16384),
        name: z.string().max(100),
        createdAt: z.number(),
        available: z.boolean(),
        git: z
          .object({
            branch: z.string().max(4096),
            clean: z.boolean(),
            added: z.number(),
            deleted: z.number(),
            modified: z.number(),
            error: z.string().max(8192).optional()
          })
          .nullable(),
        sessions: z.array(sessionSchema).max(10000)
      })
    )
    .max(10000),
  skills: z.array(summarySchema).max(10000)
})
const exportSchema = z.object({
  skillId: z.string().uuid(),
  package: packageSchema,
  hash: fingerprintSchema
})
interface Identity extends DeviceIdentity {
  cert: string
  private: string
  fingerprint: string
}
interface Peer {
  device: DeviceIdentity
  fingerprint: string
  address: string
  lastSeen: number | null
  etag?: string
  snapshot: SharedSnapshot | null
  error?: string
}
interface PairRequest {
  id: string
  device: DeviceIdentity
  address: string
  /** 对端 TLS 客户端证书指纹；不接受请求体自报的指纹。 */
  fingerprint: string
  expires: number
}
interface ResolvedPairRequest {
  status: 'accepted' | 'declined'
  fingerprint: string
  expires: number
}
interface OutgoingPairRequest {
  id: string
  deviceId: string
  address: string
  fingerprint: string
  expires: number
  /** 等待对方确认的调用方；结果只用于界面提示，配对成功后由快照驱动。 */
  waiters: Set<(outcome: PairOutcome) => void>
  outcome?: PairOutcome
  checking?: Promise<void>
}
interface Options {
  directory: string
  snapshot: () => Promise<Pick<SharedSnapshot, 'folders' | 'skills'>>
  changed: () => void
  now?: () => number
  /** 有新配对请求时由宿主把主窗口带到前台，弹窗不能藏在后台窗口里。 */
  request?: () => void
  /** 测试可以关闭真实组播，但 HTTPS 通信仍走真实 socket。 */
  discovery?: boolean
}

/** LAN 服务只发布本机白名单 DTO；缓存永远不能进入本机目录、租约或安装业务表。 */
export class Lan {
  readonly transfer: SkillTransfer
  private identity!: Identity
  private enabled = false
  private server?: Server
  private port: number | null = null
  private error?: string
  private peers = new Map<string, Peer>()
  private discovered = new Map<
    string,
    DeviceIdentity & { address: string; fingerprint: string | null }
  >()
  private candidates = new Map<string, string>()
  private refreshes = new Map<string, Promise<void>>()
  private sockets = new Set<Duplex>()
  private lastDiscovery = 0
  private bonjour?: Bonjour
  private browser?: Browser
  private publication?: Service
  private timer?: ReturnType<typeof setInterval>
  private polling?: Promise<void>
  private pendingRequests = new Set<ReturnType<typeof request>>()
  /** 等待本机用户确认的请求；只在内存中保存，关闭共享或重启后失效。 */
  private pairRequests = new Map<string, PairRequest>()
  /** 已确认/拒绝的结果供发起方轮询一次，保留到请求有效期结束。 */
  private resolvedPairs = new Map<string, ResolvedPairRequest>()
  /** 本机发起、仍在等待对方确认的请求，按目标设备去重。 */
  private outgoingPairs = new Map<string, OutgoingPairRequest>()
  private configuring: Promise<unknown> = Promise.resolve()
  private now: () => number
  constructor(
    private store: Store,
    skills: Skills,
    private options: Options
  ) {
    this.now = options.now ?? Date.now
    this.transfer = new SkillTransfer(store, skills, this.now)
    store.db.exec(`CREATE TABLE IF NOT EXISTS lan_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lan_peers(id TEXT PRIMARY KEY,value TEXT NOT NULL);`)
    for (const row of store.db.prepare('SELECT id,value FROM lan_peers').all() as {
      id: string
      value: string
    }[])
      this.peers.set(row.id, JSON.parse(row.value))
  }
  async initialize(): Promise<void> {
    const file = path.join(this.options.directory, 'lan-identity.json')
    if (existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as Identity
      identitySchema.parse(saved)
      this.identity = saved
    } else {
      const keys = await new Promise<{ cert: string; private: string }>((resolve, reject) =>
        generate(
          [{ name: 'commonName', value: 'Ebisu LAN' }],
          {
            keySize: 2048,
            days: 3650,
            algorithm: 'sha256',
            extensions: [
              { name: 'basicConstraints', cA: false },
              { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
              { name: 'extKeyUsage', serverAuth: true, clientAuth: true }
            ]
          },
          (error, result) => (error ? reject(error) : resolve(result))
        )
      )
      const { X509Certificate } = await import('node:crypto')
      this.identity = {
        id: randomUUID(),
        name: hostname().slice(0, 100) || 'Ebisu',
        protocol: PROTOCOL,
        cert: keys.cert,
        private: keys.private,
        fingerprint: fingerprint(new X509Certificate(keys.cert).raw)
      }
      this.saveIdentity()
    }
    const config = this.store.db
      .prepare("SELECT value FROM lan_state WHERE key='enabled'")
      .get() as { value: string } | undefined
    if (config?.value === 'true') {
      try {
        await this.configure(true, this.identity.name)
      } catch {
        /* 错误显示在设置页，本机业务继续运行。 */
      }
    }
  }
  private saveIdentity(): void {
    const file = path.join(this.options.directory, 'lan-identity.json')
    writeFileSync(`${file}.tmp`, JSON.stringify(this.identity), { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
    this.store.db
      .prepare("INSERT OR REPLACE INTO lan_state VALUES('device',?)")
      .run(JSON.stringify(this.device()))
  }
  device(): DeviceIdentity {
    return { id: this.identity.id, name: this.identity.name, protocol: PROTOCOL }
  }
  private addresses(): string[] {
    if (!this.port) return []
    return Object.values(networkInterfaces()).flatMap((items) =>
      (items ?? [])
        .filter((item) => !item.internal && item.family === 'IPv4' && isLocalAddress(item.address))
        .map((item) => `${item.address}:${this.port}`)
    )
  }
  view(): LanView {
    const now = this.now()
    return {
      enabled: this.enabled,
      device: this.device(),
      port: this.port,
      addresses: this.addresses(),
      error: this.error,
      // 已配对设备不再出现在附近设备里，解除配对后会随发现信息重新出现。
      discovered: [...this.discovered.values()].filter((device) => !this.peers.has(device.id)),
      requests: [...this.pairRequests.values()]
        .filter((request) => request.expires > now)
        .map(({ id, device, address, expires }) => ({ id, device, address, expires })),
      peers: [...this.peers.values()].map((peer) => ({
        ...peer.device,
        address: peer.address,
        online:
          this.enabled &&
          !!this.server &&
          peer.lastSeen !== null &&
          now - peer.lastSeen < 15000 &&
          peer.device.protocol === PROTOCOL,
        lastSeen: peer.lastSeen,
        error: peer.error,
        snapshot: peer.snapshot
      }))
    }
  }
  configure(enabled: boolean, name: string, restart = false): Promise<void> {
    const operation = this.configuring
      .catch(() => undefined)
      .then(async () => {
        const validName = identitySchema.shape.name.parse(name)
        if (
          !restart &&
          enabled === this.enabled &&
          validName === this.identity.name &&
          (!enabled || this.server)
        )
          return
        await this.stop()
        this.identity.name = validName
        this.saveIdentity()
        this.enabled = enabled
        this.error = undefined
        this.store.db
          .prepare("INSERT OR REPLACE INTO lan_state VALUES('enabled',?)")
          .run(String(enabled))
        if (enabled) {
          try {
            await this.start()
          } catch (error) {
            this.error = String(error)
            await this.stop()
            this.options.changed()
            throw error
          }
        }
        this.options.changed()
      })
    this.configuring = operation
    return operation
  }
  private savePeer(peer: Peer): void {
    this.store.db
      .prepare('INSERT OR REPLACE INTO lan_peers VALUES(?,?)')
      .run(peer.device.id, JSON.stringify(peer))
    this.peers.set(peer.device.id, peer)
  }
  private async start(): Promise<void> {
    this.server = createServer(
      {
        key: this.identity.private,
        cert: this.identity.cert,
        requestCert: true,
        rejectUnauthorized: false,
        minVersion: 'TLSv1.2',
        handshakeTimeout: 5000
      },
      (req, res) => {
        const send = (status: number, value?: unknown, etag?: string) => {
          if (res.destroyed || res.writableEnded) return
          res.writeHead(status, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            ...(etag ? { ETag: etag } : {})
          })
          res.end(value === undefined ? undefined : JSON.stringify(value))
        }
        // 总请求期限也覆盖慢速上传，不能只依靠 socket 的空闲超时。
        const deadline = setTimeout(() => req.destroy(), 5000)
        res.once('close', () => clearTimeout(deadline))
        void (async () => {
          try {
            if (req.headers.origin || !this.enabled) throw new SkillError(401, '未经授权')
            const cert = (req.socket as TLSSocket).getPeerCertificate()
            if (!cert.raw) throw new SkillError(401, '需要设备证书')
            const remoteFingerprint = fingerprint(cert.raw)
            const url = req.url ?? ''
            const readJson = async (limit: number): Promise<unknown> => {
              if (!req.headers['content-type']?.startsWith('application/json'))
                throw new SkillError(415, '需要 JSON')
              const chunks: Buffer[] = []
              let bytes = 0
              for await (const chunk of req) {
                bytes += chunk.length
                if (bytes > limit) throw new SkillError(413, '请求过大')
                chunks.push(chunk)
              }
              return JSON.parse(Buffer.concat(chunks).toString('utf8'))
            }
            // 配对入口不要求已配对证书，但必须由本机用户确认后才建立信任。
            if (req.method === 'POST' && url === '/lan/v1/pair-request') {
              const data = z
                .object({
                  device: identitySchema,
                  request: z.string().uuid(),
                  address: addressSchema
                })
                .strict()
                .parse(await readJson(4096))
              if (data.device.protocol !== PROTOCOL)
                throw new SkillError(409, '协议版本不兼容，请升级 Ebisu')
              if (data.device.id === this.identity.id) throw new SkillError(400, '不能与自己配对')
              const previous = this.peers.get(data.device.id)
              if (previous) {
                if (previous.fingerprint !== remoteFingerprint)
                  throw new SkillError(409, '设备身份已变化，请先解除旧配对')
                // 对方丢失配对状态时直接确认，避免已配对设备反复弹窗。
                send(200, { status: 'paired', device: this.device() })
                return
              }
              const port = new URL(`https://${data.address}`).port
              if (!port) throw new SkillError(400, '设备地址无效')
              // 请求 ID 由发起方生成；不能覆盖其他设备的待确认请求。
              const conflict = this.pairRequests.get(data.request)
              if (conflict && conflict.device.id !== data.device.id)
                throw new SkillError(409, '配对请求标识冲突，请重新发起')
              // 同一设备只保留最新请求，避免重复点击堆积多个弹窗。
              for (const [id, request] of this.pairRequests)
                if (request.device.id === data.device.id) this.pairRequests.delete(id)
              if (this.pairRequests.size >= MAX_PAIR_REQUESTS)
                throw new SkillError(429, '待处理配对请求过多，请稍后再试')
              // 回连地址优先采用真实来源 IP，避免对端多网卡时上报不可达地址。
              const source = connectionHost((req.socket as TLSSocket).remoteAddress)
              this.pairRequests.set(data.request, {
                id: data.request,
                device: data.device,
                address: source ? `${source}:${port}` : data.address,
                fingerprint: remoteFingerprint,
                expires: this.now() + PAIR_TTL
              })
              send(200, { status: 'pending', device: this.device() })
              this.options.changed()
              try {
                this.options.request?.()
              } catch {
                /* 唤醒窗口失败不影响请求，用户仍可手动打开设置。 */
              }
              return
            }
            if (req.method === 'POST' && url === '/lan/v1/pair-status') {
              const data = z
                .object({ request: z.string().uuid() })
                .strict()
                .parse(await readJson(1024))
              const pending = this.pairRequests.get(data.request)
              if (
                pending &&
                pending.fingerprint === remoteFingerprint &&
                pending.expires > this.now()
              ) {
                send(200, { status: 'pending', device: this.device() })
                return
              }
              const resolved = this.resolvedPairs.get(data.request)
              if (
                resolved &&
                resolved.fingerprint === remoteFingerprint &&
                resolved.expires > this.now()
              ) {
                send(200, { status: resolved.status, device: this.device() })
                return
              }
              throw new SkillError(401, '配对请求不存在或已过期')
            }
            const peer = [...this.peers.values()].find(
              (item) => item.fingerprint === remoteFingerprint
            )
            if (!peer) throw new SkillError(401, '设备未配对或已撤销')
            if (req.method !== 'GET') throw new SkillError(404, '接口不存在')
            if (url === '/lan/v1/snapshot') {
              const local = await this.options.snapshot()
              const shared = sharedSchema.parse({
                device: this.device(),
                folders: local.folders,
                skills: local.skills
              })
              const etag = `"${packageHash(shared)}"`
              if (req.headers['if-none-match'] === etag) send(304, undefined, etag)
              else send(200, shared, etag)
            } else {
              const match = /^\/lan\/v1\/skills\/([a-f0-9-]{36})(?:\/(export))?$/.exec(url)
              if (!match) throw new SkillError(404, '接口不存在')
              const exported = this.transfer.export(z.string().uuid().parse(match[1]))
              send(200, exported)
            }
          } catch (error) {
            send(
              error instanceof SkillError
                ? error.status
                : error instanceof z.ZodError || error instanceof SyntaxError
                  ? 400
                  : 500,
              { error: error instanceof SkillError ? error.message : '局域网请求失败' }
            )
          }
        })()
      }
    )
    this.server.requestTimeout = 5000
    this.server.maxConnections = 64
    this.server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    })
    this.server.headersTimeout = 5000
    this.server.on('error', (error) => {
      this.error = String(error)
      this.options.changed()
    })
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(0, '0.0.0.0', () => {
        this.server!.removeListener('error', reject)
        resolve()
      })
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('无法启动局域网服务')
    this.port = address.port
    if (this.options.discovery !== false) {
      try {
        this.bonjour = new Bonjour({}, (error: Error) => {
          this.error = `设备发现不可用，请检查局域网与防火墙设置：${String(error)}`
          this.options.changed()
        })
        this.publication = this.bonjour.publish({
          name: `Ebisu-${this.identity.id}`,
          type: 'ebisu',
          protocol: 'tcp',
          port: this.port,
          // 证书指纹随发现广播，配对前必须先固定对端证书，避免明文发现信息直接建立信任。
          txt: {
            id: this.identity.id,
            name: this.identity.name,
            protocol: String(PROTOCOL),
            fingerprint: this.identity.fingerprint
          }
        })
        this.publication.on('error', (error: Error) => {
          this.error = String(error)
          this.options.changed()
        })
        this.browser = this.bonjour.find({ type: 'ebisu' })
        this.browser.on('up', (service: Service) => this.discover(service))
        this.browser.on('srv-update', (service: Service) => this.discover(service))
        this.browser.on('txt-update', (service: Service) => this.discover(service))
        this.browser.on('down', (service: Service) => {
          this.discovered.delete(service.txt?.id)
          this.options.changed()
        })
      } catch (error) {
        this.error = `自动发现不可用，请检查局域网与防火墙设置：${String(error)}`
      }
    }
    this.timer = setInterval(() => {
      void this.poll()
    }, 2000)
    void this.poll()
  }
  private discover(service: Service): void {
    const parsed = identitySchema.safeParse({
      id: service.txt?.id,
      name: service.txt?.name,
      protocol: Number(service.txt?.protocol)
    })
    const pin = fingerprintSchema.safeParse(service.txt?.fingerprint)
    const host = service.addresses?.find((item) => isIP(item) === 4 && isLocalAddress(item))
    if (
      !this.enabled ||
      !this.server ||
      !parsed.success ||
      !host ||
      parsed.data.id === this.identity.id
    )
      return
    const address = `${host}:${service.port}`
    this.discovered.set(parsed.data.id, {
      ...parsed.data,
      address,
      // 旧版本不广播指纹；这类设备会出现在列表里但不能发起配对。
      fingerprint: pin.success ? pin.data : null
    })
    const peer = this.peers.get(parsed.data.id)
    // 发现信息只提供候选地址；取得已配对证书认证后才持久化地址与身份。
    if (peer && address !== peer.address) {
      this.candidates.set(peer.device.id, address)
      void this.refreshPeer(peer)
    }
    this.options.changed()
  }
  /**
   * 向附近设备发起配对，等待对方确认后保存对端身份。
   * 返回 paired 表示完成；declined 表示对方拒绝；pending 表示等待超时，
   * 后台仍会在请求有效期内继续完成，成功后通过快照更新体现。
   */
  async requestPair(deviceId: string): Promise<PairOutcome> {
    const id = z.string().uuid().parse(deviceId)
    if (!this.enabled || !this.port) throw new SkillError(409, '请先开启局域网共享')
    if (this.peers.has(id)) throw new SkillError(409, '该设备已配对')
    let entry = this.outgoingPairs.get(id)
    if (entry && entry.expires <= this.now()) {
      this.settleOutgoing(entry, 'pending')
      entry = undefined
    }
    if (!entry) {
      const target = this.discovered.get(id)
      if (!target) throw new SkillError(404, '附近没有这台设备，请确认双方已开启共享')
      if (target.protocol !== PROTOCOL)
        throw new SkillError(409, '对方协议版本不兼容，请升级 Ebisu')
      if (!target.fingerprint) throw new SkillError(409, '对方版本不支持请求配对，请升级 Ebisu')
      const request: OutgoingPairRequest = {
        id: randomUUID(),
        deviceId: id,
        address: target.address,
        fingerprint: target.fingerprint,
        expires: this.now() + PAIR_TTL,
        waiters: new Set()
      }
      this.outgoingPairs.set(id, request)
      entry = request
      try {
        const response = await this.fetch(
          request.address,
          request.fingerprint,
          '/lan/v1/pair-request',
          {
            device: this.device(),
            request: request.id,
            address: this.addresses()[0] || `127.0.0.1:${this.port}`
          }
        )
        const result = z
          .object({
            status: z.enum(['pending', 'paired']),
            device: identitySchema
          })
          .parse(response.body)
        if (result.status === 'paired') {
          await this.completeOutgoing(request, result.device)
          return 'paired'
        }
      } catch (error) {
        if (this.outgoingPairs.get(id) === request) this.outgoingPairs.delete(id)
        throw error
      }
      this.options.changed()
    }
    return this.waitOutgoing(entry)
  }
  /** 本机用户确认或拒绝请求；请求已过期或已被处理时返回 404。 */
  async respondPair(requestId: string, accept: boolean): Promise<void> {
    const id = z.string().uuid().parse(requestId)
    const request = this.pairRequests.get(id)
    if (!request) throw new SkillError(404, '配对请求不存在或已过期')
    this.pairRequests.delete(id)
    if (request.expires <= this.now()) {
      this.options.changed()
      throw new SkillError(410, '配对请求已过期')
    }
    const existing = this.peers.get(request.device.id)
    if (accept && existing && existing.fingerprint !== request.fingerprint) {
      this.resolvedPairs.set(id, {
        status: 'declined',
        fingerprint: request.fingerprint,
        expires: this.now() + PAIR_TTL
      })
      this.options.changed()
      throw new SkillError(409, '设备身份已变化，请先解除旧配对')
    }
    this.resolvedPairs.set(id, {
      status: accept ? 'accepted' : 'declined',
      fingerprint: request.fingerprint,
      expires: this.now() + PAIR_TTL
    })
    if (!accept) {
      this.options.changed()
      return
    }
    const peer: Peer = existing ?? {
      device: request.device,
      fingerprint: request.fingerprint,
      address: request.address,
      lastSeen: null,
      snapshot: null
    }
    peer.device = request.device
    peer.address = request.address
    this.savePeer(peer)
    this.options.changed()
    await this.refreshPeer(peer)
  }
  private waitOutgoing(entry: OutgoingPairRequest): Promise<PairOutcome> {
    if (entry.outcome) return Promise.resolve(entry.outcome)
    return new Promise((resolve) => {
      const waiter = (outcome: PairOutcome) => {
        clearTimeout(timer)
        resolve(outcome)
      }
      const timer = setTimeout(() => {
        entry.waiters.delete(waiter)
        resolve('pending')
      }, PAIR_WAIT)
      entry.waiters.add(waiter)
      if (entry.outcome) {
        entry.waiters.delete(waiter)
        clearTimeout(timer)
        resolve(entry.outcome)
      }
    })
  }
  private settleOutgoing(entry: OutgoingPairRequest, outcome: PairOutcome): void {
    if (this.outgoingPairs.get(entry.deviceId) === entry) this.outgoingPairs.delete(entry.deviceId)
    entry.outcome = outcome
    for (const waiter of entry.waiters) waiter(outcome)
    entry.waiters.clear()
  }
  private async completeOutgoing(
    entry: OutgoingPairRequest,
    device: DeviceIdentity
  ): Promise<void> {
    if (device.id !== entry.deviceId || device.protocol !== PROTOCOL)
      throw new SkillError(401, '设备身份不匹配')
    if (this.outgoingPairs.get(entry.deviceId) !== entry) return
    const peer: Peer = {
      device,
      address: entry.address,
      fingerprint: entry.fingerprint,
      lastSeen: null,
      snapshot: null
    }
    this.savePeer(peer)
    this.settleOutgoing(entry, 'paired')
    await this.refreshPeer(peer)
    this.options.changed()
  }
  /** 检查本机发起的配对是否已被对方处理；网络瞬断时不结束请求。 */
  private checkOutgoing(entry: OutgoingPairRequest): Promise<void> {
    if (entry.checking) return entry.checking
    entry.checking = (async () => {
      if (this.now() >= entry.expires) {
        this.settleOutgoing(entry, 'pending')
        return
      }
      try {
        const response = await this.fetch(entry.address, entry.fingerprint, '/lan/v1/pair-status', {
          request: entry.id
        })
        const result = z
          .object({
            status: z.enum(['pending', 'accepted', 'declined']),
            device: identitySchema
          })
          .parse(response.body)
        if (result.status === 'accepted') await this.completeOutgoing(entry, result.device)
        else if (result.status === 'declined') this.settleOutgoing(entry, 'declined')
      } catch (error) {
        // 对方重启后内存中的请求会丢失，继续轮询没有意义；其余错误留到有效期结束。
        if (error instanceof LanHttpError && error.status === 401)
          this.settleOutgoing(entry, 'pending')
      }
    })().finally(() => {
      entry.checking = undefined
    })
    return entry.checking
  }
  private prunePairs(): void {
    const now = this.now()
    let changed = false
    for (const [id, request] of this.pairRequests) {
      if (request.expires <= now) {
        this.pairRequests.delete(id)
        changed = true
      }
    }
    for (const [id, resolved] of this.resolvedPairs)
      if (resolved.expires <= now) this.resolvedPairs.delete(id)
    for (const entry of [...this.outgoingPairs.values()])
      if (entry.expires <= now) {
        this.settleOutgoing(entry, 'pending')
        changed = true
      }
    if (changed) this.options.changed()
  }
  unpair(id: string): void {
    z.string().uuid().parse(id)
    this.peers.delete(id)
    this.candidates.delete(id)
    // 保留发现信息，解除配对后设备立即回到附近列表；地址仍会随发现刷新。
    this.store.db.prepare('DELETE FROM lan_peers WHERE id=?').run(id)
    this.options.changed()
  }
  private async fetch(
    address: string,
    pin: string,
    route: string,
    body?: unknown,
    etag?: string
  ): Promise<{ status: number; body: unknown; etag?: string }> {
    addressSchema.parse(address)
    const url = new URL(`https://${address}${route}`)
    const agent = new Agent({ keepAlive: false })
    let transport: TLSSocket | undefined
    // 在交出 socket 给 HTTP 层之前验证指纹；不能先发送请求体再检查证书。
    agent.createConnection = (_options: RequestOptions, callback) => {
      const socket = connect({
        host: url.hostname.replace(/^\[|\]$/g, ''),
        port: Number(url.port || 443),
        key: this.identity.private,
        cert: this.identity.cert,
        rejectUnauthorized: false,
        minVersion: 'TLSv1.2'
      })
      transport = socket
      let settled = false
      const finish = (error: Error | null) => {
        if (settled) return
        settled = true
        callback?.(error, socket)
        if (error) socket.destroy()
      }
      socket.once('error', (error) => finish(error))
      socket.once('secureConnect', () => {
        const cert = socket.getPeerCertificate()
        finish(
          cert.raw && fingerprint(cert.raw) === pin ? null : new Error('设备证书不匹配，已拒绝连接')
        )
      })
      return undefined as unknown as TLSSocket
    }
    try {
      return await new Promise((resolve, reject) => {
        const encoded = body === undefined ? undefined : JSON.stringify(body)
        const req = request(
          url,
          {
            agent,
            method: body === undefined ? 'GET' : 'POST',
            headers: {
              ...(encoded
                ? {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(encoded)
                  }
                : {}),
              ...(etag ? { 'If-None-Match': etag } : {})
            }
          },
          (res) => {
            const chunks: Buffer[] = []
            let bytes = 0
            res.on('data', (chunk: Buffer) => {
              bytes += chunk.length
              if (bytes > MAX_BODY) {
                res.destroy(new Error('远端数据超过限额'))
                return
              }
              chunks.push(chunk)
            })
            res.on('error', reject)
            res.on('end', () => {
              try {
                const data = bytes ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
                if (res.statusCode !== 200 && res.statusCode !== 304)
                  throw new LanHttpError(
                    res.statusCode ?? 500,
                    data?.error || `远端返回 ${res.statusCode}`
                  )
                resolve({ status: res.statusCode, body: data, etag: res.headers.etag })
              } catch (error) {
                reject(error)
              }
            })
          }
        )
        this.pendingRequests.add(req)
        const deadline = setTimeout(() => req.destroy(new Error('设备连接超时')), 5000)
        req.once('close', () => {
          clearTimeout(deadline)
          this.pendingRequests.delete(req)
        })
        req.once('error', reject)
        req.end(encoded)
      })
    } finally {
      agent.destroy()
      transport?.destroy()
    }
  }
  private refreshPeer(peer: Peer): Promise<void> {
    const pending = this.refreshes.get(peer.device.id)
    if (pending) return pending
    const address = this.candidates.get(peer.device.id) ?? peer.address
    // 同设备只保留一条刷新链，避免发现与轮询的旧响应覆盖较新的快照。
    const operation = (async () => {
      const success = await this.fetchPeer(peer, address)
      if (
        !success &&
        address !== peer.address &&
        this.enabled &&
        this.peers.get(peer.device.id) === peer
      )
        await this.fetchPeer(peer, peer.address)
    })().finally(() => this.refreshes.delete(peer.device.id))
    this.refreshes.set(peer.device.id, operation)
    return operation
  }
  private async fetchPeer(peer: Peer, address: string): Promise<boolean> {
    try {
      const result = await this.fetch(
        address,
        peer.fingerprint,
        '/lan/v1/snapshot',
        undefined,
        peer.etag
      )
      if (!this.enabled || this.peers.get(peer.device.id) !== peer) return false
      if (result.status === 200) {
        const snapshot = sharedSchema.parse(result.body)
        if (snapshot.device.id !== peer.device.id) throw new Error('设备身份不匹配')
        if (snapshot.device.protocol !== PROTOCOL) throw new Error('协议版本不兼容，请升级 Ebisu')
        peer.device = snapshot.device
        peer.snapshot = snapshot
        peer.etag = result.etag
      }
      peer.address = address
      peer.lastSeen = this.now()
      peer.error = undefined
      this.savePeer(peer)
      if (this.candidates.get(peer.device.id) === address) this.candidates.delete(peer.device.id)
      this.options.changed()
      return true
    } catch (error) {
      if (this.peers.get(peer.device.id) === peer) {
        peer.error = String(error)
        this.savePeer(peer)
      }
    }
    this.options.changed()
    return false
  }
  poll(): Promise<void> {
    if (!this.enabled || !this.server || this.polling) return this.polling ?? Promise.resolve()
    this.polling = (async () => {
      if (this.now() - this.lastDiscovery >= 15000) {
        this.lastDiscovery = this.now()
        this.browser?.update()
      }
      this.prunePairs()
      const peers = [...this.peers.values()]
      for (let i = 0; this.enabled && this.server && i < peers.length; i += 4)
        await Promise.all(peers.slice(i, i + 4).map((peer) => this.refreshPeer(peer)))
      // 已发起的配对请求由主进程统一轮询，界面关闭后也能完成配对。
      await Promise.all([...this.outgoingPairs.values()].map((entry) => this.checkOutgoing(entry)))
    })().finally(() => {
      this.polling = undefined
    })
    return this.polling
  }
  async remoteSkill(deviceId: string, skillId: string): Promise<SkillExport> {
    const peer = this.peers.get(z.string().uuid().parse(deviceId))
    if (!this.enabled || !peer) throw new SkillError(401, '设备未连接')
    const response = await this.fetch(
      peer.address,
      peer.fingerprint,
      `/lan/v1/skills/${z.string().uuid().parse(skillId)}/export`
    )
    if (!this.enabled || this.peers.get(deviceId) !== peer)
      throw new SkillError(401, '设备已解除配对')
    const exported = exportSchema.parse(response.body)
    if (exported.skillId !== skillId || packageHash(exported.package) !== exported.hash)
      throw new SkillError(400, '技能包校验失败')
    return exported
  }
  async prepareImport(deviceId: string, skillId: string) {
    const exported = await this.remoteSkill(deviceId, skillId)
    return this.transfer.prepare(this.peers.get(deviceId)!.device, exported)
  }
  private async stop(): Promise<void> {
    clearInterval(this.timer)
    // 关闭共享时所有待确认请求和等待中的发起请求都应立即失效。
    for (const entry of [...this.outgoingPairs.values()]) this.settleOutgoing(entry, 'pending')
    this.outgoingPairs.clear()
    this.pairRequests.clear()
    this.resolvedPairs.clear()
    this.browser?.stop()
    this.browser = undefined
    this.publication?.stop()
    this.publication = undefined
    this.bonjour?.destroy()
    this.bonjour = undefined
    this.discovered.clear()
    this.candidates.clear()
    for (const req of this.pendingRequests) req.destroy(new Error('局域网服务已停止'))
    const server = this.server
    this.server = undefined
    this.port = null
    for (const socket of this.sockets) socket.destroy()
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    await this.polling
    await Promise.all(this.refreshes.values())
  }
  async resume(): Promise<void> {
    if (this.enabled) await this.configure(true, this.identity.name, true)
  }
  async close(): Promise<void> {
    await this.configuring.catch(() => undefined)
    this.enabled = false
    await this.stop()
  }
}
function fingerprint(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex')
}
/** 保留 HTTP 状态码，让配对轮询能区分“请求已失效”和短暂网络故障。 */
class LanHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}
/** 把 TLS 连接来源规范化为局域网 IPv4；IPv6、带 zone 或公网地址时返回 null。 */
function connectionHost(address?: string): string | null {
  if (!address) return null
  const normalized = address.replace(/^::ffff:/, '').replace(/^\[|\]$/g, '')
  return isIP(normalized) === 4 && isLocalAddress(normalized) ? normalized : null
}
