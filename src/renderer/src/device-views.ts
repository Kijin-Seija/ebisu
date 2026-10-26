import type { Snapshot, FolderView } from '../../shared/types'
import type { SkillSummary } from '../../shared/skills'

export interface Origin {
  deviceId: string
  deviceName: string
  remote: boolean
  online: boolean
  lastSeen: number | null
}
export type ProjectView = FolderView & Origin
export type SkillView = SkillSummary & Origin
/** 来源身份参与卡片和会话键，离线快照可以查看但不能算作实时活跃。 */
export function deviceViews(
  snapshot: Snapshot | null,
  filter: string
): { folders: ProjectView[]; skills: SkillView[] } {
  if (!snapshot) return { folders: [], skills: [] }
  const local: Origin = {
    deviceId: snapshot.lan?.device.id ?? 'local',
    deviceName: '本机',
    remote: false,
    online: true,
    lastSeen: null
  }
  const folders: ProjectView[] =
    filter === 'all' || filter === 'local'
      ? snapshot.folders.map((item) => ({ ...item, ...local }))
      : []
  const skills: SkillView[] =
    filter === 'all' || filter === 'local'
      ? snapshot.skills.map((item) => ({ ...item, ...local }))
      : []
  for (const peer of snapshot.lan?.peers ?? []) {
    if (filter !== 'all' && filter !== peer.id) continue
    const origin: Origin = {
      deviceId: peer.id,
      deviceName: peer.name,
      remote: true,
      online: peer.online,
      lastSeen: peer.lastSeen
    }
    folders.push(
      ...(peer.snapshot?.folders ?? []).map((item) => ({
        ...item,
        ...origin,
        sessions: item.sessions.map((session) => ({ ...session, remoteDeviceId: peer.id }))
      }))
    )
    skills.push(...(peer.snapshot?.skills ?? []).map((item) => ({ ...item, ...origin })))
  }
  return { folders, skills }
}
