import { afterEach, beforeEach, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Store } from '../src/main/database'
import { RemoteCommands } from '../src/main/remote-commands'
import type { DeviceIdentity } from '../src/shared/lan'

let root: string
let store: Store
let manager: RemoteCommands
const source: DeviceIdentity = { id: randomUUID(), name: 'remote', protocol: 1 }

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'ebisu-remote-command-'))
  store = new Store(path.join(root, 'state.sqlite'))
  const executable = path.join(root, 'fake-agent')
  writeFileSync(
    executable,
    '#!/bin/sh\nprintf \'{"thread_id":"native-session","summary":"处理完成"}\'\n'
  )
  chmodSync(executable, 0o755)
  manager = new RemoteCommands(store, () => ({ id: randomUUID(), name: 'local', protocol: 1 }), {
    resolveExecutable: () => executable
  })
  manager.setEnabled(true)
})

afterEach(() => {
  manager.close()
  store.close()
  rmSync(root, { recursive: true, force: true })
})

async function until(predicate: () => boolean) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 3000) throw new Error('等待远程任务超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

it('创建任务、幂等重试并返回结构化结论', async () => {
  const project = path.join(root, 'project')
  mkdirSync(project)
  const requestId = randomUUID()
  const first = await manager.create(source, {
    requestId,
    terminal: 'codex',
    path: project,
    prompt: '完成测试'
  })
  const duplicate = await manager.create(source, {
    requestId,
    terminal: 'codex',
    path: project,
    prompt: '完成测试'
  })
  expect(duplicate.commandId).toBe(first.commandId)
  await until(() => manager.get(first.commandId)?.status === 'completed')
  expect(manager.get(first.commandId)?.result).toMatchObject({
    status: 'completed',
    summary: '处理完成',
    exitCode: 0
  })
  expect(manager.get(first.commandId)?.sessionId).toBe('native-session')
})

it('默认关闭远程执行并拒绝不存在的项目路径', async () => {
  manager.setEnabled(false)
  const disabled = new RemoteCommands(store, () => source, {
    resolveExecutable: () => '/bin/true'
  })
  await expect(
    disabled.create(source, {
      requestId: randomUUID(),
      terminal: 'codex',
      path: root,
      prompt: '拒绝'
    })
  ).rejects.toThrow('未开启')
  disabled.setEnabled(true)
  await expect(
    disabled.create(source, {
      requestId: randomUUID(),
      terminal: 'codex',
      path: path.join(root, 'missing'),
      prompt: '拒绝'
    })
  ).rejects.toThrow('路径不存在')
  disabled.close()
})
