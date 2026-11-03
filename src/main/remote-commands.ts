import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { z } from 'zod'
import type {
  DeviceIdentity,
  RemoteCommand,
  RemoteCommandRequest,
  RemoteCommandResult,
  RemoteCommandStatus,
  RemoteCommandTerminal
} from '../shared/lan'
import { remoteCommandStatuses } from '../shared/lan'
import type { Store } from './database'
import type { TerminalId } from '../shared/types'
import { remoteArgs } from './terminal-adapters'
import { SkillError } from './skills'

const MAX_PROMPT = 64 * 1024
const MAX_OUTPUT = 1024 * 1024
const MAX_ACTIVE_PER_SOURCE = 4
const RETAIN_MS = 30 * 24 * 60 * 60 * 1000
const SUPPORTED = new Set<RemoteCommandTerminal>(['codex', 'claude', 'dsh', 'qoder'])
const requestSchema = z
  .object({
    requestId: z.string().uuid(),
    terminal: z.enum(['codex', 'claude', 'dsh', 'qoder']),
    path: z
      .string()
      .min(1)
      .max(16384)
      .refine((value) => path.isAbsolute(value), 'path 必须是绝对路径'),
    prompt: z.string().trim().min(1).max(MAX_PROMPT)
  })
  .strict()

type CommandRow = RemoteCommand & {
  sourceId: string
  sourceJson: string
  resultJson: string | null
}

interface Options {
  now?: () => number
  changed?: () => void
  resolveExecutable?: (terminal: RemoteCommandTerminal) => string | null
}

/**
 * 远程任务只接受固定终端标识和提示词，绝不经过 shell。
 * 任务表是恢复和幂等的唯一事实来源，子进程仅保存在内存中用于取消。
 */
export class RemoteCommands {
  private readonly now: () => number
  private readonly changed: () => void
  private readonly children = new Map<string, ChildProcess>()
  private readonly commands = new Map<string, RemoteCommand>()
  private readonly resolveExecutable: (terminal: RemoteCommandTerminal) => string | null

  constructor(
    private readonly store: Store,
    private readonly localDevice: () => DeviceIdentity,
    options: Options = {}
  ) {
    this.now = options.now ?? Date.now
    this.changed = options.changed ?? (() => {})
    this.resolveExecutable = options.resolveExecutable ?? defaultExecutable
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS remote_commands (
        commandId TEXT PRIMARY KEY,
        requestId TEXT NOT NULL,
        sourceId TEXT NOT NULL,
        sourceJson TEXT NOT NULL,
        terminal TEXT NOT NULL,
        path TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        sessionId TEXT,
        createdAt INTEGER NOT NULL,
        startedAt INTEGER,
        finishedAt INTEGER,
        resultJson TEXT,
        UNIQUE(sourceId, requestId)
      );
      CREATE INDEX IF NOT EXISTS remote_commands_created ON remote_commands(createdAt);
    `)
    const columns = store.db.prepare('PRAGMA table_info(remote_commands)').all() as {
      name: string
    }[]
    if (!columns.some((column) => column.name === 'prompt'))
      store.db.exec("ALTER TABLE remote_commands ADD COLUMN prompt TEXT NOT NULL DEFAULT ''")
    // 进程句柄无法跨重启恢复；将旧任务收敛为失败，避免调用方误以为仍在执行。
    store.db
      .prepare(
        `UPDATE remote_commands
         SET status='failed', finishedAt=?, resultJson=?
         WHERE status IN ('queued','running','waiting')`
      )
      .run(
        this.now(),
        JSON.stringify({
          status: 'failed',
          summary: '应用重启后任务未恢复',
          exitCode: null,
          error: '远程任务无法跨应用重启继续执行'
        } satisfies RemoteCommandResult)
      )
    for (const row of store.db
      .prepare('SELECT * FROM remote_commands ORDER BY createdAt DESC LIMIT 100')
      .all() as CommandRow[]) {
      this.commands.set(row.commandId, this.fromRow(row))
    }
  }

  enabled(): boolean {
    if (this.store.settings().remoteExecution === true) return true
    const row = this.store.db
      .prepare("SELECT value FROM lan_state WHERE key='remote-execution'")
      .get() as { value: string } | undefined
    return row?.value === 'true'
  }

  setEnabled(enabled: boolean): void {
    this.store.db
      .prepare("INSERT OR REPLACE INTO lan_state VALUES('remote-execution', ?)")
      .run(String(enabled))
    this.changed()
  }

  list(): RemoteCommand[] {
    return [...this.commands.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  get(commandId: string): RemoteCommand | undefined {
    return this.commands.get(commandId)
  }

  getForSource(commandId: string, sourceId: string): RemoteCommand | undefined {
    const command = this.commands.get(commandId)
    return command && command.source.id === sourceId ? command : undefined
  }

  async create(source: DeviceIdentity, input: RemoteCommandRequest): Promise<RemoteCommand> {
    const request = requestSchema.parse(input)
    if (!this.enabled()) throw new SkillError(409, '本机未开启远程任务执行')
    if (!SUPPORTED.has(request.terminal)) throw new SkillError(400, '该终端暂不支持远程任务')
    if (!existsSync(request.path) || !statSync(request.path).isDirectory())
      throw new SkillError(400, '项目路径不存在或不是目录')
    const existing = this.store.db
      .prepare('SELECT * FROM remote_commands WHERE sourceId=? AND requestId=?')
      .get(source.id, request.requestId) as CommandRow | undefined
    if (existing) return this.fromRow(existing)
    const active = this.store.db
      .prepare(
        `SELECT COUNT(*) AS count FROM remote_commands
         WHERE sourceId=? AND status IN ('queued','running','waiting')`
      )
      .get(source.id) as { count: number }
    if (active.count >= MAX_ACTIVE_PER_SOURCE)
      throw new SkillError(429, '该设备已有过多运行中的远程任务')
    this.store.db
      .prepare('DELETE FROM remote_commands WHERE finishedAt IS NOT NULL AND finishedAt<?')
      .run(this.now() - RETAIN_MS)
    const command: RemoteCommand = {
      commandId: randomUUID(),
      requestId: request.requestId,
      source,
      terminal: request.terminal,
      path: request.path,
      prompt: request.prompt,
      status: 'queued',
      sessionId: null,
      createdAt: this.now(),
      startedAt: null,
      finishedAt: null,
      result: null
    }
    this.persist(command)
    this.commands.set(command.commandId, command)
    this.changed()
    // 让 HTTP 请求尽快返回 queued，同时保持主进程事件循环可用。
    setImmediate(() => void this.run(command))
    return command
  }

  cancel(commandId: string): RemoteCommand {
    const command = this.mustGet(commandId)
    if (['completed', 'failed', 'cancelled'].includes(command.status)) return command
    const child = this.children.get(commandId)
    if (child) child.kill('SIGTERM')
    else
      this.finish(command, {
        status: 'cancelled',
        summary: '任务已取消',
        exitCode: null
      })
    return command
  }

  cancelForSource(commandId: string, sourceId: string): RemoteCommand {
    const command = this.getForSource(commandId, sourceId)
    if (!command) throw new SkillError(404, '任务不存在')
    return this.cancel(commandId)
  }

  close(): void {
    for (const child of this.children.values()) child.kill('SIGTERM')
    this.children.clear()
  }

  private async run(command: RemoteCommand): Promise<void> {
    if (command.status !== 'queued') return
    const executable = this.resolveExecutable(command.terminal)
    if (!executable) {
      this.finish(command, {
        status: 'failed',
        summary: `${command.terminal} 未检测到可执行文件`,
        exitCode: null,
        error: '请先安装并配置对应终端'
      })
      return
    }
    command.status = 'running'
    command.startedAt = this.now()
    command.sessionId = `remote-${command.commandId}`
    this.persist(command)
    this.changed()
    // 已注册项目可在现有面板显示会话；任意绝对路径仍只影响远程任务本身。
    this.store.activity({
      path: command.path,
      terminal: command.terminal,
      sessionId: command.sessionId,
      action: 'enter',
      phase: 'executing',
      taskTitle: command.prompt.slice(0, 512)
    })
    const args = remoteArgs(command.terminal, command.prompt)
    if (!args) {
      this.finish(command, {
        status: 'failed',
        summary: '该终端没有可用的非交互启动器',
        exitCode: null,
        error: '终端适配器未声明结构化远程执行参数'
      })
      return
    }
    let child: ChildProcess
    try {
      child = spawn(executable, args, {
        cwd: command.path,
        env: { ...process.env, EBISU_REMOTE_COMMAND_ID: command.commandId },
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      this.finish(command, {
        status: 'failed',
        summary: '终端启动失败',
        exitCode: null,
        error: String(error)
      })
      return
    }
    this.children.set(command.commandId, child)
    let output = ''
    const append = (chunk: Buffer | string) => {
      output = `${output}${chunk}`.slice(-MAX_OUTPUT)
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.once('error', (error) => {
      this.children.delete(command.commandId)
      this.finish(command, {
        status: 'failed',
        summary: '终端执行失败',
        exitCode: null,
        output: output || undefined,
        error: String(error)
      })
    })
    child.once('close', (code, signal) => {
      this.children.delete(command.commandId)
      const cancelled = command.status === 'cancelled' || signal === 'SIGTERM'
      const parsed = parseOutput(output)
      if (parsed.sessionId && command.sessionId !== parsed.sessionId) {
        command.sessionId = parsed.sessionId
        this.persist(command)
      }
      const hasRealSession = !!command.sessionId && !command.sessionId.startsWith('remote-')
      this.finish(command, {
        status: cancelled
          ? 'cancelled'
          : code === 0 && parsed.structured && hasRealSession
            ? 'completed'
            : 'failed',
        summary: cancelled ? '任务已取消' : parsed.summary,
        exitCode: code,
        output: parsed.output,
        error: cancelled
          ? undefined
          : code === 0 && parsed.structured && hasRealSession
            ? undefined
            : parsed.error ||
              (code === 0 && !hasRealSession
                ? '终端未返回真实会话 ID，无法确认其已进入会话列表'
                : code === 0
                  ? '终端未返回结构化结果'
                  : `退出码 ${code}`)
      })
      this.store.activity({
        path: command.path,
        terminal: command.terminal,
        sessionId: command.sessionId!,
        action: 'exit',
        scope: 'session'
      })
    })
  }

  private finish(command: RemoteCommand, result: RemoteCommandResult): void {
    if (command.finishedAt !== null) return
    command.status = result.status
    command.finishedAt = this.now()
    command.result = result
    this.persist(command)
    this.changed()
  }

  private persist(command: RemoteCommand): void {
    this.store.db
      .prepare(
        `INSERT OR REPLACE INTO remote_commands
         (commandId,requestId,sourceId,sourceJson,terminal,path,prompt,status,sessionId,createdAt,startedAt,finishedAt,resultJson)
         VALUES(@commandId,@requestId,@sourceId,@sourceJson,@terminal,@path,@prompt,@status,@sessionId,@createdAt,@startedAt,@finishedAt,@resultJson)`
      )
      .run({
        commandId: command.commandId,
        requestId: command.requestId,
        sourceId: command.source.id,
        sourceJson: JSON.stringify(command.source),
        terminal: command.terminal,
        path: command.path,
        prompt: command.prompt,
        status: command.status,
        sessionId: command.sessionId,
        createdAt: command.createdAt,
        startedAt: command.startedAt,
        finishedAt: command.finishedAt,
        resultJson: command.result ? JSON.stringify(command.result) : null
      })
  }

  private fromRow(row: CommandRow): RemoteCommand {
    return {
      commandId: row.commandId,
      requestId: row.requestId,
      source: JSON.parse(row.sourceJson),
      terminal: row.terminal,
      path: row.path,
      prompt: row.prompt,
      status: row.status,
      sessionId: row.sessionId,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      result: row.resultJson ? JSON.parse(row.resultJson) : null
    }
  }

  private mustGet(commandId: string): RemoteCommand {
    const command = this.commands.get(commandId)
    if (!command) throw new Error('任务不存在')
    return command
  }
}

function defaultExecutable(terminal: RemoteCommandTerminal): string | null {
  const override = process.env[`EBISU_REMOTE_${terminal.toUpperCase()}_COMMAND`]
  const candidates = override
    ? [override]
    : terminal === 'qoder'
      ? ['qodercli', 'qoder']
      : [terminal]
  const search = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && existsSync(candidate)) return candidate
    for (const directory of search) {
      const file = path.join(directory, candidate)
      try {
        if (existsSync(file) && statSync(file).isFile()) return file
      } catch {
        /* 探测失败交给后续候选项。 */
      }
    }
  }
  return null
}

function parseOutput(raw: string): {
  summary: string
  output?: string
  error?: string
  structured: boolean
  sessionId?: string
} {
  const output = raw.trim().slice(-MAX_OUTPUT)
  if (!output) return { summary: '终端未返回结构化结果', output: undefined, structured: false }
  const lines = output.split(/\r?\n/)
  let sessionId: string | undefined
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      sessionId ??=
        (typeof parsed.thread_id === 'string' && parsed.thread_id) ||
        (typeof parsed.session_id === 'string' && parsed.session_id) ||
        (typeof parsed.sessionId === 'string' && parsed.sessionId) ||
        undefined
    } catch {
      /* 日志行不是事件，继续寻找会话 ID。 */
    }
  }
  for (const line of lines.reverse()) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      const summary =
        (typeof parsed.summary === 'string' && parsed.summary) ||
        (typeof parsed.result === 'string' && parsed.result) ||
        line
      return { summary: summary.slice(0, 4096), output, structured: true, sessionId }
    } catch {
      /* CLI 可能输出日志行，继续寻找最后一条 JSON 结果。 */
    }
  }
  return { summary: output.slice(0, 4096), output, structured: false }
}

export function isRemoteCommandStatus(value: string): value is RemoteCommandStatus {
  return (remoteCommandStatuses as readonly string[]).includes(value)
}

export function isRemoteCommandTerminal(value: TerminalId): value is RemoteCommandTerminal {
  return SUPPORTED.has(value as RemoteCommandTerminal)
}
