const { app, BrowserWindow, shell, ipcMain, dialog, screen, Menu } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const { pathToFileURL } = require('url')
const { createMediaProbe } = require('./mediaProbe.cjs')
const { exportSequence } = require('./exportSequence.cjs')
const { createNativePlayer, rgb24ToBmpDataUrl } = require('./nativePlayer.cjs')
const { makeProxy } = require('./makeProxy.cjs')
const { createPreviewEngine } = require('./previewEngine.cjs')
const { createRecentProjects, writeProjectFile, readProjectFile, createProjectFolder, PROJECT_SUBDIRS } = require('./projectFile.cjs')

const isDev = !app.isPackaged

function appIconPath() {
  const ico = path.join(__dirname, '../build/icon.ico')
  if (fs.existsSync(ico)) return ico
  return path.join(__dirname, '../build/icon.png')
}

/** @type {BrowserWindow | null} */
let mainWindow = null
/** @type {BrowserWindow | null} */
let timelineWindow = null
/** @type {BrowserWindow | null} */
let aiWindow = null
/** @type {BrowserWindow | null} */
let browserWindow = null
/** @type {import('electron').WebContents | null} */
let browserGuest = null
/** @type {import('child_process').ChildProcess | null} */
let aiServerProc = null
/** @type {string} */
let aiBaseUrl = ''
/** @type {ReturnType<typeof createPreviewEngine> | null} */
let previewEngine = null
/** 主窗关闭前先让渲染层落盘工程；渲染层回 close-ready 或超时后才真正关闭 */
let allowMainClose = false
let closeRequested = false

// 硬件加速默认开启；仅在环境变量显式关闭时禁用
if (process.env.TODO_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration()
}

/** 崩溃诊断：子进程/渲染进程异常退出、主进程未捕获异常都写到 userData/logs/crash.log */
function crashLog(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`
  try {
    const dir = path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'crash.log'), line)
  } catch { /* */ }
  console.error('[crash]', line.trim())
}
process.on('uncaughtException', (e) => crashLog('main uncaughtException', String(e?.stack || e)))
process.on('unhandledRejection', (e) => crashLog('main unhandledRejection', String(e?.stack || e)))
process.on('exit', (code) => crashLog('main exit', { code }))
app.on('child-process-gone', (_e, d) => crashLog('child-process-gone', d))
app.on('render-process-gone', (_e, wc, d) => crashLog('render-process-gone', { url: wc.getURL(), ...d }))
app.on('web-contents-created', (_e, wc) => {
  wc.on('console-message', (_ev, level, message, line, sourceId) => {
    if (level >= 3) crashLog('renderer error', { message, sourceId, line })
  })
  wc.on('unresponsive', () => crashLog('renderer unresponsive', { url: wc.getURL() }))
})

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
  const { workArea } = screen.getPrimaryDisplay()
  // 跟工作区走，勿强制比屏幕还宽的最小窗
  const width = Math.min(1440, Math.max(1024, workArea.width - 48))
  const height = Math.min(900, Math.max(640, workArea.height - 48))
  const win = new BrowserWindow({
    width,
    height,
    minWidth: 960,
    minHeight: 600,
    title: 'TO DO',
    backgroundColor: '#F2EEE8',
    icon: appIconPath(),
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
  allowMainClose = false
  closeRequested = false
  win.once('ready-to-show', () => win.show())
  win.on('close', (e) => {
    if (allowMainClose || win.webContents.isLoading()) return
    e.preventDefault()
    if (closeRequested) return
    closeRequested = true
    win.webContents.send('desktop:request-close')
    setTimeout(() => {
      if (win.isDestroyed()) return
      allowMainClose = true
      win.close()
    }, 8000)
  })
  win.webContents.on('render-process-gone', () => { allowMainClose = true })
  win.on('closed', () => {
    mainWindow = null
    if (timelineWindow && !timelineWindow.isDestroyed()) timelineWindow.close()
    if (aiWindow && !aiWindow.isDestroyed()) aiWindow.close()
    if (browserWindow && !browserWindow.isDestroyed()) browserWindow.close()
  })
  // 点节目区时仍把弹出时间轴压在主窗前面（不抢焦点）
  win.on('focus', () => {
    if (timelineWindow && !timelineWindow.isDestroyed() && timelineWindow.isVisible()) {
      timelineWindow.moveTop()
    }
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
      if (pop === 'browser') {
        openBrowserWindow()
        return { action: 'deny' }
      }
    } catch { /* */ }
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

function raiseTimelineAboveProgram() {
  if (!timelineWindow || timelineWindow.isDestroyed()) return
  timelineWindow.show()
  timelineWindow.moveTop()
  timelineWindow.focus()
}

async function openTimelineWindow() {
  if (timelineWindow && !timelineWindow.isDestroyed()) {
    raiseTimelineAboveProgram()
    notifyMainTimelineOpened()
    return { ok: true, reused: true }
  }

  const parent =
    mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined

  const win = new BrowserWindow({
    width: 1280,
    height: 260,
    minWidth: 720,
    minHeight: 160,
    title: 'TO DO · 时间轴',
    backgroundColor: '#F2EEE8',
    icon: appIconPath(),
    // 挂到主窗：始终叠在节目监视器所在主窗前面
    parent,
    modal: false,
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
    raiseTimelineAboveProgram()
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

function resizeTimelineWindow(size = {}) {
  if (!timelineWindow || timelineWindow.isDestroyed()) return { ok: false }
  const cur = timelineWindow.getContentSize()
  const screenH = screen.getPrimaryDisplay()?.workAreaSize?.height || 900
  const maxH = Math.max(400, Math.floor(screenH * 0.9))
  const w = Math.max(720, Math.round(size.width ?? cur[0]))
  const h = Math.max(160, Math.min(maxH, Math.round(size.height ?? cur[1])))
  if (w === cur[0] && h === cur[1]) return { ok: true, unchanged: true }
  timelineWindow.setContentSize(w, h)
  return { ok: true }
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
    icon: appIconPath(),
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

async function openBrowserWindow(startUrl) {
  if (browserWindow && !browserWindow.isDestroyed()) {
    browserWindow.show()
    browserWindow.focus()
    if (startUrl && browserGuest && !browserGuest.isDestroyed()) {
      try { browserGuest.loadURL(String(startUrl)) } catch { /* */ }
    }
    return { ok: true, reused: true }
  }

  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 640,
    minHeight: 480,
    title: 'TO DO · 浏览器',
    backgroundColor: '#F2EEE8',
    icon: appIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'browser-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      backgroundThrottling: false,
    },
    show: true,
  })

  if (mainWindow && !mainWindow.isDestroyed()) {
    const b = mainWindow.getBounds()
    win.setPosition(Math.max(40, b.x + 80), Math.max(40, b.y + 40))
  }

  browserWindow = win
  browserGuest = null
  win.webContents.on('did-attach-webview', (_e, guest) => {
    browserGuest = guest
    guest.setWindowOpenHandler(({ url }) => {
      try { guest.loadURL(url) } catch { /* */ }
      return { action: 'deny' }
    })
    // 网页内按 F1 也进入截图（焦点常在 webview 里）
    guest.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F1') {
        event.preventDefault()
        if (browserWindow && !browserWindow.isDestroyed()) {
          browserWindow.webContents.send('todo-browser:toggle-shot')
        }
      }
    })
  })
  win.on('closed', () => {
    browserWindow = null
    browserGuest = null
  })

  const html = path.join(__dirname, 'browser.html')
  await win.loadFile(html)
  if (startUrl) {
    win.webContents.once('did-finish-load', () => {
      if (browserGuest && !browserGuest.isDestroyed()) {
        try { browserGuest.loadURL(String(startUrl)) } catch { /* */ }
      }
    })
  }
  if (!win.isDestroyed()) {
    win.show()
    win.focus()
  }
  return { ok: true, reused: false }
}

function closeBrowserWindow() {
  if (browserWindow && !browserWindow.isDestroyed()) {
    browserWindow.close()
    return { ok: true }
  }
  return { ok: true, alreadyClosed: true }
}

/** 把 dataURL 落到项目素材目录（与 save-media-asset 同路径规则） */
function writeMediaAsset(name, dataUrl) {
  const safe = path.basename(String(name || `asset_${Date.now()}.png`))
  if (!safe) return { ok: false, error: 'invalid name' }
  const b64 = String(dataUrl || '').replace(/^data:image\/\w+;base64,/, '')
  if (!b64 || b64 === String(dataUrl || '')) return { ok: false, error: '无效图片数据' }
  const destDir = currentProjectDir
    ? path.join(currentProjectDir, PROJECT_SUBDIRS.ai)
    : path.join(userDataPaths().cache, 'assets')
  try {
    fs.mkdirSync(destDir, { recursive: true })
    const dest = path.join(destDir, safe)
    fs.writeFileSync(dest, Buffer.from(b64, 'base64'))
    return { ok: true, path: dest, url: pathToFileURL(dest).href, name: safe }
  } catch (e) {
    return { ok: false, error: e.message || String(e) }
  }
}

/** 当前打开的项目文件夹（工程文件所在目录）；没开项目时导出 / 代理回落到 userData */
let currentProjectDir = null

function userDataPaths() {
  const root = app.getPath('userData')
  const projects = path.join(root, 'projects')
  const cache = currentProjectDir ? path.join(currentProjectDir, PROJECT_SUBDIRS.cache) : path.join(root, 'cache')
  const exportsDir = currentProjectDir ? path.join(currentProjectDir, PROJECT_SUBDIRS.exports) : path.join(root, 'exports')
  for (const d of [projects, cache, exportsDir]) {
    fs.mkdirSync(d, { recursive: true })
  }
  let projectsRoot = path.join(root, 'projects')
  try {
    projectsRoot = path.join(app.getPath('documents'), 'TO DO 项目')
    fs.mkdirSync(projectsRoot, { recursive: true })
  } catch { /* */ }
  return { root, projects, cache, exports: exportsDir, projectsRoot, projectDir: currentProjectDir }
}

const recentProjects = createRecentProjects(() => path.join(app.getPath('userData'), 'recent-projects.json'))

/** 扫描常用目录下的 *.todo.json，补回「最近项目」 */
function discoverProjectFiles() {
  const { projectsRoot, projects } = userDataPaths()
  const roots = [projectsRoot, projects]
  try { roots.push(app.getPath('desktop')) } catch { /* */ }
  try { roots.push(path.join(app.getPath('documents'), 'TO DO 项目')) } catch { /* */ }
  const found = []
  const seen = new Set()
  const add = (filePath) => {
    const key = path.resolve(filePath).toLowerCase()
    if (seen.has(key) || !fs.existsSync(filePath)) return
    seen.add(key)
    found.push(filePath)
  }
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue
    let ents = []
    try { ents = fs.readdirSync(root, { withFileTypes: true }) } catch { continue }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue
      const full = path.join(root, e.name)
      if (e.isFile() && /\.todo\.json$/i.test(e.name)) {
        add(full)
        continue
      }
      if (!e.isDirectory()) continue
      // 项目文件夹：<name>/<name>.todo.json 或任意 *.todo.json
      let kids = []
      try { kids = fs.readdirSync(full) } catch { continue }
      for (const k of kids) {
        if (/\.todo\.json$/i.test(k)) add(path.join(full, k))
      }
    }
  }
  return found
}

function aiServerScript() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'server', 'aiServer.mjs')
  }
  return path.join(__dirname, '../server/aiServer.mjs')
}

function stopAiServer() {
  if (!aiServerProc) return
  try { aiServerProc.kill() } catch { /* */ }
  aiServerProc = null
}

/** @returns {Promise<string>} */
function startAiServer() {
  if (aiBaseUrl) return Promise.resolve(aiBaseUrl)
  const dataDir = path.join(app.getPath('userData'), 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  const script = aiServerScript()
  const env = {
    ...process.env,
    TODO_DATA_DIR: dataDir,
    TODO_NATIVE_BIN: app.isPackaged
      ? path.join(process.resourcesPath, 'native')
      : path.join(__dirname, '../native/bin'),
  }
  /** @type {import('child_process').ChildProcess} */
  let child
  if (isDev) {
    child = spawn('node', [script, '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  } else {
    env.ELECTRON_RUN_AS_NODE = '1'
    child = spawn(process.execPath, [script, '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  }
  aiServerProc = child

  return new Promise((resolve, reject) => {
    let buf = ''
    const onData = (chunk) => {
      buf += String(chunk)
      const line = buf.split(/\r?\n/).find((l) => l.includes('"ok"'))
      if (!line) return
      try {
        const msg = JSON.parse(line)
        if (msg.ok && msg.port) {
          aiBaseUrl = `http://127.0.0.1:${msg.port}`
          child.stdout?.off('data', onData)
          resolve(aiBaseUrl)
          return
        }
      } catch { /* keep reading */ }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', (d) => console.error('[ai-server]', String(d).trim()))
    child.on('error', (e) => {
      stopAiServer()
      reject(e)
    })
    child.on('exit', (code) => {
      if (!aiBaseUrl) reject(new Error(`ai-server exited ${code}`))
      aiServerProc = null
    })
    setTimeout(() => {
      if (!aiBaseUrl) {
        stopAiServer()
        reject(new Error('ai-server start timeout'))
      }
    }, 15000)
  })
}

app.whenReady().then(async () => {
  // 去掉 Electron 默认 File/Edit/View/Window/Help 菜单栏
  Menu.setApplicationMenu(null)

  ipcMain.handle('desktop:get-paths', () => userDataPaths())
  ipcMain.on('desktop:ai-base-url', (e) => { e.returnValue = aiBaseUrl })
  ipcMain.handle('desktop:get-ai-base-url', () => aiBaseUrl)
  ipcMain.on('desktop:smiley-font-url', (e) => {
    const { pathToFileURL } = require('node:url')
    const home = process.env.USERPROFILE || process.env.HOME || ''
    const cands = [
      process.env.SUB_FONT_FILE,
      home && path.join(home, 'AppData/Local/Microsoft/Windows/Fonts/SmileySans-Oblique.otf'),
      path.join(__dirname, '../public/fonts/SmileySans-Oblique.otf'),
      process.env.WINDIR && path.join(process.env.WINDIR, 'Fonts/SmileySans-Oblique.otf'),
    ].filter(Boolean)
    let url = ''
    for (const p of cands) {
      try {
        if (fs.existsSync(p)) { url = pathToFileURL(p).href; break }
      } catch { /* */ }
    }
    e.returnValue = url
  })

  try {
    await startAiServer()
  } catch (e) {
    console.error('[ai-server] failed to start', e)
  }

  const nativeBin = app.isPackaged
    ? path.join(process.resourcesPath, 'native')
    : path.join(__dirname, '../native/bin')
  const probeMedia = createMediaProbe({
    enginePath: path.join(nativeBin, 'todo-media-engine.exe'),
    nativePath: path.join(nativeBin, 'todo-media-probe.exe'),
  })
  ipcMain.handle('desktop:probe-media', (_e, payload) => probeMedia(payload))

  ipcMain.handle('desktop:decode-media-frame', async (_e, payload = {}) => {
    const { filePath, timeSec = 0, timeoutMs = 10000 } = payload || {}
    const engineExe = path.join(nativeBin, 'todo-media-engine.exe')
    if (!fs.existsSync(engineExe)) return { ok: false, error: 'engine missing' }
    try {
      if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !fs.statSync(filePath).isFile()) {
        return { ok: false, error: 'invalid path' }
      }
      const t = Number(timeSec)
      if (!Number.isFinite(t) || t < 0) return { ok: false, error: 'invalid time' }
      const outFile = path.join(app.getPath('temp'), `todo-frame-${Date.now()}-${Math.random().toString(36).slice(2)}.bmp`)
      const { execFile } = require('node:child_process')
      const result = await new Promise((resolve) => {
        execFile(engineExe, ['frame', filePath, String(t), outFile, String(timeoutMs || 10000)], {
          windowsHide: true, encoding: 'utf8', timeout: (timeoutMs || 10000) + 2000, maxBuffer: 65536,
        }, (err, stdout) => {
          try {
            const meta = JSON.parse(String(stdout || '{}'))
            if (err || !meta.ok || !fs.existsSync(outFile)) {
              resolve({ ok: false, error: meta?.error?.message || err?.message || 'decode failed' })
              return
            }
            const buf = fs.readFileSync(outFile)
            fs.unlink(outFile, () => {})
            resolve({
              ok: true,
              width: meta.width,
              height: meta.height,
              dataUrl: `data:image/bmp;base64,${buf.toString('base64')}`,
            })
          } catch (e) {
            resolve({ ok: false, error: e.message })
          }
        })
      })
      return result
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })

  const nativePlayer = createNativePlayer({
    enginePath: path.join(nativeBin, 'todo-media-engine.exe'),
    timeoutMs: 8000,
  })

  ipcMain.handle('desktop:native-play-open', async (_e, payload = {}) => {
    const { filePath, timeoutMs } = payload || {}
    return nativePlayer.open(filePath, timeoutMs)
  })
  ipcMain.handle('desktop:native-play-seek', async (_e, payload = {}) => {
    const { timeSec, timeoutMs } = payload || {}
    return nativePlayer.seek(timeSec, timeoutMs)
  })
  ipcMain.handle('desktop:native-play-read', async (_e, payload = {}) => {
    const { timeoutMs } = payload || {}
    const r = await nativePlayer.read(timeoutMs)
    if (!r.ok || !r.rgb) {
      return { ok: false, eof: !!r.eof, error: r.error || 'read failed' }
    }
    try {
      const dataUrl = rgb24ToBmpDataUrl(r.w, r.h, r.rgb)
      return { ok: true, w: r.w, h: r.h, pts: r.pts, dataUrl }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })
  ipcMain.handle('desktop:native-play-audio-clock', async (_e, payload = {}) => {
    const { timeoutMs } = payload || {}
    return nativePlayer.audioClock(timeoutMs)
  })
  ipcMain.handle('desktop:native-play-close', async () => nativePlayer.close())

  ipcMain.handle('desktop:compose-frame', async (_e, payload = {}) => {
    const { graph, timeSec = 0, timeoutMs = 20000 } = payload || {}
    const engineExe = path.join(nativeBin, 'todo-media-engine.exe')
    if (!fs.existsSync(engineExe)) return { ok: false, error: 'engine missing' }
    if (!graph || typeof graph !== 'object') return { ok: false, error: 'invalid graph' }
    const t = Number(timeSec)
    if (!Number.isFinite(t) || t < 0) return { ok: false, error: 'invalid time' }
    try {
      const tmpDir = app.getPath('temp')
      const graphFile = path.join(tmpDir, `todo-compose-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
      const outFile = path.join(tmpDir, `todo-compose-${Date.now()}-${Math.random().toString(36).slice(2)}.bmp`)
      fs.writeFileSync(graphFile, JSON.stringify(graph), 'utf8')
      const { execFile } = require('node:child_process')
      const result = await new Promise((resolve) => {
        execFile(engineExe, ['compose', graphFile, String(t), outFile], {
          windowsHide: true,
          encoding: 'utf8',
          timeout: (timeoutMs || 20000) + 2000,
          maxBuffer: 65536,
          env: { ...process.env, PATH: `${nativeBin}${path.delimiter}${process.env.PATH || ''}` },
        }, (err, stdout) => {
          try {
            fs.unlink(graphFile, () => {})
            const meta = JSON.parse(String(stdout || '{}'))
            if (err || !meta.ok || !fs.existsSync(outFile)) {
              resolve({ ok: false, error: meta?.error || err?.message || 'compose failed' })
              return
            }
            const buf = fs.readFileSync(outFile)
            fs.unlink(outFile, () => {})
            resolve({
              ok: true,
              backend: meta.backend,
              width: meta.width,
              height: meta.height,
              layers: meta.layers,
              time: meta.time,
              dataUrl: `data:image/bmp;base64,${buf.toString('base64')}`,
            })
          } catch (e) {
            resolve({ ok: false, error: e.message })
          }
        })
      })
      return result
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('desktop:make-proxy', async (_e, payload = {}) => {
    const { filePath, height } = payload || {}
    const { cache } = userDataPaths()
    const outDir = path.join(cache, 'proxies')
    return makeProxy({
      filePath,
      outDir,
      height: height === 480 ? 480 : 720,
      nativeBin,
      timeoutMs: 180000,
    })
  })

  /** 测试用：顺序解码 N 秒帧数 smoke（无窗、无音频时钟） */
  ipcMain.handle('desktop:play-smoke', async (_e, payload = {}) => {
    const { filePath, seconds = 1, timeoutMs = 15000 } = payload || {}
    const engineExe = path.join(nativeBin, 'todo-media-engine.exe')
    if (!fs.existsSync(engineExe)) return { ok: false, error: 'engine missing' }
    try {
      if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !fs.statSync(filePath).isFile()) {
        return { ok: false, error: 'invalid path' }
      }
      const sec = Number(seconds)
      if (!Number.isFinite(sec) || sec <= 0) return { ok: false, error: 'invalid seconds' }
      const { execFile } = require('node:child_process')
      const wall = Math.max((timeoutMs || 15000) + 5000, Math.ceil(sec * 1000) + 10000)
      return await new Promise((resolve) => {
        execFile(engineExe, ['play-smoke', filePath, String(sec), String(timeoutMs || 15000)], {
          windowsHide: true, encoding: 'utf8', timeout: wall, maxBuffer: 65536,
        }, (err, stdout) => {
          try {
            const meta = JSON.parse(String(stdout || '{}'))
            if (err || !meta.ok) {
              resolve({ ok: false, error: meta?.error?.message || err?.message || 'play-smoke failed', ...meta })
              return
            }
            resolve({
              ok: true,
              frames: meta.frames,
              fps: meta.fps,
              duration: meta.duration,
              engine: meta.engine,
            })
          } catch (e) {
            resolve({ ok: false, error: e.message })
          }
        })
      })
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('desktop:save-project', async (_e, { defaultName, json, filePath: target }) => {
    let filePath = typeof target === 'string' && target ? target : ''
    if (!filePath) {
      const { projects } = userDataPaths()
      const r = await dialog.showSaveDialog(mainWindow ?? undefined, {
        title: '保存工程',
        defaultPath: path.join(currentProjectDir || projects, defaultName || 'project.todo.json'),
        filters: [{ name: 'TO DO 工程', extensions: ['todo.json', 'json'] }],
      })
      if (r.canceled || !r.filePath) return { ok: false, canceled: true }
      filePath = r.filePath
    }
    try {
      writeProjectFile(filePath, json)
    } catch (e) {
      return { ok: false, error: e.message, path: filePath }
    }
    recentProjects.push(filePath)
    return { ok: true, path: filePath }
  })

  ipcMain.handle('desktop:open-project', async (_e, opts) => {
    let filePath = typeof opts?.filePath === 'string' ? opts.filePath : ''
    if (!filePath) {
      const { projectsRoot } = userDataPaths()
      const r = await dialog.showOpenDialog(mainWindow ?? undefined, {
        title: '打开项目',
        defaultPath: fs.existsSync(projectsRoot) ? projectsRoot : undefined,
        properties: ['openFile'],
        filters: [{ name: 'TO DO 工程', extensions: ['todo.json', 'json'] }],
      })
      if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true }
      filePath = r.filePaths[0]
    }
    if (!fs.existsSync(filePath)) {
      recentProjects.remove(filePath)
      return { ok: false, notFound: true, path: filePath, error: '工程文件不存在' }
    }
    try {
      const { data, relinked, missing } = readProjectFile(filePath)
      recentProjects.push(filePath)
      return { ok: true, path: filePath, json: data, relinked, missing }
    } catch (e) {
      return { ok: false, path: filePath, error: e.message }
    }
  })

  ipcMain.handle('desktop:recent-projects', () => {
    // 每次打开列表时扫一遍本机项目目录，避免「最近」丢了但工程还在
    try { recentProjects.merge(discoverProjectFiles()) } catch { /* */ }
    return recentProjects.list().map((p) => ({ path: p, exists: fs.existsSync(p) }))
  })
  ipcMain.handle('desktop:remove-recent-project', (_e, filePath) => recentProjects.remove(String(filePath || '')))
  ipcMain.handle('desktop:discover-projects', () => {
    try { recentProjects.merge(discoverProjectFiles()) } catch { /* */ }
    return {
      ok: true,
      projects: recentProjects.list().map((p) => ({ path: p, exists: fs.existsSync(p) })),
      roots: (() => {
        const { projectsRoot, projects } = userDataPaths()
        return [projectsRoot, projects].filter(Boolean)
      })(),
    }
  })

  ipcMain.handle('desktop:create-project', (_e, { parentDir, name } = {}) => {
    try {
      const { dir, filePath } = createProjectFolder(parentDir, name)
      return { ok: true, dir, path: filePath }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('desktop:pick-directory', async (_e, { title, defaultPath } = {}) => {
    const r = await dialog.showOpenDialog(mainWindow ?? undefined, {
      title: title || '选择文件夹',
      defaultPath: typeof defaultPath === 'string' && defaultPath ? defaultPath : undefined,
      properties: ['openDirectory', 'createDirectory'],
    })
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true }
    return { ok: true, path: r.filePaths[0] }
  })

  /** 渲染端打开 / 新建 / 关闭项目时告知工程文件路径；null = 回到起始页 */
  ipcMain.handle('desktop:set-project', (_e, filePath) => {
    currentProjectDir = typeof filePath === 'string' && path.isAbsolute(filePath) ? path.dirname(filePath) : null
    return { ok: true, dir: currentProjectDir }
  })

  /** AI 服务产物（userData/data/ai-generated/<name>）复制进当前项目的 ai-generated/，项目搬家时素材跟着走 */
  ipcMain.handle('desktop:collect-ai-file', (_e, { name } = {}) => {
    if (!currentProjectDir) return { ok: false, error: '没有打开的项目' }
    const base = path.basename(String(name || ''))
    if (!base || base !== String(name)) return { ok: false, error: 'invalid name' }
    const src = path.join(app.getPath('userData'), 'data', 'ai-generated', base)
    const destDir = path.join(currentProjectDir, PROJECT_SUBDIRS.ai)
    const dest = path.join(destDir, base)
    try {
      if (!fs.existsSync(dest)) {
        if (!fs.existsSync(src)) return { ok: false, error: `找不到 AI 文件：${base}` }
        fs.mkdirSync(destDir, { recursive: true })
        fs.copyFileSync(src, dest)
      }
      return { ok: true, path: dest, url: pathToFileURL(dest).href }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('desktop:reveal-project', () => {
    if (!currentProjectDir) return { ok: false }
    void shell.openPath(currentProjectDir)
    return { ok: true }
  })

  ipcMain.on('desktop:close-ready', () => {
    allowMainClose = true
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close()
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

  // Offline sequence export: prefers todo-media-engine export, falls back to ffmpeg-cli
  ipcMain.handle('desktop:export-sequence', async (event, payload = {}) => {
    const { jobId, sequence, defaultName, audioOnly, outPath: forcedOut, skipDialog } = payload || {}
    const { exports: exportsDir } = userDataPaths()
    const ext = audioOnly || sequence?.audioOnly ? 'm4a' : 'mp4'
    const fallbackName = defaultName || `export_${Date.now()}.${ext}`
    const defaultPath = path.join(exportsDir, fallbackName)

    let filePath = typeof forcedOut === 'string' && forcedOut ? forcedOut : null
    if (!filePath) {
      if (skipDialog) {
        filePath = defaultPath
      } else {
        const { canceled, filePath: picked } = await dialog.showSaveDialog({
          title: '导出序列',
          defaultPath,
          filters: audioOnly || sequence?.audioOnly
            ? [{ name: 'Audio', extensions: ['m4a', 'aac'] }]
            : [{ name: 'MP4', extensions: ['mp4'] }],
        })
        if (canceled || !picked) return { ok: false, canceled: true }
        filePath = picked
      }
    }

    const sender = event.sender
    const result = await exportSequence(
      { ...(sequence || {}), audioOnly: !!(audioOnly || sequence?.audioOnly) },
      filePath,
      {
        nativeBin,
        chalkRendererUrl: isDev ? new URL('/chalk-render.html', appUrl()).href : undefined,
        onProgress: (progress, stage) => {
          if (!sender.isDestroyed()) {
            sender.send('desktop:export-progress', { jobId, progress, stage, status: 'running' })
          }
        },
      },
    )
    if (!sender.isDestroyed()) {
      sender.send('desktop:export-progress', {
        jobId,
        progress: result.ok ? 100 : 0,
        status: result.ok ? 'done' : 'error',
        error: result.error,
        path: result.path,
      })
    }
    return result
  })

  ipcMain.handle('desktop:reveal', async (_e, filePath) => {
    if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath)
    return { ok: true }
  })

  ipcMain.handle('desktop:open-timeline-window', async () => openTimelineWindow())
  ipcMain.handle('desktop:close-timeline-window', () => closeTimelineWindow())
  ipcMain.handle('desktop:resize-timeline-window', (_e, size) => resizeTimelineWindow(size || {}))
  ipcMain.handle('desktop:timeline-window-alive', () => ({ ok: timelineWindowAlive() }))
  ipcMain.handle('desktop:open-ai-window', async () => openAiWindow())
  ipcMain.handle('desktop:close-ai-window', () => closeAiWindow())
  ipcMain.handle('desktop:open-browser-window', async (_e, payload = {}) => openBrowserWindow(payload?.url))
  ipcMain.handle('desktop:close-browser-window', () => closeBrowserWindow())
  ipcMain.handle('desktop:browser-detect-boxes', async () => {
    if (!browserGuest || browserGuest.isDestroyed()) {
      return { ok: false, boxes: [], error: '浏览器页面还没就绪' }
    }
    try {
      const { buildDetectScript } = require('./browser-detect-inject.cjs')
      const r = await browserGuest.executeJavaScript(buildDetectScript(), true)
      if (!r || typeof r !== 'object') return { ok: false, boxes: [] }
      return { ok: !!r.ok, boxes: Array.isArray(r.boxes) ? r.boxes : [], error: r.error }
    } catch (e) {
      return { ok: false, boxes: [], error: e.message || String(e) }
    }
  })
  ipcMain.handle('desktop:browser-capture-import', async (_e, payload = {}) => {
    if (!browserGuest || browserGuest.isDestroyed()) {
      return { ok: false, error: '浏览器页面还没就绪' }
    }
    try {
      const mode = String(payload?.mode || 'page')
      const rectIn = payload?.rect && typeof payload.rect === 'object' ? payload.rect : null

      // 先整页抓图，再按外壳坐标裁切（避开 capturePage(rect) 在部分 DPI 下偏移）
      const full = await browserGuest.capturePage()
      const fullSize = full.getSize()
      if (!fullSize.width || !fullSize.height) return { ok: false, error: '截到的画面是空的' }

      let img = full
      let label = String(payload?.label || (mode === 'page' ? '整页' : '框选'))

      if (rectIn && mode !== 'page') {
        const viewW = Math.max(1, Number(payload?.viewWidth) || 0)
        const viewH = Math.max(1, Number(payload?.viewHeight) || 0)
        // 外壳 overlay 坐标是 CSS 像素；NativeImage 是物理像素
        const scaleX = viewW > 0 ? fullSize.width / viewW : 1
        const scaleY = viewH > 0 ? fullSize.height / viewH : scaleX
        const crop = {
          x: Math.max(0, Math.round((Number(rectIn.x) || 0) * scaleX)),
          y: Math.max(0, Math.round((Number(rectIn.y) || 0) * scaleY)),
          width: Math.max(1, Math.round((Number(rectIn.width) || 0) * scaleX)),
          height: Math.max(1, Math.round((Number(rectIn.height) || 0) * scaleY)),
        }
        if (crop.x + crop.width > fullSize.width) crop.width = fullSize.width - crop.x
        if (crop.y + crop.height > fullSize.height) crop.height = fullSize.height - crop.y
        if (crop.width < 2 || crop.height < 2) return { ok: false, error: '选区太小' }
        img = full.crop(crop)
      }

      const size = img.getSize()
      if (!size.width || !size.height) return { ok: false, error: '截到的区域是空的' }
      const dataUrl = img.toDataURL()

      const host = (() => {
        try { return new URL(String(payload?.pageUrl || '')).hostname.replace(/^www\./, '') || 'web' }
        catch { return 'web' }
      })()
      const stamp = new Date()
      const pad = (n) => String(n).padStart(2, '0')
      const tag = label.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 24) || '截图'
      const name = `网页_${host}_${tag}_${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}_${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.png`
      const saved = writeMediaAsset(name, dataUrl)
      if (!saved.ok) return saved
      const shot = {
        name: saved.name,
        path: saved.path,
        url: saved.url,
        width: size.width,
        height: size.height,
        title: String(payload?.title || ''),
        pageUrl: String(payload?.pageUrl || ''),
        label: tag,
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('desktop:browser-shot', shot)
      }
      return { ok: true, ...shot }
    } catch (e) {
      return { ok: false, error: e.message || String(e) }
    }
  })

  const { extractWaveformPeaks, extractWaveformPeaksFromBuffer } = require('./waveformPeaks.cjs')
  ipcMain.handle('desktop:waveform-peaks', async (_e, payload = {}) => {
    const { filePath, bins } = payload || {}
    return extractWaveformPeaks({ filePath, bins, nativeBin })
  })
  ipcMain.handle('desktop:waveform-peaks-buffer', async (_e, payload = {}) => {
    const { data, bins, ext } = payload || {}
    return extractWaveformPeaksFromBuffer({ data, bins, ext, nativeBin })
  })

  const { analyzeLoudness } = require('./loudnessAnalyze.cjs')
  ipcMain.handle('desktop:analyze-loudness', async (_e, payload = {}) => {
    const { filePath, inPoint, duration } = payload || {}
    return analyzeLoudness({ filePath, inPoint, duration, nativeBin })
  })

  /** 把 dataURL 图片落到当前项目 ai-generated/（无项目则 userData/cache），作透明水印等素材 */
  ipcMain.handle('desktop:save-media-asset', async (_e, payload = {}) => {
    return writeMediaAsset(String(payload?.name || `asset_${Date.now()}.png`), String(payload?.dataUrl || ''))
  })

  const douyin = require('./douyinPublish.cjs')
  ipcMain.handle('desktop:douyin-status', (_e, payload = {}) => douyin.status(payload?.root))
  ipcMain.handle('desktop:douyin-open-desk', (_e, payload = {}) => douyin.openDesk(payload?.root))
  ipcMain.handle('desktop:douyin-reveal-inbox', (_e, payload = {}) => douyin.revealInbox(payload?.root))
  ipcMain.handle('desktop:douyin-list-assets', (_e, payload = {}) => douyin.listAssets(payload?.root))
  ipcMain.handle('desktop:douyin-use-asset', (_e, payload = {}) => douyin.useAsset(payload?.slug, payload?.root))
  ipcMain.handle('desktop:douyin-stage-asset', (_e, payload = {}) => douyin.stageAsset(payload || {}))
  ipcMain.handle('desktop:douyin-attach-cover', (_e, payload = {}) => douyin.attachCover(payload || {}))
  ipcMain.handle('desktop:douyin-save-meta', (_e, payload = {}) => douyin.saveAssetMeta(payload || {}))
  ipcMain.handle('desktop:douyin-publish', async (_e, payload = {}) => {
    const body = payload || {}
    const action = String(body.action || 'phones')
    if (action === 'phones' || action === 'status' || action === 'restart-adb') {
      return douyin.listPhonesWithHint({
        ...body,
        action: 'phones',
        restartAdb: action === 'restart-adb' || !!body.restartAdb,
      })
    }
    return douyin.runPublish(body)
  })
  ipcMain.handle('desktop:pick-image', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '选择封面图（须生图自带大标题，禁止后期贴字）',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    })
    if (canceled || !filePaths[0]) return { ok: false, canceled: true }
    return { ok: true, path: filePaths[0], url: pathToFileURL(filePaths[0]).href }
  })
  ipcMain.handle('desktop:pick-video', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '选择成片视频',
      properties: ['openFile'],
      filters: [{ name: '视频', extensions: ['mp4', 'mov', 'webm'] }],
    })
    if (canceled || !filePaths[0]) return { ok: false, canceled: true }
    return { ok: true, path: filePaths[0], url: pathToFileURL(filePaths[0]).href }
  })

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

  /** B2 native preview host (popup); renderer drives via preview:* IPC */
  const ensurePreview = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return null
    if (!previewEngine) previewEngine = createPreviewEngine(mainWindow)
    return previewEngine
  }
  ipcMain.handle('preview:init', (_e, opts = {}) => {
    const pe = ensurePreview()
    if (!pe) return { ok: false, error: 'no_window' }
    if (pe.isRunning()) return { ok: true, already: true }
    return pe.start(opts || {})
  })
  ipcMain.handle('preview:stop', () => {
    if (previewEngine) previewEngine.stop()
    previewEngine = null
    return { ok: true }
  })
  ipcMain.handle('preview:rect', (_e, css) => {
    const pe = ensurePreview()
    if (!pe || !pe.isRunning()) return { ok: false }
    pe.syncRect(css)
    return { ok: true }
  })
  ipcMain.handle('preview:visible', (_e, on) => {
    const pe = ensurePreview()
    if (!pe || !pe.isRunning()) return { ok: false }
    pe.setVisible(!!on)
    return { ok: true }
  })
  ipcMain.handle('preview:suspend', (_e, reason) => {
    const pe = ensurePreview()
    if (!pe || !pe.isRunning()) return { ok: false }
    pe.suspend(reason)
    return { ok: true }
  })
  ipcMain.handle('preview:resume', () => {
    const pe = ensurePreview()
    if (!pe || !pe.isRunning()) return { ok: false }
    pe.resume()
    return { ok: true }
  })
  ipcMain.handle('preview:timeline', (_e, json) => {
    const pe = ensurePreview()
    if (!pe || !pe.isRunning()) return { ok: false }
    pe.send({ cmd: 'timeline', json: typeof json === 'string' ? json : JSON.stringify(json) })
    return { ok: true }
  })
  ipcMain.handle('preview:seek', (_e, frame) => {
    const pe = ensurePreview()
    if (!pe || !pe.isRunning()) return { ok: false }
    pe.send({ cmd: 'seek', frame: Number(frame) || 0 })
    return { ok: true }
  })
  ipcMain.handle('preview:play', () => {
    const pe = ensurePreview()
    if (!pe || !pe.isRunning()) return { ok: false }
    pe.send({ cmd: 'play' })
    return { ok: true }
  })
  ipcMain.handle('preview:pause', () => {
    const pe = ensurePreview()
    if (!pe || !pe.isRunning()) return { ok: false }
    pe.send({ cmd: 'pause' })
    return { ok: true }
  })
  ipcMain.handle('preview:stats', () => {
    const pe = ensurePreview()
    if (!pe || !pe.isRunning()) return { ok: false }
    pe.send({ cmd: 'stats' })
    return { ok: true }
  })

  // DEV spike S0.1 — only when TODO_SPIKE_CHILD=1 (do not enable in release)
  if (process.env.TODO_SPIKE_CHILD === '1') {
    const { startSpikeOverlay } = require('./spikeOverlay.cjs')
    const bootSpike = () => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      const run = () => {
        startSpikeOverlay(mainWindow, {
          mode: process.env.TODO_SPIKE_MODE || undefined,
        }).then((r) => console.log('[spike] result', r)).catch((e) => console.error('[spike]', e))
      }
      if (mainWindow.webContents.isLoading()) {
        mainWindow.webContents.once('did-finish-load', () => setTimeout(run, 800))
      } else {
        setTimeout(run, 800)
      }
    }
    bootSpike()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (previewEngine) {
    previewEngine.stop()
    previewEngine = null
  }
  stopAiServer()
})

app.on('will-quit', () => {
  if (previewEngine) {
    previewEngine.stop()
    previewEngine = null
  }
  stopAiServer()
})
