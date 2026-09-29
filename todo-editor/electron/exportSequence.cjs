/**
 * Sequence → mp4 via todo-media-engine export (preferred) or local ffmpeg-cli.
 * Contract: EditGraph v1 (`version` optional for back-compat).
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')

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

function resolveFfprobe(nativeBin) {
  const candidates = [
    process.env.FFPROBE,
    nativeBin && path.join(nativeBin, 'ffprobe.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft/WinGet/Links/ffprobe.exe'),
    'ffprobe',
  ].filter(Boolean)
  for (const c of candidates) {
    if (c === 'ffprobe') return c
    try {
      if (fs.existsSync(c)) return c
    } catch { /* */ }
  }
  return 'ffprobe'
}

function resolveEngine(nativeBin) {
  const candidates = [
    nativeBin && path.join(nativeBin, 'todo-media-engine.exe'),
    path.join(__dirname, '../native/bin/todo-media-engine.exe'),
  ].filter(Boolean)
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch { /* */ }
  }
  return ''
}

/** @param {string} p */
function usablePath(p) {
  if (typeof p !== 'string' || !p || p.includes('\0')) return false
  if (p.startsWith('blob:') || p.startsWith('data:')) return false
  try {
    return path.isAbsolute(p) && fs.statSync(p).isFile()
  } catch {
    return false
  }
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff'])

/** @param {{ kind?: string, mediaPath?: string }} c */
function isStillImage(c) {
  if (c.kind === 'image') return true
  const ext = path.extname(c.mediaPath || '').toLowerCase()
  return IMAGE_EXT.has(ext)
}

/**
 * Prefer C++ `todo-media-engine export`; falls back to ffmpeg-cli JS.
 * @param {object} seq EditGraph-like sequence
 * @param {string} outPath
 * @param {{ nativeBin?: string, onProgress?: (p: number) => void, preferJs?: boolean }} [opts]
 */
async function exportSequence(seq, outPath, opts = {}) {
  try {
    const { prepareAlphaVideos } = require('./alphaVideoExport.cjs')
    seq = await prepareAlphaVideos(seq, { ffmpeg: resolveFfmpeg(opts.nativeBin), onProgress: opts.onProgress })
  } catch (e) { return { ok: false, error: e.message || '透明视频预处理失败' } }
  if (!seq.audioOnly && (seq.clips || []).some(c => c.enabled !== false && c.text?.fancy)) {
    let prepared
    try {
      const { prepareChalkText } = require('./chalkTextExport.cjs')
      prepared = await prepareChalkText(seq, { ffmpeg: resolveFfmpeg(opts.nativeBin), rendererUrl: opts.chalkRendererUrl, onProgress: opts.onProgress })
      return await exportPreparedSequence(prepared.sequence, outPath, { ...opts, onProgress: p => opts.onProgress?.(25 + Math.round(p * 0.75)) })
    } catch (e) { return { ok: false, error: e.message || '粉笔花字导出失败' } }
    finally { prepared?.cleanup() }
  }
  return exportPreparedSequence(seq, outPath, opts)
}

function exportPreparedSequence(seq, outPath, opts = {}) {
  if (!opts.preferJs) {
    const engine = resolveEngine(opts.nativeBin)
    if (engine) {
      return exportViaCpp(engine, seq, outPath, opts).then((r) => {
        if (r.ok) return r
        return exportViaFfmpegCli(seq, outPath, opts)
      })
    }
  }
  return exportViaFfmpegCli(seq, outPath, opts)
}

function exportViaCpp(engine, seq, outPath, opts = {}) {
  return new Promise((resolve) => {
    let graphFile = ''
    try {
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
      graphFile = path.join(
        os.tmpdir(),
        `todo-editgraph-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
      )
      const graph = {
        version: seq.version || 1,
        clips: seq.clips || [],
        tracks: seq.tracks || [],
        settings: seq.settings || {},
        workIn: seq.workIn ?? 0,
        workOut: seq.workOut ?? 1,
        rangeOnly: !!seq.rangeOnly,
        audioOnly: !!seq.audioOnly,
      }
      fs.writeFileSync(graphFile, JSON.stringify(graph), 'utf8')
    } catch (e) {
      resolve({ ok: false, error: e.message || '无法写 EditGraph 临时文件' })
      return
    }

    const child = spawn(engine, ['export', graphFile, outPath], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: opts.nativeBin
          ? `${opts.nativeBin}${path.delimiter}${process.env.PATH || ''}`
          : process.env.PATH,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c) => { stderr += c })
    child.on('error', (err) => {
      try { fs.unlinkSync(graphFile) } catch { /* */ }
      resolve({
        ok: false,
        error: err.code === 'ENOENT' ? '找不到 todo-media-engine' : (err.message || '引擎启动失败'),
      })
    })
    child.on('close', (code) => {
      try { fs.unlinkSync(graphFile) } catch { /* */ }
      let parsed = null
      try {
        const line = String(stdout || '').trim().split(/\r?\n/).filter(Boolean).pop()
        parsed = line ? JSON.parse(line) : null
      } catch { /* */ }
      if (code === 0 && parsed?.ok && fs.existsSync(outPath)) {
        if (opts.onProgress) opts.onProgress(100)
        resolve({
          ok: true,
          path: parsed.path || outPath,
          backend: parsed.backend || 'todo-cpp-ffmpeg',
        })
        return
      }
      const errObj = parsed?.error
      const errMsg = typeof errObj === 'string'
        ? errObj
        : (errObj && errObj.message) || ''
      resolve({
        ok: false,
        error: errMsg || (stderr || stdout || `engine exit ${code}`).trim().slice(0, 500),
      })
    })
  })
}

/**
 * @param {object} seq
 * @param {string} outPath
 * @param {{ nativeBin?: string, onProgress?: (p: number) => void }} [opts]
 */
function exportViaFfmpegCli(seq, outPath, opts = {}) {
  const ffmpeg = resolveFfmpeg(opts.nativeBin)
  const settings = seq.settings || {}
  const w = Math.max(16, Math.round(Number(settings.width) || 1920) & ~1)
  const h = Math.max(16, Math.round(Number(settings.height) || 1080) & ~1)
  const fps = Math.max(1, Number(settings.fps) || 30)
  const audioOnly = !!seq.audioOnly
  const rangeOnly = !!seq.rangeOnly
  const workIn = Math.max(0, Number(seq.workIn) || 0)
  const workOut = Math.max(workIn + 0.05, Number(seq.workOut) || workIn + 1)

  const trackById = new Map((seq.tracks || []).map((t, i) => [t.id, { ...t, _i: i }]))
  const clips = (seq.clips || []).filter((c) => c && c.enabled !== false && usablePath(c.mediaPath))

  const videoClips = clips
    .filter((c) => {
      const t = trackById.get(c.trackId)
      if (!t || t.kind !== 'video') return false
      const k = c.kind || (isStillImage(c) ? 'image' : 'video')
      return k === 'video' || k === 'image'
    })
    .sort((a, b) => {
      const ia = trackById.get(a.trackId)?._i ?? 0
      const ib = trackById.get(b.trackId)?._i ?? 0
      return ib - ia || a.start - b.start
    })

  // Audio only from audio tracks (linked A clips); avoids double-mix with V-track PCM
  const audioClips = clips.filter((c) => {
    const t = trackById.get(c.trackId)
    if (!t || t.kind !== 'audio' || t.muted) return false
    if (isStillImage(c) || c.kind === 'image') return false
    return true
  })

  let timelineEnd = 0
  for (const c of clips) timelineEnd = Math.max(timelineEnd, Number(c.start) + Number(c.duration))
  if (!(timelineEnd > 0)) timelineEnd = rangeOnly ? workOut : 1
  const outDur = Math.max(0.1, timelineEnd)

  /** @type {Array<{ path: string, loop?: boolean, t?: number }>} */
  const inputs = []
  /** @type {string[]} */
  const filters = []
  let nextIn = 0

  /** @param {string} filePath @param {{ loop?: boolean, t?: number }} [meta] */
  const pushInput = (filePath, meta = {}) => {
    const idx = nextIn++
    inputs.push({ path: filePath, ...meta })
    return idx
  }

  /** @type {Map<string, number>} */
  const pathToInput = new Map()

  if (!audioOnly) {
    filters.push(`color=c=black:s=${w}x${h}:d=${outDur}:r=${fps}[base]`)
    let last = 'base'
    if (videoClips.length === 0) {
      filters.push(`[base]null[vout]`)
    } else {
      videoClips.forEach((c, i) => {
        const start = Math.max(0, Number(c.start) || 0)
        const dur = Math.max(0.04, Number(c.duration) || 0.04)
        const inPoint = Math.max(0, Number(c.inPoint) || 0)
        const still = isStillImage(c)
        const idx = pushInput(c.mediaPath, still ? { loop: true, t: dur + 0.05 } : {})
        pathToInput.set(c.mediaPath, idx)
        const lab = `vc${i}`
        const delayed = `vd${i}`
        const next = i === videoClips.length - 1 ? 'vout' : `vo${i}`
        if (still) {
          filters.push(
            `[${idx}:v]setpts=PTS-STARTPTS,` +
            `scale=${w}:${h}:force_original_aspect_ratio=decrease,format=rgba,` +
            `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black@0,setsar=1,fps=${fps},trim=duration=${dur},setpts=PTS-STARTPTS[${lab}]`,
          )
        } else {
          filters.push(
            `[${idx}:v]trim=start=${inPoint}:duration=${dur},setpts=PTS-STARTPTS,` +
            `scale=${w}:${h}:force_original_aspect_ratio=decrease,format=rgba,` +
            `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black@0,setsar=1,fps=${fps}[${lab}]`,
          )
        }
        filters.push(`[${lab}]tpad=start_duration=${start}[${delayed}]`)
        filters.push(`[${last}][${delayed}]overlay=eof_action=pass[${next}]`)
        last = next
      })
    }
  }

  const audioLabs = []
  audioClips.forEach((c, i) => {
    let idx = pathToInput.get(c.mediaPath)
    if (idx === undefined) {
      idx = pushInput(c.mediaPath)
      pathToInput.set(c.mediaPath, idx)
    }
    const start = Math.max(0, Number(c.start) || 0)
    const dur = Math.max(0.04, Number(c.duration) || 0.04)
    const inPoint = Math.max(0, Number(c.inPoint) || 0)
    const delayMs = Math.round(start * 1000)
    const lab = `a${i}`
    filters.push(
      `[${idx}:a]atrim=start=${inPoint}:duration=${dur},asetpts=PTS-STARTPTS,` +
      `adelay=${delayMs}|${delayMs}:all=1[${lab}]`,
    )
    audioLabs.push(`[${lab}]`)
  })

  if (audioLabs.length === 1) {
    filters.push(`${audioLabs[0]}anull[aout]`)
  } else if (audioLabs.length > 1) {
    filters.push(`${audioLabs.join('')}amix=inputs=${audioLabs.length}:duration=longest:dropout_transition=0[aout]`)
  }

  if (audioOnly && audioLabs.length === 0) {
    return Promise.resolve({ ok: false, error: '没有可导出的音频片段（需本机 path）' })
  }
  if (!audioOnly && videoClips.length === 0 && audioLabs.length === 0) {
    return Promise.resolve({ ok: false, error: '没有可导出的媒体片段（需本机 path）' })
  }

  /** @type {string[]} */
  const args = ['-y', '-hide_banner', '-loglevel', 'error']
  for (const inp of inputs) {
    if (inp.loop) {
      args.push('-loop', '1', '-framerate', String(fps), '-t', String(Math.max(0.05, inp.t || 1)))
    }
    args.push('-i', inp.path)
  }

  if (filters.length) {
    args.push('-filter_complex', filters.join(';'))
  }

  if (audioOnly) {
    args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '192k', '-vn')
  } else {
    args.push('-map', '[vout]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast')
    if (audioLabs.length) {
      args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '192k')
    } else {
      args.push('-an')
    }
  }

  if (rangeOnly) {
    args.push('-ss', String(workIn), '-t', String(Math.max(0.05, workOut - workIn)))
  } else {
    args.push('-t', String(outDur))
  }

  args.push('-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', outPath)

  const totalMs = Math.max(100, (rangeOnly ? workOut - workIn : outDur) * 1000)

  return new Promise((resolve) => {
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    let child
    try {
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
      child = spawn(ffmpeg, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      finish({ ok: false, error: e.message || '无法启动 ffmpeg' })
      return
    }

    let buf = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buf += chunk
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (line.startsWith('out_time_ms=')) {
          const ms = Number(line.slice('out_time_ms='.length))
          if (Number.isFinite(ms) && opts.onProgress) {
            opts.onProgress(Math.min(99, (ms / totalMs) * 100))
          }
        } else if (line === 'progress=end' && opts.onProgress) {
          opts.onProgress(100)
        }
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { stderr += chunk })

    child.on('error', (err) => {
      const missing = err.code === 'ENOENT'
      finish({
        ok: false,
        error: missing
          ? '找不到 ffmpeg（PATH / WinGet Links / native/bin / FFMPEG）'
          : (err.message || 'ffmpeg 启动失败'),
      })
    })

    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(outPath)) {
        if (opts.onProgress) opts.onProgress(100)
        finish({ ok: true, path: outPath, backend: 'ffmpeg-cli', ffmpeg })
      } else {
        finish({
          ok: false,
          error: (stderr || `ffmpeg 退出码 ${code}`).trim().slice(0, 500),
        })
      }
    })
  })
}

module.exports = {
  exportSequence,
  exportViaFfmpegCli,
  resolveFfmpeg,
  resolveFfprobe,
  resolveEngine,
  usablePath,
  isStillImage,
}
