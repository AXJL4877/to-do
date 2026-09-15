/**
 * ffmpeg 抽 mono PCM → 峰值
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function resolveFfmpeg(nativeBin) {
  const candidates = [
    process.env.FFMPEG,
    nativeBin && path.join(nativeBin, 'ffmpeg.exe'),
    nativeBin && path.join(nativeBin, 'ffmpeg'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft/WinGet/Links/ffmpeg.exe'),
    'ffmpeg',
  ].filter(Boolean)
  for (const c of candidates) {
    if (c === 'ffmpeg') return c
    try {
      if (fs.existsSync(c)) return c
    } catch { /* */ }
  }
  return 'ffmpeg'
}

function extractFromPath(filePath, bins, nativeBin, timeoutMs) {
  const ffmpeg = resolveFfmpeg(nativeBin)
  const sr = 12000
  const args = [
    '-hide_banner',
    '-nostdin',
    '-v', 'error',
    '-i', filePath,
    '-vn',
    '-sn',
    '-dn',
    '-map', '0:a:0',
    '-ac', '1',
    '-ar', String(sr),
    '-f', 'f32le',
    'pipe:1',
  ]

  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const chunks = []
    let stderr = ''
    let settled = false
    const finish = (r) => {
      if (settled) return
      settled = true
      resolve(r)
    }

    let child
    try {
      child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      finish({ ok: false, error: e.message || '无法启动 ffmpeg' })
      return
    }

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* */ }
      finish({ ok: false, error: 'waveform timeout' })
    }, timeoutMs)

    child.stdout.on('data', (d) => { chunks.push(d) })
    child.stderr.on('data', (d) => { stderr += String(d) })
    child.on('error', (err) => {
      clearTimeout(timer)
      finish({
        ok: false,
        error: /ENOENT/i.test(String(err.message)) ? '找不到 ffmpeg' : (err.message || 'ffmpeg 启动失败'),
      })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      // -map 0:a:0 失败时再试不带 map
      if ((code !== 0 || chunks.length === 0) && args.includes('0:a:0')) {
        const fallback = args.filter((a) => a !== '-map' && a !== '0:a:0')
        extractFromPathWithArgs(filePath, bins, nativeBin, timeoutMs, fallback).then(finish)
        return
      }
      if (code !== 0 && chunks.length === 0) {
        finish({ ok: false, error: (stderr || `ffmpeg 退出码 ${code}`).trim().slice(0, 300) })
        return
      }
      finish(peaksFromPcm(Buffer.concat(chunks), sr, bins, stderr))
    })
  })
}

function extractFromPathWithArgs(filePath, bins, nativeBin, timeoutMs, args) {
  const ffmpeg = resolveFfmpeg(nativeBin)
  const sr = 12000
  return new Promise((resolve) => {
    const chunks = []
    let stderr = ''
    let settled = false
    const finish = (r) => { if (!settled) { settled = true; resolve(r) } }
    let child
    try {
      child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      finish({ ok: false, error: e.message || '无法启动 ffmpeg' })
      return
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* */ }
      finish({ ok: false, error: 'waveform timeout' })
    }, timeoutMs)
    child.stdout.on('data', (d) => { chunks.push(d) })
    child.stderr.on('data', (d) => { stderr += String(d) })
    child.on('error', (err) => {
      clearTimeout(timer)
      finish({ ok: false, error: err.message || 'ffmpeg 启动失败' })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0 && chunks.length === 0) {
        finish({ ok: false, error: (stderr || `ffmpeg 退出码 ${code}`).trim().slice(0, 300) })
        return
      }
      finish(peaksFromPcm(Buffer.concat(chunks), sr, bins, stderr))
    })
  })
}

function peaksFromPcm(buf, sr, bins, stderr) {
  const sampleCount = Math.floor(buf.length / 4)
  if (sampleCount < 8) {
    return { ok: false, error: (stderr || 'no audio samples').trim().slice(0, 300) }
  }
  const duration = sampleCount / sr
  const peaks = new Array(bins).fill(0)
  for (let i = 0; i < bins; i++) {
    const start = Math.floor((i / bins) * sampleCount)
    const end = Math.max(start + 1, Math.floor(((i + 1) / bins) * sampleCount))
    let peak = 0
    for (let j = start; j < end; j++) {
      const v = Math.abs(buf.readFloatLE(j * 4))
      if (v > peak) peak = v
    }
    peaks[i] = peak
  }
  return { ok: true, peaks, duration }
}

/**
 * @param {{ filePath: string, bins?: number, nativeBin?: string, timeoutMs?: number }} opts
 */
function extractWaveformPeaks(opts) {
  const filePath = opts.filePath
  const bins = Math.max(64, Math.min(4096, Math.floor(opts.bins || 1536)))
  const timeoutMs = opts.timeoutMs || 90000
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    return Promise.resolve({ ok: false, error: 'invalid path' })
  }
  try {
    if (!fs.statSync(filePath).isFile()) return Promise.resolve({ ok: false, error: 'not a file' })
  } catch {
    return Promise.resolve({ ok: false, error: 'not a file' })
  }
  return extractFromPath(filePath, bins, opts.nativeBin, timeoutMs)
}

/**
 * 浏览器 blob / 无 path：把字节落临时文件再抽峰值
 * @param {{ data: ArrayBuffer|Buffer|Uint8Array, ext?: string, bins?: number, nativeBin?: string, timeoutMs?: number }} opts
 */
async function extractWaveformPeaksFromBuffer(opts) {
  const bins = Math.max(64, Math.min(4096, Math.floor(opts.bins || 1536)))
  const timeoutMs = opts.timeoutMs || 90000
  const ext = (opts.ext || 'mp4').replace(/[^\w]/g, '') || 'mp4'
  const tmp = path.join(os.tmpdir(), `todo-wf-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`)
  try {
    const body = Buffer.isBuffer(opts.data) ? opts.data : Buffer.from(opts.data)
    fs.writeFileSync(tmp, body)
    return await extractFromPath(tmp, bins, opts.nativeBin, timeoutMs)
  } catch (e) {
    return { ok: false, error: e.message || 'temp write failed' }
  } finally {
    try { fs.unlinkSync(tmp) } catch { /* */ }
  }
}

module.exports = { extractWaveformPeaks, extractWaveformPeaksFromBuffer, resolveFfmpeg }
