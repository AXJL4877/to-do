import type { MediaItem, ProjectSettings, Sequence } from '../types'
import { pictureIdentity, changedPictureRanges, retainedPictureFrame } from './previewIdentity'
import type { ImageCache } from './monitorDraw'
import { renderProgramFrame } from './monitorDraw'
import { anyVideoSeeking, frameSampleUnstable, frameSampleCacheable, frameSampleMissing, holdVideoDecode, releaseVideoDecode, withVideoFrameScope } from './videoCache'
import {
  clearDiskCache, diskBusy, diskFrames, diskHas, diskRead, diskReadPending, diskReadSlots, diskReady,
  diskWritable, diskWrite, hashKey, totalDiskBytes, useDiskKey,
} from './previewDiskCache'

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

const MB = 1024 * 1024

/** RAM 预算：本机内存的 30%，夹在 512MB～6GB，其余留给解码、系统和别的软件 */
function ramBudgetBytes() {
  let totalMb = 0
  try {
    const desktop = (window as Window & { todoDesktop?: { systemMemoryMb?: () => number } }).todoDesktop
    totalMb = desktop?.systemMemoryMb?.() ?? 0
  } catch { /* */ }
  if (!totalMb) totalMb = ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4) * 1024
  return Math.round(Math.min(6144, Math.max(512, totalMb * 0.3)) * MB)
}

const MAX_BYTES = ramBudgetBytes()

let sharedCache = createPreviewCache()
let cacheRev = 0
let notifyTimer = 0
const cacheSubs = new Set<() => void>()

/** 后台自动缓存的代号，播放/改动时递增以作废进行中的任务 */
let prefetchGen = 0
/** 拖播放头、缩放时记一笔：这段时间只显示，不往缓存里塞新帧，避免分配和淘汰跟手抢主线程 */
let interactiveUntil = 0

export function markPreviewInteractive(ms = 220) {
  interactiveUntil = Math.max(interactiveUntil, performance.now() + ms)
}

export function previewInteractive() {
  const active = document.activeElement
  return performance.now() < interactiveUntil || !!active?.matches(
    'textarea, input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]), [contenteditable="true"]',
  )
}
let scratch: HTMLCanvasElement | null = null
let composeScratch: HTMLCanvasElement | null = null
let lastPresented: HTMLCanvasElement | null = null
let lastPresentedFrame = -1
const sheetPool: HTMLCanvasElement[] = []

function acquireSheet(w: number, h: number) {
  let sheet = sheetPool.pop()
  if (!sheet) {
    sheet = document.createElement('canvas')
    // 上千张缓存帧必须放 CPU 内存，GPU 加速画布会把显存吃光
    sheet.getContext('2d', { willReadFrequently: true })
  }
  if (sheet.width !== w || sheet.height !== h) {
    sheet.width = w
    sheet.height = h
  }
  return sheet
}

function releaseSheet(sheet: HTMLCanvasElement) {
  if (sheetPool.length < 96) sheetPool.push(sheet)
}

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
  media: MediaItem[] = [],
): string {
  return pictureIdentity(seq, settings, cacheW, cacheH, media)
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
  const ranges = changedPictureRanges(cache.fingerprint, fp)
  if (ranges && cache.cacheW === cacheW && cache.cacheH === cacheH) {
    const keep = retainedPictureFrame(cache.fingerprint, fp)
    for (const [frame, sheet] of cache.frames) {
      if (keep(frame)) continue
      cache.frames.delete(frame)
      cache.bytes -= frameBytes(cache)
      releaseSheet(sheet)
    }
    lastPresentedFrame = -1
    lastPresented = null
    cancelPrefetchProgramFrames()
  } else clearPreviewCache(cache)
  cache.fingerprint = fp
  cache.cacheW = cacheW
  cache.cacheH = cacheH
  notifyPreviewCacheChanged(true)
}

export function clearPreviewCache(cache: PreviewRamCache) {
  for (const sheet of cache.frames.values()) releaseSheet(sheet)
  cache.frames.clear()
  cache.bytes = 0
  cache.hits = 0
  cache.misses = 0
  cache.fingerprint = ''
  cache.cacheW = 0
  cache.cacheH = 0
  lastPresentedFrame = -1
  lastPresented = null
  cancelPrefetchProgramFrames()
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
    const old = cache.frames.get(worst)
    cache.frames.delete(worst)
    if (old) releaseSheet(old)
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

function composeScratchCanvas(w: number, h: number) {
  if (!composeScratch) composeScratch = document.createElement('canvas')
  if (composeScratch.width !== w || composeScratch.height !== h) {
    composeScratch.width = w
    composeScratch.height = h
  }
  return composeScratch
}

function publishPresented(source: HTMLCanvasElement, frame: number) {
  if (!lastPresented) lastPresented = document.createElement('canvas')
  if (lastPresented.width !== source.width || lastPresented.height !== source.height) {
    lastPresented.width = source.width
    lastPresented.height = source.height
  }
  const ctx = lastPresented.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, lastPresented.width, lastPresented.height)
  ctx.drawImage(source, 0, 0)
  lastPresentedFrame = frame
}

function blitLastPresented(dest: HTMLCanvasElement, w: number, h: number): boolean {
  if (!lastPresented || lastPresented.width <= 0 || lastPresented.height <= 0) return false
  blitCachedFrame(dest, lastPresented, w, h)
  return true
}

export function putCachedFrame(
  cache: PreviewRamCache,
  frame: number,
  source: CanvasImageSource,
  keepNear = frame,
) {
  if (cache.frames.has(frame)) return
  if (!cache.cacheW || !cache.cacheH) return
  const bytes = frameBytes(cache)
  evictFarthest(cache, keepNear)
  const sheet = acquireSheet(cache.cacheW, cache.cacheH)
  const ctx = sheet.getContext('2d')
  if (!ctx) {
    releaseSheet(sheet)
    return
  }
  // 画布来自复用池，残留旧帧
  ctx.clearRect(0, 0, cache.cacheW, cache.cacheH)
  ctx.drawImage(source, 0, 0, cache.cacheW, cache.cacheH)
  cache.frames.set(frame, sheet)
  cache.bytes += bytes
  // 播放中编码跟不上就先不落盘，空闲时自动缓存会补
  if (cache === sharedCache && !diskHas(frame) && !diskBusy()) void diskWrite(frame, sheet)
  notifyPreviewCacheChanged()
}

let syncedDiskKey = ''
let syncedDiskFingerprint = ''

/** Carry unchanged disk pixels into the new revision without decoding/re-encoding. */
function syncDiskKey(cache: PreviewRamCache, _seq: Sequence, _media: MediaItem[]) {
  if (cache !== sharedCache || !cache.fingerprint) return false
  const key = hashKey(cache.fingerprint)
  if (key !== syncedDiskKey) {
    const keep = retainedPictureFrame(syncedDiskFingerprint, cache.fingerprint)
    syncedDiskKey = key
    syncedDiskFingerprint = cache.fingerprint
    void useDiskKey(key, keep).then(() => notifyPreviewCacheChanged(true))
  }
  return true
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
  const ctx = dest.getContext('2d', { alpha: false, desynchronized: true } as CanvasRenderingContext2DSettings)
    ?? dest.getContext('2d')
  if (!ctx) return
  ctx.drawImage(cached, 0, 0, w, h)
}

type FpMemo = {
  seq: Sequence
  settings: ProjectSettings
  media: MediaItem[]
  cw: number
  ch: number
  fp: string
}

let fpMemo: FpMemo | null = null
const noMedia: MediaItem[] = []

/** 同一序列对象重复取指纹直接复用；长序列算一次要把每个片段 JSON 化 */
export function fingerprintOf(seq: Sequence, settings: ProjectSettings, cw: number, ch: number, media: MediaItem[] = noMedia) {
  if (
    fpMemo
    && fpMemo.seq === seq
    && fpMemo.settings === settings
    && fpMemo.media === media
    && fpMemo.cw === cw
    && fpMemo.ch === ch
  ) return fpMemo.fp
  const fp = previewFingerprint(seq, settings, cw, ch, media)
  fpMemo = { seq, settings, media, cw, ch, fp }
  return fp
}

/**
 * 节目底图呈现。
 * - 驱动钟：缓存命中直接贴；未命中离屏合成，不稳定则保留上一帧，稳定才入库
 * - 跟窗（followOnly）：只贴缓存或共享上一帧，绝不碰 HTMLVideo 解码槽
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
  opts?: { playing?: boolean; followOnly?: boolean },
): boolean {
  const { w: cw, h: ch } = stableCacheSize(settings, maxEdge)
  const fp = fingerprintOf(seq, settings, cw, ch, media)
  ensurePreviewFingerprint(cache, fp, cw, ch)
  syncDiskKey(cache, seq, media)
  const t = frame / Math.max(1, fps)
  const followOnly = !!opts?.followOnly

  const hit = cache.frames.get(frame)
  if (hit) {
    if (!followOnly) holdVideoDecode()
    cache.hits++
    blitCachedFrame(dest, hit, displayW, displayH)
    if (!followOnly) publishPresented(dest, frame)
    return true
  }
  cache.misses++

  // 跟窗：禁止二次合成，避免双窗抢同一解码槽导致闪烁/卡顿
  if (followOnly) {
    if (blitLastPresented(dest, displayW, displayH)) return true
    // 退一步：贴邻近已缓存帧，总比黑屏/占位闪好
    const near = cache.frames.get(frame - 1) ?? cache.frames.get(frame + 1)
    if (near) {
      blitCachedFrame(dest, near, displayW, displayH)
      return true
    }
    return false
  }

  // 离屏合成：失败/未就绪时不先清空 dest，避免节目窗闪黑
  releaseVideoDecode()
  const compose = composeScratchCanvas(displayW, displayH)
  renderProgramFrame(compose, seq, media, settings, t, imgCache, displayW, displayH, [], undefined, false, undefined, true)
  const unstable = anyVideoSeeking() || frameSampleUnstable()
  // 播放中某层在 seek 时它自己退回上一帧即可，其余层照常走；
  // 整帧沿用上一帧只用于有层连旧帧都没有（否则会闪占位块）或静止 scrub
  const holdPrevious = unstable && (!opts?.playing || frameSampleMissing())

  if (holdPrevious && (lastPresentedFrame >= 0 || cache.frames.has(frame - 1))) {
    const prev = cache.frames.get(frame - 1)
    if (prev) blitCachedFrame(dest, prev, displayW, displayH)
    else blitLastPresented(dest, displayW, displayH)
    return false
  }

  blitCachedFrame(dest, compose, displayW, displayH)
  publishPresented(dest, frame)

  if (!previewInteractive() && !unstable && frameSampleCacheable() && !cache.frames.has(frame)) {
    const sheet = scratchCanvas(cw, ch)
    const sctx = sheet.getContext('2d')
    if (sctx) {
      sctx.clearRect(0, 0, cw, ch)
      sctx.drawImage(compose, 0, 0, cw, ch)
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

function sequenceEndFrame(seq: Sequence, fps: number) {
  const end = seq.clips.reduce((m, c) => (c.enabled ? Math.max(m, c.start + c.duration) : m), 0)
  return Math.max(0, Math.ceil(end * fps - 1e-6))
}

function scheduleIdle(cb: (deadline?: IdleDeadline) => void, timeout: number) {
  const ric = (window as Window & {
    requestIdleCallback?: (cb: (deadline: IdleDeadline) => void) => number
  }).requestIdleCallback
  // Background cache must never turn an expired timeout into foreground work.
  if (ric) ric(cb)
  else window.setTimeout(() => cb(), timeout)
}

/**
 * 后台自动缓存整条序列：从 fromFrame 往后到结尾，再从头补到 fromFrame。
 * 每个 idle 片只处理一帧不堵主线程。RAM 有空优先进 RAM（盘上有就直接读回），
 * RAM 满了就只落盘；两级都满才停，不挤掉已缓存帧。
 */
export function autoCacheProgramFrames(opts: {
  cache: PreviewRamCache
  fromFrame: number
  fps: number
  seq: Sequence
  media: MediaItem[]
  settings: ProjectSettings
  imgCache: ImageCache
  maxEdge?: number
}) {
  const maxEdge = opts.maxEdge ?? 720
  const fps = Math.max(1, opts.fps)
  const { w: cw, h: ch } = stableCacheSize(opts.settings, maxEdge)
  const fp = fingerprintOf(opts.seq, opts.settings, cw, ch, opts.media)
  const cache = opts.cache
  ensurePreviewFingerprint(cache, fp, cw, ch)
  const useDisk = syncDiskKey(cache, opts.seq, opts.media)
  const gen = ++prefetchGen

  const endFrame = sequenceEndFrame(opts.seq, fps)
  if (endFrame <= 0) return
  const start = Math.min(Math.max(0, opts.fromFrame), endFrame - 1)
  let i = 0
  let attempts = 0
  const frameAt = (k: number) => (start + k) % endFrame
  const alive = () => gen === prefetchGen && cache.fingerprint === fp
  const ramFull = () => cache.bytes + frameBytes(cache) > cache.maxBytes
  const done = (f: number) => {
    const inRam = cache.frames.has(f)
    if (!useDisk) return inRam
    if (inRam) return diskHas(f) || !diskWritable()
    return diskHas(f) && ramFull()
  }

  const step = (deadline?: IdleDeadline) => {
    if (!alive()) return
    if (previewInteractive() || (deadline && deadline.timeRemaining() < 8)) {
      window.setTimeout(() => { if (alive()) scheduleIdle(step, 80) }, 200)
      return
    }
    if (useDisk && diskBusy()) {
      window.setTimeout(step, 30)
      return
    }
    while (i < endFrame && done(frameAt(i))) i++
    if (i >= endFrame) return
    const f = frameAt(i)

    if (cache.frames.has(f)) {
      void diskWrite(f, cache.frames.get(f)!)
      i++
      scheduleIdle(step, 80)
      return
    }
    if (useDisk && diskHas(f)) {
      void diskRead(f).then((bmp) => {
        if (bmp) {
          if (alive()) putCachedFrame(cache, f, bmp, start)
          bmp.close()
        }
        if (!alive()) return
        i++
        scheduleIdle(step, 80)
      })
      return
    }
    const toDiskOnly = ramFull()
    if (toDiskOnly && !(useDisk && diskWritable())) return

    const sheet = scratchCanvas(cw, ch)
    const ready = withVideoFrameScope('prefetch', () => {
      renderProgramFrame(
        sheet, opts.seq, opts.media, opts.settings, f / fps, opts.imgCache,
        cw, ch, [], undefined, false, undefined, true,
      )
      return !anyVideoSeeking() && frameSampleCacheable()
    })
    if (!ready) {
      // 素材迟迟解不出来就跳过这帧，别卡住后面整条
      if (++attempts < 50) {
        window.setTimeout(step, 20)
        return
      }
    } else if (!toDiskOnly) {
      putCachedFrame(cache, f, sheet, start)
    } else {
      void diskWrite(f, sheet).then((ok) => { if (ok) notifyPreviewCacheChanged() })
    }
    attempts = 0
    i++
    if (i < endFrame) scheduleIdle(step, 80)
  }
  if (useDisk) void diskReady().then(() => { if (alive()) scheduleIdle(step, 50) })
  else scheduleIdle(step, 50)
}

export function cancelPrefetchProgramFrames() {
  prefetchGen++
}

/** 播放中把前方已落盘、RAM 里没有的帧提前读回 RAM */
export function readAheadFromDisk(cache: PreviewRamCache, frame: number, count: number) {
  if (cache !== sharedCache) return
  const fp = cache.fingerprint
  for (let f = frame + 1; f <= frame + count && diskReadSlots() > 0; f++) {
    if (cache.frames.has(f) || !diskHas(f) || diskReadPending(f)) continue
    void diskRead(f).then((bmp) => {
      if (!bmp) return
      if (cache.fingerprint === fp) putCachedFrame(cache, f, bmp, frame)
      bmp.close()
    })
  }
}

export function previewCacheUsage() {
  return { ramBytes: sharedCache.bytes, ramMaxBytes: sharedCache.maxBytes, diskBytes: totalDiskBytes() }
}

/** 手动清理：RAM 和磁盘两级一起清 */
export async function clearAllPreviewCaches() {
  clearPreviewCache(sharedCache)
  await clearDiskCache()
  notifyPreviewCacheChanged(true)
}

/** Only contiguous, actually cached frames count as a cached interval. */
export function cachedTimeRanges(cache: PreviewRamCache, fps: number): { start: number; end: number }[] {
  const frames = [...cache.frames.keys()]
  if (cache === sharedCache) for (const f of diskFrames()) if (!cache.frames.has(f)) frames.push(f)
  if (!frames.length || fps <= 0) return []
  frames.sort((a, b) => a - b)
  const gapOk = 1
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
