import { afterEach, beforeEach, expect, it } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TaskTitles } from '../src/main/task-titles'
import type { SessionActivity } from '../src/shared/types'

let root: string
let index: string
let titles: TaskTitles
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'ebisu-titles-'))
  index = path.join(root, 'session_index.jsonl')
  titles = new TaskTitles(root)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
const session = (patch: Partial<SessionActivity> = {}): SessionActivity => ({
  terminal: 'codex',
  sessionId: 'thread-one',
  phase: 'executing',
  model: null,
  startedAt: 123,
  lastSeen: 456,
  ...patch
})
const line = (id: string, thread_name: string) => JSON.stringify({ id, thread_name }) + '\n'

it('读取真实 thread_name，按会话及终端隔离，不从 title/提示词猜测', async () => {
  writeFileSync(
    index,
    line('thread-one', '开发 Agent 文件夹监控应用') +
      JSON.stringify({ id: 'no-name', title: '这是一段首条提示词' }) +
      '\n' +
      line('other', '其他任务')
  )
  const source = [session(), session({ terminal: 'grok' }), session({ sessionId: 'no-name' })]
  const result = await titles.enrich(source)
  expect(result.map((row) => row.taskTitle)).toEqual(['开发 Agent 文件夹监控应用', null, null])
  expect(source[0].taskTitle).toBeUndefined()
  expect(result[0]).toMatchObject({ startedAt: 123, lastSeen: 456, phase: 'executing' })
})

it('追加改名及索引轮换后更新，损坏行不影响并发快照', async () => {
  writeFileSync(index, line('thread-one', '原任务') + 'not json\n')
  const results = await Promise.all([titles.enrich([session()]), titles.enrich([session()])])
  expect(results.map((rows) => rows[0].taskTitle)).toEqual(['原任务', '原任务'])
  appendFileSync(index, line('thread-one', '新的任务标题') + '{"partial"')
  expect((await titles.enrich([session()]))[0].taskTitle).toBe('新的任务标题')
  renameSync(index, index + '.old')
  writeFileSync(index, line('thread-one', '轮换后的标题'))
  expect((await titles.enrich([session()]))[0].taskTitle).toBe('轮换后的标题')
})

it('索引缺失或不可读取时使用已上报标题，后续生成索引仍可恢复', async () => {
  expect((await titles.enrich([session({ taskTitle: '宿主标题' })]))[0].taskTitle).toBe('宿主标题')
  mkdirSync(index)
  expect((await titles.enrich([session()]))[0].taskTitle).toBeNull()
  rmSync(index, { recursive: true })
  writeFileSync(index, line('thread-one', '真实标题'))
  expect((await titles.enrich([session({ taskTitle: '旧的标题' })]))[0].taskTitle).toBe('真实标题')
})
