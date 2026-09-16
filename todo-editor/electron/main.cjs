const { app, BrowserWindow, shell, ipcMain, dialog, screen, Menu } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const { pathToFileURL } = require('url')
const { createMediaProbe } = require('./mediaProbe.cjs')
const { exportSequence } = require('./exportSequence.cjs')
const { createNativePlayer, rgb24ToBmpDataUrl } = require('./nativePlayer.cjs')
const { makeProxy } = require('./makeProxy.cjs')

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
/** @type {import('child_process').ChildProcess | null} */
let aiServerProc = null
/** @type {string} */
let aiBaseUrl = ''

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
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    mainWindow = null
    if (timelineWindow && !timelineWindow.isDestroyed()) timelineWindow.close()
    if (aiWindow && !aiWindow.isDestroyed()) aiWindow.close()
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
    height: 420,
    minWidth: 720,
    minHeight: 240,
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
        onProgress: (progress) => {
          if (!sender.isDestroyed()) {
            sender.send('desktop:export-progress', { jobId, progress, status: 'running' })
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
  ipcMain.handle('desktop:timeline-window-alive', () => ({ ok: timelineWindowAlive() }))
  ipcMain.handle('desktop:open-ai-window', async () => openAiWindow())
  ipcMain.handle('desktop:close-ai-window', () => closeAiWindow())

  const { extractWaveformPeaks, extractWaveformPeaksFromBuffer } = require('./waveformPeaks.cjs')
  ipcMain.handle('desktop:waveform-peaks', async (_e, payload = {}) => {
    const { filePath, bins } = payload || {}
    return extractWaveformPeaks({ filePath, bins, nativeBin })
  })
  ipcMain.handle('desktop:waveform-peaks-buffer', async (_e, payload = {}) => {
    const { data, bins, ext } = payload || {}
    return extractWaveformPeaksFromBuffer({ data, bins, ext, nativeBin })
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
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  stopAiServer()
})

app.on('will-quit', () => {
  stopAiServer()
})
