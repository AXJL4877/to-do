/**
 * 用 ffmpeg ebur128 量一段媒体的综合响度（LUFS），给一键调音算增益。
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

/** @returns {number | null} */
function parseIntegratedLufs(stderr) {
  // ebur128 Summary 末尾：I:         -16.2 LUFS
  const m = String(stderr).match(/Integrated loudness:[\s\S]*?\bI:\s*(-?[\d.]+)\s*LUFS/i)
    || String(stderr).match(/\bI:\s*(-?[\d.]+)\s*LUFS/i)
  if (!m) return null
  const v = Number(m[1])
  return Number.isFinite(v) ? v : null
}

/**
 * @param {{ filePath: string, inPoint?: number, duration?: number, nativeBin?: string, timeoutMs?: number }} opts
 */
function analyzeLoudness(opts) {
  const filePath = String(opts.filePath || '')
  const inPoint = Math.max(0, Number(opts.inPoint) || 0)
  const duration = Math.max(0.05, Number(opts.duration) || 0)
  const timeoutMs = Math.max(5000, Number(opts.timeoutMs) || 60000)
  if (!filePath || !fs.existsSync(filePath)) {
    return Promise.resolve({ ok: false, error: '找不到媒体文件' })
  }

  const ffmpeg = resolveFfmpeg(opts.nativeBin)
  const args = [
    '-hide_banner',
    '-nostdin',
    '-i', filePath,
    '-ss', String(inPoint),
    '-t', String(duration),
    '-vn',
    '-sn',
    '-dn',
    '-map', '0:a:0?',
    '-af', 'ebur128=peak=true',
    '-f', 'null',
    '-',
  ]

  return new Promise((resolve) => {
    let stderr = ''
    let settled = false
    const finish = (r) => {
      if (settled) return
      settled = true
      resolve(r)
    }

    let child
    try {
      child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (e) {
      finish({ ok: false, error: e.message || '无法启动 ffmpeg' })
      return
    }

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* */ }
      finish({ ok: false, error: '响度分析超时' })
    }, timeoutMs)

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-12000) })
    child.on('error', (err) => {
      clearTimeout(timer)
      finish({
        ok: false,
        error: /ENOENT/i.test(String(err.message)) ? '找不到 ffmpeg' : (err.message || 'ffmpeg 启动失败'),
      })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const lufs = parseIntegratedLufs(stderr)
      if (lufs == null) {
        finish({
          ok: false,
          error: code === 0
            ? '这段没有可测的声音（太静或无音轨）'
            : (stderr.trim().slice(-300) || `ffmpeg 退出码 ${code}`),
        })
        return
      }
      finish({ ok: true, lufs })
    })
  })
}

module.exports = { analyzeLoudness, parseIntegratedLufs }
