/** 终端标识固定为协议值，不能由用户显示名称推断。 */
export const terminalIds = ['codex', 'workbuddy', 'claude', 'grok', 'qoder'] as const
export type TerminalId = (typeof terminalIds)[number]
export type ModelFamily = 'gpt' | 'claude' | 'deepseek' | 'kimi' | 'qwen' | 'gemini' | 'grok'
export const activityPhases = ['executing', 'waiting', 'error'] as const
export type ActivityPhase = (typeof activityPhases)[number]
export type AvatarKey = `model:${ModelFamily}` | `tray:${ModelFamily}` | `terminal:${TerminalId}`
/** 上报携带真实路径；sequence 用于抵御异步 hook 的迟到请求。 */
export interface ActivityRequest {
  path: string
  terminal: TerminalId
  sessionId: string
  /** 上报桥明确确认的旧临时 ID；只用于迁移同一会话，不按项目推断或合并其他会话。 */
  sessionAliases?: string[]
  action: 'enter' | 'exit'
  phase?: ActivityPhase
  model?: string
  /** 终端已生成的真实任务/会话标题；不使用提示词或文件夹名称猜测。 */
  taskTitle?: string
  sequence?: number
  /** hook 使用 session 范围结束跨目录任务；普通调用默认 folder。 */
  scope?: 'folder' | 'session'
  preserveWaiting?: boolean
}
export interface SessionActivity {
  terminal: TerminalId
  sessionId: string
  phase: ActivityPhase
  model: string | null
  taskTitle?: string | null
  lastSeen: number
  startedAt: number
}
export interface GitStatus {
  branch: string
  clean: boolean
  added: number
  deleted: number
  modified: number
  error?: string
}
export interface Folder {
  id: string
  path: string
  name: string
  createdAt: number
}
export interface FolderView extends Folder {
  git: GitStatus | null
  sessions: SessionActivity[]
  available: boolean
}
export interface IntegrationView {
  id: TerminalId
  name: string
  detected: boolean
  evidence: string[]
  installed: boolean
  health: 'absent' | 'restart' | 'healthy' | 'damaged' | 'limited'
  detail: string
  lastSeen: number | null
}
export interface Settings {
  theme: 'system' | 'light' | 'dark'
  avatars: Partial<Record<AvatarKey, string>>
}
export interface Snapshot {
  skills: import('./skills').SkillSummary[]
  folders: FolderView[]
  integrations: IntegrationView[]
  settings: Settings
  service: { running: boolean; port: number; error?: string }
}
/** preload 只公开业务操作，不向网页暴露通用 IPC、文件或命令执行能力。 */
export interface EbisuApi {
  skillDetail(id: string): Promise<import('./skills').SkillDetail>
  skillFilePath(id: string, relative: string): Promise<string>
  revealSkillFile(id: string, relative: string): Promise<void>
  saveSkillFile(id: string, relative: string): Promise<string | null>
  installSkill(id: string, terminal: TerminalId): Promise<void>
  uninstallSkill(id: string, terminal: TerminalId): Promise<void>
  deleteExperience(id: string, revision: number): Promise<void>
  skillVariables(id: string, folderId: string | null): Promise<import('./skills').VariableView[]>
  setSkillVariable(
    id: string,
    name: string,
    target: import('./skills').VariableTarget,
    value: string | null
  ): Promise<void>
  revealSkillVariable(
    id: string,
    name: string,
    target: import('./skills').VariableTarget
  ): Promise<string | null>
  snapshot(): Promise<Snapshot>
  addFolder(): Promise<void>
  removeFolder(id: string): Promise<void>
  renameFolder(id: string, name: string): Promise<void>
  openFolder(id: string): Promise<void>
  openSession(terminal: TerminalId, sessionId: string): Promise<void>
  clearSession(folderId: string, terminal: TerminalId, sessionId: string): Promise<void>
  rescan(): Promise<void>
  install(id: TerminalId): Promise<void>
  uninstall(id: TerminalId): Promise<void>
  check(id: TerminalId): Promise<string>
  setTheme(theme: Settings['theme']): Promise<void>
  chooseAvatar(key: AvatarKey): Promise<void>
  resetAvatars(): Promise<void>
  showMain(): Promise<void>
  onChanged(callback: () => void): () => void
}
