import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import path from 'node:path'
import {
  collectMetrics,
  countHeavyProcesses,
  MetricsSampler,
  parseFreePct,
  parsePressureLevel,
  parseSwapUsedMB,
  type CommandRunner
} from '../src/main/metrics'
import { sharedSchema } from '../src/main/lan'
import { metricsSummary } from '../src/renderer/src/device-views'
import { Store } from '../src/main/database'
import { Chat } from '../src/main/chat'
import { startServer } from '../src/main/server'
import type { DeviceMetrics } from '../src/shared/lan'

const GB = 1024 ** 3
/** 模拟 macOS 上各命令的输出；未列出的命令视为失败。 */
function fakeRun(outputs: Record<string, string | Error>): CommandRunner {
  return async (file, args) => {
    const key = [file, ...args].join(' ')
    const value = outputs[key]
    if (value === undefined || value instanceof Error) throw value ?? new Error(`ENOENT ${key}`)
    return value
  }
}
const base = {
  platform: 'darwin' as const,
  now: () => 1_700_000_000_000,
  loadavg: () => [3.14159, 2.5, 1],
  cpus: () => 8,
  totalmem: () => 16 * GB,
  exists: (p: string) => p === '/System/Volumes/Data',
  statfs: async (p: string) => {
    expect(p).toBe('/System/Volumes/Data')
    return { free: 120 * GB, total: 460 * GB }
  }
}

it('解析 sysctl 输出：压力等级、swap 单位换算与可用内存百分比', () => {
  expect(parsePressureLevel('1\n')).toBe('normal')
  expect(parsePressureLevel('2')).toBe('warn')
  expect(parsePressureLevel('4')).toBe('critical')
  expect(parsePressureLevel('3')).toBeNull()
  expect(parsePressureLevel('')).toBeNull()
  expect(parsePressureLevel(null)).toBeNull()
  expect(parseSwapUsedMB('total = 6144.00M  used = 4599.12M  free = 1544.88M  (encrypted)')).toBe(
    4599.1
  )
  expect(parseSwapUsedMB('total = 0.00M  used = 0.00M  free = 0.00M')).toBe(0)
  expect(parseSwapUsedMB('total = 8.00G  used = 1.50G  free = 6.50G')).toBe(1536)
  expect(parseSwapUsedMB('garbage')).toBeNull()
  expect(parseSwapUsedMB(null)).toBeNull()
  expect(parseFreePct('56\n')).toBe(56)
  expect(parseFreePct('101')).toBeNull()
  expect(parseFreePct('abc')).toBeNull()
})

it('重任务进程按行计数，规则沿用 machine-status.py', () => {
  const ps = [
    'COMMAND',
    'node /x/node_modules/.bin/vitest run --pool forks',
    'node /x/node_modules/vitest/dist/workers/forks.js',
    'node scripts/quality/pre-push.mjs',
    'node /x/tsgo --noEmit',
    'node /x/eslint . && lint-monorepo',
    'node /x/vite --config sdk.config.ts serve',
    'pnpm dev:sdk',
    'node run-pixel-check.mjs',
    '/usr/bin/zsh'
  ].join('\n')
  expect(countHeavyProcesses(ps)).toEqual({
    prePush: 1,
    pixel: 1,
    vitest: 2,
    devServer: 2,
    tsc: 1,
    eslint: 1
  })
})

it('macOS 全部命令成功时输出完整负载', async () => {
  const metrics = await collectMetrics({
    ...base,
    run: fakeRun({
      'sysctl -n kern.memorystatus_vm_pressure_level': '2\n',
      'sysctl -n kern.memorystatus_level': '41\n',
      'sysctl -n vm.swapusage': 'total = 6144.00M  used = 4599.12M  free = 1544.88M  (encrypted)\n',
      'ps -axo command': 'COMMAND\nnode vitest\n'
    })
  })
  expect(metrics).toEqual({
    at: 1_700_000_000_000,
    cpu: { cores: 8, load1: 3.14, load5: 2.5, load15: 1 },
    memory: { totalGB: 16, freePct: 41, pressure: 'warn', swapUsedMB: 4599.1 },
    disk: { path: '/System/Volumes/Data', freeGB: 120, totalGB: 460, usedPct: 73.9 },
    procs: { prePush: 0, pixel: 0, vitest: 1, devServer: 0, tsc: 0, eslint: 0 }
  })
})

it('命令失败、超时与 statfs 异常只降级对应字段，不抛错', async () => {
  const metrics = await collectMetrics({
    ...base,
    exists: () => false,
    statfs: async () => {
      throw new Error('EACCES')
    },
    run: fakeRun({ 'sysctl -n kern.memorystatus_level': 'oops' })
  })
  expect(metrics.cpu).toEqual({ cores: 8, load1: 3.14, load5: 2.5, load15: 1 })
  expect(metrics.memory).toEqual({ totalGB: 16, freePct: null, pressure: null, swapUsedMB: null })
  expect(metrics.disk).toBeNull()
  expect(metrics.procs).toBeNull()
})

it('真实超时：外部命令卡住时在超时后降级，不阻塞采集', async () => {
  const started = Date.now()
  const metrics = await collectMetrics({
    ...base,
    // 模拟命令执行器的超时行为：子进程被终止后 reject。
    run: (file) =>
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`timeout ${file}`)), 50))
  })
  expect(Date.now() - started).toBeLessThan(2000)
  expect(metrics.memory.pressure).toBeNull()
  expect(metrics.procs).toBeNull()
  expect(metrics.disk?.path).toBe('/System/Volumes/Data')
})

it('非 macOS 不调用 sysctl，可用内存退回 os.freemem，磁盘使用 /', async () => {
  const run = vi.fn<CommandRunner>(async () => 'COMMAND\n')
  const metrics = await collectMetrics({
    ...base,
    platform: 'linux',
    freemem: () => 4 * GB,
    statfs: async (p) => {
      expect(p).toBe('/')
      return { free: 10 * GB, total: 100 * GB }
    },
    run
  })
  expect(run.mock.calls.map(([file]) => file)).toEqual(['ps'])
  expect(metrics.memory).toEqual({ totalGB: 16, freePct: 25, pressure: null, swapUsedMB: null })
  expect(metrics.disk).toMatchObject({ path: '/', freeGB: 10, usedPct: 90 })
})

it('本机实测采集一次：字段齐全且耗时受控', async () => {
  const metrics = await collectMetrics()
  expect(metrics.cpu.cores).toBeGreaterThan(0)
  expect(metrics.memory.totalGB).toBeGreaterThan(0)
  if (process.platform === 'darwin') {
    expect(metrics.memory.pressure).not.toBeNull()
    expect(metrics.disk?.path).toBe('/System/Volumes/Data')
  }
}, 10000)

it('采集器：失败时保留上一次结果，并发刷新只运行一轮', async () => {
  let calls = 0
  let fail = false
  const sample = (at: number) => ({ at }) as unknown as DeviceMetrics
  const sampler = new MetricsSampler({
    collect: async () => {
      calls++
      if (fail) throw new Error('boom')
      return sample(calls)
    }
  })
  expect(sampler.current()).toBeNull()
  await Promise.all([sampler.refresh(), sampler.refresh()])
  expect(calls).toBe(1)
  expect(sampler.current()?.at).toBe(1)
  fail = true
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  await sampler.refresh()
  warn.mockRestore()
  expect(sampler.current()?.at).toBe(1)
})

const sampleMetrics: DeviceMetrics = {
  at: 1_700_000_000_000,
  cpu: { cores: 8, load1: 2.5, load5: 2, load15: 1.5 },
  memory: { totalGB: 16, freePct: 56, pressure: 'normal', swapUsedMB: 4599.1 },
  disk: { path: '/System/Volumes/Data', freeGB: 120, totalGB: 460, usedPct: 73.9 },
  procs: { prePush: 0, pixel: 0, vitest: 1, devServer: 0, tsc: 0, eslint: 0 }
}
const snapshotBody = (extra: Record<string, unknown>) => ({
  device: { id: randomUUID(), name: 'peer', protocol: 1 },
  folders: [],
  skills: [],
  ...extra
})

it('对端快照兼容：旧版本不带 metrics、非法 metrics 降为 null，合法 metrics 原样保留', () => {
  // 旧版本对端：没有 metrics 字段，快照仍然有效。
  const old = sharedSchema.parse(snapshotBody({}))
  expect(old.metrics ?? null).toBeNull()
  expect(sharedSchema.parse(snapshotBody({ metrics: null })).metrics).toBeNull()
  // 未来版本或损坏数据：metrics 不合法时只丢弃负载，不影响整份快照。
  const broken = sharedSchema.parse(snapshotBody({ metrics: { at: 'x', cpu: 1 } }))
  expect(broken.metrics).toBeNull()
  expect(broken.folders).toEqual([])
  // 新增未知字段会被剥离，已知字段保留。
  const parsed = sharedSchema.parse(snapshotBody({ metrics: { ...sampleMetrics, gpu: 1 } }))
  expect(parsed.metrics).toEqual(sampleMetrics)
})

it('渲染摘要只展示存在的字段', () => {
  expect(metricsSummary(sampleMetrics)).toBe(
    '负载 2.5/8 核 · 内存 可用 56% 压力正常 · swap 4.5 GB · 磁盘剩余 120/460 GB'
  )
  expect(
    metricsSummary({
      ...sampleMetrics,
      memory: { totalGB: 16, freePct: null, pressure: null, swapUsedMB: null },
      disk: null
    })
  ).toBe('负载 2.5/8 核')
})

let root: string
let store: Store
let chat: Chat
const self = { id: randomUUID(), name: 'jiedeMacBook-Pro', protocol: 1 }
const peers = [
  { id: randomUUID(), name: 'almondeMac22-Mini', online: true, metrics: sampleMetrics },
  // 旧版本对端：没有负载数据。
  { id: randomUUID(), name: 'jiedeMac-mini11', online: false, metrics: null }
]
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'ebisu-metrics-'))
  store = new Store(path.join(root, 'state.sqlite'))
  chat = new Chat(store, () => self)
  chat.attach(
    {
      list: () => [
        {
          id: self.id,
          name: self.name,
          self: true,
          online: true,
          metrics: { ...sampleMetrics, at: 42 }
        },
        ...peers.map(({ id, name, online, metrics }) => ({
          id,
          name,
          self: false,
          online,
          metrics
        }))
      ],
      resolve: (value) =>
        [self, ...peers].find(
          (device) => device.id === value || device.name.toLowerCase() === value.toLowerCase()
        )?.id ?? null
    },
    () => {}
  )
})
afterEach(() => {
  chat.close()
  store.close()
  rmSync(root, { recursive: true, force: true })
})

it('chat devices / metrics 命令输出结构：本机与对端都带 metrics，--device 过滤，未知设备报错', async () => {
  const runtimeFile = path.join(root, 'runtime.json')
  const server = await startServer(store, runtimeFile, () => {}, undefined, chat)
  const spawnJson = (script: string, args: string[]) =>
    new Promise<{ code: number; out: Record<string, any> }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          path.join(__dirname, '../resources/integration', script),
          '--runtime',
          runtimeFile,
          ...args
        ],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HOME: root } }
      )
      let out = ''
      child.stdout.on('data', (chunk) => (out += chunk))
      child.once('error', reject)
      child.once('close', (code) => resolve({ code: code ?? 0, out: JSON.parse(out) }))
      child.stdin.end()
    })
  const chatCli = (...args: string[]) => spawnJson('chat.cjs', ['--terminal', 'claude', ...args])
  try {
    const devices = (await chatCli('devices')).out
    expect(devices.ok).toBe(true)
    expect(devices.devices).toEqual([
      {
        id: self.id,
        name: 'jiedeMacBook-Pro',
        self: true,
        online: true,
        metrics: { ...sampleMetrics, at: 42 }
      },
      {
        id: peers[0].id,
        name: 'almondeMac22-Mini',
        self: false,
        online: true,
        metrics: sampleMetrics
      },
      { id: peers[1].id, name: 'jiedeMac-mini11', self: false, online: false, metrics: null }
    ])
    // metrics 命令与 devices 结构一致，只是专用于负载查询。
    const all = (await chatCli('metrics')).out
    expect(all.devices.map((d: { name: string }) => d.name)).toEqual([
      'jiedeMacBook-Pro',
      'almondeMac22-Mini',
      'jiedeMac-mini11'
    ])
    expect(all.devices[0].metrics.at).toBe(42)
    const one = (await chatCli('metrics', '--device', 'ALMONDEMAC22-MINI')).out
    expect(one).toEqual({
      ok: true,
      devices: [
        {
          id: peers[0].id,
          name: 'almondeMac22-Mini',
          self: false,
          online: true,
          metrics: sampleMetrics
        }
      ]
    })
    const old = (await chatCli('metrics', '--device', 'jiedeMac-mini11')).out
    expect(old.devices[0].metrics).toBeNull()
    const missing = await chatCli('metrics', '--device', 'nobody')
    expect(missing.code).not.toBe(0)
    expect(missing.out).toMatchObject({ ok: false, reason: expect.stringContaining('未找到') })
    // 帮助文本说明字段含义。
    const help = await new Promise<string>((resolve) => {
      const child = spawn(
        process.execPath,
        [path.join(__dirname, '../resources/integration/chat.cjs'), 'protocol'],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
      )
      let out = ''
      child.stdout.on('data', (chunk) => (out += chunk))
      child.once('close', () => resolve(out))
    })
    expect(help).toContain('metrics [--device')
    expect(help).toContain('memory.pressure')
    // 通知桥 report --chat metrics 走同一接口，始终 0 退出。
    const report = await spawnJson('report.cjs', [
      '--terminal',
      'claude',
      '--chat',
      'metrics',
      '--device',
      'jiedeMacBook-Pro'
    ])
    expect(report.code).toBe(0)
    expect(report.out.devices).toHaveLength(1)
    expect(report.out.devices[0]).toMatchObject({ self: true, metrics: { at: 42 } })
  } finally {
    await server.close()
  }
}, 30000)
