/**
 * Program 监视器：交互走 Canvas2D；静止后防抖 C++ EditGraph compose → WebGL（与导出同规则）。
 * 卡顿主因曾是 scrub 每帧 spawn 引擎进程 + 工程全分辨率合成。
 */
import type { MediaItem, ProjectSettings, Sequence } from '../types'
import { buildEditGraph } from './editGraph'
import { desktop } from './desktop'
import { presentOnGpu } from './gpuPresent'
import { renderProgramOverlay } from './monitorDraw'
import type { SnapGuide } from './monitorSnap'

type CacheEntry = { key: string; dataUrl: string; backend?: string }

let cache: CacheEntry | null = null
let inflight: Promise<string | null> | null = null
let inflightKey = ''
let lastPresentBackend: 'webgl' | 'canvas2d' | 'none' = 'none'
let upgradeTimer: ReturnType<typeof setTimeout> | null = null
let upgradeGen = 0

export function lastComposePresentBackend() {
  return lastPresentBackend
}

function graphKey(
  seq: Sequence,
  media: MediaItem[],
  settings: ProjectSettings,
  t: number,
  pw: number,
  ph: number,
) {
  const fps = Math.max(1, settings.fps)
  const frame = Math.floor(t * fps + 1e-6)
  return `${seq.id}:${frame}:${pw}x${ph}:${seq.clips.map((c) => c.id).join(',')}`
}

export async function fetchComposePreview(
  seq: Sequence,
  media: MediaItem[],
  settings: ProjectSettings,
  t: number,
  previewW: number,
  previewH: number,
): Promise<string | null> {
  const api = desktop()
  if (!api?.composeFrame) return null
  const pw = Math.max(16, previewW | 0)
  const ph = Math.max(16, previewH | 0)
  const key = graphKey(seq, media, settings, t, pw, ph)
  if (cache?.key === key) return cache.dataUrl
  if (inflight && inflightKey === key) return inflight

  const graph = buildEditGraph({
    clips: seq.clips,
    tracks: seq.tracks,
    media,
    settings: { width: pw, height: ph, fps: settings.fps },
    workIn: seq.workIn,
    workOut: seq.workOut,
  })
  inflightKey = key
  inflight = api
    .composeFrame(graph, Math.max(0, t), 12000)
    .then((r) => {
      if (!r.ok || !r.dataUrl) return null
      cache = { key, dataUrl: r.dataUrl, backend: r.backend }
      return r.dataUrl
    })
    .catch(() => null)
    .finally(() => {
      if (inflightKey === key) {
        inflight = null
        inflightKey = ''
      }
    })
  return inflight
}

function loadImage(dataUrl: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = dataUrl
  })
}

function blit2d(canvas: HTMLCanvasElement, img: CanvasImageSource, w: number, h: number) {
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.fillStyle = '#0b0d10'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(img, 0, 0, w, h)
}

export type ComposePaintOpts = {
  canvas: HTMLCanvasElement
  overlay?: HTMLCanvasElement | null
  seq: Sequence
  media: MediaItem[]
  settings: ProjectSettings
  t: number
  w: number
  h: number
  selectedIds?: string[]
  showMotionPath?: boolean
  guides?: SnapGuide[]
}

/** GPU 出画到底图层；失败回退 2d。叠层画在 overlay（2d）。 */
export async function paintProgramViaCompose(opts: ComposePaintOpts): Promise<boolean> {
  const url = await fetchComposePreview(
    opts.seq, opts.media, opts.settings, opts.t, opts.w, opts.h,
  )
  if (!url) {
    lastPresentBackend = 'none'
    return false
  }
  const img = await loadImage(url)
  if (!img) {
    lastPresentBackend = 'none'
    return false
  }

  const gpuOk = presentOnGpu(opts.canvas, img, opts.w, opts.h)
  if (gpuOk) {
    lastPresentBackend = 'webgl'
  } else {
    blit2d(opts.canvas, img, opts.w, opts.h)
    lastPresentBackend = 'canvas2d'
  }

  const overlay = opts.overlay
  if (overlay) {
    if (overlay.width !== opts.w || overlay.height !== opts.h) {
      overlay.width = opts.w
      overlay.height = opts.h
    }
    const octx = overlay.getContext('2d')
    if (octx) {
      octx.clearRect(0, 0, opts.w, opts.h)
      renderProgramOverlay(
        overlay,
        opts.seq,
        opts.settings,
        opts.t,
        opts.w,
        opts.h,
        opts.selectedIds ?? [],
        opts.showMotionPath ?? false,
        opts.guides,
      )
    }
  } else if (!gpuOk) {
    renderProgramOverlay(
      opts.canvas,
      opts.seq,
      opts.settings,
      opts.t,
      opts.w,
      opts.h,
      opts.selectedIds ?? [],
      opts.showMotionPath ?? false,
      opts.guides,
    )
  }
  return true
}

/** 拖 scrub 时防抖再 compose，避免每帧 spawn 引擎。 */
export function scheduleComposeUpgrade(
  opts: ComposePaintOpts,
  onDone?: (ok: boolean) => void,
  delayMs = 400,
) {
  const gen = ++upgradeGen
  if (upgradeTimer) clearTimeout(upgradeTimer)
  upgradeTimer = setTimeout(() => {
    upgradeTimer = null
    void paintProgramViaCompose(opts).then((ok) => {
      if (gen !== upgradeGen) return
      onDone?.(ok)
    })
  }, delayMs)
}

export function cancelComposeUpgrade() {
  upgradeGen++
  if (upgradeTimer) {
    clearTimeout(upgradeTimer)
    upgradeTimer = null
  }
}
