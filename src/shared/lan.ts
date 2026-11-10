import type { FolderView, TerminalId } from './types'
import type { SkillPackage, SkillSummary } from './skills'
import type { ChatChannelSummary, ChatMessage, ChatTombstone } from './chat'

export interface DeviceIdentity {
  id: string
  name: string
  protocol: number
}
/** macOS 内存压力等级：kern.memorystatus_vm_pressure_level 的 1/2/4。 */
export type MemoryPressure = 'normal' | 'warn' | 'critical'
/**
 * 设备负载快照：主进程每 30 秒采集一次，随局域网快照同步给已配对设备。
 * 只用于观测与派单参考，Ebisu 不会据此清理、终止进程或限流。
 * 单项采集失败时该项为 null，不影响其他字段。
 */
export interface DeviceMetrics {
  /** 采集完成时间（毫秒时间戳）；对端离线时保留最后一次收到的数据，按 at 判断新旧。 */
  at: number
  cpu: {
    /** 逻辑核数。 */
    cores: number
    /** 1/5/15 分钟平均负载（os.loadavg）。 */
    load1: number
    load5: number
    load15: number
  }
  memory: {
    totalGB: number
    /** 系统可用内存百分比（macOS 为 kern.memorystatus_level，同 memory_pressure 的 free percentage）。 */
    freePct: number | null
    pressure: MemoryPressure | null
    /** 已用 swap（MB，vm.swapusage）。 */
    swapUsedMB: number | null
  }
  /** 数据卷容量：macOS 优先 /System/Volumes/Data，否则 /；读取失败为 null。 */
  disk: { path: string; freeGB: number; totalGB: number; usedPct: number } | null
  /** 重任务进程计数（ps 命令行匹配）；ps 失败为 null。 */
  procs: Record<string, number> | null
}
export interface SharedSnapshot {
  device: DeviceIdentity
  folders: FolderView[]
  skills: SkillSummary[]
  /** 来源设备最新负载；旧版本不发送该字段，接收方按 null 处理。 */
  metrics?: DeviceMetrics | null
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
