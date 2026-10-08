const { BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { randomUUID } = require('node:crypto')

const ANIM_IN = new Set(['fade', 'pop', 'typewriter'])
/** @type {Map<string, { wc: Electron.WebContents, write: (buf: Buffer) => Promise<void> }>} */
const exportSessions = new Map()
let frameHandlerReady = false

function ensureFrameHandler() {
  if (frameHandlerReady) return
  frameHandlerReady = true
  ipcMain.handle('chalk-export-frame', async (event, sessionId, buffer) => {
    const session = exportSessions.get(sessionId)
    if (!session || event.sender !== session.wc) throw new Error('文字导出会话无效')
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
    await session.write(buf)
  })
}

/** 文字哪段时间在动：[入场结束, 出场开始]；整段都得逐帧画时返回 null，完全静止时返回 [0, duration] */
function staticSpan(clip) {
  const t = clip.text
  if (t.fancy || clip.keyframes?.fontSize?.length) return null
  const inDur = ANIM_IN.has(t.animIn) ? Math.max(0.05, t.animInDur ?? 0.8) : 0
  const outDur = t.animOut === 'fade' ? Math.max(0.05, t.animOutDur ?? 0.4) : 0
  return [inDur, clip.duration - outDur]
}

function inExportRange(seq, c) {
  if (!seq.rangeOnly) return true
  return c.start < Number(seq.workOut) && c.start + c.duration > Number(seq.workIn)
}

/** 完整编排（v2）同段场景共用一份 composition，导出时只烘焙一次再切片，避免 N 镜重复整段渲染 */
function fullCompositionKey(clip) {
  const d = clip.text?.fancy?.dynamic
  if (!d || d.version !== 2 || !d.composition?.scenes?.length) return null
  const { offset: _o, scenes, ...rest } = d.composition
  return JSON.stringify({
    scenes: scenes.map((s) => [s.start, s.end, s.content]),
    rest,
    seed: d.seed,
    motion: d.motion,
    accent: d.accent,
    fontFamily: clip.text.fontFamily,
    fontWeight: clip.text.fancy?.fontWeight,
    fontSize: clip.text.fontSize,
    fill: clip.text.fancy?.fill,
    color: clip.text.color,
  })
}

function buildBakeClip(group) {
  const base = group.slice().sort((a, b) => a.text.fancy.dynamic.composition.offset - b.text.fancy.dynamic.composition.offset)[0]
  const scenes = base.text.fancy.dynamic.composition.scenes.map((s) => ({ ...s }))
  for (const c of group) {
    const off = c.text.fancy.dynamic.composition.offset
    for (let i = 0; i < scenes.length; i++) {
      if (off >= scenes[i].start - 0.001 && off < scenes[i].end) scenes[i] = { ...scenes[i], content: c.text.content }
    }
  }
  const t0 = Math.min(...group.map((c) => c.text.fancy.dynamic.composition.offset))
  const t1 = Math.max(...group.map((c) => c.text.fancy.dynamic.composition.offset + c.duration))
  const duration = Math.max(1 / 30, t1 - t0)
  const head = scenes.find((s) => t0 >= s.start - 0.001 && t0 < s.end)?.content || base.text.content
  return {
    bake: {
      ...base,
      duration,
      text: {
        ...base.text,
        content: head,
        fancy: {
          ...base.text.fancy,
          dynamic: {
            ...base.text.fancy.dynamic,
            duration,
            composition: { ...base.text.fancy.dynamic.composition, scenes, offset: t0 },
          },
        },
      },
    },
    t0,
    duration,
  }
}

/**
 * 文字片段（字幕、普通文字、花字）用和监视器同一份 drawTextClip 预渲染成透明素材：
 * 静止的出一张 PNG，带动画的出 qtrle/argb MOV。
 * 花字/动态文字：渲染进程内连续出 RGBA → ffmpeg rawvideo（不再每帧 PNG+IPC）。
 * 完整编排同段多镜：整段只烘一次，各镜用 inPoint 切片。
 */
async function prepareTextLayers(sequence, { ffmpeg, rendererUrl, onProgress }) {
  const titles = (sequence.clips || []).filter((c) => c.enabled !== false && c.text && inExportRange(sequence, c))
  if (sequence.audioOnly || !titles.length) return { sequence, cleanup() {} }
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-text-'))
  const cleanup = () => fs.rmSync(folder, { recursive: true, force: true })
  let win
  ensureFrameHandler()
  try {
    win = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        backgroundThrottling: false,
        preload: path.join(__dirname, 'chalkExportPreload.cjs'),
      },
    })
    if (rendererUrl) await win.loadURL(rendererUrl)
    else await win.loadFile(path.join(__dirname, '../dist/chalk-render.html'))
    if (!await win.webContents.executeJavaScript('typeof window.renderChalkFrame === "function"')) throw new Error('文字导出组件未加载，请重新构建应用')
    if (!await win.webContents.executeJavaScript('typeof window.renderChalkClipExport === "function" && !!(window.todoChalkExport && window.todoChalkExport.pushFrame)')) {
      throw new Error('文字导出加速通道未加载，请重新构建应用')
    }
    const { width = 1920, height = 1080, fps = 30 } = sequence.settings || {}
    if (![width, height, fps].every(Number.isFinite) || width < 16 || height < 16 || width > 7680 || height > 7680 || fps < 1 || fps > 120) throw new Error('无效的文字导出尺寸或帧率')
    const families = [...new Set(titles.map((c) => c.text.fontFamily).filter(Boolean))]
    if (await win.webContents.executeJavaScript('typeof window.loadTextFonts === "function"')) {
      await win.webContents.executeJavaScript(`window.loadTextFonts(${JSON.stringify(families)})`)
    }
    const render = (clip, time) => win.webContents.executeJavaScript(
      `window.renderChalkFrame(...${JSON.stringify([clip.text, clip.keyframes, clip.duration, width, height, time])})`)

    const stills = new Map()
    const replacements = new Map()
    const fullGroups = new Map()
    for (const clip of titles) {
      const key = fullCompositionKey(clip)
      if (!key) continue
      if (!fullGroups.has(key)) fullGroups.set(key, [])
      fullGroups.get(key).push(clip)
    }
    const baked = new Set()
    let done = 0
    const total = titles.length

    for (const group of fullGroups.values()) {
      if (group.length < 2) continue
      for (const c of group) {
        if (!Number.isFinite(c.duration) || c.duration <= 0) throw new Error('无效的文字片段时长')
      }
      const { bake, t0 } = buildBakeClip(group)
      onProgress?.((done / total) * 100, `渲染完整编排 ${group.length} 镜合并`)
      const mediaPath = path.join(folder, `text-full-${baked.size}.mov`)
      await encodeRawClip(bake, { ffmpeg, fps, width, height, output: mediaPath, win })
      for (const clip of group) {
        const inPoint = Math.max(0, clip.text.fancy.dynamic.composition.offset - t0)
        replacements.set(clip, {
          ...clip, kind: 'video', textLayer: true, text: undefined, mediaPath,
          inPoint, outPoint: inPoint + clip.duration, speed: 1, reverse: false, freeze: undefined,
        })
        baked.add(clip)
        done++
      }
    }

    for (let n = 0; n < titles.length; n++) {
      const clip = titles[n]
      if (baked.has(clip)) continue
      if (!Number.isFinite(clip.duration) || clip.duration <= 0) throw new Error('无效的文字片段时长')
      onProgress?.((done / total) * 100, `渲染字幕 ${done + 1}/${total}`)
      const span = staticSpan(clip)
      let mediaPath
      let kind = 'image'
      if (span && span[0] <= 1e-6 && span[1] >= clip.duration - 1e-6) {
        const key = JSON.stringify(clip.text)
        mediaPath = stills.get(key)
        if (!mediaPath) {
          mediaPath = path.join(folder, `text-${stills.size}.png`)
          fs.writeFileSync(mediaPath, Buffer.from(await render(clip, clip.duration / 2), 'base64'))
          stills.set(key, mediaPath)
        }
      } else if (!span) {
        // 花字 / 动态文字 / 字号关键帧：RGBA 直推，避免每帧 PNG+executeJavaScript
        kind = 'video'
        mediaPath = path.join(folder, `text-anim-${n}.mov`)
        await encodeRawClip(clip, { ffmpeg, fps, width, height, output: mediaPath, win })
      } else {
        kind = 'video'
        mediaPath = path.join(folder, `text-anim-${n}.mov`)
        await encodeAnimated(clip, span, { ffmpeg, fps, output: mediaPath, render })
      }
      replacements.set(clip, { ...clip, kind, textLayer: true, text: undefined, mediaPath,
        inPoint: 0, outPoint: clip.duration, speed: 1, reverse: false, freeze: undefined })
      done++
    }
    // 字幕轨换成可绘制的视频轨并放到最上面（ffmpeg 兜底导出只认视频轨）
    const titleTracks = new Set(titles.map((c) => c.trackId))
    const tracks = sequence.tracks || []
    return { sequence: { ...sequence, clips: sequence.clips.map((c) => replacements.get(c) || c),
      tracks: [...tracks.filter((t) => titleTracks.has(t.id)).map((t) => ({ ...t, kind: 'video' })), ...tracks.filter((t) => !titleTracks.has(t.id))] }, cleanup }
  } catch (error) { cleanup(); throw error }
  finally { win?.destroy() }
}

async function encodeRawClip(clip, { ffmpeg, fps, width, height, output, win }) {
  const frameBytes = width * height * 4
  const encoder = spawn(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgba',
    '-s', `${width}x${height}`,
    '-framerate', String(fps),
    '-i', 'pipe:0',
    '-an', '-c:v', 'qtrle', '-pix_fmt', 'argb', output,
  ], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
  let errorText = '', pipeError
  encoder.stderr.on('data', (data) => { errorText = (errorText + data).slice(-4000) })
  encoder.stdin.on('error', (e) => { pipeError = e })
  const completed = new Promise((resolve, reject) => {
    encoder.once('error', reject)
    encoder.once('close', (code) => (code === 0 ? resolve() : reject(new Error(errorText || `文字编码失败 (${code})`))))
  })
  completed.catch(() => {})

  const sessionId = randomUUID()
  let writeChain = Promise.resolve()
  const write = (buf) => {
    if (pipeError) return Promise.reject(pipeError)
    if (buf.length !== frameBytes) return Promise.reject(new Error(`文字帧尺寸不匹配 (${buf.length}≠${frameBytes})`))
    writeChain = writeChain.then(async () => {
      if (pipeError) throw pipeError
      if (!encoder.stdin.write(buf)) {
        await Promise.race([once(encoder.stdin, 'drain'), completed.then(() => { throw new Error('文字编码提前结束') })])
      }
    })
    return writeChain
  }
  exportSessions.set(sessionId, { wc: win.webContents, write })
  try {
    const frames = await win.webContents.executeJavaScript(
      `window.renderChalkClipExport(...${JSON.stringify([clip.text, clip.keyframes, clip.duration, width, height, fps, sessionId])})`)
    await writeChain
    const expected = Math.ceil(clip.duration * fps)
    if (frames !== expected) throw new Error(`文字帧数不匹配 (${frames}≠${expected})`)
    encoder.stdin.end()
    await completed
  } catch (error) {
    encoder.kill()
    await completed.catch(() => {})
    throw error
  } finally {
    exportSessions.delete(sessionId)
  }
}

async function encodeAnimated(clip, span, { ffmpeg, fps, output, render }) {
  const encoder = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-vcodec', 'png', '-framerate', String(fps), '-i', 'pipe:0', '-an', '-c:v', 'qtrle', '-pix_fmt', 'argb', output], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
  let errorText = '', pipeError
  encoder.stderr.on('data', (data) => { errorText = (errorText + data).slice(-4000) })
  encoder.stdin.on('error', (e) => { pipeError = e })
  const completed = new Promise((resolve, reject) => {
    encoder.once('error', reject)
    encoder.once('close', (code) => (code === 0 ? resolve() : reject(new Error(errorText || `文字编码失败 (${code})`))))
  })
  // Attach immediately: an early encoder failure must not become an unhandled rejection.
  completed.catch(() => {})
  try {
    const frames = Math.ceil(clip.duration * fps)
    let held = null
    for (let i = 0; i < frames; i++) {
      if (pipeError) throw pipeError
      const t = i / fps
      const still = span && t >= span[0] && t < span[1]
      let png = still ? held : null
      if (!png) {
        png = Buffer.from(await render(clip, t), 'base64')
        if (still) held = png
      }
      if (!encoder.stdin.write(png)) await Promise.race([once(encoder.stdin, 'drain'), completed.then(() => { throw new Error('文字编码提前结束') })])
    }
    encoder.stdin.end()
    await completed
  } catch (error) { encoder.kill(); await completed.catch(() => {}); throw error }
}

module.exports = { prepareTextLayers, fullCompositionKey, buildBakeClip }
