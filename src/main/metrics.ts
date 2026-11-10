import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import os from 'node:os'
import { z } from 'zod'
import type { DeviceMetrics, MemoryPressure } from '../shared/lan'

/** 采集周期：30 秒。 */
export const METRICS_INTERVAL_MS = 30_000
/** 单个外部命令的超时；超时后子进程被终止，该项降级为 null。 */
const COMMAND_TIMEOUT_MS = 3000

/**
 * 重任务进程的命令行匹配规则，沿用知识库临时脚本 machine-status.py 的 procs 定义。
 * 只计数用于派单参考，不据此终止任何进程。
 */
export const HEAVY_PROCESS_PATTERNS: Record<string, RegExp> = {
  prePush: /scripts\/quality\/pre-push\.mjs/,
  pixel: /run-pixel-check|word-preview/,
  vitest: /vitest/,
  devServer: /vite( |$).*(sdk|serve)|dev:sdk/,
  tsc: /tsgo|tsc /,
  eslint: /eslint|lint-monorepo/
}

/** 执行外部命令并返回 stdout；失败或超时时抛错，由调用方降级。 */
export type CommandRunner = (file: string, args: string[]) => Promise<string>
export interface CollectOptions {
  run?: CommandRunner
  platform?: NodeJS.Platform
  now?: () => number
  loadavg?: () => number[]
  cpus?: () => number
  totalmem?: () => number
  freemem?: () => number
  /** 返回卷容量（字节）；测试可注入。 */
  statfs?: (path: string) => Promise<{ free: number; total: number }>
  exists?: (path: string) => boolean
}

/** 默认命令执行器：不经过 shell，带超时与输出上限，失败时 reject。 */
export const runCommand: CommandRunner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    )
  })

async function defaultStatfs(path: string): Promise<{ free: number; total: number }> {
  const stats = await statfs(path)
  // bavail 为非特权用户可用块数，与 df / shutil.disk_usage 的“可用”一致。
  return { free: stats.bavail * stats.bsize, total: stats.blocks * stats.bsize }
}

const round = (value: number, digits = 1) => {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}
const GB = 1024 ** 3

/** 解析 kern.memorystatus_vm_pressure_level：1 normal，2 warn，4 critical；其他值为 null。 */
export function parsePressureLevel(output: string | null): MemoryPressure | null {
  const level = output?.trim()
  return level === '1' ? 'normal' : level === '2' ? 'warn' : level === '4' ? 'critical' : null
}
/** 解析 vm.swapusage 中的已用量，统一换算为 MB；例如 `total = 6144.00M  used = 4599.12M ...`。 */
export function parseSwapUsedMB(output: string | null): number | null {
  const match = /used\s*=\s*([\d.]+)\s*([KMGT])?/i.exec(output ?? '')
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value)) return null
  const unit = (match[2] ?? 'M').toUpperCase()
  const factor = unit === 'K' ? 1 / 1024 : unit === 'G' ? 1024 : unit === 'T' ? 1024 * 1024 : 1
  return round(value * factor, 1)
}
/** 解析 kern.memorystatus_level（0–100 的可用内存百分比）。 */
export function parseFreePct(output: string | null): number | null {
  const text = output?.trim() ?? ''
  if (!/^\d+$/.test(text)) return null
  const value = Number(text)
  return value >= 0 && value <= 100 ? value : null
}
/** 按命令行逐行匹配重任务规则，同一行在每个规则下最多计一次。 */
export function countHeavyProcesses(output: string): Record<string, number> {
  const lines = output.split('\n').filter((line) => line.trim())
  return Object.fromEntries(
    Object.entries(HEAVY_PROCESS_PATTERNS).map(([key, pattern]) => [
      key,
      lines.filter((line) => pattern.test(line)).length
    ])
  )
}

/**
 * 采集一次本机负载。所有外部命令都有超时，任一项失败只把该项降为 null，函数本身不抛错。
 */
export async function collectMetrics(options: CollectOptions = {}): Promise<DeviceMetrics> {
  const run = options.run ?? runCommand
  const platform = options.platform ?? process.platform
  const darwin = platform === 'darwin'
  const exists = options.exists ?? existsSync
  const safe = async <T>(task: () => Promise<T>): Promise<T | null> => {
    try {
      return await task()
    } catch {
      return null
    }
  }
  const sysctl = (name: string) => (darwin ? safe(() => run('sysctl', ['-n', name])) : null)
  const diskPath = darwin && exists('/System/Volumes/Data') ? '/System/Volumes/Data' : '/'
  // 相互独立的采集并发执行，总耗时受单个命令超时约束。
  const [pressure, level, swap, disk, ps] = await Promise.all([
    sysctl('kern.memorystatus_vm_pressure_level'),
    sysctl('kern.memorystatus_level'),
    sysctl('vm.swapusage'),
    safe(() => (options.statfs ?? defaultStatfs)(diskPath)),
    safe(() => run('ps', ['-axo', 'command']))
  ])
  const [load1 = 0, load5 = 0, load15 = 0] = (options.loadavg ?? os.loadavg)()
  const total = (options.totalmem ?? os.totalmem)()
  // 非 macOS 没有 memorystatus，退回 os.freemem；macOS 上 freemem 只含空闲页，读取失败时宁可为 null。
  const freePct = darwin
    ? parseFreePct(level)
    : total > 0
      ? round(((options.freemem ?? os.freemem)() / total) * 100, 0)
      : null
  return {
    at: (options.now ?? Date.now)(),
    cpu: {
      cores: (options.cpus ?? (() => os.cpus().length))(),
      load1: round(load1, 2),
      load5: round(load5, 2),
      load15: round(load15, 2)
    },
    memory: {
      totalGB: round(total / GB),
      freePct,
      pressure: parsePressureLevel(pressure),
      swapUsedMB: parseSwapUsedMB(swap)
    },
    disk:
      disk && disk.total > 0
        ? {
            path: diskPath,
            freeGB: round(disk.free / GB),
            totalGB: round(disk.total / GB),
            usedPct: round((100 * (disk.total - disk.free)) / disk.total)
          }
        : null,
    procs: ps === null ? null : countHeavyProcesses(ps)
  }
}

/** 对端负载的校验规则；字段不合法时整体视为 null，不能影响快照与在线状态。 */
const num = z.number().refine(Number.isFinite)
export const metricsSchema = z.object({
  at: num,
  cpu: z.object({ cores: num, load1: num, load5: num, load15: num }),
  memory: z.object({
    totalGB: num,
    freePct: num.nullable(),
    pressure: z.enum(['normal', 'warn', 'critical']).nullable(),
    swapUsedMB: num.nullable()
  }),
  disk: z
    .object({ path: z.string().max(4096), freeGB: num, totalGB: num, usedPct: num })
    .nullable(),
  procs: z
    .record(z.string().max(64), z.number().int().nonnegative())
    .refine((value) => Object.keys(value).length <= 64)
    .nullable()
})

/**
 * 周期采集器：启动时立即采集一次，之后每 30 秒一次；上一轮未结束时跳过本轮。
 * 定时器 unref，不阻止进程退出；采集失败保留上一次结果。
 */
export class MetricsSampler {
  private latest: DeviceMetrics | null = null
  private timer?: ReturnType<typeof setInterval>
  private running?: Promise<void>
  constructor(
    private readonly options: {
      intervalMs?: number
      collect?: () => Promise<DeviceMetrics>
      changed?: () => void
    } = {}
  ) {}
  current(): DeviceMetrics | null {
    return this.latest
  }
  refresh(): Promise<void> {
    if (this.running) return this.running
    this.running = (async () => {
      try {
        this.latest = await (this.options.collect ?? collectMetrics)()
        this.options.changed?.()
      } catch (error) {
        console.warn('采集本机负载失败:', String(error))
      }
    })().finally(() => {
      this.running = undefined
    })
    return this.running
  }
  start(): void {
    if (this.timer) return
    void this.refresh()
    this.timer = setInterval(
      () => void this.refresh(),
      this.options.intervalMs ?? METRICS_INTERVAL_MS
    )
    this.timer.unref?.()
  }
  stop(): void {
    clearInterval(this.timer)
    this.timer = undefined
  }
}
