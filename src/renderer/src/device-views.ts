import type { Snapshot, FolderView } from '../../shared/types'
import type { SkillSummary } from '../../shared/skills'
import type { DeviceMetrics } from '../../shared/lan'

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

const pressureLabel = { normal: '正常', warn: '紧张', critical: '严重' } as const
/** 设备卡片的一行负载摘要；缺失的单项直接省略。 */
export function metricsSummary(metrics: DeviceMetrics): string {
  const parts = [`负载 ${metrics.cpu.load1}/${metrics.cpu.cores} 核`]
  const memory: string[] = []
  if (metrics.memory.freePct !== null) memory.push(`可用 ${metrics.memory.freePct}%`)
  if (metrics.memory.pressure) memory.push(`压力${pressureLabel[metrics.memory.pressure]}`)
  if (memory.length) parts.push(`内存 ${memory.join(' ')}`)
  if (metrics.memory.swapUsedMB !== null)
    parts.push(`swap ${(metrics.memory.swapUsedMB / 1024).toFixed(1)} GB`)
  if (metrics.disk) parts.push(`磁盘剩余 ${metrics.disk.freeGB}/${metrics.disk.totalGB} GB`)
  return parts.join(' · ')
}
