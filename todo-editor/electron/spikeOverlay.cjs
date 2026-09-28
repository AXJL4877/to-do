/**
 * DEV ONLY — S0.1 child/popup overlay spike.
 * Enable: set TODO_SPIKE_CHILD=1 before electron:dev
 * Modes: TODO_SPIKE_MODE=child|popup (default tries child then popup on fail)
 */
'use strict'

const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

function hwndToInt64(buf) {
  if (!buf || buf.length < 8) return 0n
  return buf.readBigInt64LE(0)
}

function findSpikeExe() {
  const candidates = [
    path.join(__dirname, '../native/bin/spike-child-window.exe'),
    path.join(process.resourcesPath || '', 'native/spike-child-window.exe'),
  ]
  return candidates.find((p) => p && fs.existsSync(p)) || ''
}

/**
 * @param {import('electron').BrowserWindow} win
 * @param {{ mode?: 'child'|'popup', preferSelector?: string }} opts
 */
async function startSpikeOverlay(win, opts = {}) {
  const exe = findSpikeExe()
  if (!exe) {
    console.error('[spike] missing spike-child-window.exe — build native/spikes first')
    return { ok: false, error: 'exe missing' }
  }
  if (!win || win.isDestroyed()) return { ok: false, error: 'no window' }

  const handle = win.getNativeWindowHandle()
  const hwnd = hwndToInt64(handle)
  const { screen } = require('electron')
  const disp = screen.getDisplayMatching(win.getBounds())
  const scale = disp.scaleFactor || 1
  console.log('[spike] Electron HWND=', hwnd.toString(), 'display.scaleFactor=', scale,
    'dpiAware note: Electron Chromium is typically Per-Monitor V2')

  const sel = opts.preferSelector
    || '[data-testid="program-viewport"], [data-testid="edit-viewport"], #program-canvas, #edit-canvas'
  const rect = await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      x: r.x, y: r.y, w: r.width, h: r.height,
      dpr: window.devicePixelRatio || 1,
      innerW: window.innerWidth, innerH: window.innerHeight,
    }
  })()`)
  if (!rect || rect.w < 8 || rect.h < 8) {
    console.error('[spike] preview rect missing', rect)
    return { ok: false, error: 'no rect', scale }
  }

  const content = win.getContentBounds() // DIP on Win+Electron
  const dpr = rect.dpr || scale
  // Child: coordinates are relative to parent HWND client (physical px when DPI-aware)
  const child = {
    x: Math.round(rect.x * dpr),
    y: Math.round(rect.y * dpr),
    w: Math.round(rect.w * dpr),
    h: Math.round(rect.h * dpr),
  }
  // Popup: screen physical px = (content DIP + css rect) * scaleFactor
  const popup = {
    x: Math.round((content.x + rect.x) * scale),
    y: Math.round((content.y + rect.y) * scale),
    w: Math.round(rect.w * scale),
    h: Math.round(rect.h * scale),
  }

  console.log('[spike] cssRect', rect, 'childPx', child, 'popupScreen', popup, 'contentBounds', content)

  const modeWant = (opts.mode || process.env.TODO_SPIKE_MODE || 'child').toLowerCase()
  const modes = modeWant === 'popup' ? ['popup'] : modeWant === 'child' ? ['child'] : ['child', 'popup']

  let proc = null
  let used = null
  for (const mode of modes) {
    const args = mode === 'child'
      ? ['child', hwnd.toString(), String(child.x), String(child.y), String(child.w), String(child.h)]
      : ['popup', hwnd.toString(), String(popup.x), String(popup.y), String(popup.w), String(popup.h)]
    console.log('[spike] spawn', exe, args.join(' '))
    const p = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: false })
    const line = await new Promise((resolve) => {
      let buf = ''
      const t = setTimeout(() => resolve(buf), 800)
      p.stdout.on('data', (d) => {
        buf += d.toString()
        if (buf.includes('\n')) {
          clearTimeout(t)
          resolve(buf)
        }
      })
      p.stderr.on('data', (d) => console.error('[spike:err]', d.toString()))
      p.on('exit', (code) => {
        console.error('[spike] exited early', code)
        resolve(buf)
      })
    })
    console.log('[spike] stdout', line.trim())
    if (line.includes('ok mode=')) {
      proc = p
      used = mode
      break
    }
    try { p.kill() } catch { /* */ }
  }
  if (!proc) return { ok: false, error: 'spawn failed', scale, rect, child, popup }

  const sync = () => {
    if (!proc || proc.killed || win.isDestroyed()) return
    win.webContents.executeJavaScript(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)})
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height, dpr: window.devicePixelRatio || 1 }
    })()`).then((r) => {
      if (!r || !proc || proc.killed) return
      const c = win.getContentBounds()
      const sf = screen.getDisplayMatching(win.getBounds()).scaleFactor || 1
      let line
      if (used === 'child') {
        const dpr = r.dpr || sf
        line = `pos ${Math.round(r.x * dpr)} ${Math.round(r.y * dpr)} ${Math.round(r.w * dpr)} ${Math.round(r.h * dpr)}\n`
      } else {
        line = `pos ${Math.round((c.x + r.x) * sf)} ${Math.round((c.y + r.y) * sf)} ${Math.round(r.w * sf)} ${Math.round(r.h * sf)}\n`
      }
      try { proc.stdin.write(line) } catch { /* */ }
    }).catch(() => {})
  }

  const onMove = () => sync()
  win.on('move', onMove)
  win.on('resize', onMove)
  win.on('maximize', onMove)
  win.on('unmaximize', onMove)
  win.on('restore', onMove)
  win.on('minimize', () => {
    if (used === 'popup' && proc && !proc.killed) {
      try { proc.stdin.write('pos -32000 -32000 1 1\n') } catch { /* */ }
    }
  })
  const iv = setInterval(sync, 500)
  win.on('closed', () => {
    clearInterval(iv)
    try { proc.stdin.write('quit\n') } catch { /* */ }
    try { proc.kill() } catch { /* */ }
  })

  // evidence screenshot (may NOT show child HWND — Chromium capture is compositor-only)
  const shotDir = path.join(__dirname, '../native/spikes/out')
  try { fs.mkdirSync(shotDir, { recursive: true }) } catch { /* */ }
  setTimeout(async () => {
    try {
      const img = await win.webContents.capturePage()
      const png = path.join(shotDir, `electron-capture-${used}.png`)
      fs.writeFileSync(png, img.toPNG())
      console.log('[spike] capturePage saved', png, '(note: may omit native child HWND)')
    } catch (e) {
      console.error('[spike] capturePage', e)
    }
  }, 1200)

  return {
    ok: true,
    mode: used,
    hwnd: hwnd.toString(),
    scale,
    rect,
    child,
    popup,
    electronDpiNote: 'Electron/Chromium on Windows uses per-monitor DPI awareness (V2 in recent builds); scaleFactor from screen.getDisplayMatching',
  }
}

module.exports = { startSpikeOverlay, hwndToInt64 }
