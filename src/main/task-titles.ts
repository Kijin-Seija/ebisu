import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import path from 'node:path'
import type { SessionActivity } from '../shared/types'

/**
 * 仅按真实 ID 读取 Codex 会话索引中的 thread_name。threads.title 可能是整段首条提示词，
 * 不用于此处；不读取对话正文、不访问 Codex 数据库，也不把目录名称当作任务标题。
 */
export class TaskTitles {
  private readonly indexFile: string
  private signature = ''
  private titles = new Map<string, string>()
  private pending: Promise<ReadonlyMap<string, string>> | undefined

  constructor(codexHome: string) {
    this.indexFile = path.join(codexHome, 'session_index.jsonl')
  }

  /** 同时到来的主窗/托盘读取合并为一次异步扫描，文件未变更时只检查元数据。 */
  private read(): Promise<ReadonlyMap<string, string>> {
    if (this.pending) return this.pending
    this.pending = (async () => {
      try {
        const info = await stat(this.indexFile)
        if (!info.isFile()) throw new Error('会话索引不是普通文件')
        const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`
        if (signature === this.signature) return this.titles
        const titles = new Map<string, string>()
        const input = createReadStream(this.indexFile, { encoding: 'utf8' })
        const lines = createInterface({ input, crlfDelay: Infinity })
        try {
          for await (const line of lines) {
            try {
              const row = JSON.parse(line)
              // 同一 ID 可多次追加（包括改名）；文件后面的有效记录是最新名称。
              if (typeof row.id === 'string' && typeof row.thread_name === 'string') {
                const title = row.thread_name.trim()
                if (title) titles.set(row.id, title.slice(0, 512))
              }
            } catch {
              // 索引可能正处于追加写入中，半行或损坏行不妨碍其余会话展示。
            }
          }
        } finally {
          lines.close()
          input.destroy()
        }
        this.signature = signature
        this.titles = titles
      } catch {
        // 尚未生成、移走、读取受限时仍可显示终端上报的标题，不影响活动服务。
        this.signature = ''
        this.titles = new Map()
      }
      return this.titles
    })().finally(() => {
      this.pending = undefined
    })
    return this.pending
  }

  /** 返回展示快照，不回写租约：标题变化不能延长心跳或复活已结束会话。 */
  async enrich(sessions: SessionActivity[]): Promise<SessionActivity[]> {
    const titles = sessions.some((session) => session.terminal === 'codex')
      ? await this.read()
      : new Map<string, string>()
    return sessions.map((session) => ({
      ...session,
      taskTitle:
        (session.terminal === 'codex' ? titles.get(session.sessionId) : undefined) ??
        session.taskTitle ??
        null
    }))
  }
}
