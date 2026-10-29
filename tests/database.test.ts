import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Store, LEASE_MS } from '../src/main/database'
import { canonicalDirectory, containsPath } from '../src/main/paths'
import type { ActivityRequest } from '../src/shared/types'

let root: string
let store: Store
let time: number
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'ebisu-store-'))
  time = 1_800_000_000_000
  store = new Store(path.join(root, 'state.sqlite'), () => time)
})
afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})
function folder(name: string) {
  const directory = path.join(root, name)
  mkdirSync(directory, { recursive: true })
  return store.addFolder(directory)
}
function report(directory: string, patch: Partial<ActivityRequest> = {}) {
  return store.activity({
    path: directory,
    terminal: 'codex',
    sessionId: 'session-1',
    action: 'enter',
    ...patch
  })
}

describe('目录与会话租约', () => {
  it('旧表原地增加任务标题列，心跳、别名迁移及重启不会丢失标题', () => {
    const project = folder('repo')
    report(project.path)
    store.db.exec('ALTER TABLE activities DROP COLUMN taskTitle; PRAGMA user_version=2')
    store.close()
    store = new Store(path.join(root, 'state.sqlite'), () => time)
    expect(store.sessions(project.id)[0].taskTitle).toBeNull()
    report(project.path, { sessionId: 'local-task', taskTitle: '修复登录问题', sequence: 10 })
    report(project.path, { sessionId: 'real-task', sessionAliases: ['local-task'], sequence: 11 })
    report(project.path, { sessionId: 'real-task', sequence: 12 })
    expect(store.sessions(project.id).find((s) => s.sessionId === 'real-task')?.taskTitle).toBe(
      '修复登录问题'
    )
    report(project.path, { sessionId: 'real-task', taskTitle: '新的真实标题', sequence: 13 })
    report(project.path, { sessionId: 'real-task', taskTitle: '迟到标题', sequence: 12 })
    store.close()
    store = new Store(path.join(root, 'state.sqlite'), () => time)
    expect(store.sessions(project.id).find((s) => s.sessionId === 'real-task')?.taskTitle).toBe(
      '新的真实标题'
    )
    expect(store.db.pragma('user_version', { simple: true })).toBe(3)
  })
  it('身份别名跨重启保留，等待状态和退出序号不因迁移丢失', () => {
    const project = folder('repo')
    report(project.path, { sessionId: 'local-old', phase: 'waiting', sequence: 10 })
    report(project.path, { sessionId: 'real-id', sessionAliases: ['local-old'], sequence: 9 })
    expect(store.sessions(project.id)).toMatchObject([{ sessionId: 'real-id', phase: 'waiting' }])
    store.close()
    store = new Store(path.join(root, 'state.sqlite'), () => time)
    report(project.path, { sessionId: 'local-old', action: 'exit', scope: 'session', sequence: 12 })
    report(project.path, { sessionId: 'real-id', sequence: 11 })
    expect(store.sessions(project.id)).toHaveLength(0)
    report(project.path, { sessionId: 'local-old', sequence: 13 })
    expect(store.sessions(project.id)).toMatchObject([{ sessionId: 'real-id' }])
  })
  it('迁移旧身份的退出墓碑，拒绝别名重新绑定及真实 ID 间的合并', () => {
    const project = folder('repo')
    report(project.path, { sessionId: 'local-old', action: 'exit', scope: 'session', sequence: 20 })
    report(project.path, { sessionId: 'real-one', sessionAliases: ['local-old'], sequence: 19 })
    expect(store.sessions(project.id)).toHaveLength(0)
    report(project.path, { sessionId: 'real-one', sequence: 21 })
    report(project.path, {
      sessionId: 'real-two',
      sessionAliases: ['local-old', 'real-one'],
      sequence: 22
    })
    report(project.path, { sessionId: 'local-old', action: 'exit', scope: 'session', sequence: 23 })
    expect(store.sessions(project.id)).toMatchObject([{ sessionId: 'real-two' }])
  })
  it('记录已结束会话的最后事件时间，供投影发现避免复活显式退出', () => {
    const project = folder('repo')
    expect(store.endedSessions(project.id).size).toBe(0)
    report(project.path, { terminal: 'dsh', sessionId: 'session-dsh' })
    expect(store.endedSessions(project.id).size).toBe(0)
    time += 1000
    report(project.path, {
      terminal: 'dsh',
      sessionId: 'session-dsh',
      action: 'exit',
      scope: 'session'
    })
    expect(store.sessions(project.id)).toHaveLength(0)
    expect(store.endedSessions(project.id).get('dsh:session-dsh')).toBe(time)
  })
  it('按真实路径去重，并使用最深目录和路径边界匹配', () => {
    const parent = folder('repo')
    const child = folder('repo/nested')
    folder('repo-other')
    const alias = path.join(root, 'alias')
    symlinkSync(parent.path, alias)
    expect(store.addFolder(alias).id).toBe(parent.id)
    expect(containsPath(parent.path, path.join(root, 'repo-ab'))).toBe(false)
    report(child.path)
    expect(store.sessions(parent.id)).toHaveLength(0)
    expect(store.sessions(child.id)).toHaveLength(1)
    expect(report(root).ignored).toBe(true)
  })
  it('拒绝相对目录及文件路径', () => {
    expect(() => canonicalDirectory('relative')).toThrow('绝对路径')
    expect(() => store.addFolder(path.join(root, 'state.sqlite'))).toThrow('文件夹')
  })
  it('同一会话重复心跳幂等，多个终端及同一终端多个会话均保留', () => {
    const project = folder('repo')
    report(project.path)
    time += 10
    report(project.path)
    report(project.path, { terminal: 'claude' })
    report(project.path, { sessionId: 'session-2' })
    expect(store.sessions(project.id)).toHaveLength(3)
    expect(store.sessions(project.id)[0].startedAt).toBe(time - 10)
    expect(store.sessions(project.id)[0].lastSeen).toBe(time)
  })
  it('等待确认仍占用，软 Stop 保留等待，恢复和强制关闭正确释放', () => {
    const project = folder('repo')
    report(project.path, { phase: 'waiting', sequence: 1 })
    report(project.path, { action: 'exit', preserveWaiting: true, sequence: 2 })
    expect(store.sessions(project.id)[0].phase).toBe('waiting')
    report(project.path, { phase: 'executing', sequence: 3 })
    expect(store.sessions(project.id)[0].phase).toBe('executing')
    report(project.path, { action: 'exit', sequence: 4 })
    report(project.path, { action: 'exit', sequence: 5 })
    expect(store.sessions(project.id)).toHaveLength(0)
  })
  it('故障跨退出与租约保留，并由同项目下一次执行请求清除', () => {
    const project = folder('repo')
    const other = folder('other')
    report(project.path, { sessionId: 'failed', phase: 'error', sequence: 1 })
    report(other.path, { sessionId: 'other-failed', phase: 'error', sequence: 2 })
    report(project.path, { sessionId: 'failed', action: 'exit', scope: 'session', sequence: 3 })
    time += LEASE_MS * 2
    expect(store.sessions(project.id)).toMatchObject([{ sessionId: 'failed', phase: 'error' }])
    expect(store.sessions(other.id)).toMatchObject([{ sessionId: 'other-failed', phase: 'error' }])
    // 等待上报不会覆盖故障。
    report(project.path, {
      terminal: 'claude',
      sessionId: 'waiting',
      phase: 'waiting',
      sequence: 4
    })
    report(project.path, { sessionId: 'failed', phase: 'waiting', sequence: 5 })
    expect(store.sessions(project.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: 'failed', phase: 'error' }),
        expect.objectContaining({ sessionId: 'waiting', phase: 'waiting' })
      ])
    )
    // 同项目的执行中请求清除全部故障，其他项目保持不变。
    report(project.path, {
      terminal: 'claude',
      sessionId: 'resumed',
      phase: 'executing',
      sequence: 6
    })
    const projectSessions = store.sessions(project.id)
    expect(projectSessions.some((session) => session.phase === 'error')).toBe(false)
    expect(projectSessions.find((session) => session.sessionId === 'resumed')?.phase).toBe(
      'executing'
    )
    expect(store.sessions(other.id)).toMatchObject([{ sessionId: 'other-failed', phase: 'error' }])
  })
  it('每个目录独立释放，session 范围关闭清理跨目录活动', () => {
    const first = folder('one')
    const second = folder('two')
    report(first.path)
    report(second.path)
    report(first.path, { action: 'exit' })
    expect(store.sessions(second.id)).toHaveLength(1)
    report(first.path)
    report(root, { action: 'exit', scope: 'session' })
    expect(store.sessions(first.id)).toHaveLength(0)
    expect(store.sessions(second.id)).toHaveLength(0)
  })
  it('结束后的迟到请求不会复活记录，较新的任务仍能进入', () => {
    const project = folder('repo')
    report(project.path, { sequence: 10 })
    report(project.path, { action: 'exit', sequence: 12 })
    report(project.path, { sequence: 11 })
    expect(store.sessions(project.id)).toHaveLength(0)
    report(project.path, { sequence: 13 })
    expect(store.sessions(project.id)).toHaveLength(1)
  })
  it('执行中与等待中均在恰好十分钟过期，刷新只延长对应会话', () => {
    const project = folder('repo')
    report(project.path)
    report(project.path, { sessionId: 'waiting', phase: 'waiting' })
    time += LEASE_MS - 1
    expect(store.sessions(project.id)).toHaveLength(2)
    report(project.path)
    time++
    expect(store.sessions(project.id)).toHaveLength(1)
    time += LEASE_MS
    expect(store.expire()).toBe(true)
    expect(store.sessions(project.id)).toHaveLength(0)
  })
  it('退出先于首次进入到达时，也不会被迟到的旧请求复活', () => {
    const project = folder('repo')
    report(project.path, { action: 'exit', scope: 'session', sequence: 100 })
    report(project.path, { sequence: 99 })
    expect(store.sessions(project.id)).toHaveLength(0)
    report(project.path, { sequence: 101 })
    expect(store.sessions(project.id)).toHaveLength(1)
  })
  it('重启恢复未过期活动，系统长时间休眠后清除过期活动', () => {
    const project = folder('repo')
    report(project.path)
    store.close()
    time += 1000
    store = new Store(path.join(root, 'state.sqlite'), () => time)
    expect(store.sessions(project.id)).toHaveLength(1)
    store.close()
    time += LEASE_MS
    store = new Store(path.join(root, 'state.sqlite'), () => time)
    expect(store.sessions(project.id)).toHaveLength(0)
  })
  it('删除目录关联只删除记录，不删除实际目录；设置可持久化', () => {
    const project = folder('repo')
    report(project.path)
    store.renameFolder(project.id, ' 新名称 ')
    expect(store.folders()[0].name).toBe('新名称')
    store.saveSettings({ theme: 'dark', avatars: { 'model:claude': '/tmp/claude.png' } })
    expect(store.settings().avatars['model:claude']).toBe('/tmp/claude.png')
    store.removeFolder(project.id)
    expect(store.sessions(project.id)).toHaveLength(0)
    expect(canonicalDirectory(project.path)).toBe(project.path)
  })
  it('目录已被移走时仍可结束整个会话', () => {
    const project = folder('repo')
    report(project.path)
    rmSync(project.path, { recursive: true })
    report(project.path, { action: 'exit', scope: 'session' })
    expect(store.sessions(project.id)).toHaveLength(0)
  })
})
