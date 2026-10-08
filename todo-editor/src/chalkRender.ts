import { drawTextClip } from './lib/monitorDraw'
import { fontStack } from './lib/fancyText'
import { defaultText, type Clip } from './types'
import { invalidateDynamicTextFonts } from './lib/dynamicText'

declare global {
  interface Window {
    todoChalkExport?: { pushFrame: (sessionId: string, buffer: ArrayBuffer) => Promise<unknown> }
    renderChalkFrame: (text: Clip['text'], keyframes: Clip['keyframes'], duration: number, width: number, height: number, time: number) => string
    renderChalkClipExport: (text: Clip['text'], keyframes: Clip['keyframes'], duration: number, width: number, height: number, fps: number, sessionId: string) => Promise<number>
    loadTextFonts: (families: string[]) => Promise<boolean>
  }
}

const canvas = document.createElement('canvas')
// This isolated renderer shares the exact text drawing code with the timeline.
Object.assign(window, {
  renderChalkFrame(text: Clip['text'], keyframes: Clip['keyframes'], duration: number, width: number, height: number, time: number) {
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    ctx.clearRect(0, 0, width, height)
    ctx.save(); ctx.translate(width / 2, height / 2)
    drawTextClip(ctx, { text: { ...defaultText(), ...text }, keyframes: keyframes ?? {}, start: 0, duration } as Clip, width, height, time)
    ctx.restore()
    return canvas.toDataURL('image/png').split(',')[1]
  },
  /** 整段在渲染进程内出帧，经 preload 推 RGBA，避免每帧 PNG/base64 IPC */
  async renderChalkClipExport(
    text: Clip['text'], keyframes: Clip['keyframes'], duration: number,
    width: number, height: number, fps: number, sessionId: string,
  ) {
    const bridge = window.todoChalkExport
    if (!bridge?.pushFrame) throw new Error('文字导出通道不可用')
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    const clip = { text: { ...defaultText(), ...text }, keyframes: keyframes ?? {}, start: 0, duration } as Clip
    const frames = Math.ceil(duration * fps)
    for (let i = 0; i < frames; i++) {
      ctx.clearRect(0, 0, width, height)
      ctx.save(); ctx.translate(width / 2, height / 2)
      drawTextClip(ctx, clip, width, height, i / fps)
      ctx.restore()
      const { data } = ctx.getImageData(0, 0, width, height)
      const copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
      await bridge.pushFrame(sessionId, copy)
    }
    return frames
  },
  /** 先把要用到的字体载入，否则第一帧会用回退字体画 */
  async loadTextFonts(families: string[]) {
    await Promise.all(families.flatMap((f) => ['400', '600', '700', '800'].map((wt) => document.fonts.load(`${wt} 48px ${fontStack(f)}`, '字Ab').catch(() => []))))
    await document.fonts.ready
    invalidateDynamicTextFonts()
    return true
  },
})
