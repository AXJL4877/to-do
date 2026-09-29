const { BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { once } = require('node:events')

/** Bake editable chalk titles to temporary lossless alpha videos before composition. */
async function prepareChalkText(sequence, { ffmpeg, rendererUrl, onProgress }) {
  const titles = (sequence.clips || []).filter(c => c.enabled !== false && c.text?.fancy)
  if (sequence.audioOnly || !titles.length) return { sequence, cleanup() {} }
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-chalk-'))
  const cleanup = () => fs.rmSync(folder, { recursive: true, force: true })
  let win
  try {
    win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
    if (rendererUrl) await win.loadURL(rendererUrl)
    else await win.loadFile(path.join(__dirname, '../dist/chalk-render.html'))
    if (!await win.webContents.executeJavaScript('typeof window.renderChalkFrame === "function"')) throw new Error('粉笔花字导出组件未加载，请重新构建应用')
    const { width = 1920, height = 1080, fps = 30 } = sequence.settings || {}
    if (![width, height, fps].every(Number.isFinite) || width < 16 || height < 16 || width > 7680 || height > 7680 || fps < 1 || fps > 120) throw new Error('无效的花字导出尺寸或帧率')
    const replacements = new Map()
    for (let n = 0; n < titles.length; n++) {
      const clip = titles[n]
      if (!Number.isFinite(clip.duration) || clip.duration <= 0) throw new Error('无效的花字片段时长')
      const output = path.join(folder, `title-${n}.mov`)
      const encoder = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-vcodec', 'png', '-framerate', String(fps), '-i', 'pipe:0', '-an', '-c:v', 'qtrle', '-pix_fmt', 'argb', output], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
      let errorText = '', pipeError
      encoder.stderr.on('data', data => { errorText = (errorText + data).slice(-4000) })
      encoder.stdin.on('error', e => { pipeError = e })
      const completed = new Promise((resolve, reject) => {
        encoder.once('error', reject)
        encoder.once('close', code => code === 0 ? resolve() : reject(new Error(errorText || `花字编码失败 (${code})`)))
      })
      // Attach immediately: an early encoder failure must not become an unhandled rejection.
      completed.catch(() => {})
      try {
        const frames = Math.ceil(clip.duration * fps)
        for (let i = 0; i < frames; i++) {
          if (pipeError) throw pipeError
          const args = [clip.text, clip.keyframes, clip.duration, width, height, i / fps]
          const png = await win.webContents.executeJavaScript(`window.renderChalkFrame(...${JSON.stringify(args)})`)
          if (!encoder.stdin.write(Buffer.from(png, 'base64'))) await Promise.race([once(encoder.stdin, 'drain'), completed.then(() => { throw new Error('花字编码提前结束') })])
          onProgress?.(Math.round((n + (i + 1) / frames) / titles.length * 25))
        }
        encoder.stdin.end()
        await completed
      } catch (error) { encoder.kill(); await completed.catch(() => {}); throw error }
      replacements.set(clip, { ...clip, kind: 'video', text: undefined, mediaPath: output,
        inPoint: 0, outPoint: clip.duration, speed: 1, reverse: false, freeze: undefined })
    }
    // Subtitle tracks must become drawable video tracks, above regular footage.
    const titleTracks = new Set(titles.map(c => c.trackId))
    const tracks = sequence.tracks || []
    return { sequence: { ...sequence, clips: sequence.clips.map(c => replacements.get(c) || c),
      tracks: [...tracks.filter(t => titleTracks.has(t.id)).map(t => ({ ...t, kind: 'video' })), ...tracks.filter(t => !titleTracks.has(t.id))] }, cleanup }
  } catch (error) { cleanup(); throw error }
  finally { win?.destroy() }
}
module.exports = { prepareChalkText }
