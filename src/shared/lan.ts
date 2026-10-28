import type { FolderView } from './types'
import type { SkillPackage, SkillSummary } from './skills'

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
export interface LanView {
  enabled: boolean
  device: DeviceIdentity
  port: number | null
  addresses: string[]
  error?: string
  discovered: (DeviceIdentity & { address: string })[]
  peers: RemoteDevice[]
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
  createInvitation(address?: string): Promise<string>
  pairDevice(invitation: string, address?: string): Promise<void>
  unpairDevice(id: string): Promise<void>
  remoteSkill(deviceId: string, skillId: string): Promise<SkillExport>
  prepareImport(deviceId: string, skillId: string): Promise<ImportDraft>
  confirmImport(draftId: string, edit: ImportEdit): Promise<string>
}
