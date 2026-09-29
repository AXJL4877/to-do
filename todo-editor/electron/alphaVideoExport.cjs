'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

const CACHE_DIR = path.join(os.tmpdir(), 'todo-alpha-mov')

function run(ffmpeg, args) {
  return new Promise((resolve) => {
    let stderr = ''
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-8000) })
    child.on('error', (e) => resolve({ code: -1, stderr: e.message }))
    child.on('close', (code) => resolve({ code, stderr }))
  })
}

/**
 * 导出引擎用 FFmpeg 自带的 vp9 解码器，读不到 WebM 的透明层（会变黑底）。
 * 视频轨上带 alpha 的 WebM 先用 libvpx-vp9 解码转成 qtrle/argb 的 MOV（和花字导出同一种中间格式），按文件缓存复用。
 */
async function prepareAlphaVideos(sequence, { ffmpeg, onProgress }) {
  if (sequence.audioOnly) return sequence
  const videoTracks = new Set((sequence.tracks || []).filter((t) => t.kind === 'video').map((t) => t.id))
  const clips = (sequence.clips || []).filter((c) => c.enabled !== false && videoTracks.has(c.trackId)
    && typeof c.mediaPath === 'string' && /\.webm$/i.test(c.mediaPath) && fs.existsSync(c.mediaPath))
  const paths = [...new Set(clips.map((c) => c.mediaPath))]
  if (!paths.length) return sequence
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  const swap = new Map()
  for (let i = 0; i < paths.length; i++) {
    const src = paths[i]
    const st = fs.statSync(src)
    const key = crypto.createHash('sha1').update(`${path.normalize(src)}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16)
    const out = path.join(CACHE_DIR, `${key}.mov`)
    if (fs.existsSync(out) && fs.statSync(out).size > 1024) {
      swap.set(src, out)
      continue
    }
    const probe = await run(ffmpeg, ['-hide_banner', '-i', src])
    if (!/alpha_mode\s*:\s*1/i.test(probe.stderr)) continue
    const tmp = `${out}.partial.mov`
    const r = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-c:v', 'libvpx-vp9', '-i', src, '-an', '-c:v', 'qtrle', '-pix_fmt', 'argb', tmp])
    if (r.code !== 0) throw new Error(`透明视频转码失败：${path.basename(src)} ${r.stderr.trim().slice(-300)}`)
    fs.renameSync(tmp, out)
    swap.set(src, out)
    onProgress?.(Math.round(((i + 1) / paths.length) * 10))
  }
  if (!swap.size) return sequence
  return {
    ...sequence,
    clips: sequence.clips.map((c) => (videoTracks.has(c.trackId) && swap.has(c.mediaPath) ? { ...c, mediaPath: swap.get(c.mediaPath) } : c)),
  }
}

module.exports = { prepareAlphaVideos }
