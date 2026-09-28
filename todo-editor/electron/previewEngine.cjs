/**
 * B2: spawn/manage todo-preview-engine.exe — JSON-line protocol v1.
 * Job Object via todo-job-bind.exe (KILL_ON_JOB_CLOSE); parent-PID watch as backup.
 */
'use strict'

const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const { screen } = require('electron')

function findExe(name) {
  const candidates = [
    path.join(__dirname, '../native/bin', name),
    path.join(process.resourcesPath || '', 'native', name),
  ]
  return candidates.find((p) => p && fs.existsSync(p)) || ''
}

function hwndToInt64(buf) {
  if (!buf || buf.length < 8) return 0n
  return buf.readBigInt64LE(0)
}

/**
 * @param {import('electron').BrowserWindow} win
 */
function createPreviewEngine(win) {
  let child = null
  let jobBind = null
  let buf = ''
  let nextId = 1
  let lastCss = null
  let crashed = false
  /** @type {((ev: object) => void) | null} */
  let onEvent = null
  /** @type {(() => void) | null} */
  let onCrashed = null
  const writeQ = []
  let writing = false

  const enginePath = findExe('todo-preview-engine.exe')
  const jobBindPath = findExe('todo-job-bind.exe')

  function flushWrite() {
    if (writing || !child || !child.stdin || child.stdin.destroyed) return
    const line = writeQ.shift()
    if (line == null) return
    writing = true
    child.stdin.write(line, 'utf8', () => {
      writing = false
      flushWrite()
    })
  }

  function send(obj) {
    if (!child || child.killed) return -1
    const id = obj.id != null ? obj.id : nextId++
    const payload = { ...obj, id }
    writeQ.push(`${JSON.stringify(payload)}\n`)
    flushWrite()
    return id
  }

  function syncRect(cssRectDIP) {
    if (!win || win.isDestroyed()) return
    if (cssRectDIP) lastCss = cssRectDIP
    if (!lastCss || lastCss.w < 1 || lastCss.h < 1) return
    const content = win.getContentBounds()
    const rectDIP = {
      x: content.x + lastCss.x,
      y: content.y + lastCss.y,
      width: lastCss.w,
      height: lastCss.h,
    }
    const phys = screen.dipToScreenRect(win, rectDIP)
    send({
      cmd: 'rect',
      x: Math.round(phys.x),
      y: Math.round(phys.y),
      w: Math.max(1, Math.round(phys.width)),
      h: Math.max(1, Math.round(phys.height)),
    })
  }

  function setVisible(on) {
    send({ cmd: 'visible', on: !!on })
    if (on) syncRect()
  }

  function attachWindowEvents() {
    const refresh = () => {
      if (win.isDestroyed()) return
      if (win.isMinimized() || !win.isVisible()) {
        setVisible(false)
        return
      }
      setVisible(true)
      syncRect()
    }
    const events = [
      'move', 'resize', 'maximize', 'unmaximize', 'minimize', 'restore',
      'hide', 'show', 'enter-full-screen', 'leave-full-screen',
    ]
    for (const e of events) win.on(e, refresh)
    const onDisplay = () => refresh()
    screen.on('display-metrics-changed', onDisplay)
    return () => {
      for (const e of events) win.removeListener(e, refresh)
      screen.removeListener('display-metrics-changed', onDisplay)
    }
  }

  let detachEvents = null

  function start(opts = {}) {
    if (child) return { ok: false, error: 'already_started' }
    if (!enginePath) return { ok: false, error: 'engine_missing' }
    if (!win || win.isDestroyed()) return { ok: false, error: 'no_window' }

    crashed = false
    const hwnd = hwndToInt64(win.getNativeWindowHandle())
    child = spawn(enginePath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        TODO_PARENT_PID: String(process.pid),
      },
      cwd: path.dirname(enginePath),
    })

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        if (!line) continue
        try {
          const ev = JSON.parse(line)
          if (onEvent) onEvent(ev)
          if (win && !win.isDestroyed()) {
            win.webContents.send('preview:event', ev)
          }
        } catch {
          console.error('[preview] bad stdout', line.slice(0, 200))
        }
      }
    })
    child.stderr.on('data', (d) => {
      console.error('[preview:err]', String(d).trim())
    })
    child.on('exit', (code, signal) => {
      const abnormal = code !== 0 && code != null
      child = null
      if (jobBind) {
        try { jobBind.stdin.end() } catch { /* */ }
        try { jobBind.kill() } catch { /* */ }
        jobBind = null
      }
      if (!crashed && (abnormal || signal)) {
        crashed = true
        if (onCrashed) onCrashed()
        if (win && !win.isDestroyed()) {
          win.webContents.send('preview:crashed', { code, signal })
        }
      }
    })

    if (jobBindPath && child.pid) {
      jobBind = spawn(jobBindPath, [String(child.pid)], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      jobBind.stdout.on('data', () => {})
      jobBind.stderr.on('data', (d) => console.error('[job-bind]', String(d).trim()))
      jobBind.on('exit', () => { jobBind = null })
    }

    detachEvents = attachWindowEvents()

    send({
      cmd: 'init',
      hwnd: Number(hwnd),
      fps: opts.fps || 30,
      budgetMB: opts.budgetMB || 512,
      adapterLuid: opts.adapterLuid ?? null,
    })
    return { ok: true, pid: child.pid, hwnd: hwnd.toString(), jobBind: !!jobBind }
  }

  function stop() {
    if (detachEvents) { detachEvents(); detachEvents = null }
    if (child) {
      try { send({ cmd: 'quit' }) } catch { /* */ }
      try { child.stdin.end() } catch { /* */ }
      setTimeout(() => {
        if (child) {
          try { child.kill() } catch { /* */ }
        }
      }, 800)
    }
    if (jobBind) {
      try { jobBind.stdin.end() } catch { /* */ }
    }
  }

  return {
    start,
    stop,
    send,
    syncRect,
    setVisible,
    suspend: (reason) => send({ cmd: 'suspend', reason: reason || 'menu' }),
    resume: () => send({ cmd: 'resume' }),
    setOnEvent: (fn) => { onEvent = fn },
    setOnCrashed: (fn) => { onCrashed = fn },
    isRunning: () => !!child && !child.killed,
    enginePath,
  }
}

module.exports = { createPreviewEngine, findExe, hwndToInt64 }
