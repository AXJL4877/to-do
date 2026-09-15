import type { MediaItem, ProjectSettings, Sequence } from '../types'
import type { ImageCache } from './monitorDraw'
import { renderProgramFrame } from './monitorDraw'

/** 节目监视器 RAM 预览缓存：播过的帧留下，未改工程再播直接 blit */
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

const MAX_BYTES = 512 * 1024 * 1024 // ~512MB

let sharedCache = createPreviewCache()
let cacheRev = 0
let notifyTimer = 0
const cacheSubs = new Set<() => void>()

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

/** 内容指纹：变了就整表作废 */
export function previewFingerprint(
  seq: Sequence,
  settings: ProjectSettings,
  w: number,
  h: number,
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
    seq.id, w, h, settings.width, settings.height, settings.fps,
    settings.canvasBg, settings.canvasColor, settings.safeFrame ? 1 : 0,
    clips,
  ].join('#')
}

/** 缓存分辨率：按自定义最长边缩放；maxEdge=0 表示与预览同尺寸 */
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

/** 超容量时丢掉离 keepNear 最远的帧，避免只剩尾巴一小段 */
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

/** 渲染并写入指定帧（供按帧补齐缓存） */
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
  if (cache.frames.has(frame)) {
    const hit = cache.frames.get(frame)!
    blitCachedFrame(dest, hit, displayW, displayH)
    cache.hits++
    return true
  }
  const t = frame / Math.max(1, fps)
  const cw = cache.cacheW || displayW
  const ch = cache.cacheH || displayH
  // 先画到目标尺寸，再缩进缓存
  renderProgramFrame(dest, seq, media, settings, t, imgCache, displayW, displayH, [], undefined, false)
  putCachedFrame(cache, frame, dest, frame)
  // put 里按 cache 尺寸重绘；若 display≠cache，再 blit 回去
  const stored = cache.frames.get(frame)
  if (stored && (cw !== displayW || ch !== displayH)) {
    blitCachedFrame(dest, stored, displayW, displayH)
  }
  return false
}

/** 连续帧合并为时间段；允许 ≤4 帧空隙（播放时降频写缓存仍画成实心绿条） */
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

/** 独立时间轴窗没有节目监视器，用主窗广播的区间画绿条 */
let remoteBarRanges: { start: number; end: number }[] = []

export function setRemotePreviewBarRanges(ranges: { start: number; end: number }[]) {
  remoteBarRanges = ranges
  notifyPreviewCacheChanged(true)
}

export function getPreviewBarRanges(fps: number): { start: number; end: number }[] {
  const local = cachedTimeRanges(sharedCache, fps)
  return local.length ? local : remoteBarRanges
}

