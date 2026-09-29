import { drawTextClip } from './lib/monitorDraw'
import { defaultText, type Clip } from './types'

const canvas = document.createElement('canvas')
// This isolated renderer shares the exact text drawing code with the timeline.
Object.assign(window, {
  renderChalkFrame(text: Clip['text'], keyframes: Clip['keyframes'], duration: number, width: number, height: number, time: number) {
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, width, height)
    ctx.save(); ctx.translate(width / 2, height / 2)
    drawTextClip(ctx, { text: { ...defaultText(), ...text }, keyframes: keyframes ?? {}, start: 0, duration } as Clip, width, height, time)
    ctx.restore()
    return canvas.toDataURL('image/png').split(',')[1]
  },
})
