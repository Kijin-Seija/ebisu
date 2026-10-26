import { contextBridge, ipcRenderer } from 'electron'
import type { EbisuApi } from '../shared/types'

/** 明确列出的命令防止 renderer 借桥接发送任意 Electron IPC。 */
const api: EbisuApi = {
  configureLan: (enabled, name) => ipcRenderer.invoke('ebisu:configure-lan', enabled, name),
  createInvitation: (address) => ipcRenderer.invoke('ebisu:create-invitation', address),
  pairDevice: (invitation, address) => ipcRenderer.invoke('ebisu:pair-device', invitation, address),
  unpairDevice: (id) => ipcRenderer.invoke('ebisu:unpair-device', id),
  remoteSkill: (device, skill) => ipcRenderer.invoke('ebisu:remote-skill', device, skill),
  prepareImport: (device, skill) => ipcRenderer.invoke('ebisu:prepare-import', device, skill),
  confirmImport: (draft, edit) => ipcRenderer.invoke('ebisu:confirm-import', draft, edit),
  skillDetail: (id) => ipcRenderer.invoke('ebisu:skill-detail', id),
  skillFilePath: (id, relative) => ipcRenderer.invoke('ebisu:skill-file-path', id, relative),
  revealSkillFile: (id, relative) => ipcRenderer.invoke('ebisu:reveal-skill-file', id, relative),
  saveSkillFile: (id, relative) => ipcRenderer.invoke('ebisu:save-skill-file', id, relative),
  installSkill: (id, terminal) => ipcRenderer.invoke('ebisu:install-skill', id, terminal),
  uninstallSkill: (id, terminal) => ipcRenderer.invoke('ebisu:uninstall-skill', id, terminal),
  deleteExperience: (id, revision) => ipcRenderer.invoke('ebisu:delete-experience', id, revision),
  skillVariables: (id, folderId) => ipcRenderer.invoke('ebisu:skill-variables', id, folderId),
  setSkillVariable: (id, name, target, value) =>
    ipcRenderer.invoke('ebisu:set-skill-variable', id, name, target, value),
  revealSkillVariable: (id, name, target) =>
    ipcRenderer.invoke('ebisu:reveal-skill-variable', id, name, target),
  snapshot: () => ipcRenderer.invoke('ebisu:snapshot'),
  addFolder: () => ipcRenderer.invoke('ebisu:add-folder'),
  removeFolder: (id) => ipcRenderer.invoke('ebisu:remove-folder', id),
  renameFolder: (id, name) => ipcRenderer.invoke('ebisu:rename-folder', id, name),
  openFolder: (id) => ipcRenderer.invoke('ebisu:open-folder', id),
  openSession: (terminal, session) => ipcRenderer.invoke('ebisu:open-session', terminal, session),
  clearSession: (folder, terminal, session) =>
    ipcRenderer.invoke('ebisu:clear-session', folder, terminal, session),
  rescan: () => ipcRenderer.invoke('ebisu:rescan'),
  install: (id) => ipcRenderer.invoke('ebisu:install', id),
  uninstall: (id) => ipcRenderer.invoke('ebisu:uninstall', id),
  check: (id) => ipcRenderer.invoke('ebisu:check', id),
  setTheme: (theme) => ipcRenderer.invoke('ebisu:set-theme', theme),
  chooseAvatar: (key) => ipcRenderer.invoke('ebisu:choose-avatar', key),
  resetAvatars: () => ipcRenderer.invoke('ebisu:reset-avatars'),
  showMain: () => ipcRenderer.invoke('ebisu:show-main'),
  onChanged: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('ebisu:changed', listener)
    return () => ipcRenderer.removeListener('ebisu:changed', listener)
  }
}
contextBridge.exposeInMainWorld('ebisu', Object.freeze(api))
