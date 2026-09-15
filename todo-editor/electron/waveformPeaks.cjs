/**
 * ffmpeg 抽 mono PCM → 峰值（与播放器同源音轨，避免 decodeAudioData 半截静音）
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
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

/**
 * @param {{ filePath: string, bins?: number, nativeBin?: string, timeoutMs?: number }} opts
 * @returns {Promise<{ ok: boolean, peaks?: number[], duration?: number, error?: string }>}
 */
function extractWaveformPeaks(opts) {
  const filePath = opts.filePath
  const bins = Math.max(64, Math.min(4096, Math.floor(opts.bins || 1024)))
  const timeoutMs = opts.timeoutMs || 60000
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    return Promise.resolve({ ok: false, error: 'invalid path' })
  }
  try {
    if (!fs.statSync(filePath).isFile()) return Promise.resolve({ ok: false, error: 'not a file' })
  } catch {
    return Promise.resolve({ ok: false, error: 'not a file' })
  }

  const ffmpeg = resolveFfmpeg(opts.nativeBin)
  const sr = 8000
  const args = [
    '-v', 'error',
    '-i', filePath,
    '-vn',
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
      child = spawn(ffmpeg, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
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
        error: /ENOENT/i.test(String(err.message))
          ? '找不到 ffmpeg'
          : (err.message || 'ffmpeg 启动失败'),
      })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0 && chunks.length === 0) {
        finish({ ok: false, error: (stderr || `ffmpeg 退出码 ${code}`).trim().slice(0, 300) })
        return
      }
      const buf = Buffer.concat(chunks)
      const sampleCount = Math.floor(buf.length / 4)
      if (sampleCount < 8) {
        finish({ ok: false, error: 'no audio samples' })
        return
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
      finish({ ok: true, peaks, duration })
    })
  })
}

module.exports = { extractWaveformPeaks, resolveFfmpeg }
