'use strict'

const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

/**
 * Spawn todo-media-engine play-session and speak the line/binary protocol.
 * @param {{ enginePath: string, timeoutMs?: number }} opts
 */
function createNativePlayer(opts = {}) {
  const enginePath = opts.enginePath
  const defaultTimeout = Math.max(500, opts.timeoutMs || 8000)
  /** @type {import('node:child_process').ChildProcessWithoutNullStreams | null} */
  let child = null
  /** @type {Buffer} */
  let buf = Buffer.alloc(0)
  /** @type {{ resolve: (v: any) => void, reject: (e: Error) => void, kind: string, timer: NodeJS.Timeout } | null} */
  let pending = null
  let openPath = ''

  function killChild() {
    if (!child) return
    const c = child
    child = null
    openPath = ''
    buf = Buffer.alloc(0)
    try {
      c.stdout?.removeAllListeners()
      c.stderr?.removeAllListeners()
      c.removeAllListeners()
      c.kill()
    } catch { /* */ }
  }

  function failPending(err) {
    if (!pending) return
    clearTimeout(pending.timer)
    const p = pending
    pending = null
    p.reject(err instanceof Error ? err : new Error(String(err)))
  }

  function settleOk(value) {
    if (!pending) return
    clearTimeout(pending.timer)
    const p = pending
    pending = null
    p.resolve(value)
  }

  function ensureChild() {
    if (child && !child.killed) return
    if (!enginePath || !fs.existsSync(enginePath)) {
      throw new Error('engine missing')
    }
    const binDir = path.dirname(enginePath)
    const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` }
    child = spawn(enginePath, ['play-session', String(Math.min(30000, Math.max(100, defaultTimeout)))], {
      windowsHide: true,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    buf = Buffer.alloc(0)
    child.stdout.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      drain()
    })
    child.stderr.on('data', () => { /* ignore ffmpeg noise */ })
    child.on('exit', () => {
      child = null
      openPath = ''
      failPending(new Error('play-session exited'))
    })
    child.on('error', (e) => {
      child = null
      openPath = ''
      failPending(e)
    })
  }

  function drain() {
    if (!pending) return
    if (pending.kind === 'line' || pending.kind === 'frame-header') {
      const nl = buf.indexOf(0x0a)
      if (nl < 0) return
      const line = buf.subarray(0, nl).toString('utf8').replace(/\r$/, '')
      buf = buf.subarray(nl + 1)
      if (pending.kind === 'line') {
        settleOk(line)
        return
      }
      // FRAME w h pts nbytes
      if (line.startsWith('ERR ')) {
        settleOk({ ok: false, error: line.slice(4).trim() })
        return
      }
      if (line === 'EOF') {
        settleOk({ ok: false, eof: true })
        return
      }
      const m = /^FRAME\s+(\d+)\s+(\d+)\s+([0-9.eE+-]+)\s+(\d+)\s*$/.exec(line)
      if (!m) {
        settleOk({ ok: false, error: `bad header: ${line}` })
        return
      }
      const w = Number(m[1])
      const h = Number(m[2])
      const pts = Number(m[3])
      const nbytes = Number(m[4])
      pending.kind = 'frame-body'
      pending.meta = { w, h, pts, nbytes }
      drain()
      return
    }
    if (pending.kind === 'frame-body') {
      const { w, h, pts, nbytes } = pending.meta
      if (buf.length < nbytes) return
      const rgb = Buffer.from(buf.subarray(0, nbytes))
      buf = buf.subarray(nbytes)
      settleOk({ ok: true, w, h, pts, rgb })
    }
  }

  function request(kind, cmd, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (pending) {
        reject(new Error('busy'))
        return
      }
      try {
        ensureChild()
      } catch (e) {
        reject(e)
        return
      }
      const wall = timeoutMs || defaultTimeout
      const timer = setTimeout(() => {
        if (!pending) return
        pending = null
        killChild()
        reject(new Error('timeout'))
      }, wall)
      pending = { resolve, reject, kind, timer, meta: null }
      try {
        child.stdin.write(cmd.endsWith('\n') ? cmd : `${cmd}\n`, 'utf8')
      } catch (e) {
        clearTimeout(timer)
        pending = null
        killChild()
        reject(e)
      }
    })
  }

  async function open(filePath, timeoutMs) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      return { ok: false, error: 'invalid path' }
    }
    if (!fs.existsSync(filePath)) return { ok: false, error: 'missing file' }
    try {
      // Fresh process per open avoids stale demux state after hard kill.
      killChild()
      const line = await request('line', `OPEN ${filePath}`, timeoutMs)
      if (line === 'OK') {
        openPath = filePath
        return { ok: true }
      }
      if (line.startsWith('ERR ')) return { ok: false, error: line.slice(4).trim() }
      return { ok: false, error: line || 'open failed' }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }

  async function seek(timeSec, timeoutMs) {
    const t = Number(timeSec)
    if (!Number.isFinite(t) || t < 0) return { ok: false, error: 'invalid time' }
    try {
      if (!child) return { ok: false, error: 'not open' }
      const line = await request('line', `SEEK ${t}`, timeoutMs)
      if (line === 'OK') return { ok: true }
      if (line.startsWith('ERR ')) return { ok: false, error: line.slice(4).trim() }
      return { ok: false, error: line || 'seek failed' }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }

  async function read(timeoutMs) {
    try {
      if (!child) return { ok: false, error: 'not open' }
      return await request('frame-header', 'READ', timeoutMs)
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }

  /** PCM/waveOut media clock (seconds); null if no audio yet. */
  async function audioClock(timeoutMs) {
    try {
      if (!child) return { ok: false, error: 'not open' }
      const line = await request('line', 'AUDIO_CLOCK', timeoutMs)
      if (line === 'AUDIO_CLOCK none') return { ok: true, sec: null }
      const m = /^AUDIO_CLOCK\s+([0-9.eE+-]+)\s*$/.exec(line)
      if (m) return { ok: true, sec: Number(m[1]) }
      if (line.startsWith('ERR ')) return { ok: false, error: line.slice(4).trim() }
      return { ok: false, error: line || 'audio clock failed' }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }

  async function close() {
    try {
      if (child) {
        try {
          await request('line', 'QUIT', 2000)
        } catch { /* */ }
      }
    } finally {
      killChild()
    }
    return { ok: true }
  }

  return {
    open,
    seek,
    read,
    audioClock,
    close,
    get path() { return openPath },
  }
}

/** RGB24 → bottom-up BGR BMP base64 (no file I/O). */
function rgb24ToBmpDataUrl(w, h, rgb) {
  const row = (w * 3 + 3) & ~3
  const pixelBytes = row * h
  const fileSize = 54 + pixelBytes
  const out = Buffer.alloc(fileSize)
  out[0] = 0x42; out[1] = 0x4d
  out.writeUInt32LE(fileSize, 2)
  out.writeUInt32LE(54, 10)
  out.writeUInt32LE(40, 14)
  out.writeInt32LE(w, 18)
  out.writeInt32LE(h, 22)
  out.writeUInt16LE(1, 26)
  out.writeUInt16LE(24, 28)
  let o = 54
  for (let y = h - 1; y >= 0; --y) {
    const src = y * w * 3
    for (let x = 0; x < w; ++x) {
      const i = src + x * 3
      out[o++] = rgb[i + 2]
      out[o++] = rgb[i + 1]
      out[o++] = rgb[i]
    }
    o += row - w * 3
  }
  return `data:image/bmp;base64,${out.toString('base64')}`
}

module.exports = { createNativePlayer, rgb24ToBmpDataUrl }
