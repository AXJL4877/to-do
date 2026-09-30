import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Timeline } from '../src/components/Timeline'
import { Monitor } from '../src/components/Monitor'
import { useApp } from '../src/store'
import { setLivePlayhead } from '../src/lib/livePlayhead'
import { notifyPreviewCacheChanged } from '../src/lib/previewCache'
import { renderProgramFrame } from '../src/lib/monitorDraw'
import { defaultAudio, defaultColor, defaultScene3d, defaultTransform, type Clip, type MediaItem, type Sequence, type Track } from '../src/types'

/** 模拟 N 条黑板报任务：每条 1 段配音 + 若干块黑板 × 3 个元素（书写 + 定格）；元素用图片素材 */
const JOBS = Number(new URLSearchParams(location.search).get('jobs') || 10)
const track = (id: string, kind: Track['kind'] = 'video'): Track => ({ id, name: id, kind, locked: false, muted: false, hidden: false, solo: false, height: kind === 'audio' ? 40 : 48 })
const clip = (id: string, trackId: string, start: number, duration: number, props: Partial<Clip> = {}): Clip => ({
  id, trackId, name: id, start, duration, inPoint: 0, outPoint: duration, enabled: true, speed: 1, reverse: false, speedKeyframes: [],
  transform: defaultTransform(), color: defaultColor(), audio: defaultAudio(), effects: [], keyframes: {}, blend: 'normal', ...props,
})

function imageUrl(i: number) {
  const c = document.createElement('canvas')
  c.width = 256; c.height = 256
  const g = c.getContext('2d')!
  g.fillStyle = `hsl(${(i * 47) % 360} 60% 50%)`
  g.fillRect(20, 20, 216, 216)
  return c.toDataURL('image/png')
}

const media: MediaItem[] = []
const tracks: Track[] = [track('v1'), track('v2'), track('v3'), track('a1', 'audio')]
const clips: Clip[] = []
let t = 0
for (let j = 0; j < JOBS; j++) {
  const boards = 6
  const jobStart = t
  for (let b = 0; b < boards; b++) {
    const bs = t, be = t + 6
    for (let k = 0; k < 3; k++) {
      const id = `m${j}_${b}_${k}`
      media.push({ id, name: id, kind: 'image', url: imageUrl(media.length), duration: 5, width: 256, height: 256, folderId: 'root', favorite: false, offline: false })
      const at = bs + k * 1.5
      const tr = { ...defaultTransform(), x: (k - 1) * 0.3, scaleX: 0.3, scaleY: 0.3 }
      clips.push(clip(`${id}_draw`, `v${k + 1}`, at, 1.2, { mediaId: id, transform: tr }))
      clips.push(clip(`${id}_hold`, `v${k + 1}`, at + 1.2, be - at - 1.2, { mediaId: id, transform: tr }))
    }
    t = be
  }
  clips.push(clip(`voice${j}`, 'a1', jobStart, t - jobStart, { solid: undefined }))
}
const seq: Sequence = { id: 'perf', name: 'perf', tracks, clips, workIn: 0, workOut: t, markers: [], scene3d: defaultScene3d() }

type Stat = { name: string; n: number; avg: number; p95: number; max: number }
const stats: Stat[] = []
function bench(name: string, n: number, fn: (i: number) => void) {
  const xs: number[] = []
  const work: number[] = [], layout: number[] = []
  for (let i = 0; i < n; i++) {
    const a = performance.now()
    fn(i)
    const b = performance.now()
    void document.body.offsetHeight
    const c = performance.now()
    xs.push(c - a)
    work.push(b - a); layout.push(c - b)
  }
  xs.sort((a, b) => a - b)
  stats.push({ name, n, avg: +(xs.reduce((s, x) => s + x, 0) / n).toFixed(2), p95: +xs[Math.floor(n * 0.95)].toFixed(2), max: +xs[n - 1].toFixed(2) })
  if (name === 'zoom committed layout') {
    for (const [label, times] of [['commit', work], ['forced layout', layout]] as const) {
      times.sort((a, b) => a - b)
      stats.push({ name: `zoom ${label}`, n, avg: times.reduce((a, b) => a + b, 0) / n, p95: times[Math.floor(n * 0.95)], max: times[n - 1] })
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function run() {
  useApp.setState({
    sequences: [seq], activeSeqId: seq.id, media, playing: false, playhead: 0, timelineZoom: 40, started: true,
    settings: { ...useApp.getState().settings, width: 1920, height: 1080, fps: 30 },
  })
  const host = document.createElement('div')
  Object.assign(host.style, { width: '1600px', height: '900px', display: 'flex', flexDirection: 'column' })
  document.body.append(host)
  const monHost = document.createElement('div')
  Object.assign(monHost.style, { width: '960px', height: '540px', position: 'relative' })
  const tlHost = document.createElement('div')
  Object.assign(tlHost.style, { width: '1600px', height: '360px' })
  host.append(monHost, tlHost)
  const t0 = performance.now()
  const mon = createRoot(monHost)
  const tl = createRoot(tlHost)
  flushSync(() => { mon.render(<Monitor mode="program" />); tl.render(<Timeline />) })
  const mount = performance.now() - t0
  await sleep(1500)

  const body = tlHost.querySelector<HTMLDivElement>('[data-testid="timeline-body"]')!
  const x = body.getBoundingClientRect().left + 400
  const wheel = (deltaY: number, mods: Partial<WheelEventInit>) => body.dispatchEvent(new WheelEvent('wheel', { clientX: x, deltaY, bubbles: true, cancelable: true, ...mods }))

  // Include the deferred wheel callback and its React commit, not just dispatch.
  const wheelSamples: number[] = []
  for (let i = 0; i < (new URLSearchParams(location.search).get('layoutOnly') === '1' ? 0 : 40); i++) {
    await new Promise<void>(resolve => requestAnimationFrame(() => {
      const start = performance.now()
      wheel(i % 20 < 10 ? -100 : 100, { altKey: true })
      requestAnimationFrame(() => {
        flushSync(() => {})
        void body.offsetHeight
        wheelSamples.push(performance.now() - start)
        resolve()
      })
    }))
  }
  wheelSamples.sort((a, b) => a - b)
  if (wheelSamples.length) stats.push({ name: 'wheel event to committed layout (includes frame wait)', n: 40,
    avg: wheelSamples.reduce((a, b) => a + b, 0) / 40, p95: wheelSamples[38], max: wheelSamples[39] })
  bench('zoom committed layout', 60, i => flushSync(() => useApp.getState().setTimelineZoom(3.6 + (i % 20) * 0.1)))
  // Materialize through the real pointer-capture path before the next operation.
  // Right button is ignored by the timeline's editing handlers.
  const beforeMaterialize = performance.now()
  flushSync(() => body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 2 })))
  void document.body.offsetHeight
  const materializeMs = performance.now() - beforeMaterialize
  stats.push({ name: 'final geometry materialization', n: 1, avg: materializeMs, p95: materializeMs, max: materializeMs })
  bench('cache progress update', 60, () => flushSync(() => notifyPreviewCacheChanged(true)))
  bench('scroll timeline (scrollLeft)', 60, (i) => { body.scrollLeft = (i % 30) * 120; body.dispatchEvent(new Event('scroll')) })
  bench('scrub playhead (live + monitor paint)', 120, (i) => setLivePlayhead(1 + (i * 0.37) % (t - 2)))
  bench('store setPlayhead (seek)', 40, (i) => flushSync(() => useApp.getState().setPlayhead(2 + (i * 1.3) % (t - 4))))
  const canvas = document.createElement('canvas')
  bench('renderProgramFrame 960x540', 60, (i) => renderProgramFrame(canvas, seq, media, useApp.getState().settings, 1 + (i * 0.37) % (t - 2), new Map(), 960, 540, [], undefined, false, undefined, true))
  bench('select clip (store)', 30, (i) => flushSync(() => useApp.getState().selectClips([clips[(i * 7) % clips.length].id])))
  await sleep(180)
  flushSync(() => {})
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))

  const clipEls = tlHost.querySelectorAll('[data-testid^="clip-"]:not([data-testid*="trim"]):not([data-testid*="anim"]):not([data-testid*="speed"])').length
  ;(window as any).perfResult = { clips: clips.length, renderedClips: clipEls, duration: t, mountMs: +mount.toFixed(1), stats }
}
;(window as any).perfDone = run().catch((e) => { (window as any).perfResult = { error: String(e && e.stack || e) } })
