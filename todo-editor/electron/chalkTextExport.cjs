const { BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { once } = require('node:events')

const ANIM_IN = new Set(['fade', 'pop', 'typewriter'])

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

/**
 * 文字片段（字幕、普通文字、花字）用和监视器同一份 drawTextClip 预渲染成透明素材：
 * 静止的出一张 PNG，带动画的出 qtrle/argb MOV（静止段复用同一帧）。
 * 导出引擎按片段自己的变换 / 透明度 / 转场去合成，与预览一致。
 */
async function prepareTextLayers(sequence, { ffmpeg, rendererUrl, onProgress }) {
  const titles = (sequence.clips || []).filter((c) => c.enabled !== false && c.text && inExportRange(sequence, c))
  if (sequence.audioOnly || !titles.length) return { sequence, cleanup() {} }
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-text-'))
  const cleanup = () => fs.rmSync(folder, { recursive: true, force: true })
  let win
  try {
    win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
    if (rendererUrl) await win.loadURL(rendererUrl)
    else await win.loadFile(path.join(__dirname, '../dist/chalk-render.html'))
    if (!await win.webContents.executeJavaScript('typeof window.renderChalkFrame === "function"')) throw new Error('文字导出组件未加载，请重新构建应用')
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
    for (let n = 0; n < titles.length; n++) {
      const clip = titles[n]
      if (!Number.isFinite(clip.duration) || clip.duration <= 0) throw new Error('无效的文字片段时长')
      onProgress?.((n / titles.length) * 100, `渲染字幕 ${n + 1}/${titles.length}`)
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
      } else {
        kind = 'video'
        mediaPath = path.join(folder, `text-anim-${n}.mov`)
        await encodeAnimated(clip, span, { ffmpeg, fps, output: mediaPath, render })
      }
      replacements.set(clip, { ...clip, kind, textLayer: true, text: undefined, mediaPath,
        inPoint: 0, outPoint: clip.duration, speed: 1, reverse: false, freeze: undefined })
    }
    // 字幕轨换成可绘制的视频轨并放到最上面（ffmpeg 兜底导出只认视频轨）
    const titleTracks = new Set(titles.map((c) => c.trackId))
    const tracks = sequence.tracks || []
    return { sequence: { ...sequence, clips: sequence.clips.map((c) => replacements.get(c) || c),
      tracks: [...tracks.filter((t) => titleTracks.has(t.id)).map((t) => ({ ...t, kind: 'video' })), ...tracks.filter((t) => !titleTracks.has(t.id))] }, cleanup }
  } catch (error) { cleanup(); throw error }
  finally { win?.destroy() }
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

module.exports = { prepareTextLayers }
