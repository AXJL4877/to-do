import { drawFancyText } from '../src/lib/fancyText'
import { buildEditGraph } from '../src/lib/editGraph'
import { defaultText } from '../src/types'

const canvas = document.createElement('canvas')
canvas.width = 640; canvas.height = 240
const ctx = canvas.getContext('2d', { willReadFrequently: true })!
const opts = {
  lines: ['粉笔 Ab'], fontPx: 80, family: 'KaiTi', align: 'center', lineHeight: 1.25,
  letterSpacing: 0, k: 1,
  fancy: { fontWeight: 400, fill: ['#ffffff'], fillAngle: 90, strokes: [],
    chalk: { duration: 2, grain: 0.5, hand: false } },
}
function frame(time: number, background = false) {
  ctx.clearRect(0, 0, 640, 240)
  if (background) { ctx.fillStyle = '#347899'; ctx.fillRect(0, 0, 640, 240) }
  ctx.save(); ctx.translate(320, 120)
  drawFancyText(ctx, { ...opts, time } as any)
  ctx.restore()
  return ctx.getImageData(0, 0, 640, 240).data
}
function ink(data: Uint8ClampedArray) {
  let sum = 0
  for (let i = 3; i < data.length; i += 4) sum += data[i]
  return sum
}
function check(ok: unknown, message: string) { if (!ok) throw new Error(message) }
const results: { name: string; ok: boolean; error?: string }[] = []
function test(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }) }
  catch (e) { results.push({ name, ok: false, error: String(e) }) }
}
test('writing begins with an empty transparent frame', () => check(ink(frame(0)) === 0, 'text visible before writing starts'))
test('ink grows during writing and holds after completion', () => {
  const partial = ink(frame(0.8)), full = ink(frame(2))
  check(partial > 0 && partial < full * 0.8, 'writing is not progressive')
  check(full === ink(frame(10)), 'completed text changes')
})
test('seeking backward restores identical pixels without random flicker', () => {
  const first = frame(0.8); frame(1.8)
  const back = frame(0.8)
  check(first.every((v, i) => v === back[i]), 'seek changed chalk pixels')

})

test('grain does not erase underlying video pixels', () => {
  const data = frame(1.2, true)
  check(data.filter((_, i) => i % 4 === 3).every(a => a === 255), 'chalk erased background')
})
test('completed chalk has transparent grain inside glyphs', () => {
  const data = frame(2)
  let translucent = 0
  for (let i = 3; i < data.length; i += 4) if (data[i] > 20 && data[i] < 210) translucent++
  check(translucent > 1000, 'missing chalk grain')
})
test('export graph retains chalk timing and font-size animation', () => {
  const graph = buildEditGraph({ clips: [{ id: 'chalk', trackId: 'title', start: 0, duration: 3, inPoint: 0,
    text: { ...defaultText(), fancy: opts.fancy }, keyframes: { fontSize: [{ t: 0, value: 80 }] } }],
    tracks: [{ id: 'title', kind: 'subtitle' }], media: [], settings: { width: 640, height: 360, fps: 30 }, workIn: 0, workOut: 3 })
  check((graph.clips[0].text as any)?.fancy?.chalk.duration === 2, 'export lost chalk style')
  check((graph.clips[0].keyframes as any)?.fontSize?.[0]?.value === 80, 'export lost font-size keyframes')
})
;(window as any).chalkTests = { results, failed: results.filter(r => !r.ok).length }

