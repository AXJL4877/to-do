/**
 * Low-res H.264 proxy via local ffmpeg → userData/cache/proxies/
 * ponytail: scale-to-max-height only; no audio in proxy; reuse exportSequence resolveFfmpeg.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { resolveFfmpeg, usablePath } = require('./exportSequence.cjs')

/**
 * @param {{
 *   filePath: string
 *   outDir: string
 *   height?: 480 | 720
 *   nativeBin?: string
 *   timeoutMs?: number
 * }} opts
 * @returns {Promise<{ ok: boolean, proxyPath?: string, cached?: boolean, height?: number, error?: string, ffmpeg?: string }>}
 */
function makeProxy(opts = {}) {
  const filePath = opts.filePath
  const outDir = opts.outDir
  const height = opts.height === 480 ? 480 : 720
  const timeoutMs = Math.max(5000, opts.timeoutMs || 120000)

  if (!usablePath(filePath)) {
    return Promise.resolve({ ok: false, error: 'invalid media path' })
  }
  if (typeof outDir !== 'string' || !outDir) {
    return Promise.resolve({ ok: false, error: 'invalid outDir' })
  }

  try {
    fs.mkdirSync(outDir, { recursive: true })
  } catch (e) {
    return Promise.resolve({ ok: false, error: e.message || 'mkdir failed' })
  }

  const hash = crypto.createHash('sha1').update(path.normalize(filePath)).digest('hex').slice(0, 16)
  const proxyPath = path.join(outDir, `${hash}_${height}p.mp4`)
  if (fs.existsSync(proxyPath) && fs.statSync(proxyPath).size > 1024) {
    return Promise.resolve({ ok: true, proxyPath, cached: true, height })
  }

  const ffmpeg = resolveFfmpeg(opts.nativeBin)
  const tmp = `${proxyPath}.partial.mp4`
  try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch { /* */ }

  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', filePath,
    '-vf', `scale=-2:'min(${height},ih)'`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
    '-an',
    '-movflags', '+faststart',
    tmp,
  ]

  return new Promise((resolve) => {
    let stderr = ''
    let settled = false
    const finish = (r) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }

    /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */
    let child
    try {
      child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (e) {
      finish({ ok: false, error: e.message || '无法启动 ffmpeg', ffmpeg })
      return
    }

    const timer = setTimeout(() => {
      try { child.kill() } catch { /* */ }
      finish({ ok: false, error: 'proxy timeout', ffmpeg })
    }, timeoutMs)

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c) => { stderr += c })
    child.on('error', (err) => {
      const missing = err.code === 'ENOENT'
      finish({
        ok: false,
        ffmpeg,
        error: missing
          ? '找不到 ffmpeg（PATH / WinGet Links / native/bin / FFMPEG）'
          : (err.message || 'ffmpeg 启动失败'),
      })
    })
    child.on('close', (code) => {
      try {
        if (code === 0 && fs.existsSync(tmp) && fs.statSync(tmp).size > 1024) {
          try { if (fs.existsSync(proxyPath)) fs.unlinkSync(proxyPath) } catch { /* */ }
          fs.renameSync(tmp, proxyPath)
          if (fs.existsSync(proxyPath)) {
            finish({ ok: true, proxyPath, cached: false, height, ffmpeg })
            return
          }
        }
      } catch (e) {
        finish({ ok: false, error: e.message || 'proxy rename failed', ffmpeg })
        return
      }
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch { /* */ }
      finish({
        ok: false,
        ffmpeg,
        error: (stderr || `ffmpeg 退出码 ${code}`).trim().slice(0, 500),
      })
    })
  })
}

module.exports = { makeProxy }
