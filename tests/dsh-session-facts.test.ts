import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DshSessionFacts, resumedAfterExit } from '../src/main/dsh-session-facts'
import type { Folder, SessionActivity } from '../src/shared/types'

let root: string
let directory: string
let facts: DshSessionFacts
beforeEach(() => {
  // canonicalDirectory 会折叠 /var 等符号链接，夹具目录必须使用真实路径。
  root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'ebisu-dsh-facts-')))
  directory = path.join(root, 'storages/session_projcache/sessions')
  mkdirSync(directory, { recursive: true })
  facts = new DshSessionFacts(root)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const folder = (id: string, location: string): Folder => ({
  id,
  name: id,
  path: location,
  createdAt: 0
})

const session = (patch: Partial<SessionActivity> = {}): SessionActivity => ({
  terminal: 'dsh',
  sessionId: 'session-one',
  phase: 'executing',
  model: null,
  startedAt: 1,
  lastSeen: 2,
  ...patch
})
const write = (id: string, rows: unknown): void => {
  writeFileSync(
    path.join(directory, `${id}.json`),
    JSON.stringify({ version: 7, record: { rows } })
  )
}
const selection = (model: string) => ({ modelSelection: { val: { lastUsed: { model } } } })

it('上报时缓存尚未落盘的会话，快照再次读取后补全模型与标题', async () => {
  const before = (await facts.enrich([session()]))[0]
  expect(before.model).toBeNull()
  expect(before.taskTitle).toBeUndefined()
  // DSH 稍后才写入投影：下一次快照必须能读到，而不是永远停留在上报时的空值。
  write('session-one', {
    ...selection('deepseek-flash'),
    title: { val: '修复 dsh 图标背景显示问题' }
  })
  const [filled] = await facts.enrich([session()])
  expect(filled).toMatchObject({
    model: 'deepseek-flash',
    taskTitle: '修复 dsh 图标背景显示问题',
    phase: 'executing',
    startedAt: 1,
    lastSeen: 2
  })
})

it('显式上报的模型与标题优先，缺失字段才用投影补全', async () => {
  write('session-one', { ...selection('deepseek-flash'), title: { val: '缓存标题' } })
  const [explicit] = await facts.enrich([
    session({ model: 'deepseek-reasoner', taskTitle: '显式标题' })
  ])
  expect(explicit).toMatchObject({ model: 'deepseek-reasoner', taskTitle: '显式标题' })
  const [partial] = await facts.enrich([session({ model: 'deepseek-reasoner' })])
  expect(partial).toMatchObject({ model: 'deepseek-reasoner', taskTitle: '缓存标题' })
})

it('模型选择尚未确认时读取 pending，其余字段忽略', async () => {
  write('session-one', {
    modelSelection: { val: { lastUsed: null, pending: { model: 'deepseek-chat' } } },
    title: { val: '  待确认模型  ' },
    contextBreakdown: { val: { messages: ['不得读取的正文'] } }
  })
  const [row] = await facts.enrich([session()])
  expect(row).toMatchObject({ model: 'deepseek-chat', taskTitle: '待确认模型' })
})

it('缓存被改写后按文件签名重新解析，仍然只补全缺失字段', async () => {
  write('session-one', selection('deepseek-flash'))
  expect((await facts.enrich([session()]))[0].model).toBe('deepseek-flash')
  write('session-one', selection('deepseek-reasoner'))
  expect((await facts.enrich([session()]))[0].model).toBe('deepseek-reasoner')
})

it('非 DSH 会话、危险会话 ID 与损坏缓存都不会读取或猜测模型', async () => {
  write('session-one', selection('deepseek-flash'))
  const source = [
    session({ terminal: 'codex' }),
    session({ sessionId: '../outside' }),
    session({ sessionId: 'session-one' })
  ]
  const sourceCopy = structuredClone(source)
  const [codex, unsafe, normal] = await facts.enrich(source)
  expect(codex.model).toBeNull()
  expect(unsafe.model).toBeNull()
  expect(normal.model).toBe('deepseek-flash')
  expect(source).toEqual(sourceCopy)
})

it('损坏或缺失的投影保持未知，修复后下一次快照恢复', async () => {
  writeFileSync(path.join(directory, 'session-one.json'), '{"record":')
  expect((await facts.enrich([session()]))[0].model).toBeNull()
  write('session-one', selection('deepseek-flash'))
  expect((await facts.enrich([session()]))[0].model).toBe('deepseek-flash')
  rmSync(path.join(directory, 'session-one.json'))
  expect((await facts.enrich([session()]))[0].model).toBeNull()
})

const writeProjection = (id: string, record: unknown): void => {
  writeFileSync(path.join(directory, `${id}.json`), JSON.stringify({ version: 7, record }))
}
const workspace = (): string => path.join(root, 'workspace')
const project = (): string => path.join(workspace(), 'packages/app')

it('投影中回合未结束的会话按最深注册目录补进面板', async () => {
  mkdirSync(project(), { recursive: true })
  writeProjection('session-live', {
    identity: { cwd: project(), createdAt: 1793267388000 },
    rows: {
      ...selection('deepseek-flash'),
      title: { val: '执行字符测试用例并修复P0/P1问题' },
      turnBoundary: { val: { openTurnStartSeq: 10 } },
      userQuestions: { val: { questions: { active: [], settled: [] } } }
    }
  })
  const live = await facts.live([folder('workspace', workspace()), folder('app', project())])
  const sessions = live.get('app') ?? []
  expect(sessions).toHaveLength(1)
  expect(sessions[0]).toMatchObject({
    terminal: 'dsh',
    sessionId: 'session-live',
    phase: 'executing',
    model: 'deepseek-flash',
    taskTitle: '执行字符测试用例并修复P0/P1问题',
    startedAt: 1793267388000
  })
  expect(sessions[0].lastSeen).toBeGreaterThan(0)
  expect(live.has('workspace')).toBe(false)
})

it('等待回答的回合标记为 waiting，工作目录可回退到 workingDirectory', async () => {
  mkdirSync(project(), { recursive: true })
  writeProjection('session-question', {
    rows: {
      workingDirectory: { val: project() },
      turnBoundary: { val: { openTurnStartSeq: 3 } },
      userQuestions: { val: { questions: { active: [{ id: 'question-1' }], settled: [] } } }
    }
  })
  const [row] = (await facts.live([folder('app', project())])).get('app') ?? []
  expect(row).toMatchObject({ sessionId: 'session-question', phase: 'waiting', model: null })
})

it('回合结束、租约过期与未注册目录的投影都不补进面板', async () => {
  const nested = project()
  const outside = path.join(root, 'outside')
  mkdirSync(nested, { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeProjection('session-ended', {
    identity: { cwd: nested },
    rows: { turnBoundary: { val: { openTurnStartSeq: null, lastStepBoundary: { kind: 'end' } } } }
  })
  writeProjection('session-stale', {
    identity: { cwd: nested },
    rows: { turnBoundary: { val: { openTurnStartSeq: 1 } } }
  })
  const old = new Date(Date.now() - 20 * 60 * 1000)
  utimesSync(path.join(directory, 'session-stale.json'), old, old)
  writeProjection('session-outside', {
    identity: { cwd: outside },
    rows: { turnBoundary: { val: { openTurnStartSeq: 1 } } }
  })
  expect([...(await facts.live([folder('app', nested)])).keys()]).toEqual([])
})

it('目录缺失或投影损坏时安静返回，不影响其余快照', async () => {
  mkdirSync(project(), { recursive: true })
  writeFileSync(path.join(directory, 'session-broken.json'), '{"record":')
  writeProjection('session-live', {
    identity: { cwd: project() },
    rows: { turnBoundary: { val: { openTurnStartSeq: 1 } } }
  })
  const missing = new DshSessionFacts(path.join(root, 'missing'))
  expect(await missing.live([folder('app', project())])).toEqual(new Map())
  expect((await facts.live([folder('app', project())])).get('app') ?? []).toHaveLength(1)
  expect(await facts.live([])).toEqual(new Map())
})

it('显式退出后的投影写入不复活会话，两分钟之后才视为新回合', () => {
  expect(resumedAfterExit(undefined, 1_000)).toBe(true)
  expect(resumedAfterExit(1_000, 1_000)).toBe(false)
  expect(resumedAfterExit(1_000, 1_000 - 5_000)).toBe(false)
  expect(resumedAfterExit(1_000, 1_000 + 119_000)).toBe(false)
  expect(resumedAfterExit(1_000, 1_000 + 121_000)).toBe(true)
})
