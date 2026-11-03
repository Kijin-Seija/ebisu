import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { Skills, SkillError } from './skills'
import { skillRequest } from './skill-protocol'
import { activityPhases, terminalIds } from '../shared/types'
import type { Store } from './database'
import { Chat, MAX_WAIT_SECONDS } from './chat'

const activitySchema = z.object({
  path: z
    .string()
    .min(1)
    .max(16384)
    .refine((value) => path.isAbsolute(value), 'path 必须是绝对路径'),
  terminal: z.enum(terminalIds),
  sessionId: z.string().min(1).max(512),
  sessionAliases: z
    .array(
      z
        .string()
        .min(7)
        .max(512)
        .regex(/^local-/)
    )
    .max(8)
    .optional(),
  action: z.enum(['enter', 'exit']),
  phase: z.enum(activityPhases).optional(),
  model: z.string().max(256).optional(),
  taskTitle: z.string().trim().min(1).max(512).optional(),
  sequence: z.number().int().nonnegative().optional(),
  scope: z.enum(['folder', 'session']).optional(),
  preserveWaiting: z.boolean().optional()
})

/** 独立的身份接口不携带活动状态，避免通知工具自己的 hook 覆盖 waiting 或 exit。 */
const identitySchema = activitySchema
  .pick({ terminal: true, sessionId: true, sessionAliases: true })
  .refine((value) => !value.sessionId.startsWith('local-') && !!value.sessionAliases?.length)

/** 本机服务使用 bearer 认证、请求体限额，并拒绝浏览器来源，避免网页跨站上报。 */
export async function startServer(
  store: Store,
  runtimeFile: string,
  changed: () => void,
  skills?: Skills,
  chat?: Chat
) {
  const token = randomBytes(32).toString('hex')
  const send = (response: ServerResponse, status: number, data: unknown) => {
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    })
    response.end(JSON.stringify(data))
  }
  const server = createServer(async (request, response) => {
    try {
      const supplied = Buffer.from(request.headers.authorization ?? '')
      const expected = Buffer.from(`Bearer ${token}`)
      if (
        request.headers.origin ||
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      ) {
        send(response, 401, { error: '未经授权' })
        return
      }
      if (request.method === 'GET' && request.url === '/v1/health') {
        send(response, 200, { ok: true, name: 'ebisu', version: 1 })
        return
      }
      if (chat && request.url?.startsWith('/v1/chat/')) {
        await chatRoute(chat, request, response, send)
        return
      }
      if (
        request.method !== 'POST' ||
        (!['/v1/activity', '/v1/identity'].includes(request.url ?? '') &&
          !(skills && /^\/v1\/skills\/[a-z-]+$/.test(request.url ?? '')))
      ) {
        send(response, 404, { error: '接口不存在' })
        return
      }
      if (!(request.headers['content-type'] ?? '').startsWith('application/json')) {
        send(response, 415, { error: '需要 application/json' })
        return
      }
      let bytes = 0
      const chunks: Buffer[] = []
      for await (const chunk of request) {
        bytes += chunk.length
        if (bytes > (request.url?.startsWith('/v1/skills/') ? 12 * 1024 * 1024 : 32768)) {
          send(response, 413, { error: '请求过大' })
          request.resume()
          return
        }
        chunks.push(chunk)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (skills && request.url?.startsWith('/v1/skills/')) {
        const result = skillRequest(skills, request.url.slice('/v1/skills/'.length), body)
        changed()
        send(response, 200, result)
        return
      }
      if (request.url === '/v1/identity') {
        const identity = identitySchema.safeParse(body)
        if (!identity.success) {
          send(response, 400, { error: '身份参数无效' })
          return
        }
        store.identifySession(
          identity.data.terminal,
          identity.data.sessionId,
          identity.data.sessionAliases!
        )
        changed()
        send(response, 200, { ok: true })
        return
      }
      const parsed = activitySchema.safeParse(body)
      if (!parsed.success) {
        send(response, 400, { error: '参数无效', details: parsed.error.issues })
        return
      }
      const result = store.activity(parsed.data)
      changed()
      send(response, 200, { ok: true, ...result, leaseSeconds: 600 })
    } catch (error) {
      send(
        response,
        error instanceof SkillError
          ? error.status
          : error instanceof z.ZodError || error instanceof SyntaxError
            ? 400
            : 500,
        {
          error:
            error instanceof SkillError
              ? error.message
              : error instanceof z.ZodError
                ? '参数无效'
                : error instanceof SyntaxError
                  ? 'JSON 格式错误'
                  : '状态更新失败'
        }
      )
    }
  })
  server.requestTimeout = 3000
  server.headersTimeout = 3000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('无法启动本机服务')
  const runtime = { port: address.port, token, pid: process.pid, startedAt: Date.now() }
  mkdirSync(path.dirname(runtimeFile), { recursive: true, mode: 0o700 })
  writeFileSync(`${runtimeFile}.tmp`, JSON.stringify(runtime), { mode: 0o600 })
  renameSync(`${runtimeFile}.tmp`, runtimeFile)
  return {
    port: address.port,
    close: async () => {
      rmSync(runtimeFile, { force: true })
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

/** 读取有限大小的 JSON 请求体。 */
async function readBody(request: IncomingMessage, limit: number): Promise<unknown> {
  if (!(request.headers['content-type'] ?? '').startsWith('application/json'))
    throw new SkillError(415, '需要 application/json')
  let bytes = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > limit) throw new SkillError(413, '请求过大')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

/**
 * Agent 对话本机接口。agent 只访问本机 Ebisu，跨设备复制由 LAN 层完成。
 * wait 为长轮询：客户端断开时立即释放等待者。
 */
async function chatRoute(
  chat: Chat,
  request: IncomingMessage,
  response: ServerResponse,
  send: (response: ServerResponse, status: number, data: unknown) => void
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const route = `${request.method} ${url.pathname}`
  const query = (name: string) => url.searchParams.get(name) ?? undefined
  const list = (value?: string) =>
    (value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  switch (route) {
    case 'GET /v1/chat/devices':
      send(response, 200, { ok: true, devices: chat.devices() })
      return
    case 'GET /v1/chat/channels':
      send(response, 200, { ok: true, channels: chat.summaries() })
      return
    case 'POST /v1/chat/channels':
      send(response, 200, {
        ok: true,
        channel: chat.createChannel((await readBody(request, 65536)) as never)
      })
      return
    case 'POST /v1/chat/channels/delete': {
      // 频道 ID 可包含 /，因此用请求体传递而不是放在路径里。
      const body = z.object({ id: z.string() }).parse(await readBody(request, 65536))
      send(response, 200, { ok: true, deleted: chat.deleteChannel(body.id) })
      return
    }
    case 'POST /v1/chat/messages':
      send(response, 200, {
        ok: true,
        message: chat.post((await readBody(request, 65536)) as never)
      })
      return
    case 'GET /v1/chat/messages': {
      const channel = z.string().parse(query('channel'))
      const since = z.coerce.number().int().nonnegative().default(0).parse(query('since'))
      const limit = z.coerce.number().int().positive().default(500).parse(query('limit'))
      send(response, 200, { ok: true, messages: chat.history(channel, since, limit) })
      return
    }
    case 'GET /v1/chat/wait': {
      const controller = new AbortController()
      response.once('close', () => controller.abort())
      const timeout = z.coerce
        .number()
        .min(0)
        .max(MAX_WAIT_SECONDS)
        .default(240)
        .parse(query('timeout'))
      const messages = await chat.wait({
        member: z.string().parse(query('member')),
        channels: list(query('channel') ?? '*'),
        timeout,
        all: query('all') === '1' || query('all') === 'true',
        peek: query('peek') === '1' || query('peek') === 'true',
        signal: controller.signal
      })
      if (!response.destroyed)
        send(response, 200, { ok: true, timeout: !messages.length, messages })
      return
    }
    case 'POST /v1/chat/ack': {
      const body = z
        .object({
          member: z.string(),
          messages: z
            .array(z.object({ channel: z.string(), seq: z.number().int().positive() }))
            .max(1000)
        })
        .parse(await readBody(request, 65536))
      chat.ack(body.member, body.messages)
      send(response, 200, { ok: true })
      return
    }
    default:
      send(response, 404, { error: '接口不存在' })
  }
}
