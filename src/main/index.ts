import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  powerMonitor,
  protocol,
  screen,
  shell,
  Tray
} from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import { z } from 'zod'
import { Store } from './database'
import { readGitStatus } from './git'
import { startServer } from './server'
import { Integrations } from './integrations'
import { TaskTitles } from './task-titles'
import { terminalIds, type AvatarKey, type GitStatus, type Snapshot } from '../shared/types'

// 自定义 scheme 仅提供白名单头像，不把完整文件系统暴露给 renderer。
protocol.registerSchemesAsPrivileged([
  { scheme: 'ebisu-asset', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])
const dataDirectory = process.env.EBISU_DATA_DIR || path.join(app.getPath('appData'), 'Ebisu')
if (process.env.EBISU_DATA_DIR) app.setPath('userData', dataDirectory)
else app.setPath('userData', dataDirectory)
const resources = app.isPackaged
  ? path.join(process.resourcesPath, 'ebisu')
  : path.join(app.getAppPath(), 'resources')
let mainWindow: BrowserWindow | null = null
let trayWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let store: Store
let integrations: Integrations
let taskTitles: TaskTitles
let service: Awaited<ReturnType<typeof startServer>> | undefined
let serviceError: string | undefined
let watcher: FSWatcher | undefined
let refreshTimer: ReturnType<typeof setTimeout> | undefined
let pollTimer: ReturnType<typeof setInterval> | undefined
let expiryTimer: ReturnType<typeof setInterval> | undefined
let developmentParentTimer: ReturnType<typeof setInterval> | undefined
let refreshing: Promise<void> | undefined
/** Git 缓存只由刷新任务写入，快照读取不启动新的子进程。 */
const gitCache = new Map<string, GitStatus | null>()
const terminalSchema = z.enum(terminalIds)
const avatarSchema = z
  .string()
  .regex(
    /^(model:(gpt|claude|deepseek|kimi|qwen|gemini|grok)|terminal:(codex|workbuddy|claude|grok|qoder))$/
  )

function changed(): void {
  for (const window of [mainWindow, trayWindow])
    if (window && !window.isDestroyed()) window.webContents.send('ebisu:changed')
}

/** 防止高频写入导致并发 Git 扫描；事件防抖和定期轮询共用一条刷新链。 */
function refreshGit(): Promise<void> {
  if (refreshing) return refreshing
  refreshing = (async () => {
    const folders = store.folders()
    // 限制并发为两个，避免大量仓库把主机进程数打满。
    for (let offset = 0; offset < folders.length; offset += 2) {
      await Promise.all(
        folders.slice(offset, offset + 2).map(async (folder) => {
          gitCache.set(folder.id, await readGitStatus(folder.path))
        })
      )
    }
    changed()
  })().finally(() => {
    refreshing = undefined
  })
  return refreshing
}

function scheduleRefresh(): void {
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    void refreshGit()
  }, 600)
}

async function watchFolders(): Promise<void> {
  await watcher?.close()
  // 深层变更由轮询兜底；不递归监听 node_modules 等庞大生成目录。
  watcher = chokidar.watch(
    store.folders().map((folder) => folder.path),
    {
      ignoreInitial: true,
      depth: 2,
      ignored: (item) => /(?:^|[/\\])(node_modules|dist|out|\.cache)(?:[/\\]|$)/.test(item)
    }
  )
  watcher.on('all', scheduleRefresh)
  watcher.on('error', (error) => {
    console.warn('目录监听降级为轮询:', String(error))
  })
  await refreshGit()
}

async function snapshot(): Promise<Snapshot> {
  const folders = await Promise.all(
    store.folders().map(async (folder) => ({
      ...folder,
      git: gitCache.get(folder.id) ?? null,
      sessions: await taskTitles.enrich(store.sessions(folder.id)),
      available: existsSync(folder.path)
    }))
  )
  return {
    folders,
    integrations: integrations.views(),
    settings: store.settings(),
    service: { running: !!service, port: service?.port ?? 0, error: serviceError }
  }
}

function createWindow(isTray: boolean): BrowserWindow {
  const window = new BrowserWindow({
    width: isTray ? 740 : 1160,
    height: isTray ? 660 : 790,
    minWidth: isTray ? 500 : 760,
    minHeight: 520,
    show: false,
    title: 'Ebisu',
    titleBarStyle: isTray ? 'default' : 'hiddenInset',
    frame: !isTray,
    // NSPanel 聚焦不会激活 Ebisu 的普通窗口，避免全屏 Space 被切回主窗所在桌面。
    type: isTray && process.platform === 'darwin' ? 'panel' : undefined,
    fullscreenable: !isTray,
    hiddenInMissionControl: isTray,
    resizable: !isTray,
    skipTaskbar: isTray,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#171217' : '#fbf5f7',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = process.env.ELECTRON_RENDERER_URL
    if (
      allowed
        ? new URL(url).origin !== new URL(allowed).origin
        : !url.startsWith(pathToFileURL(path.join(__dirname, '../renderer/index.html')).href)
    )
      event.preventDefault()
  })
  if (process.env.ELECTRON_RENDERER_URL)
    void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}${isTray ? '?tray=1' : ''}`)
  else
    void window.loadFile(path.join(__dirname, '../renderer/index.html'), {
      query: isTray ? { tray: '1' } : {}
    })
  if (!isTray) {
    window.once('ready-to-show', () => {
      if (!process.env.EBISU_SMOKE) window.show()
    })
    window.on('close', (event) => {
      if (!quitting) {
        event.preventDefault()
        window.hide()
      }
    })
  } else {
    // 允许出现在其他应用的全屏 Space；不能只设置置顶，否则窗口仍隶属原桌面。
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    window.setAlwaysOnTop(true, 'pop-up-menu')
    window.on('blur', () => window.hide())
  }
  return window
}

function showMain(): void {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow(false)
  mainWindow.show()
  mainWindow.focus()
  trayWindow?.hide()
}

/** 弹窗锚定托盘图标，并约束在当前显示器可用区域内。 */
export function toggleTray(): void {
  if (!trayWindow || !tray) return
  if (trayWindow.isVisible()) {
    trayWindow.hide()
    return
  }
  const bounds = tray.getBounds()
  const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y })
  const area = display.workArea
  const [width, height] = trayWindow.getSize()
  trayWindow.setPosition(
    Math.round(
      Math.max(
        area.x,
        Math.min(bounds.x + bounds.width / 2 - width / 2, area.x + area.width - width)
      )
    ),
    Math.round(
      Math.max(area.y, Math.min(bounds.y + bounds.height + 6, area.y + area.height - height))
    )
  )
  trayWindow.showInactive()
  trayWindow.focus()
}

/** 每个 IPC 调用均校验来源和输入；只允许本应用创建的两个窗口调用。 */
function handle(channel: string, callback: (...args: any[]) => unknown): void {
  ipcMain.handle(`ebisu:${channel}`, (event, ...args) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (
      !owner ||
      ![mainWindow, trayWindow].includes(owner) ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error('不受信任的调用来源')
    return callback(...args)
  })
}

function installIpc(): void {
  handle('snapshot', snapshot)
  handle('add-folder', async () => {
    const parent = mainWindow?.isVisible() ? mainWindow : undefined
    const options = {
      properties: ['openDirectory', 'multiSelections'] as ('openDirectory' | 'multiSelections')[],
      title: '关联项目文件夹'
    }
    const selection = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    if (!selection.canceled) {
      for (const directory of selection.filePaths) store.addFolder(directory)
      await watchFolders()
      changed()
    }
  })
  handle('remove-folder', async (id: unknown) => {
    store.removeFolder(z.string().uuid().parse(id))
    await watchFolders()
    changed()
  })
  handle('rename-folder', (id: unknown, name: unknown) => {
    store.renameFolder(z.string().uuid().parse(id), z.string().parse(name))
    changed()
  })
  handle('open-folder', async (id: unknown) => {
    const folder = store.folders().find((item) => item.id === z.string().uuid().parse(id))
    if (!folder) throw new Error('目录已被移除')
    const error = await shell.openPath(folder.path)
    if (error) throw new Error(error)
  })
  handle('clear-session', (id: unknown, terminal: unknown, session: unknown) => {
    store.clearSession(
      z.string().uuid().parse(id),
      terminalSchema.parse(terminal),
      z.string().parse(session)
    )
    changed()
  })
  handle('rescan', async () => {
    await refreshGit()
    changed()
  })
  handle('install', (id: unknown) => {
    integrations.install(terminalSchema.parse(id))
    changed()
  })
  handle('uninstall', (id: unknown) => {
    integrations.uninstall(terminalSchema.parse(id))
    changed()
  })
  handle('check', (id: unknown) => integrations.check(terminalSchema.parse(id)))
  handle('set-theme', (input: unknown) => {
    const theme = z.enum(['system', 'light', 'dark']).parse(input)
    store.saveSettings({ ...store.settings(), theme })
    nativeTheme.themeSource = theme
    changed()
  })
  handle('choose-avatar', async (input: unknown) => {
    const key = avatarSchema.parse(input) as AvatarKey
    const selection = await dialog.showOpenDialog({
      title: '选择本地头像',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    })
    if (selection.canceled) return
    const source = selection.filePaths[0]
    if (statSync(source).size > 10 * 1024 * 1024) throw new Error('头像不能大于 10 MB')
    if (nativeImage.createFromPath(source).isEmpty()) throw new Error('无法读取这张图片')
    const target = path.join(
      dataDirectory,
      'avatars',
      `${key.replace(':', '-')}${path.extname(source).toLowerCase()}`
    )
    mkdirSync(path.dirname(target), { recursive: true })
    copyFileSync(source, target)
    const settings = store.settings()
    settings.avatars[key] = target
    store.saveSettings(settings)
    changed()
  })
  handle('reset-avatars', () => {
    store.saveSettings({ ...store.settings(), avatars: {} })
    changed()
  })
  handle('show-main', showMain)
}

async function boot(): Promise<void> {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 })
  store = new Store(path.join(dataDirectory, 'ebisu.sqlite'))
  integrations = new Integrations(store, {
    dataDirectory,
    resources,
    executable: process.execPath,
    // 仅隔离测试模式允许替换 HOME；正式运行始终使用真实用户目录。
    home: process.env.EBISU_SMOKE ? process.env.EBISU_TEST_HOME : undefined
  })
  integrations.prepareBridge()
  taskTitles = new TaskTitles(
    // smoke 不得读取真实用户的 Codex 元数据；正式环境支持自定义 CODEX_HOME。
    process.env.EBISU_SMOKE
      ? path.join(integrations.home, '.codex')
      : process.env.CODEX_HOME || path.join(integrations.home, '.codex')
  )
  nativeTheme.themeSource = store.settings().theme
  protocol.handle('ebisu-asset', async (request) => {
    const url = new URL(request.url)
    const parts = url.pathname.split('/').filter(Boolean)
    if (
      url.hostname !== 'avatar' ||
      parts.length !== 2 ||
      !avatarSchema.safeParse(`${parts[0]}:${parts[1]}`).success
    )
      return new Response('Not found', { status: 404 })
    const key = `${parts[0]}:${parts[1]}` as AvatarKey
    const custom = store.settings().avatars[key]
    const base = path.join(resources, 'avatars', `${parts[0]}-${parts[1]}`)
    // 装饰背景优先使用随包发布的透明轮廓，小头像保持原图；托盘使用 Q 版素材，主窗口沿用旧轮廓。
    const backgroundFolder = url.searchParams.get('tray') === '1' ? 'tray' : 'backgrounds'
    const silhouette = path.join(
      resources,
      'avatars',
      backgroundFolder,
      `${parts[0]}-${parts[1]}.png`
    )
    const filename =
      custom && existsSync(custom)
        ? custom
        : url.searchParams.get('background') === '1' && existsSync(silhouette)
          ? silhouette
          : ['.webp', '.png', '.svg', '.jpg'].map((extension) => base + extension).find(existsSync)
    return filename
      ? net.fetch(pathToFileURL(filename).href)
      : new Response('Not found', { status: 404 })
  })
  try {
    service = await startServer(store, path.join(dataDirectory, 'runtime.json'), changed)
  } catch (error) {
    serviceError = String(error)
    console.error('本机服务启动失败:', error)
  }
  // 隔离 smoke 模式可预注册目录，无需操作系统目录选择器。
  if (process.env.EBISU_SMOKE_FOLDER) store.addFolder(process.env.EBISU_SMOKE_FOLDER)
  installIpc()
  mainWindow = createWindow(false)
  trayWindow = createWindow(true)
  const icon = nativeImage.createFromPath(path.join(resources, 'trayTemplate.png'))
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip('Ebisu · 项目活动')
  tray.on('click', toggleTray)
  tray.on('right-click', () =>
    tray?.popUpContextMenu(
      Menu.buildFromTemplate([
        { label: '打开 Ebisu', click: showMain },
        { type: 'separator' },
        { label: '退出', click: () => app.quit() }
      ])
    )
  )
  app.setAboutPanelOptions({
    applicationName: 'Ebisu',
    applicationVersion: app.getVersion(),
    copyright: '本地项目与 Agent 会话状态面板'
  })
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Ebisu',
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { type: 'separator' },
          { role: 'quit' }
        ]
      },
      {
        label: '编辑',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' }
        ]
      },
      { label: '窗口', submenu: [{ role: 'minimize' }, { label: '显示主窗口', click: showMain }] }
    ])
  )
  await watchFolders()
  pollTimer = setInterval(() => {
    void refreshGit()
  }, 15000)
  expiryTimer = setInterval(() => {
    if (store.expire()) changed()
  }, 1000)
  powerMonitor.on('resume', () => {
    store.expire()
    void refreshGit()
    changed()
  })
  // 开发启动器关闭后，Electron 可能被 macOS 收养为孤儿进程；它已无法使用 Vite 页面，
  // 应退出并释放单实例锁。正式安装包继续保持独立运行和托盘常驻行为。
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    developmentParentTimer = setInterval(() => {
      if (process.ppid === 1) app.quit()
    }, 1000)
    developmentParentTimer.unref()
  }
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', showMain)
  app
    .whenReady()
    .then(boot)
    .catch((error) => {
      dialog.showErrorBox('Ebisu 启动失败', String(error))
      app.quit()
    })
  app.on('activate', () => {
    if (store) showMain()
  })
  app.on('window-all-closed', () => {
    /* macOS 常驻托盘，不随窗口关闭而退出。 */
  })
  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    clearInterval(pollTimer)
    clearInterval(expiryTimer)
    clearInterval(developmentParentTimer)
    clearTimeout(refreshTimer)
    // watcher、Git 或 HTTP 清理异常不能无限占用单实例锁。数据库写入本身同步提交，
    // 兜底退出前尽力关闭数据库；不会等待外部文件系统或连接永久挂起。
    const exit = () => {
      try {
        store?.close()
      } catch (error) {
        console.warn('退出时关闭数据库失败:', String(error))
      }
      app.exit(0)
    }
    const deadline = setTimeout(exit, 3000)
    void (async () => {
      try {
        // 并行停止相互独立的资源，避免慢 Git 查询阻止 HTTP 服务及运行信息的释放。
        await Promise.all([watcher?.close(), refreshing, service?.close()])
      } catch (error) {
        console.warn('退出时资源清理失败:', String(error))
      } finally {
        clearTimeout(deadline)
        // 已完成退出清理，直接退出而非再次进入可被取消的 app.quit 事件流程。
        exit()
      }
    })()
  })
}
