import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Store } from '../src/main/database'
import { startServer } from '../src/main/server'

let root: string
let store: Store
let server: Awaited<ReturnType<typeof startServer>>
let base: string
let token: string
let changes: number
beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'ebisu-http-'))
  store = new Store(path.join(root, 'state.sqlite'))
  store.addFolder(root)
  changes = 0
  server = await startServer(store, path.join(root, 'runtime.json'), () => changes++)
  base = `http://127.0.0.1:${server.port}`
  token = JSON.parse(readFileSync(path.join(root, 'runtime.json'), 'utf8')).token
})
afterEach(async () => {
  await server.close()
  store.close()
  rmSync(root, { recursive: true, force: true })
})
function send(body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/v1/activity`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })
}
const event = () => ({ path: root, terminal: 'codex', sessionId: 'one', action: 'enter' })
it('服务发现文件权限为 0600，健康探测不创建会话', async () => {
  expect(statSync(path.join(root, 'runtime.json')).mode & 0o777).toBe(0o600)
  const response = await fetch(`${base}/v1/health`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  expect(await response.json()).toMatchObject({ ok: true })
  expect(changes).toBe(0)
})
it('拒绝无令牌、错误令牌和带浏览器 Origin 的请求', async () => {
  expect((await fetch(`${base}/v1/health`)).status).toBe(401)
  expect((await send(event(), { Authorization: 'Bearer invalid' })).status).toBe(401)
  expect((await send(event(), { Origin: 'https://example.com' })).status).toBe(401)
})
it('拒绝无效状态、相对路径、畸形 JSON 和过大请求', async () => {
  expect((await send({ ...event(), action: 'oops' })).status).toBe(400)
  expect((await send({ ...event(), phase: 'oops' })).status).toBe(400)
  expect((await send({ ...event(), path: './relative' })).status).toBe(400)
  expect((await send({ ...event(), sessionAliases: ['real-other-session'] })).status).toBe(400)
  expect((await send({ ...event(), sessionId: 'a'.repeat(40000) })).status).toBe(413)
  const malformed = await fetch(`${base}/v1/activity`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{oops'
  })
  expect(malformed.status).toBe(400)
})
it('并发 upsert 无重复，并实时触发通知；未知目录忽略', async () => {
  await Promise.all(Array.from({ length: 8 }, () => send(event())))
  expect(store.sessions(store.folders()[0].id)).toHaveLength(1)
  expect(changes).toBe(8)
  const response = await send({ ...event(), path: tmpdir(), sessionId: 'unregistered' })
  expect(await response.json()).toMatchObject({ ok: true, ignored: true })
  expect(store.folders()).toHaveLength(1)
})
it('接受故障阶段，并由同项目执行中请求清除全部故障', async () => {
  const folderId = store.folders()[0].id
  expect((await send({ ...event(), sessionId: 'failed', phase: 'error' })).status).toBe(200)
  expect(store.sessions(folderId)).toMatchObject([{ sessionId: 'failed', phase: 'error' }])
  // 已存在的执行会话发送普通心跳，也会清除项目内其他会话的故障。
  expect((await send({ ...event(), sessionId: 'alive' })).status).toBe(200)
  expect((await send({ ...event(), sessionId: 'alive' })).status).toBe(200)
  expect(store.sessions(folderId)).toMatchObject([{ sessionId: 'alive', phase: 'executing' }])
})
it('接收真实任务标题并保留到后续心跳，拒绝空白和超长标题', async () => {
  expect((await send({ ...event(), taskTitle: ' 修复登录问题 ' })).status).toBe(200)
  await send(event())
  expect(store.sessions(store.folders()[0].id)[0].taskTitle).toBe('修复登录问题')
  expect((await send({ ...event(), taskTitle: ' ' })).status).toBe(400)
  expect((await send({ ...event(), taskTitle: 'a'.repeat(513) })).status).toBe(400)
})
