import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { canonicalDirectory, deepestFolder } from './paths'
import type {
  ActivityRequest,
  Folder,
  SessionActivity,
  Settings,
  TerminalId
} from '../shared/types'

/** 协议规定的租约时长；所有判断使用服务端接收时间。 */
export const LEASE_MS = 10 * 60 * 1000
type ActivityRow = SessionActivity & { folderId: string; active: number; sequence: number | null }

/** 主进程唯一持有的数据库。WAL 与事务保证并发 HTTP 请求可预测地落库。 */
export class Store {
  readonly db: Database.Database
  constructor(
    filename: string,
    private readonly now: () => number = Date.now
  ) {
    this.db = new Database(filename)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS folders (
        id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS activities (
        folderId TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
        terminal TEXT NOT NULL, sessionId TEXT NOT NULL, phase TEXT NOT NULL,
        model TEXT, taskTitle TEXT, startedAt INTEGER NOT NULL, lastSeen INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1, sequence INTEGER,
        PRIMARY KEY (folderId, terminal, sessionId)
      );
      CREATE INDEX IF NOT EXISTS activities_lease ON activities(active, lastSeen);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS integrations (
        terminal TEXT PRIMARY KEY, manifest TEXT, lastSeen INTEGER
      );
      CREATE TABLE IF NOT EXISTS session_ends (
        terminal TEXT NOT NULL, sessionId TEXT NOT NULL, sequence INTEGER NOT NULL,
        PRIMARY KEY (terminal,sessionId)
      );
      CREATE TABLE IF NOT EXISTS session_aliases (
        terminal TEXT NOT NULL, alias TEXT NOT NULL, sessionId TEXT NOT NULL,
        PRIMARY KEY (terminal,alias)
      );
    `)
    // 老版本的活动记录原地升级；显式列名写入兼容追加列后的物理列顺序。
    const columns = this.db.prepare('PRAGMA table_info(activities)').all() as { name: string }[]
    if (!columns.some((column) => column.name === 'taskTitle'))
      this.db.exec('ALTER TABLE activities ADD COLUMN taskTitle TEXT')
    this.db.pragma('user_version = 3')
    this.expire()
  }

  /** 按注册时间稳定排列卡片，界面刷新时不会跳动。 */
  folders(): Folder[] {
    return this.db.prepare('SELECT * FROM folders ORDER BY createdAt, id').all() as Folder[]
  }

  /** 重复选择同一真实目录返回已有卡片，不覆盖用户改过的名称。 */
  addFolder(input: string): Folder {
    const canonical = canonicalDirectory(input)
    const existing = this.folders().find((folder) => folder.path === canonical)
    if (existing) return existing
    const folder = {
      id: randomUUID(),
      path: canonical,
      name: path.basename(canonical) || canonical,
      createdAt: this.now()
    }
    this.db.prepare('INSERT INTO folders VALUES (@id, @path, @name, @createdAt)').run(folder)
    return folder
  }

  /** 外键级联删除活动记录；从不接触目录里的实际文件。 */
  removeFolder(id: string): void {
    this.db.prepare('DELETE FROM folders WHERE id = ?').run(id)
  }
  /** 显示名称与目录身份分离，改名不会影响路径匹配。 */
  renameFolder(id: string, name: string): void {
    if (!name.trim() || name.trim().length > 100) throw new Error('名称需为 1–100 个字符')
    this.db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(name.trim(), id)
  }

  /**
   * 将上报桥明确确认的 local- 身份迁移到真实 ID，涵盖该会话此前占用的所有目录。
   * 别名按终端隔离且不可重新绑定；持久化后，旧进程继续用 local- 发送的退出也能命中。
   * 没有显式身份证据时绝不合并，即使同一个项目只有一个已知真实会话。
   */
  private reconcileIdentity(request: ActivityRequest): ActivityRequest {
    const resolve = (id: string) =>
      (
        this.db
          .prepare('SELECT sessionId FROM session_aliases WHERE terminal=? AND alias=?')
          .get(request.terminal, id) as { sessionId: string } | undefined
      )?.sessionId ?? id
    const sessionId = resolve(request.sessionId)
    if (!sessionId.startsWith('local-')) {
      for (const alias of new Set(request.sessionAliases ?? [])) {
        if (!alias.startsWith('local-') || alias === sessionId) continue
        const bound = resolve(alias)
        if (bound !== alias && bound !== sessionId) continue
        this.db
          .prepare('INSERT OR IGNORE INTO session_aliases VALUES(?,?,?)')
          .run(request.terminal, alias, sessionId)
        const oldRows = this.db
          .prepare('SELECT * FROM activities WHERE terminal=? AND sessionId=?')
          .all(request.terminal, alias) as ActivityRow[]
        for (const old of oldRows) {
          const current = this.db
            .prepare('SELECT * FROM activities WHERE folderId=? AND terminal=? AND sessionId=?')
            .get(old.folderId, request.terminal, sessionId) as ActivityRow | undefined
          // 优先比较事件序号，兼容无序号的旧请求时才退回服务端接收时间。
          const useOld =
            !current ||
            (old.sequence !== null && current.sequence !== null
              ? old.sequence > current.sequence
              : old.lastSeen > current.lastSeen)
          const latest = useOld ? old : current!
          this.db
            .prepare(
              `INSERT OR REPLACE INTO activities
              (folderId,terminal,sessionId,phase,model,taskTitle,startedAt,lastSeen,active,sequence)
              VALUES(?,?,?,?,?,?,?,?,?,?)`
            )
            .run(
              old.folderId,
              request.terminal,
              sessionId,
              latest.phase,
              latest.model ?? current?.model ?? old.model,
              latest.taskTitle ?? current?.taskTitle ?? old.taskTitle ?? null,
              Math.min(old.startedAt, current?.startedAt ?? old.startedAt),
              latest.lastSeen,
              latest.active,
              latest.sequence
            )
        }
        this.db
          .prepare('DELETE FROM activities WHERE terminal=? AND sessionId=?')
          .run(request.terminal, alias)
        // 旧身份的退出墓碑也要迁移，防止迟到心跳在身份归一后重新点亮项目。
        this.db
          .prepare(
            `INSERT INTO session_ends(terminal,sessionId,sequence)
          SELECT terminal,?,sequence FROM session_ends WHERE terminal=? AND sessionId=?
          ON CONFLICT(terminal,sessionId) DO UPDATE SET sequence=MAX(sequence,excluded.sequence)`
          )
          .run(sessionId, request.terminal, alias)
        this.db
          .prepare('DELETE FROM session_ends WHERE terminal=? AND sessionId=?')
          .run(request.terminal, alias)
      }
    }
    return { ...request, sessionId }
  }

  /**
   * 工具 hook 同时见到原生 ID 和上报命令里的 local- ID 时，只登记身份证据。
   * 不产生心跳、不恢复执行、不修改退出序号；PostToolUse 因而不会复活已退出的任务。
   */
  identifySession(
    terminal: ActivityRequest['terminal'],
    sessionId: string,
    sessionAliases: string[]
  ): void {
    this.db.transaction(() => {
      this.reconcileIdentity({ terminal, sessionId, sessionAliases, path: '/', action: 'enter' })
    })()
  }

  /** 保留退出墓碑中的 sequence，阻止迟到的低序号 enter 复活已结束任务。 */
  activity(request: ActivityRequest): { ignored: boolean; folderId?: string } {
    return this.db.transaction(() => {
      const receivedAt = this.now()
      this.expire(receivedAt)
      request = this.reconcileIdentity(request)
      this.db
        .prepare(
          `INSERT INTO integrations(terminal,lastSeen) VALUES(?,?)
        ON CONFLICT(terminal) DO UPDATE SET lastSeen=excluded.lastSeen`
        )
        .run(request.terminal, receivedAt)
      // 即使退出先于首次 enter 到达，也记录会话级序号边界，避免乱序复活。
      if (request.sequence !== undefined) {
        const ended = this.db
          .prepare('SELECT sequence FROM session_ends WHERE terminal=? AND sessionId=?')
          .get(request.terminal, request.sessionId) as { sequence: number } | undefined
        if (request.action === 'enter' && ended && request.sequence <= ended.sequence)
          return { ignored: true }
        if (request.action === 'exit' && request.scope === 'session') {
          this.db
            .prepare(
              `INSERT INTO session_ends VALUES(?,?,?) ON CONFLICT(terminal,sessionId)
            DO UPDATE SET sequence=MAX(sequence,excluded.sequence)`
            )
            .run(request.terminal, request.sessionId, request.sequence)
        }
      }
      let folder: Folder | undefined
      try {
        folder = deepestFolder(this.folders(), canonicalDirectory(request.path))
      } catch {
        // 目录删除后，session 范围退出仍需清理此前的活动。
      }
      const rows = (
        request.scope === 'session'
          ? this.db
              .prepare('SELECT * FROM activities WHERE terminal=? AND sessionId=?')
              .all(request.terminal, request.sessionId)
          : folder
            ? this.db
                .prepare('SELECT * FROM activities WHERE folderId=? AND terminal=? AND sessionId=?')
                .all(folder.id, request.terminal, request.sessionId)
            : []
      ) as ActivityRow[]
      let changed = false
      // 只有本目录真正接受了这次进入，才允许它清除项目内的故障记录。
      let acceptedInFolder = false
      for (const row of rows) {
        if (
          request.sequence !== undefined &&
          row.sequence !== null &&
          request.sequence <= row.sequence
        )
          continue
        // Stop 是软结束：等待状态不被覆盖；故障只能由同项目的 executing 请求清除。
        const preserve =
          request.action === 'exit' &&
          row.active === 1 &&
          (row.phase === 'error' || (request.preserveWaiting && row.phase === 'waiting'))
        const active = request.action === 'exit' && !preserve ? 0 : 1
        if (
          request.action === 'enter' &&
          row.active === 0 &&
          request.scope === 'session' &&
          folder?.id !== row.folderId
        )
          continue
        const incoming = request.phase ?? 'executing'
        // 故障状态具有粘性：waiting 或重复的 error 上报不能将其降级。
        const phase =
          request.action === 'enter'
            ? row.active === 1 && row.phase === 'error' && incoming !== 'executing'
              ? 'error'
              : incoming
            : row.phase
        this.db
          .prepare(
            `UPDATE activities SET active=?,phase=?,model=?,taskTitle=?,lastSeen=?,startedAt=?,sequence=?
          WHERE folderId=? AND terminal=? AND sessionId=?`
          )
          .run(
            active,
            phase,
            request.model ?? row.model,
            request.taskTitle ?? row.taskTitle ?? null,
            preserve ? row.lastSeen : receivedAt,
            row.active ? row.startedAt : receivedAt,
            request.sequence ?? null,
            row.folderId,
            request.terminal,
            request.sessionId
          )
        changed = true
        if (row.folderId === folder?.id) acceptedInFolder = true
      }
      if (
        folder &&
        request.action === 'enter' &&
        !rows.some((row) => row.folderId === folder!.id)
      ) {
        this.db
          .prepare(
            `INSERT INTO activities
            (folderId,terminal,sessionId,phase,model,taskTitle,startedAt,lastSeen,active,sequence)
            VALUES(?,?,?,?,?,?,?,?,?,?)`
          )
          .run(
            folder.id,
            request.terminal,
            request.sessionId,
            request.phase ?? 'executing',
            request.model ?? null,
            request.taskTitle ?? null,
            receivedAt,
            receivedAt,
            1,
            request.sequence ?? null
          )
        changed = true
        acceptedInFolder = true
      }
      // 同项目出现新的执行请求后，其他会话遗留的故障记录一并释放。
      if (
        folder &&
        acceptedInFolder &&
        request.action === 'enter' &&
        (request.phase ?? 'executing') === 'executing'
      ) {
        this.db
          .prepare("UPDATE activities SET active=0 WHERE folderId=? AND phase='error' AND active=1")
          .run(folder.id)
        changed = true
      }
      if (
        folder &&
        request.action === 'exit' &&
        request.sequence !== undefined &&
        !rows.some((row) => row.folderId === folder!.id)
      ) {
        this.db
          .prepare(
            `INSERT INTO activities
            (folderId,terminal,sessionId,phase,model,taskTitle,startedAt,lastSeen,active,sequence)
            VALUES(?,?,?,?,?,?,?,?,?,?)`
          )
          .run(
            folder.id,
            request.terminal,
            request.sessionId,
            request.phase ?? 'executing',
            request.model ?? null,
            request.taskTitle ?? null,
            receivedAt,
            receivedAt,
            0,
            request.sequence
          )
      }
      return { ignored: !changed, folderId: folder?.id }
    })()
  }

  /** 读取前先检查租约，让休眠恢复或重启后的首个快照也准确。 */
  sessions(folderId: string): SessionActivity[] {
    this.expire()
    return this.db
      .prepare(
        `SELECT terminal,sessionId,phase,model,taskTitle,startedAt,lastSeen FROM activities
      WHERE folderId=? AND active=1 ORDER BY startedAt,terminal,sessionId`
      )
      .all(folderId) as SessionActivity[]
  }
  /** 仅解除面板占用；不会终止宿主 agent，故障只能由同项目后续的执行中请求清除。 */
  clearSession(folderId: string, terminal: TerminalId, sessionId: string): void {
    this.db
      .prepare(
        "UPDATE activities SET active=0 WHERE folderId=? AND terminal=? AND sessionId=? AND phase<>'error'"
      )
      .run(folderId, terminal, sessionId)
  }
  /** 返回是否发生状态变化，供主进程决定是否广播刷新事件。故障不参与租约过期。 */
  expire(at = this.now()): boolean {
    return (
      this.db
        .prepare("UPDATE activities SET active=0 WHERE active=1 AND phase<>'error' AND lastSeen<=?")
        .run(at - LEASE_MS).changes > 0
    )
  }
  /** 首次启动提供默认设置；自定义头像保存的是应用私有副本路径。 */
  settings(): Settings {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get('preferences') as
      | { value: string }
      | undefined
    return row ? JSON.parse(row.value) : { theme: 'system', avatars: {} }
  }
  saveSettings(settings: Settings): void {
    this.db
      .prepare('INSERT OR REPLACE INTO settings VALUES(?,?)')
      .run('preferences', JSON.stringify(settings))
  }
  integration(id: TerminalId): { manifest: string | null; lastSeen: number | null } | undefined {
    return this.db
      .prepare('SELECT manifest,lastSeen FROM integrations WHERE terminal=?')
      .get(id) as { manifest: string | null; lastSeen: number | null } | undefined
  }
  saveManifest(id: TerminalId, manifest: unknown): void {
    this.db
      .prepare(
        `INSERT INTO integrations(terminal,manifest) VALUES(?,?)
      ON CONFLICT(terminal) DO UPDATE SET manifest=excluded.manifest`
      )
      .run(id, manifest === null ? null : JSON.stringify(manifest))
  }
  close(): void {
    this.db.close()
  }
}
