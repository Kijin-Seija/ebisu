import { contextBridge, ipcRenderer } from 'electron'
import type { EbisuApi } from '../shared/types'

/** 明确列出的命令防止 renderer 借桥接发送任意 Electron IPC。 */
const api: EbisuApi = {
  snapshot: () => ipcRenderer.invoke('ebisu:snapshot'),
  addFolder: () => ipcRenderer.invoke('ebisu:add-folder'),
  removeFolder: (id) => ipcRenderer.invoke('ebisu:remove-folder', id),
  renameFolder: (id, name) => ipcRenderer.invoke('ebisu:rename-folder', id, name),
  openFolder: (id) => ipcRenderer.invoke('ebisu:open-folder', id),
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
