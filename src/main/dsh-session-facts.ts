import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { LEASE_MS } from './database'
import { canonicalDirectory, deepestFolder } from './paths'
import type { Folder, SessionActivity } from '../shared/types'

/** DSH 会话投影中只用于展示的元数据；不读取对话正文。 */
interface DshProjection {
  model?: string
  taskTitle?: string
  cwd?: string
  createdAt?: number
  /** 有未结束的回合；等待用户回答时回合仍然打开。 */
  live: boolean
  /** 投影记录了尚未回答的问题，说明模型正在等待用户。 */
  waiting: boolean
}

interface LoadedProjection {
  facts: DshProjection
  updatedAt: number
}

/** 退出上报与随后的投影落盘属于同一回合，窗口内的写入不能当作新活动。 */
const EXIT_GRACE_MS = 2 * 60 * 1000

/**
 * 显式退出的会话不应被投影发现立即复活；退出两分钟后的投影写入才视为重新开始的新回合。
 * 没有退出记录（或仅由租约过期结束）的会话始终允许发现。
 */
export function resumedAfterExit(endedAt: number | undefined, projectionAt: number): boolean {
  return endedAt === undefined || projectionAt - endedAt > EXIT_GRACE_MS
}

/**
 * DSH 没有原生生命周期 hook，模型、标题、工作目录和回合状态都只写在会话投影缓存里。
 * 这里只读投影的元数据，做两件事：
 * 1. 上报时缓存可能尚未落盘，展示快照按真实会话 ID 再读一次，补全缺失的模型与标题；
 * 2. 投影文件仍在更新且存在未结束回合时，直接把运行中的会话补进面板，不依赖模型主动上报。
 * 读取失败或格式变化时保持未知，绝不按终端品牌猜测模型，也不会复活已结束的回合。
 */
export class DshSessionFacts {
  private readonly directory: string
  private readonly cache = new Map<string, { signature: string; loaded: LoadedProjection }>()
  private readonly pending = new Map<string, Promise<LoadedProjection | undefined>>()

  constructor(
    dshHome: string,
    private readonly now: () => number = Date.now
  ) {
    this.directory = path.join(dshHome, 'storages', 'session_projcache', 'sessions')
  }

  /** 投影文件按秒级频率重写，用 inode/大小/修改时间判断是否需要重新解析。 */
  private async load(sessionId: string): Promise<LoadedProjection | undefined> {
    // 会话 ID 直接拼接为文件名，必须拒绝路径分隔符、空值与超长输入。
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return undefined
    const file = path.join(this.directory, `${sessionId}.json`)
    try {
      const info = await stat(file)
      if (!info.isFile()) throw new Error('会话投影不是普通文件')
      const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`
      const cached = this.cache.get(sessionId)
      if (cached?.signature === signature) return cached.loaded
      const loaded = {
        facts: sessionFacts(JSON.parse(await readFile(file, 'utf8'))),
        updatedAt: info.mtimeMs
      }
      this.cache.set(sessionId, { signature, loaded })
      return loaded
    } catch {
      // 缓存未生成、正在替换或格式变化时回落到上报值；下次快照仍会重试。
      this.cache.delete(sessionId)
      return undefined
    }
  }

  private projection(sessionId: string): Promise<LoadedProjection | undefined> {
    // 主窗、托盘与局域网可能同时请求快照，合并同一会话的并发解析。
    const pending = this.pending.get(sessionId)
    if (pending) return pending
    const task = this.load(sessionId).finally(() => this.pending.delete(sessionId))
    this.pending.set(sessionId, task)
    return task
  }

  /** 只补全空字段：显式上报的模型与标题优先，非 DSH 会话完全不读取投影缓存。 */
  async enrich(sessions: SessionActivity[]): Promise<SessionActivity[]> {
    const targets = sessions.filter(
      (session) => session.terminal === 'dsh' && (!session.model || !session.taskTitle)
    )
    if (!targets.length) return sessions
    const entries = await Promise.all(
      targets.map(
        async (session) => [session.sessionId, await this.projection(session.sessionId)] as const
      )
    )
    const found = new Map(entries)
    return sessions.map((session) => {
      const facts = session.terminal === 'dsh' ? found.get(session.sessionId)?.facts : undefined
      if (!facts?.model && !facts?.taskTitle) return session
      return {
        ...session,
        model: session.model || facts.model || null,
        taskTitle: session.taskTitle || facts.taskTitle || null
      }
    })
  }

  /**
   * 发现仍在运行的 DSH 会话，按注册目录分组。
   * 只有回合尚未结束、投影在租约窗口内更新过、且工作目录能匹配已注册目录时才返回；
   * 回合结束后立即隐藏，窗口外的文件不再补报，避免保留崩溃或强退后的幽灵会话。
   */
  async live(folders: Folder[]): Promise<Map<string, SessionActivity[]>> {
    const result = new Map<string, SessionActivity[]>()
    if (!folders.length) return result
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch {
      return result
    }
    const ids = names
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
    const at = this.now()
    const projections = await Promise.all(
      ids.map(async (sessionId) => ({ sessionId, loaded: await this.projection(sessionId) }))
    )
    for (const { sessionId, loaded } of projections) {
      if (!loaded?.facts.live || at - loaded.updatedAt > LEASE_MS) continue
      if (!loaded.facts.cwd) continue
      let folder: Folder | undefined
      try {
        folder = deepestFolder(folders, canonicalDirectory(loaded.facts.cwd))
      } catch {
        // 工作目录被删除或不可访问时无法归属项目，跳过该会话。
        continue
      }
      if (!folder) continue
      const sessions = result.get(folder.id) ?? []
      sessions.push({
        terminal: 'dsh',
        sessionId,
        phase: loaded.facts.waiting ? 'waiting' : 'executing',
        model: loaded.facts.model ?? null,
        taskTitle: loaded.facts.taskTitle ?? null,
        startedAt: loaded.facts.createdAt ?? loaded.updatedAt,
        lastSeen: loaded.updatedAt
      })
      result.set(folder.id, sessions)
    }
    return result
  }
}

/** 只识别投影里的会话元数据字段，其他内容（含对话正文）一律忽略。 */
function sessionFacts(value: unknown): DshProjection {
  const record = (
    value as { record?: { identity?: unknown; rows?: Record<string, unknown> } } | null
  )?.record
  const rows = record?.rows
  const identity = record?.identity as { cwd?: unknown; createdAt?: unknown } | null | undefined
  const selection = (
    rows?.modelSelection as
      | { val?: { lastUsed?: { model?: unknown }; pending?: { model?: unknown } } }
      | undefined
  )?.val
  const title = (rows?.title as { val?: unknown } | undefined)?.val
  const turn = (rows?.turnBoundary as { val?: unknown } | undefined)?.val as
    | { openTurnStartSeq?: unknown }
    | null
    | undefined
  const questions = (
    rows?.userQuestions as { val?: { questions?: { active?: unknown } } } | undefined
  )?.val?.questions?.active
  const workingDirectory = (rows?.workingDirectory as { val?: unknown } | undefined)?.val
  const cwd = typeof identity?.cwd === 'string' ? identity.cwd : workingDirectory
  return {
    model: text(selection?.lastUsed?.model ?? selection?.pending?.model, 128),
    taskTitle: text(title, 512),
    cwd: typeof cwd === 'string' && path.isAbsolute(cwd) ? cwd : undefined,
    createdAt:
      typeof identity?.createdAt === 'number' && Number.isFinite(identity.createdAt)
        ? identity.createdAt
        : undefined,
    live: typeof turn?.openTurnStartSeq === 'number',
    waiting: Array.isArray(questions) && questions.length > 0
  }
}

function text(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : undefined
}
