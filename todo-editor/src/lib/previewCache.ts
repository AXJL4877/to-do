import type { MediaItem, ProjectSettings, Sequence } from '../types'
import type { ImageCache } from './monitorDraw'
import { renderProgramFrame } from './monitorDraw'
import { anyVideoSeeking } from './videoCache'

/** 节目窗 RAM 帧缓存：固定分辨率，与监视器显示尺寸解耦，避免叠层改分辨率整表作废 */
export type PreviewRamCache = {
  fingerprint: string
  frames: Map<number, HTMLCanvasElement>
  bytes: number
  maxBytes: number
  hits: number
  misses: number
  cacheW: number
  cacheH: number
}

const MAX_BYTES = 512 * 1024 * 1024

let sharedCache = createPreviewCache()
let cacheRev = 0
let notifyTimer = 0
const cacheSubs = new Set<() => void>()

/** 预取：按播放头向前补帧 */
let prefetchGen = 0
let scratch: HTMLCanvasElement | null = null

export function createPreviewCache(): PreviewRamCache {
  return {
    fingerprint: '',
    frames: new Map(),
    bytes: 0,
    maxBytes: MAX_BYTES,
    hits: 0,
    misses: 0,
    cacheW: 0,
    cacheH: 0,
  }
}

export function getProgramPreviewCache() {
  return sharedCache
}

export function getPreviewCacheRev() {
  return cacheRev
}

export function subscribePreviewCache(onStoreChange: () => void) {
  cacheSubs.add(onStoreChange)
  return () => { cacheSubs.delete(onStoreChange) }
}

export function notifyPreviewCacheChanged(immediate = false) {
  if (immediate) {
    if (notifyTimer) {
      clearTimeout(notifyTimer)
      notifyTimer = 0
    }
    cacheRev++
    cacheSubs.forEach((cb) => cb())
    return
  }
  if (notifyTimer) return
  notifyTimer = window.setTimeout(() => {
    notifyTimer = 0
    cacheRev++
    cacheSubs.forEach((cb) => cb())
  }, 300)
}

/** 缓存分辨率：始终相对工程画幅，不跟叠层临时预览尺寸走 */
export function stableCacheSize(
  settings: ProjectSettings,
  maxEdge: number = 720,
): { w: number; h: number } {
  const edge = maxEdge > 0 ? maxEdge : 720
  return cachePixelSize(settings.width, settings.height, edge)
}

/** 内容指纹：尺寸用稳定缓存边，显示缩放变化不刷掉已缓存帧 */
export function previewFingerprint(
  seq: Sequence,
  settings: ProjectSettings,
  cacheW: number,
  cacheH: number,
): string {
  const clips = seq.clips.map((c) =>
    [
      c.id, c.trackId, c.mediaId ?? '', c.start, c.duration, c.inPoint, c.outPoint,
      c.enabled ? 1 : 0, c.speed, c.reverse ? 1 : 0, c.blend,
      JSON.stringify(c.transform),
      JSON.stringify(c.keyframes),
      JSON.stringify(c.color),
      c.text ? JSON.stringify(c.text) : '',
      JSON.stringify(c.effects),
      c.transitionOut ? JSON.stringify(c.transitionOut) : '',
    ].join(','),
  ).join('|')
  return [
    seq.id, cacheW, cacheH, settings.width, settings.height, settings.fps,
    settings.canvasBg, settings.canvasColor,
    seq.tracks.map((t) => `${t.id}:${t.kind}:${t.hidden ? 0 : 1}`).join(','),
    clips,
  ].join('#')
}

export function cachePixelSize(previewW: number, previewH: number, maxEdge: number = 720) {
  if (!maxEdge || maxEdge <= 0) return { w: previewW, h: previewH }
  const long = Math.max(previewW, previewH)
  if (long <= maxEdge) return { w: previewW, h: previewH }
  const s = maxEdge / long
  return {
    w: Math.max(1, Math.round(previewW * s)),
    h: Math.max(1, Math.round(previewH * s)),
  }
}

export function ensurePreviewFingerprint(
  cache: PreviewRamCache,
  fp: string,
  cacheW: number,
  cacheH: number,
) {
  if (cache.fingerprint === fp && cache.cacheW === cacheW && cache.cacheH === cacheH) return
  clearPreviewCache(cache)
  cache.fingerprint = fp
  cache.cacheW = cacheW
  cache.cacheH = cacheH
  notifyPreviewCacheChanged(true)
}

export function clearPreviewCache(cache: PreviewRamCache) {
  cache.frames.clear()
  cache.bytes = 0
  cache.hits = 0
  cache.misses = 0
  cache.fingerprint = ''
  cache.cacheW = 0
  cache.cacheH = 0
}

export function getCachedFrame(cache: PreviewRamCache, frame: number): HTMLCanvasElement | undefined {
  const hit = cache.frames.get(frame)
  if (hit) cache.hits++
  else cache.misses++
  return hit
}

function frameBytes(cache: PreviewRamCache) {
  return Math.max(1, cache.cacheW * cache.cacheH * 4)
}

function evictFarthest(cache: PreviewRamCache, keepNear: number) {
  const bytes = frameBytes(cache)
  while (cache.bytes + bytes > cache.maxBytes && cache.frames.size > 0) {
    let worst: number | null = null
    let worstDist = -1
    for (const f of cache.frames.keys()) {
      const d = Math.abs(f - keepNear)
      if (d > worstDist) {
        worstDist = d
        worst = f
      }
    }
    if (worst == null) break
    cache.frames.delete(worst)
    cache.bytes -= bytes
  }
}

function scratchCanvas(w: number, h: number) {
  if (!scratch) scratch = document.createElement('canvas')
  if (scratch.width !== w || scratch.height !== h) {
    scratch.width = w
    scratch.height = h
  }
  return scratch
}

export function putCachedFrame(
  cache: PreviewRamCache,
  frame: number,
  source: HTMLCanvasElement,
  keepNear = frame,
) {
  if (cache.frames.has(frame)) return
  if (!cache.cacheW || !cache.cacheH) return
  const bytes = frameBytes(cache)
  evictFarthest(cache, keepNear)
  const sheet = document.createElement('canvas')
  sheet.width = cache.cacheW
  sheet.height = cache.cacheH
  const ctx = sheet.getContext('2d')
  if (!ctx) return
  ctx.drawImage(source, 0, 0, cache.cacheW, cache.cacheH)
  cache.frames.set(frame, sheet)
  cache.bytes += bytes
  notifyPreviewCacheChanged()
}

export function blitCachedFrame(
  dest: HTMLCanvasElement,
  cached: HTMLCanvasElement,
  w: number,
  h: number,
) {
  if (dest.width !== w || dest.height !== h) {
    dest.width = w
    dest.height = h
  }
  const ctx = dest.getContext('2d')
  if (!ctx) return
  ctx.drawImage(cached, 0, 0, w, h)
}

/**
 * 节目底图呈现。
 * - 播放中：始终现场合成到 dest（不 blit 可能含黑帧的缓存），画面稳了再写入缓存
 * - 暂停/scrub：优先 blit 缓存
 */
export function presentCachedProgramFrame(
  cache: PreviewRamCache,
  frame: number,
  fps: number,
  dest: HTMLCanvasElement,
  seq: Sequence,
  media: MediaItem[],
  settings: ProjectSettings,
  imgCache: ImageCache,
  displayW: number,
  displayH: number,
  maxEdge = 720,
  opts?: { playing?: boolean },
): boolean {
  const { w: cw, h: ch } = stableCacheSize(settings, maxEdge)
  const fp = previewFingerprint(seq, settings, cw, ch)
  ensurePreviewFingerprint(cache, fp, cw, ch)
  const t = frame / Math.max(1, fps)

  // 播放：现场画，禁止用缓存盖住当前帧（缓存可能是 seek 中的黑帧）
  if (opts?.playing) {
    renderProgramFrame(dest, seq, media, settings, t, imgCache, displayW, displayH, [], undefined, false, undefined, true)
    if (!cache.frames.has(frame) && !anyVideoSeeking()) {
      const sheet = scratchCanvas(cw, ch)
      const sctx = sheet.getContext('2d')
      if (sctx) {
        sctx.drawImage(dest, 0, 0, cw, ch)
        putCachedFrame(cache, frame, sheet, frame)
      }
    }
    return false
  }

  const hit = getCachedFrame(cache, frame)
  if (hit) {
    blitCachedFrame(dest, hit, displayW, displayH)
    return true
  }

  renderProgramFrame(dest, seq, media, settings, t, imgCache, displayW, displayH, [], undefined, false, undefined, true)
  if (!anyVideoSeeking()) {
    const sheet = scratchCanvas(cw, ch)
    const sctx = sheet.getContext('2d')
    if (sctx) {
      sctx.drawImage(dest, 0, 0, cw, ch)
      putCachedFrame(cache, frame, sheet, frame)
    }
  }
  return false
}

/** @deprecated 用 presentCachedProgramFrame */
export function renderAndCacheFrame(
  cache: PreviewRamCache,
  frame: number,
  fps: number,
  dest: HTMLCanvasElement,
  seq: Sequence,
  media: MediaItem[],
  settings: ProjectSettings,
  imgCache: ImageCache,
  displayW: number,
  displayH: number,
): boolean {
  return presentCachedProgramFrame(
    cache, frame, fps, dest, seq, media, settings, imgCache, displayW, displayH,
  )
}

/** 播放时向前预取若干帧（每 idle 一片，不堵主线程） */
export function prefetchProgramFrames(opts: {
  cache: PreviewRamCache
  fromFrame: number
  fps: number
  seq: Sequence
  media: MediaItem[]
  settings: ProjectSettings
  imgCache: ImageCache
  maxEdge?: number
  ahead?: number
}) {
  const ahead = Math.max(1, Math.min(24, opts.ahead ?? 8))
  const gen = ++prefetchGen
  const maxEdge = opts.maxEdge ?? 720
  const { w: cw, h: ch } = stableCacheSize(opts.settings, maxEdge)
  const fp = previewFingerprint(opts.seq, opts.settings, cw, ch)
  ensurePreviewFingerprint(opts.cache, fp, cw, ch)

  let i = 1
  const step = () => {
    if (gen !== prefetchGen) return
    while (i <= ahead) {
      const f = opts.fromFrame + i
      i++
      if (opts.cache.frames.has(f)) continue
      const t = f / Math.max(1, opts.fps)
      const sheet = scratchCanvas(cw, ch)
      renderProgramFrame(
        sheet, opts.seq, opts.media, opts.settings, t, opts.imgCache,
        cw, ch, [], undefined, false, undefined, true,
      )
      putCachedFrame(opts.cache, f, sheet, opts.fromFrame)
      break
    }
    if (i <= ahead && gen === prefetchGen) {
      const ric = (window as Window & {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
      }).requestIdleCallback
      if (ric) ric(step, { timeout: 80 })
      else window.setTimeout(step, 0)
    }
  }
  const ric = (window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
  }).requestIdleCallback
  if (ric) ric(step, { timeout: 50 })
  else window.setTimeout(step, 0)
}

export function cancelPrefetchProgramFrames() {
  prefetchGen++
}

/** 连续帧合并为时间段；允许 ≤4 帧空隙 */
export function cachedTimeRanges(cache: PreviewRamCache, fps: number): { start: number; end: number }[] {
  if (!cache.frames.size || fps <= 0) return []
  const frames = [...cache.frames.keys()].sort((a, b) => a - b)
  const gapOk = 4
  const ranges: { start: number; end: number }[] = []
  let a = frames[0]
  let prev = frames[0]
  for (let i = 1; i < frames.length; i++) {
    const f = frames[i]
    if (f <= prev + gapOk) {
      prev = f
      continue
    }
    ranges.push({ start: a / fps, end: (prev + 1) / fps })
    a = prev = f
  }
  ranges.push({ start: a / fps, end: (prev + 1) / fps })
  return ranges
}

let remoteBarRanges: { start: number; end: number }[] = []

export function setRemotePreviewBarRanges(ranges: { start: number; end: number }[]) {
  remoteBarRanges = ranges
  notifyPreviewCacheChanged(true)
}

export function getPreviewBarRanges(fps: number): { start: number; end: number }[] {
  const local = cachedTimeRanges(sharedCache, fps)
  return local.length ? local : remoteBarRanges
}
