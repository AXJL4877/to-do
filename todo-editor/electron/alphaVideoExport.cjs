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
  const inRange = (c) => !sequence.rangeOnly
    || (c.start < Number(sequence.workOut) && c.start + c.duration > Number(sequence.workIn))
  const clips = (sequence.clips || []).filter((c) => c.enabled !== false && videoTracks.has(c.trackId) && inRange(c)
    && typeof c.mediaPath === 'string' && /\.webm$/i.test(c.mediaPath) && fs.existsSync(c.mediaPath))
  const paths = [...new Set(clips.map((c) => c.mediaPath))]
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
    onProgress?.(1 + (i / paths.length) * 9, `透明素材转码 ${i + 1}/${paths.length}`)
    const probe = await run(ffmpeg, ['-hide_banner', '-i', src])
    if (!/alpha_mode\s*:\s*1/i.test(probe.stderr)) continue
    const tmp = `${out}.partial.mov`
    const r = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-c:v', 'libvpx-vp9', '-i', src, '-an', '-c:v', 'qtrle', '-pix_fmt', 'argb', tmp])
    if (r.code !== 0) throw new Error(`透明视频转码失败：${path.basename(src)} ${r.stderr.trim().slice(-300)}`)
    fs.renameSync(tmp, out)
    swap.set(src, out)
  }
  const holds = await matchHoldStills(sequence, { ffmpeg, videoTracks, inRange, swap })
  if (!swap.size && !holds.size) return sequence
  return {
    ...sequence,
    clips: sequence.clips.map((c) => {
      if (!videoTracks.has(c.trackId)) return c
      const to = swap.get(c.mediaPath) || holds.get(c.mediaPath)
      return to ? { ...c, mediaPath: to } : c
    }),
  }
}

/**
 * 黑板书写的定格图 xxx_hold.png 是无损原图，前面的 xxx.webm 却是 yuv420 有损编码，
 * 视频切到定格图那一帧颜色 / 纹理会跳一下。导出时改用视频真正的最后一帧当定格图；
 * 取帧必须来自引擎实际读的那份（转码后的 MOV），换条解码路径颜色又会差一点。
 */
async function matchHoldStills(sequence, { ffmpeg, videoTracks, inRange, swap }) {
  const holds = new Map()
  const stills = [...new Set((sequence.clips || [])
    .filter((c) => c.enabled !== false && videoTracks.has(c.trackId) && inRange(c)
      && typeof c.mediaPath === 'string' && /_hold\.png$/i.test(c.mediaPath))
    .map((c) => c.mediaPath))]
  for (const still of stills) {
    const webm = still.replace(/_hold\.png$/i, '.webm')
    const src = swap.get(webm)
    if (!src || !fs.existsSync(still)) continue
    const st = fs.statSync(src)
    const key = crypto.createHash('sha1').update(`${path.normalize(src)}|${st.size}|${st.mtimeMs}|last`).digest('hex').slice(0, 16)
    const out = path.join(CACHE_DIR, `${key}_last.png`)
    if (!fs.existsSync(out)) {
      const tmp = path.join(CACHE_DIR, `${key}_last.partial.png`)
      const r = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-sseof', '-1', '-i', src,
        '-an', '-pix_fmt', 'rgba', '-f', 'image2', '-update', '1', tmp])
      if (r.code !== 0 || !fs.existsSync(tmp)) continue
      fs.renameSync(tmp, out)
    }
    holds.set(still, out)
  }
  return holds
}

module.exports = { prepareAlphaVideos }
