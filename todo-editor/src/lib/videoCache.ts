import type { MediaItem } from '../types'
import { desktop } from './desktop'
import { clearNativePlayBridge } from './nativePlayBridge'
import { pathToFileUrl } from './importFiles'
import { mayHaveAlpha } from './mediaAlpha'

type Slot = {
  v: HTMLVideoElement
  snap: HTMLCanvasElement | null
  settled: number | null
  pending: number | null
  /** 已跟采的片内帧号；同帧不重复 seek，避免元素拖着打转 */
  followFrame: number | null
  /** A cache hit paused this slot; the next live sample must align before presenting. */
  resumeSync: boolean
  /** 本次 seek 发起时刻（performance.now） */
  seekAt: number | null
  /** 实测 seek 耗时（秒，平滑值）；播放中 seek 目标按它前置，否则永远追不上播放头 */
  seekLatency: number
  /** 本帧实际交出去的画面对应的素材时间；叠在上面、要跟画面走的层（粉笔手）按它对齐 */
  shown: number | null
}

const SEEK_LEAD_MAX = 2.5

function startSeek(s: Slot, t: number) {
  s.seekAt = performance.now()
  s.v.currentTime = t
}

const slots = new Map<string, Slot>()
// Renderer-thread-only scope; prefetch never seeks or pauses foreground slots.
let frameScope = 'program'
export function withVideoFrameScope<T>(scope: string, render: () => T): T {
  const previous = frameScope
  frameScope = scope
  try { return render() } finally { frameScope = previous }
}
const warmup = new Map<string, HTMLVideoElement>()
const nativeSnaps = new Map<string, { t: number; canvas: HTMLCanvasElement }>()
const nativePending = new Map<string, number>()
let onReady: (() => void) | null = null
/**
 * 节目播放中：元素只跟播放头采样。
 * 禁止用 v.currentTime 反推播放头；seek 只在播放头换帧时触发。
 */
let composePlay = false

export type VideoFrameOpts = {
  speed?: number
  volume?: number
  reverse?: boolean
  /** false：只要画面采样（可暂停）；true/默认：需要持续解码出声时保持 play */
  live?: boolean
}

function playUrl(m: MediaItem): string | undefined {
  // 代理是 H.264，没有透明通道
  if (mayHaveAlpha(m)) return m.url
  if (m.proxyUrl) return m.proxyUrl
  if (m.proxyPath) return pathToFileUrl(m.proxyPath)
  return m.url
}

export function setVideoCacheListener(cb: (() => void) | null) {
  onReady = cb
}

export function beginVideoCompose(_priorityMediaIds: string[] = []) {}

export function setVideoSeekQuiet(on: boolean) {
  composePlay = on
  // 预取槽只服务静止时的预热；开播时还在 seek 会和节目槽抢同一文件的解码
  if (on) {
    for (const id of [...slots.keys()]) {
      if (id.startsWith('prefetch:')) dropVideo(id)
    }
  }
  for (const s of slots.values()) {
    s.pending = null
    s.followFrame = null
    try {
      s.v.pause()
      s.v.muted = true
    } catch { /* */ }
  }
}

/** 播放中是否还有层在 seek（此时不宜写入 RAM 缓存，否则会缓存黑帧导致闪烁） */
export function anyVideoSeeking() {
  for (const [id, s] of slots) {
    if (!id.startsWith(`${frameScope}:`)) continue
    if (s.v.seeking) return true
  }
  return false
}

/** 本帧有层没拿到稳定画面（seek / 未解码），合成结果不能写入 RAM */
let sampleUnstable = false
let sampleCacheable = true
/** 本帧有视频层连上一帧都没有（会画占位块） */
let sampleMissing = false

export function resetFrameSampleStability() {
  sampleUnstable = false
  sampleCacheable = true
  sampleMissing = false
}

export function frameSampleCacheable() { return !sampleUnstable && sampleCacheable }

export function frameSampleMissing() { return sampleMissing }

export function frameSampleUnstable() {
  return sampleUnstable
}

function markUnstable() {
  sampleUnstable = true
}

/** 命中 RAM 帧时停掉 HTMLVideo，避免后台继续解码把已缓存回放拖卡 */
let decodeHeld = false

export function holdVideoDecode() {
  if (decodeHeld) return
  decodeHeld = true
  for (const s of slots.values()) {
    try {
      s.resumeSync = true
      if (!s.v.paused) s.v.pause()
    } catch { /* */ }
  }
}

export function releaseVideoDecode() {
  decodeHeld = false
}

/** 只静音，不停播（播放循环里每帧 mute+pause 会把叠层卡死） */
export function muteAllVideos() {
  for (const s of slots.values()) {
    try {
      s.v.muted = true
      s.v.volume = 0
    } catch { /* */ }
  }
  for (const v of warmup.values()) {
    try {
      v.muted = true
      v.volume = 0
    } catch { /* */ }
  }
}

/** 停播并静音（真正停节目时用） */
export function pauseAllVideos() {
  for (const s of slots.values()) {
    try {
      s.v.muted = true
      s.v.volume = 0
      if (!s.v.paused) s.v.pause()
    } catch { /* */ }
  }
  for (const v of warmup.values()) {
    try {
      v.muted = true
      v.volume = 0
      if (!v.paused) v.pause()
    } catch { /* */ }
  }
}

function bump() {
  if (!composePlay) onReady?.()
}

function makeVideo(onSeeked: (el: HTMLVideoElement) => void): HTMLVideoElement {
  const v = document.createElement('video')
  v.muted = true
  v.playsInline = true
  v.preload = 'auto'
  v.addEventListener('seeked', () => onSeeked(v))
  v.addEventListener('loadeddata', () => onSeeked(v))
  v.addEventListener('error', bump)
  return v
}

function capture(s: Slot): boolean {
  const v = s.v
  if (v.seeking || v.readyState < 2 || !v.videoWidth) return false
  let sheet = s.snap
  if (!sheet) {
    sheet = document.createElement('canvas')
    s.snap = sheet
  }
  // still 缓存压到预览级，避免叠层时每层存一份 4K 位图
  const maxEdge = 720
  let dw = v.videoWidth
  let dh = v.videoHeight
  if (Math.max(dw, dh) > maxEdge) {
    const sc = maxEdge / Math.max(dw, dh)
    dw = Math.max(1, Math.round(dw * sc))
    dh = Math.max(1, Math.round(dh * sc))
  }
  if (sheet.width !== dw || sheet.height !== dh) {
    sheet.width = dw
    sheet.height = dh
  }
  const ctx = sheet.getContext('2d')
  if (!ctx) return false
  // 透明视频（WebM alpha）不会覆盖上一帧，不清会叠出残影
  ctx.clearRect(0, 0, dw, dh)
  ctx.drawImage(v, 0, 0, dw, dh)
  return sheet.width > 0
}

function still(s: Slot): HTMLCanvasElement | null {
  return s.snap && s.snap.width > 0 ? s.snap : null
}

function slotOf(clipId: string, m: MediaItem): Slot {
  let s = slots.get(clipId)
  if (!s) {
    s = { v: makeVideo((el) => {
      const cur = slots.get(clipId)
      if (!cur || cur.v !== el) return
      if (cur.seekAt != null && !el.seeking) {
        const lat = (performance.now() - cur.seekAt) / 1000
        cur.seekLatency = Math.min(SEEK_LEAD_MAX, cur.seekLatency * 0.5 + lat * 0.5)
        cur.seekAt = null
      }
      if (capture(cur)) {
        cur.settled = el.currentTime
        cur.pending = null
      }
      if (clipId.startsWith('program:')) bump()
    }), snap: null, settled: null, pending: null, followFrame: null, resumeSync: false, seekAt: null, seekLatency: 0.3, shown: null }
    slots.set(clipId, s)
  }
  const src = playUrl(m)
  if (src && s.v.dataset.src !== src) {
    // 播放中途换代理源会闪黑；等停播再切
    if (composePlay && s.v.dataset.src) {
      return s
    }
    s.v.dataset.src = src
    s.v.src = src
    s.snap = null
    s.settled = null
    s.pending = null
    s.followFrame = null
  }
  return s
}

export function ensureVideo(m: MediaItem): HTMLVideoElement {
  let v = warmup.get(m.id)
  if (!v) {
    v = makeVideo((el) => {
      try { el.pause() } catch { /* */ }
      bump()
    })
    warmup.set(m.id, v)
  }
  const src = playUrl(m)
  if (src && v.dataset.src !== src) {
    v.dataset.src = src
    v.src = src
  }
  try { v.muted = true; v.pause() } catch { /* */ }
  return v
}

function htmlFrame(clipId: string, m: MediaItem, t: number, step: number, opts?: VideoFrameOpts): CanvasImageSource | null {
  if (!playUrl(m)) return null
  const s = slotOf(clipId, m)
  const img = pickHtmlFrame(s, t, step, opts)
  s.shown = img == null ? null : img === s.v ? s.v.currentTime : s.settled
  return img
}

function pickHtmlFrame(s: Slot, t: number, step: number, opts?: VideoFrameOpts): CanvasImageSource | null {
  const v = s.v
  if (v.error) { markUnstable(); return still(s) }

  const q = Math.round(t / step) * step
  const frame = Math.round(q / step)

  // 播放：只采样画面（声走 programAudio 混音）。
  // ⑤ 不堵：seeking / 未就绪立刻退回上一帧；主钟不在这里等。
  // seek 只跟播放头纠偏，元素绝不反推播放头。
  if (composePlay && frameScope === 'program' && !opts?.reverse) {
    const rate = Math.max(0.25, Math.min(4, opts?.speed ?? 1))
    try {
      v.playbackRate = rate
      v.volume = 0
      v.muted = true
    } catch { /* */ }

    if ((s.resumeSync || s.followFrame !== frame) && !v.seeking && v.readyState >= 1) {
      s.followFrame = frame
      // 连续解码；落后超过 ~8 帧才纠（过紧会 seek 闪烁，过松会音画漂）
      const ahead = v.currentTime - q
      const drifted = Number.isNaN(v.currentTime) || ahead < -step * 8 || ahead > SEEK_LEAD_MAX + step * 8
      if (drifted || (s.resumeSync && Math.abs(ahead) > step)) {
        // seek 期间播放头继续走：目标前置一个实测 seek 耗时，落地时正好被播放头追上
        let target = drifted ? q + Math.min(SEEK_LEAD_MAX, s.seekLatency * rate) : q
        if (Number.isFinite(v.duration) && v.duration > 0) target = Math.min(target, Math.max(q, v.duration - step))
        try { startSeek(s, target) } catch { /* */ }
      }
      s.resumeSync = false
    }

    // 前置 seek 落在播放头前面：停在这一帧等播放头追上，再接着解码
    const waitForHead = !v.seeking && v.currentTime - q > step * 1.5
    if (waitForHead) {
      if (!v.paused) try { v.pause() } catch { /* */ }
    } else if (v.paused && !v.seeking && v.readyState >= 2) {
      void v.play().catch(() => { /* */ })
    }

    // 直接画 HTMLVideo；seeking 时优先上一帧，避免占位符闪白/闪黑
    if (v.readyState >= 2 && v.videoWidth > 0) {
      if (!v.seeking) {
        if (Math.floor(v.currentTime / step + 1e-4) !== frame) sampleCacheable = false
        return v
      }
      markUnstable()
      return still(s) ?? v
    }
    markUnstable()
    return still(s)
  }

  // 暂停/scrub：用户拖播放头 → 按播放头采样（同样不读元素时间当主钟）
  try {
    v.muted = true
    if (!v.paused) v.pause()
  } catch { /* */ }

  const eps = 1e-4
  if (s.settled != null && Math.abs(s.settled - q) <= eps && still(s)) return still(s)
  if (v.seeking || s.pending != null) { markUnstable(); return still(s) }
  if (v.readyState >= 2 && Math.abs(v.currentTime - q) <= eps) {
    if (capture(s)) s.settled = q
    return still(s)
  }
  s.pending = q
  s.followFrame = frame
  try { startSeek(s, q) } catch { s.pending = null }
  markUnstable()
  return still(s)
}

function nativeFrameAt(id: string, m: MediaItem, t: number, step: number): CanvasImageSource | null {
  const api = desktop()
  if (!api?.decodeMediaFrame || !m.path) return null
  const hit = nativeSnaps.get(id)
  if (hit && Math.abs(hit.t - t) <= Math.max(step, 0.08)) return hit.canvas

  const pending = nativePending.get(id)
  if (pending == null || Math.abs(pending - t) > 0.08) {
    nativePending.set(id, t)
    const mediaPath = m.path
    void api.decodeMediaFrame(mediaPath, t, 8000).then((r) => {
      if (nativePending.get(id) !== t) return
      nativePending.delete(id)
      if (!r.ok || !r.dataUrl) return
      const img = new Image()
      img.onload = () => {
        let canvas = nativeSnaps.get(id)?.canvas
        if (!canvas) canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth || r.width || 1
        canvas.height = img.naturalHeight || r.height || 1
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.drawImage(img, 0, 0)
        nativeSnaps.set(id, { t, canvas })
        bump()
      }
      img.src = r.dataUrl
    }).catch(() => {
      if (nativePending.get(id) === t) nativePending.delete(id)
    })
  }

  if (hit && Math.abs(hit.t - t) < 0.35) return hit.canvas
  return null
}

export function videoFrameAt(
  m: MediaItem,
  mediaTime: number,
  fps = 30,
  clipId?: string,
  opts?: VideoFrameOpts,
): CanvasImageSource | null {
  const step = 1 / Math.max(1, fps)
  const t = Math.max(0, mediaTime)
  const id = `${frameScope}:${clipId || `media:${m.id}`}`

  const html = htmlFrame(id, m, t, step, opts)
  if (html) return html
  if (m.url && slots.has(id)) {
    const held = still(slots.get(id)!)
    if (!held && composePlay) sampleMissing = true
    return held
  }

  if (!composePlay && m.path && m.kind === 'video' && desktop()?.decodeMediaFrame) {
    const native = nativeFrameAt(id, m, t, step)
    if (native) return native
    const hit = nativeSnaps.get(id)
    return hit && Math.abs(hit.t - t) < 0.35 ? hit.canvas : null
  }

  return null
}

/** 片段本帧实际显示的素材时间（当前取帧域）；没画出来为 null */
export function shownVideoTime(clipId: string): number | null {
  return slots.get(`${frameScope}:${clipId}`)?.shown ?? null
}

/**
 * 节目播放时，快开始的片段先把解码槽载好停在首帧：
 * 否则进场那一刻才载入，追播放头时会前置 seek，短片段直接跳到尾帧。
 * 不影响本帧能否写入 RAM 缓存。
 */
export function prerollVideo(m: MediaItem, mediaTime: number, fps: number, clipId: string) {
  if (frameScope !== 'program' || !playUrl(m)) return
  const flags = [sampleUnstable, sampleCacheable, sampleMissing] as const
  const s = slotOf(`${frameScope}:${clipId}`, m)
  const step = 1 / Math.max(1, fps)
  const t = Math.max(0, mediaTime)
  const v = s.v
  if (composePlay) {
    try { if (!v.paused) v.pause() } catch { /* */ }
    if (!v.seeking && v.readyState >= 1 && Math.abs(v.currentTime - t) > step / 2 && s.pending !== t) {
      s.pending = t
      try { startSeek(s, t) } catch { s.pending = null }
    }
    // 下一帧进场时按播放头接着走，不当成「漂了」再前置 seek
    s.followFrame = null
    s.resumeSync = false
  } else {
    pickHtmlFrame(s, t, step)
  }
  ;[sampleUnstable, sampleCacheable, sampleMissing] = flags
}

export function dropVideo(id: string) {
  if (!id.startsWith('program:') && !id.startsWith('prefetch:')) {
    dropVideo(`program:${id}`)
    dropVideo(`prefetch:${id}`)
  }
  const s = slots.get(id)
  if (s) {
    s.v.removeAttribute('src')
    s.v.load()
    slots.delete(id)
  }
  const w = warmup.get(id)
  if (w) {
    w.removeAttribute('src')
    w.load()
    warmup.delete(id)
  }
  nativeSnaps.delete(id)
  nativePending.delete(id)
  clearNativePlayBridge(id)
}

/** 停掉未在本帧使用的解码槽，释放叠层时的多余 HTMLVideo */
export function pauseUnusedVideoSlots(activeClipIds: Set<string>) {
  for (const [id, s] of slots) {
    if (!id.startsWith(`${frameScope}:`)) continue
    if (activeClipIds.has(id.slice(frameScope.length + 1))) continue
    try {
      s.v.muted = true
      if (!s.v.paused) s.v.pause()
    } catch { /* */ }
  }
}
