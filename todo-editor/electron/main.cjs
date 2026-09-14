const { app, BrowserWindow, shell, ipcMain, dialog, screen, Menu } = require('electron')
const path = require('path')
const fs = require('fs')
const { pathToFileURL } = require('url')

const isDev = !app.isPackaged

/** @type {BrowserWindow | null} */
let mainWindow = null
/** @type {BrowserWindow | null} */
let timelineWindow = null
/** @type {BrowserWindow | null} */
let aiWindow = null

// 硬件加速默认开启；仅在环境变量显式关闭时禁用
if (process.env.TODO_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration()
}

function appUrl(search = '') {
  const base = (process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173').replace(/\/$/, '')
  return search ? `${base}${search.startsWith('?') ? search : `?${search}`}` : base
}

function loadApp(win, search = '') {
  if (isDev) {
    return win.loadURL(appUrl(search))
  }
  const file = path.join(__dirname, '../dist/index.html')
  const opts = search
    ? { search: search.startsWith('?') ? search.slice(1) : search }
    : undefined
  return win.loadFile(file, opts)
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1280,
    minHeight: 720,
    title: 'TO DO',
    backgroundColor: '#F2EEE8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webgl: true,
      backgroundThrottling: false,
      // 桌面剪辑需预览本机 file:// 媒体
      webSecurity: false,
    },
    show: false,
  })

  mainWindow = win
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    mainWindow = null
    if (timelineWindow && !timelineWindow.isDestroyed()) timelineWindow.close()
    if (aiWindow && !aiWindow.isDestroyed()) aiWindow.close()
  })

  void loadApp(win)

  // 禁止随意外开；时间轴 / AI popout 走我们自己的第二窗
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url)
      const pop = u.searchParams.get('popout')
      if (pop === 'timeline') {
        openTimelineWindow()
        return { action: 'deny' }
      }
      if (pop === 'ai') {
        openAiWindow()
        return { action: 'deny' }
      }
    } catch { /* */ }
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

async function openTimelineWindow() {
  if (timelineWindow && !timelineWindow.isDestroyed()) {
    timelineWindow.show()
    timelineWindow.focus()
    notifyMainTimelineOpened()
    return { ok: true, reused: true }
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 420,
    minWidth: 720,
    minHeight: 240,
    title: 'TO DO · 时间轴',
    backgroundColor: '#F2EEE8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webgl: true,
      backgroundThrottling: false,
      webSecurity: false,
    },
    show: true,
  })

  if (mainWindow && !mainWindow.isDestroyed()) {
    const b = mainWindow.getBounds()
    win.setPosition(Math.max(40, b.x + 48), Math.max(40, b.y + Math.max(80, b.height - 460)))
  }

  timelineWindow = win
  win.on('closed', () => {
    timelineWindow = null
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('desktop:timeline-window-closed')
    }
  })

  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('[timeline-window] load failed', code, desc)
  })

  await loadApp(win, 'popout=timeline')
  if (!win.isDestroyed()) {
    win.show()
    win.focus()
  }
  notifyMainTimelineOpened()
  return { ok: true, reused: false }
}

function notifyMainTimelineOpened() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('desktop:timeline-window-opened')
  }
}

function timelineWindowAlive() {
  return !!(timelineWindow && !timelineWindow.isDestroyed())
}

function closeTimelineWindow() {
  if (timelineWindow && !timelineWindow.isDestroyed()) {
    timelineWindow.close()
    return { ok: true }
  }
  return { ok: true, alreadyClosed: true }
}

async function openAiWindow() {
  if (aiWindow && !aiWindow.isDestroyed()) {
    aiWindow.show()
    aiWindow.focus()
    return { ok: true, reused: true }
  }

  const win = new BrowserWindow({
    width: 420,
    height: 740,
    minWidth: 360,
    minHeight: 480,
    title: 'TO DO · AI+',
    backgroundColor: '#F2EEE8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webgl: true,
      backgroundThrottling: false,
      webSecurity: false,
    },
    show: true,
  })

  if (mainWindow && !mainWindow.isDestroyed()) {
    const b = mainWindow.getBounds()
    win.setPosition(Math.max(40, b.x + b.width - 440), Math.max(40, b.y + 60))
  }

  aiWindow = win
  win.on('closed', () => {
    aiWindow = null
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('desktop:ai-window-closed')
    }
  })

  await loadApp(win, 'popout=ai')
  if (!win.isDestroyed()) {
    win.show()
    win.focus()
  }
  return { ok: true, reused: false }
}

function closeAiWindow() {
  if (aiWindow && !aiWindow.isDestroyed()) {
    aiWindow.close()
    return { ok: true }
  }
  return { ok: true, alreadyClosed: true }
}

function userDataPaths() {
  const root = app.getPath('userData')
  const projects = path.join(root, 'projects')
  const cache = path.join(root, 'cache')
  const exportsDir = path.join(root, 'exports')
  for (const d of [projects, cache, exportsDir]) {
    fs.mkdirSync(d, { recursive: true })
  }
  return { root, projects, cache, exports: exportsDir }
}

app.whenReady().then(() => {
  // 去掉 Electron 默认 File/Edit/View/Window/Help 菜单栏
  Menu.setApplicationMenu(null)

  ipcMain.handle('desktop:get-paths', () => userDataPaths())

  ipcMain.handle('desktop:save-project', async (_e, { defaultName, json }) => {
    const { projects } = userDataPaths()
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '保存工程',
      defaultPath: path.join(projects, defaultName || 'project.todo.json'),
      filters: [{ name: 'TO DO 工程', extensions: ['todo.json', 'json'] }],
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    fs.writeFileSync(filePath, typeof json === 'string' ? json : JSON.stringify(json, null, 2), 'utf8')
    return { ok: true, path: filePath }
  })

  ipcMain.handle('desktop:open-project', async () => {
    const { projects } = userDataPaths()
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '打开工程',
      defaultPath: projects,
      properties: ['openFile'],
      filters: [{ name: 'TO DO 工程', extensions: ['todo.json', 'json'] }],
    })
    if (canceled || !filePaths[0]) return { ok: false, canceled: true }
    const raw = fs.readFileSync(filePaths[0], 'utf8')
    return { ok: true, path: filePaths[0], json: JSON.parse(raw) }
  })

  ipcMain.handle('desktop:pick-media', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '导入媒体',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '媒体', extensions: ['mp4', 'mov', 'webm', 'mkv', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'wav', 'mp3', 'aac', 'm4a'] },
      ],
    })
    if (canceled || !filePaths.length) return { ok: false, canceled: true, files: [] }
    const files = filePaths.map((p) => {
      const ext = path.extname(p).toLowerCase()
      const kind = /\.(png|jpe?g|webp|gif)$/i.test(ext)
        ? 'image'
        : /\.(wav|mp3|aac|m4a)$/i.test(ext)
          ? 'audio'
          : 'video'
      return {
        name: path.basename(p),
        path: p,
        url: pathToFileURL(p).href,
        kind,
      }
    })
    return { ok: true, files }
  })

  ipcMain.handle('desktop:export-frame', async (_e, { defaultName, dataUrl }) => {
    const { exports: exportsDir } = userDataPaths()
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出帧',
      defaultPath: path.join(exportsDir, defaultName || `frame_${Date.now()}.png`),
      filters: [{ name: 'PNG', extensions: ['png'] }],
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    const b64 = String(dataUrl || '').replace(/^data:image\/\w+;base64,/, '')
    fs.writeFileSync(filePath, Buffer.from(b64, 'base64'))
    return { ok: true, path: filePath }
  })

  ipcMain.handle('desktop:reveal', async (_e, filePath) => {
    if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath)
    return { ok: true }
  })

  ipcMain.handle('desktop:open-timeline-window', async () => openTimelineWindow())
  ipcMain.handle('desktop:close-timeline-window', () => closeTimelineWindow())
  ipcMain.handle('desktop:timeline-window-alive', () => ({ ok: timelineWindowAlive() }))
  ipcMain.handle('desktop:open-ai-window', async () => openAiWindow())
  ipcMain.handle('desktop:close-ai-window', () => closeAiWindow())

  // Windows 上 BrowserWindow 之间 HTML5 拖放经常丢；松手时看光标是否在时间轴窗里
  ipcMain.on('desktop:media-drag-end', (_e, mediaId) => {
    if (!mediaId || !timelineWindow || timelineWindow.isDestroyed()) return
    const pt = screen.getCursorScreenPoint()
    const b = timelineWindow.getContentBounds()
    if (pt.x < b.x || pt.y < b.y || pt.x > b.x + b.width || pt.y > b.y + b.height) return
    timelineWindow.webContents.send('desktop:media-drop', {
      mediaId: String(mediaId),
      x: pt.x - b.x,
      y: pt.y - b.y,
    })
  })

  // 主窗 ↔ 时间轴/AI 窗状态同步（比 BroadcastChannel 在 Electron/file 下更稳）
  ipcMain.on('desktop:store-sync', (event, msg) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed() || w.webContents.id === event.sender.id) continue
      w.webContents.send('desktop:store-sync', msg)
    }
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
