import type { FolderView, TerminalId } from './types'
import type { SkillPackage, SkillSummary } from './skills'
import type { ChatChannelSummary, ChatMessage, ChatTombstone } from './chat'

export interface DeviceIdentity {
  id: string
  name: string
  protocol: number
}
export interface SharedSnapshot {
  device: DeviceIdentity
  folders: FolderView[]
  skills: SkillSummary[]
}
export interface RemoteDevice extends DeviceIdentity {
  address: string
  online: boolean
  lastSeen: number | null
  error?: string
  snapshot: SharedSnapshot | null
}
/** 附近设备来自 mDNS；指纹用于首次连接前固定对端证书，缺失表示对方版本不支持。 */
export interface NearbyDevice extends DeviceIdentity {
  address: string
  fingerprint: string | null
}
/** 对方发起的待确认配对请求，仅在内存中保留，重启或过期后失效。 */
export interface PairRequestView {
  id: string
  device: DeviceIdentity
  address: string
  expires: number
}
/** 本机发起配对后的等待结果；pending 表示对方在等待期限内尚未处理。 */
export type PairOutcome = 'paired' | 'declined' | 'pending'
export const remoteCommandStatuses = [
  'queued',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled'
] as const
export type RemoteCommandStatus = (typeof remoteCommandStatuses)[number]
export type RemoteCommandTerminal = Extract<TerminalId, 'codex' | 'claude' | 'dsh' | 'qoder'>
export interface RemoteCommandRequest {
  requestId: string
  terminal: RemoteCommandTerminal
  path: string
  prompt: string
}
export interface RemoteCommandResult {
  status: Extract<RemoteCommandStatus, 'completed' | 'failed' | 'cancelled'>
  summary: string
  exitCode: number | null
  output?: string
  error?: string
}
export interface RemoteCommand {
  commandId: string
  requestId: string
  source: DeviceIdentity
  terminal: RemoteCommandTerminal
  path: string
  prompt: string
  status: RemoteCommandStatus
  sessionId: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  result: RemoteCommandResult | null
}
export interface LanView {
  enabled: boolean
  device: DeviceIdentity
  port: number | null
  addresses: string[]
  error?: string
  discovered: NearbyDevice[]
  requests: PairRequestView[]
  peers: RemoteDevice[]
  remoteExecution: boolean
  commands: RemoteCommand[]
  /** 本机持有副本的 Agent 对话频道摘要。 */
  chats: ChatChannelSummary[]
}
export interface SkillExport {
  skillId: string
  package: SkillPackage
  hash: string
}
export interface ImportDraft extends SkillExport {
  id: string
  device: DeviceIdentity
  existingId: string | null
  conflict: boolean
}
export interface ImportEdit {
  name: string
  texts: Record<string, string>
}
export interface DeviceApi {
  configureLan(enabled: boolean, name: string): Promise<void>
  requestPair(deviceId: string): Promise<PairOutcome>
  respondPair(requestId: string, accept: boolean): Promise<void>
  unpairDevice(id: string): Promise<void>
  remoteSkill(deviceId: string, skillId: string): Promise<SkillExport>
  prepareImport(deviceId: string, skillId: string): Promise<ImportDraft>
  confirmImport(draftId: string, edit: ImportEdit): Promise<string>
  configureRemoteExecution(enabled: boolean): Promise<void>
  remoteCommand(deviceId: string, request: RemoteCommandRequest): Promise<RemoteCommand>
  remoteCommandStatus(deviceId: string, commandId: string): Promise<RemoteCommand>
  cancelRemoteCommand(deviceId: string, commandId: string): Promise<RemoteCommand>
  cancelLocalCommand(commandId: string): Promise<RemoteCommand>
  chatHistory(channel: string): Promise<ChatMessage[]>
  /** 删除频道：本机与其他持有副本的设备都会删除。 */
  deleteChat(channel: string): Promise<ChatTombstone>
}
