import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Timeline } from '../src/components/Timeline'
import { Monitor } from '../src/components/Monitor'
import { useApp } from '../src/store'
import { tidyTimeline } from '../src/lib/timelineTidy'
import { renderProgramFrame } from '../src/lib/monitorDraw'
import { getLivePlayhead, setLivePlayhead } from '../src/lib/livePlayhead'
import { PlayheadOverlay } from '../src/components/PlayheadOverlay'
import { notifyPreviewCacheChanged, createPreviewCache, autoCacheProgramFrames, cancelPrefetchProgramFrames } from '../src/lib/previewCache'
import { defaultAudio, defaultColor, defaultTransform, defaultScene3d, defaultText, type Clip, type Sequence, type Track } from '../src/types'

const track = (id: string, props: Partial<Track> = {}): Track => ({ id, name: id, kind: 'video', locked: false, muted: false, hidden: false, solo: false, height: 48, ...props })
const clip = (id: string, trackId: string, start: number, duration: number, color: string, props: Partial<Clip> = {}): Clip => ({ id, trackId, name: id, start, duration, inPoint: 0, outPoint: duration, enabled: true, speed: 1, reverse: false, speedKeyframes: [], transform: defaultTransform(), color: defaultColor(), audio: defaultAudio(), effects: [], keyframes: {}, blend: 'normal', solid: { color }, ...props })
const sequence: Sequence = { id: 'tidy', name: 'tidy', tracks: [track('v1'), track('v2'), track('v3'), track('v4'), track('a', { kind: 'audio' })],
  clips: [clip('top', 'v1', 0, 2, '#ff0000', { transform: { ...defaultTransform(), opacity: 0.6, x: 0.25, scaleX: 0.4 } }),
    clip('middle', 'v2', 0, 4, '#00ff00'), clip('lower', 'v3', 2, 2, '#0000ff'),
    clip('later', 'v4', 4, 2, '#ff00ff', { text: { ...defaultText(), content: 'Layer', fontSize: 30 } })],
  workIn: 0, workOut: 6, markers: [], scene3d: defaultScene3d() }
const results: { name: string; ok: boolean; error?: string }[] = []
function check(ok: unknown, message: string) { if (!ok) throw new Error(message) }
let chain = Promise.resolve()
function test(name: string, fn: () => void | Promise<void>) {
  chain = chain.then(async () => {
    try {
      await fn()
      results.push({ name, ok: true })
    } catch (e) { results.push({ name, ok: false, error: String(e) }) }
  })
}
function frames() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      flushSync(() => {})
      requestAnimationFrame(() => {
        flushSync(() => {})
        resolve()
      })
    })
  })
}
const settings = { ...useApp.getState().settings, width: 320, height: 180, safeFrame: false }
const pixels = (seq: Sequence, t: number) => {
  const canvas = document.createElement('canvas')
  renderProgramFrame(canvas, seq, [], settings, t, new Map(), 320, 180, [], undefined, false, undefined, true)
  return canvas.getContext('2d')!.getImageData(0, 0, 320, 180).data
}
test('consolidation preserves actual Canvas pixels across cuts, transparency and text', () => {
  const tidied = tidyTimeline(sequence)
  check(tidied.tracks.length < sequence.tracks.length, 'fixture did not consolidate')
  for (const t of [0, 1.5, 1.999, 2, 3.5, 4, 5.5, 6, 0.5]) {
    const before = pixels(sequence, t), after = pixels(tidied, t)
    check(before.every((v, i) => v === after[i]), `pixels differ at ${t}`)
  }
})
test('toolbar button consolidates once; undo and redo restore exact sequence', () => {
  useApp.setState({ sequences: [sequence], activeSeqId: sequence.id, selectedClipIds: ['later'], settings,
    history: [], future: [], playing: false })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  flushSync(() => root.render(<Timeline />))
  const btn = container.querySelector<HTMLButtonElement>('[data-testid="btn-tidy-timeline"]')
  check(btn?.textContent?.includes('一键整理'), 'missing visible button')
  flushSync(() => btn!.click())
  const result = JSON.stringify(useApp.getState().seq())
  check(useApp.getState().seq().tracks.length === 4, 'button did not remove spare track')
  check(useApp.getState().selectedClipIds[0] === 'later', 'selection lost')
  check(useApp.getState().history.length === 1, 'must create one undo step')
  flushSync(() => btn!.click())
  check(useApp.getState().history.length === 1, 'no-op polluted undo history')
  flushSync(() => useApp.getState().undo())
  check(JSON.stringify(useApp.getState().seq()) === JSON.stringify(sequence), 'undo did not restore exact sequence')
  flushSync(() => useApp.getState().redo())
  check(JSON.stringify(useApp.getState().seq()) === result, 'redo did not restore exact sequence')
  root.unmount()
})
test('Alt wheel keeps the timeline time under the mouse fixed', async () => {
  useApp.setState({ sequences: [{ ...sequence, workOut: 100 }], activeSeqId: sequence.id, timelineZoom: 50, selectedClipIds: ['later'] })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  flushSync(() => root.render(<Timeline />))
  const body = container.querySelector<HTMLDivElement>('[data-testid="timeline-body"]')!
  Object.assign(body.style, { width: '600px', overflow: 'auto', maxWidth: '600px' })
  body.scrollLeft = 900
  const x = body.getBoundingClientRect().left + 200
  const before = (body.scrollLeft + 200) / useApp.getState().timelineZoom
  const zoom = async (deltaY: number) => {
    body.dispatchEvent(new WheelEvent('wheel', { clientX: x, deltaY, altKey: true, bubbles: true, cancelable: true }))
    await frames()
    const pps = useApp.getState().timelineZoom
    const layer = container.querySelector<HTMLElement>('[data-testid="timeline-geometry"]')
    const scale = layer ? new DOMMatrix(layer.style.transform).a : 1
    check(container.querySelector('[data-testid="clip-later"]'), 'selected offscreen clip was unmounted')
    for (const c of sequence.clips) {
      const el = container.querySelector<HTMLElement>(`[data-testid="clip-${c.id}"]`)
      if (!el) continue
      check(Math.abs(parseFloat(el.style.left) * scale - c.start * pps) < 0.001, 'clip position lost zoom')
      check(Math.abs(parseFloat(el.style.width) * scale - Math.max(1, c.duration * pps)) < 0.001, 'clip width lost zoom')
    }
  }
  await zoom(-100)
  check(Math.abs((body.scrollLeft + 200) / useApp.getState().timelineZoom - before) < 0.02, 'zoom moved time away from cursor')
  await zoom(100)
  check(Math.abs((body.scrollLeft + 200) / useApp.getState().timelineZoom - before) < 0.02, 'zoom out moved time away from cursor')
  body.dispatchEvent(new WheelEvent('wheel', { clientX: x, deltaY: -100, altKey: true, bubbles: true, cancelable: true }))
  body.dispatchEvent(new WheelEvent('wheel', { clientX: x, deltaY: -100, altKey: true, bubbles: true, cancelable: true }))
  await frames()
  check(Math.abs((body.scrollLeft + 200) / useApp.getState().timelineZoom - before) < 0.02, 'batched wheel events lost anchor')
  root.unmount()
})
test('Ctrl wheel keeps the preview image point under the mouse fixed', () => {
  useApp.setState({ sequences: [sequence], activeSeqId: sequence.id, playing: false, playhead: 0, settings, monitorCompose: '2d' })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  flushSync(() => root.render(<Monitor mode="program" />))
  const viewport = container.querySelector<HTMLDivElement>('[data-testid="program-viewport"]')!
  Object.assign(viewport.style, { position: 'relative', width: '600px', height: '400px' })
  const rect = viewport.getBoundingClientRect()
  const clientX = Math.round(rect.left) + 450
  const clientY = Math.round(rect.top) + 100
  flushSync(() => viewport.dispatchEvent(new WheelEvent('wheel', { clientX, clientY,
    deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true })))
  const canvas = container.querySelector<HTMLCanvasElement>('[data-testid="program-canvas"]')!
  const matrix = new DOMMatrix(getComputedStyle(canvas).transform)
  const ox = clientX - rect.left - viewport.clientWidth / 2
  const oy = clientY - rect.top - viewport.clientHeight / 2
  check(Math.abs((ox - matrix.e) / matrix.a - ox) < 0.05, 'preview horizontal cursor anchor moved')
  check(Math.abs((oy - matrix.f) / matrix.d - oy) < 0.05, 'preview vertical cursor anchor moved')
  root.unmount()
})

test('continuous zoom reuses clip geometry and settles before editing', async () => {
  useApp.setState({ sequences: [{ ...sequence, workOut: 100 }], activeSeqId: sequence.id,
    timelineZoom: 50, selectedClipIds: [], settings: { ...settings, snap: false }, playing: false, history: [], future: [] })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    flushSync(() => root.render(<Timeline />))
    const el = container.querySelector<HTMLElement>('[data-testid="clip-later"]')!
    const left = el.style.left, width = el.style.width
    await frames()
    const readLabelPixels = (start = 4) => {
      const canvas = container.querySelector<HTMLCanvasElement>('[data-testid="timeline-labels"]')!
      check(canvas, 'missing independent text layer')
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const body = container.querySelector<HTMLElement>('[data-testid="timeline-body"]')!
      const x = (start * useApp.getState().timelineZoom + 6 - body.scrollLeft) * dpr
      const y = (144 + 6 - parseFloat(canvas.style.top)) * dpr
      return canvas.getContext('2d')!.getImageData(Math.round(x), Math.round(y), Math.round(32 * dpr), Math.round(14 * dpr)).data
    }
    const textPixels = readLabelPixels()
    check(textPixels.some((v, i) => i % 4 === 3 && v > 0), 'text fixture has no glyph pixels')
    flushSync(() => useApp.getState().setTimelineZoom(55))
    flushSync(() => useApp.getState().setTimelineZoom(60))
    const zoomedTextPixels = readLabelPixels()
    const pixelWidth = Math.round(32 * Math.min(2, window.devicePixelRatio || 1))
    const bounds = (pixels: Uint8ClampedArray) => {
      let x0 = pixelWidth, x1 = -1, y0 = 1000, y1 = -1
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 10) {
        const x = ((i - 3) / 4) % pixelWidth, y = Math.floor((i - 3) / 4 / pixelWidth)
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
      }
      return [x0, x1, y0, y1]
    }
    // Raster alpha may differ at fractional device-pixel positions; glyph
    // extents must remain identical, rather than stretching with the track.
    check(bounds(textPixels).every((v, i) => v === bounds(zoomedTextPixels)[i]), 'continuous zoom stretches glyph bounds')
    check(el.style.left === left && el.style.width === width, 'zoom relaid out each clip instead of reusing geometry')
    const layer = container.querySelector<HTMLElement>('[data-testid="timeline-geometry"]')!
    check(Math.abs(new DOMMatrix(layer.style.transform).a - 1.2) < 0.001, 'preview transform does not match current zoom')
    setLivePlayhead(2)
    const ph = container.querySelector<HTMLElement>('[data-testid="playhead-layer"]')!
    check(Math.abs(new DOMMatrix(ph.style.transform).m41 - 119) < 0.001, 'playhead does not use current zoom')
    check(!layer.contains(ph), 'playhead is scaled twice')
    // Synthetic pointer events cannot acquire OS pointer capture; exercise the
    // real drag handlers with that browser boundary stubbed.
    el.setPointerCapture = () => {}
    const rect = el.getBoundingClientRect()
    const x = rect.left + 20, y = rect.top + rect.height / 2
    flushSync(() => el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 9, clientX: x, clientY: y })))
    check(parseFloat(el.style.left) === 240 && parseFloat(el.style.width) === 120, 'editing started with stale geometry')
    flushSync(() => window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 9, buttons: 1, clientX: x + 60, clientY: y })))
    await Promise.resolve()
    check(bounds(textPixels).every((v, i) => v === bounds(readLabelPixels(5))[i]), 'canvas label did not follow the live drag preview')
    flushSync(() => window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 9, clientX: x + 60, clientY: y })))
    await frames()
    const movedClip = useApp.getState().seq().clips.find(c => c.id === 'later')!
    check(Math.abs(movedClip.start - 5) < 0.001, `drag after zoom used stale pixels per second: ${movedClip.start}, track ${movedClip.trackId}, x ${x}, y ${y}, tool ${useApp.getState().tool}`)
    flushSync(() => useApp.getState().undo())
    check(useApp.getState().seq().clips.find(c => c.id === 'later')!.start === 4, 'drag after zoom cannot be undone')
    flushSync(() => useApp.getState().setTimelineZoom(45))
    await new Promise(resolve => setTimeout(resolve, 180))
    flushSync(() => {})
    check(parseFloat(el.style.left) === 180 && parseFloat(el.style.width) === 90, 'idle zoom did not materialize exact geometry')
    check(new DOMMatrix(layer.style.transform).a === 1, 'idle transform was not cleared')
  } finally { root.unmount(); container.remove() }
})

test('sequence switch cancels pending zoom geometry from the previous sequence', async () => {
  useApp.setState({ sequences: [sequence], activeSeqId: sequence.id, timelineZoom: 50, selectedClipIds: [] })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    flushSync(() => root.render(<Timeline />))
    flushSync(() => useApp.getState().setTimelineZoom(80))
    const next = { ...sequence, id: 'next', clips: [clip('next-clip', 'v1', 1, 3, '#123456')] }
    flushSync(() => useApp.setState({ sequences: [sequence, next], activeSeqId: next.id, timelineZoom: 20 }))
    await new Promise(resolve => setTimeout(resolve, 180))
    flushSync(() => {})
    const el = container.querySelector<HTMLElement>('[data-testid="clip-next-clip"]')!
    check(parseFloat(el.style.left) === 20 && parseFloat(el.style.width) === 60, 'old zoom timer changed new sequence geometry')
    check(!container.querySelector('[data-testid="clip-later"]'), 'previous sequence clips leaked')
  } finally { root.unmount(); container.remove() }
})

test('zooming during a clip drag keeps preview and committed drop aligned', async () => {
  const seq = { ...sequence, tracks: [track('v1')], clips: [clip('moving', 'v1', 4, 2, '#123456')], workOut: 100 }
  useApp.setState({ sequences: [seq], activeSeqId: seq.id, timelineZoom: 50,
    selectedClipIds: [], settings: { ...settings, snap: false }, tool: 'select' })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    flushSync(() => root.render(<Timeline />))
    const el = container.querySelector<HTMLElement>('[data-testid="clip-moving"]')!
    el.setPointerCapture = () => {}
    const r = el.getBoundingClientRect(), x = r.left + 20, y = r.top + r.height / 2
    flushSync(() => el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 11, clientX: x, clientY: y })))
    flushSync(() => window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 11, buttons: 1, clientX: x + 50, clientY: y })))
    flushSync(() => useApp.getState().setTimelineZoom(100))
    flushSync(() => window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 11, buttons: 1, clientX: x + 100, clientY: y })))
    const previewLeft = el.getBoundingClientRect().left
    flushSync(() => window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 11, clientX: x + 100, clientY: y })))
    await frames()
    const dropLeft = container.querySelector<HTMLElement>('[data-testid="clip-moving"]')!.getBoundingClientRect().left
    check(Math.abs(previewLeft - dropLeft) < 1, `drag preview jumped on drop: ${previewLeft} -> ${dropLeft}`)
  } finally { root.unmount(); container.remove() }
})
test('cache progress does not enumerate timeline tracks again', async () => {
  let reads = 0
  const seq = { ...sequence, get tracks() { reads++; return sequence.tracks } }
  useApp.setState({ sequences: [seq], activeSeqId: seq.id, playing: false })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    flushSync(() => root.render(<Timeline />))
    await frames()
    reads = 0
    flushSync(() => notifyPreviewCacheChanged(true))
    check(reads === 0, `cache progress revisited tracks ${reads} times`)
  } finally { root.unmount(); container.remove() }
})

test('reversing zoom keeps edge clips mounted until the gesture settles', async () => {
  const seq = { ...sequence, clips: [...sequence.clips, clip('edge', 'v1', 18, 2, '#123456')], workOut: 100 }
  useApp.setState({ sequences: [seq], activeSeqId: seq.id, timelineZoom: 50, selectedClipIds: [] })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    flushSync(() => root.render(<Timeline />))
    const body = container.querySelector<HTMLElement>('[data-testid="timeline-body"]')!
    Object.assign(body.style, { width: '600px', maxWidth: '600px' })
    await frames()
    const edge = container.querySelector('[data-testid="clip-edge"]')
    check(edge, 'edge fixture is not initially visible')
    flushSync(() => useApp.getState().setTimelineZoom(100))
    check(container.querySelector('[data-testid="clip-edge"]') === edge, 'continuous zoom unmounted an edge clip')
    flushSync(() => useApp.getState().setTimelineZoom(50))
    check(container.querySelector('[data-testid="clip-edge"]') === edge, 'zoom reversal recreated an edge clip')
    flushSync(() => useApp.getState().setTimelineZoom(100))
    await new Promise(resolve => setTimeout(resolve, 180))
    flushSync(() => {})
    check(!container.querySelector('[data-testid="clip-edge"]'), 'idle zoom retained offscreen clips')
  } finally { root.unmount(); container.remove() }
})

test('playhead advances between video frames', async () => {
  useApp.setState({ sequences: [sequence], activeSeqId: sequence.id, media: [], playing: false,
    playhead: 0, settings: { ...settings, fps: 1 }, monitorCompose: '2d' })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    flushSync(() => root.render(<Monitor mode="program" />))
    flushSync(() => useApp.setState({ playing: true }))
    await frames()
    const t = getLivePlayhead()
    check(t > 0 && Math.abs(t - Math.round(t)) > 0.0001, `clock is locked to video frames: ${t}`)
  } finally {
    flushSync(() => useApp.setState({ playing: false }))
    root.unmount(); container.remove()
  }
})

test('background preview yields while a text editor is focused and resumes after blur', async () => {
  const originalIdle = window.requestIdleCallback
  const pending: (() => void)[] = []
  window.requestIdleCallback = cb => { pending.push(() => cb({ didTimeout: false, timeRemaining: () => 50 })); return 1 }
  const input = document.createElement('textarea')
  document.body.append(input)
  const cache = createPreviewCache()
  try {
    await new Promise(resolve => setTimeout(resolve, 250))
    input.focus()
    autoCacheProgramFrames({ cache, fromFrame: 0, fps: 1, seq: sequence, media: [], settings, imgCache: new Map(), maxEdge: 64 })
    check(pending.length, 'background worker was not scheduled')
    pending.shift()!()
    check(cache.frames.size === 0, 'background frame composition competed with prompt input')
    input.blur()
    await new Promise(resolve => setTimeout(resolve, 250))
    check(pending.length, 'background worker did not resume after blur')
    pending.shift()!()
    check(cache.frames.size > 0, 'background cache did not progress after input ended')
  } finally {
    cancelPrefetchProgramFrames()
    input.remove()
    window.requestIdleCallback = originalIdle
  }
})

test('multi-clip drag across tracks keeps each clip on its own lane and stacking order', async () => {
  const base: Sequence = { ...sequence, tracks: [track('v1'), track('v2'), track('v3'), track('v4'), track('a', { kind: 'audio' })],
    clips: [clip('p', 'v2', 0, 2, '#ff0000'), clip('q', 'v3', 0, 2, '#00ff00')], workOut: 10 }
  const lanes = () => {
    const s = useApp.getState().seq()
    const idx = (id: string) => s.tracks.findIndex(t => t.id === s.clips.find(c => c.id === id)!.trackId)
    return { s, p: idx('p'), q: idx('q'), pt: s.clips.find(c => c.id === 'p')!.trackId, qt: s.clips.find(c => c.id === 'q')!.trackId }
  }
  const drag = async (primaryId: string, trackId?: string, spawn?: 'before' | 'after') => {
    useApp.setState({ sequences: [base], activeSeqId: base.id, selectedClipIds: ['p', 'q'], playing: false })
    useApp.getState().dragMoveClips(['p', 'q'], { p: 0, q: 0 }, 1, trackId, { primaryId, alt: true, spawn })
    await frames()
    return lanes()
  }
  let r = await drag('p', 'v1')
  check(r.pt === 'v1' && r.qt === 'v2', `up: p=${r.pt} q=${r.qt}`)
  r = await drag('q', 'v4')
  check(r.pt === 'v3' && r.qt === 'v4', `down: p=${r.pt} q=${r.qt}`)
  r = await drag('p', undefined, 'before')
  check(r.pt !== r.qt && r.p < r.q && r.q - r.p === 1, `spawn above: p=${r.p} q=${r.q}`)
  check(r.s.clips.every(c => c.start === 1), 'time offset not applied to the whole selection')
})

test('live playhead moves immediately without waiting for a React commit', () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    setLivePlayhead(0)
    flushSync(() => root.render(<PlayheadOverlay xAt={t => t * 50} />))
    setLivePlayhead(1.125)
    const el = container.querySelector<HTMLElement>('[data-testid="playhead-layer"]')!
    check(Math.abs(new DOMMatrix(el.style.transform).m41 - (getLivePlayhead() * 50 - 1)) < 0.001, 'playhead awaits React commit')
    flushSync(() => root.render(<PlayheadOverlay xAt={t => t * 100} />))
    check(Math.abs(new DOMMatrix(el.style.transform).m41 - 111.5) < 0.001, 'zoom did not reposition playhead')
  } finally { root.unmount(); container.remove() }
})
;(window as any).tidyTests = chain.then(() => ({ results, failed: results.filter(r => !r.ok).length }))
