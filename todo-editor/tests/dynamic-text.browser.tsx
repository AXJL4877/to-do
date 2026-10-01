import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { FANCY_PRESETS, FANCY_CATEGORIES, clonePresetFancy } from '../src/lib/fancyText'
import { drawTextClip } from '../src/lib/monitorDraw'
import { FancyTextPanel } from '../src/components/FancyTextPanel'
import { DynamicTextPanel } from '../src/components/DynamicTextPanel'
import { SkillsPanel } from '../src/components/SkillsPanel'
import { DYNAMIC_TEXT_PRESETS } from '../src/lib/dynamicTextPack'
import { useApp } from '../src/store'
import { defaultText, type Clip, type TextStyle } from '../src/types'
import { progressThemeForJob } from '../src/components/CreativeProgress'

const results: { name: string; ok: boolean; error?: string }[] = []
let chain = Promise.resolve()
const check = (ok: unknown, reason: string) => { if (!ok) throw new Error(reason) }
const test = (name: string, fn: () => void | Promise<void>) => {
  chain = chain.then(async () => { try { await fn(); results.push({ name, ok: true }) }
    catch (e) { results.push({ name, ok: false, error: String(e) }) } })
}
const presets = () => DYNAMIC_TEXT_PRESETS
const textFor = (i = 0, content = '把灵感 写下来'): TextStyle => ({ ...defaultText(), content,
  fontFamily: 'Microsoft YaHei', fontSize: 96, animIn: 'none', animOut: 'none', fancy: clonePresetFancy(presets()[i]) })
function render(text: TextStyle, time = 1.2, w = 640, h = 360, duration = 3, target?: HTMLCanvasElement) {
  const canvas = target ?? document.createElement('canvas')
  if (!target) { canvas.width = w; canvas.height = h }
  const ctx = canvas.getContext('2d')!
  ctx.save(); ctx.translate(w / 2, h / 2)
  drawTextClip(ctx, { text, start: 0, duration, keyframes: {} } as Clip, w, h, time)
  ctx.restore()
  return canvas
}
const data = (c: HTMLCanvasElement) => c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
const same = (a: Uint8ClampedArray, b: Uint8ClampedArray) => a.length === b.length && a.every((x, i) => x === b[i])
const visible = (d: Uint8ClampedArray) => d.filter((_, i) => i % 4 === 3 && d[i] > 0).length
const frames = () => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())))

test('dynamic templates belong to a separate extension, outside the font library', () => {
  check(!FANCY_CATEGORIES.some(c => c.id === 'dynamic'), 'dynamic category remains in font library')
  check(!FANCY_PRESETS.some(p => p.fancy.dynamic), 'dynamic templates remain in font library')
  check(presets().length === 6, 'expected six dynamic presets')
  check(FANCY_PRESETS.some(p => p.category === 'chalk'), 'chalk must remain available')
})
test('progress theme handles jobs with null skill data', () => {
  check(progressThemeForJob({ kind: 'image', params: { skill: null } } as any) === 'brush', 'nullable job skill must be safe')
})
test('every effect draws Chinese/Latin text on transparent landscape and portrait frames', () => {
  for (let i = 0; i < 6; i++) for (const [w, h] of [[640, 360], [360, 640]]) {
    const d = data(render(textFor(i), 1.2, w, h))
    check(visible(d) > 100, `empty ${i} at ${w}x${h}`)
    check(visible(d) < w * h * 0.85, `opaque background in ${i}`)
    check(d[3] === 0, `corner must stay transparent in ${i}`)
  }
})
test('seeking and independent draws reproduce exact pixels with no window.J pollution', () => {
  for (let i = 0; i < 6; i++) {
    const t = textFor(i)
    const first = data(render(t))
    render(t, 2.8); render(textFor((i + 1) % 6), 0.4)
    check(same(first, data(render(t))), `nondeterministic preset ${i}`)
  }
  check(!(window as any).J, 'engine leaks a global J')
})
test('draw preserves host background, alpha and transform', () => {
  const c = document.createElement('canvas'); c.width = 640; c.height = 360
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#223344'; ctx.fillRect(0, 0, 640, 360)
  ctx.globalAlpha = 0.5
  const before = ctx.getTransform()
  render(textFor(), 1.2, 640, 360, 3, c)
  const d = data(c)
  check(d[0] === 34 && d[1] === 51 && d[2] === 68 && d[3] === 255, 'host background cleared')
  check(ctx.globalAlpha === 0.5 && ctx.getTransform().a === before.a, 'host drawing state leaked')
})
test('empty, literal punctuation, long and multiline text are safe', () => {
  check(visible(data(render(textFor(0, '')))) === 0, 'empty text draws decorations')
  for (const input of ['中文 / *字* [01:20]', '中文 English\n第二行 / 保留', '长文测试'.repeat(70)]) {
    check(visible(data(render(textFor(5, input)))) > 100, 'fallback must remain visible')
  }
})
test('invalid saved dynamic configuration falls back, and fonts do not contaminate later draws', () => {
  const a = textFor(); const first = data(render(a))
  render({ ...a, fontFamily: 'SimSun' })
  check(same(first, data(render(a))), 'font metrics leak between clips')
  const bad = { ...a, fancy: { ...a.fancy!, dynamic: { version: 999, presetId: 'missing', duration: NaN, motion: Infinity } } } as TextStyle
  check(visible(data(render(bad))) > 100, 'invalid saved configuration becomes blank')
})
test('long clips keep visible hold stage and short clips remain renderable', () => {
  for (let i = 0; i < 6; i++) {
    check(visible(data(render(textFor(i), 7, 640, 360, 10))) > 100, `long clip blank ${i}`)
    check(visible(data(render(textFor(i), 0.6, 640, 360, 0.8))) > 0, `trimmed clip blank ${i}`)
  }
})
test('motion strength changes all effects and zero motion stays still', () => {
  const movingTimes = [0.2, 1.2, 0.4, 0.1, 0.8, 0.2]
  for (let i = 0; i < 6; i++) {
    const low = textFor(i); low.fancy!.dynamic!.motion = 0.05
    const high = textFor(i); high.fancy!.dynamic!.motion = 1
    check(!same(data(render(low, movingTimes[i])), data(render(high, movingTimes[i]))), `strength has no effect on preset ${i}`)
    const zero = textFor(i); zero.fancy!.dynamic!.motion = 0
    check(same(data(render(zero, 0.4)), data(render(zero, 1.2))), `zero strength still moves preset ${i}`)
  }
})
test('default typing preset reveals text over time instead of skipping its entrance', () => {
  const t = textFor(1)
  const early = visible(data(render(t, 0.05)))
  const late = visible(data(render(t, 1.2)))
  check(early < late * 0.5, `typing entrance skipped: early ${early}, late ${late}`)
})
test('minimum duration reaches the same completed arrangement as a normal duration', () => {
  for (let i = 0; i < 6; i++) {
    const short = textFor(i); short.fancy!.dynamic!.duration = 0.5
    const normal = textFor(i)
    check(same(data(render(short, 1, 640, 360, 10)), data(render(normal, 3, 640, 360, 10))), `short duration never settles preset ${i}`)
  }
})
test('library creates editable dynamic clip; edits, undo and JSON roundtrip retain its configuration', async () => {
  useApp.getState().newProject('dynamic acceptance')
  const host = document.createElement('div'); host.style.width = '420px'; document.body.append(host)
  const root = createRoot(host)
  try {
    flushSync(() => root.render(<FancyTextPanel />))
    check(!host.querySelector('[data-testid="fancy-cat-dynamic"]'), 'font library still exposes dynamic entry')
    flushSync(() => root.render(<DynamicTextPanel onBack={() => {}} />))
    check(host.querySelectorAll('[data-testid^="fancy-preset-dynamic-"]').length === 6, 'extension must show all six templates')
    await frames()
    check(host.querySelector('[data-testid="dynamic-motion"]'), 'dynamic parameters missing')
    flushSync(() => host.querySelector<HTMLButtonElement>('[data-testid="fancy-play"]')!.click())
    const seek = host.querySelector<HTMLInputElement>('[data-testid="fancy-seek"]')!
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(seek, '1.2')
      seek.dispatchEvent(new Event('input', { bubbles: true }))
      seek.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await frames()
    const cv = host.querySelector<HTMLCanvasElement>('[data-testid="fancy-preview"]')!
    check(visible(data(cv)) > 0, 'panel preview blank')
    flushSync(() => host.querySelector<HTMLButtonElement>('[data-testid="fancy-add"]')!.click())
    await frames()
    const st = useApp.getState(); const seq = st.sequences.find(s => s.id === st.activeSeqId)!
    const clip = seq.clips.find(c => st.selectedClipIds.includes(c.id))!
    check((clip.text?.fancy as any)?.dynamic, 'clip loses dynamic data')
    const seed = (clip.text!.fancy as any).dynamic.seed
    flushSync(() => host.querySelector<HTMLButtonElement>('[data-testid="dynamic-shuffle"]')!.click())
    const shuffled = useApp.getState().sequences.find(s => s.id === seq.id)!.clips.find(c => c.id === clip.id)!
    check((shuffled.text!.fancy as any).dynamic.seed !== seed && shuffled.text!.content === clip.text!.content, 'shuffle must preserve text and change seed')
    const original = clip.text!.content
    flushSync(() => st.updateSelectedText({ content: '修改之后' }))
    const current = useApp.getState().sequences.find(s => s.id === seq.id)!.clips.find(c => c.id === clip.id)!
    const reopened = JSON.parse(JSON.stringify(current))
    check(reopened.text.content === '修改之后' && reopened.text.fancy.dynamic.seed === (shuffled.text!.fancy as any).dynamic.seed, 'save data changed')
    flushSync(() => useApp.getState().undo())
    check(useApp.getState().sequences.find(s => s.id === seq.id)!.clips.find(c => c.id === clip.id)!.text!.content === original, 'undo fails')
    flushSync(() => root.render(<FancyTextPanel />))
    check(!host.querySelector('[data-testid="dynamic-controls"]'), 'font editor must not edit dynamic clips')
    flushSync(() => root.render(<SkillsPanel />))
    check(host.querySelector('[data-testid="skill-prompt"]'), 'extension must open narration input')
    check(host.querySelector('[data-testid="skill-generate"]')?.textContent?.includes('一键成片'), 'extension must use production action')
    check(host.querySelector('[data-testid="skill-auto-timeline"]'), 'extension must offer automatic timeline placement')
  } finally { root.unmount(); host.remove() }
})

let gallery: string | undefined
const exportFixtures: any[] = []
test('produce reference frames for independently loaded export renderer', () => {
  for (let i = 0; i < 6; i++) {
    const text = textFor(i)
    text.fancy!.dynamic!.duration = 1.5
    exportFixtures.push({ text, time: 0.75, duration: 1.5, w: 640, h: 360, png: render(text, 0.75, 640, 360, 1.5).toDataURL('image/png').split(',')[1] })
  }
})
test('generate acceptance gallery', () => {
  const c = document.createElement('canvas'); c.width = 1200; c.height = 780
  const x = c.getContext('2d')!; x.fillStyle = '#161a21'; x.fillRect(0, 0, c.width, c.height)
  for (let i = 0; i < 6; i++) {
    const px = (i % 2) * 600, py = Math.floor(i / 2) * 260
    x.fillStyle = '#242b36'; x.fillRect(px + 12, py + 12, 576, 238)
    x.drawImage(render(textFor(i), 1.2, 576, 200), px + 12, py + 32)
    x.font = '18px "Microsoft YaHei"'; x.fillStyle = '#e8edf6'; x.fillText(presets()[i].name, px + 28, py + 36)
  }
  gallery = c.toDataURL('image/png')
})
;(window as any).dynamicTests = chain.then(() => ({ results, failed: results.filter(r => !r.ok).length, gallery, exportFixtures }))
