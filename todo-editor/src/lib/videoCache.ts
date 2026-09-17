import type { MediaItem } from '../types'
import { desktop } from './desktop'
import { clearNativePlayBridge } from './nativePlayBridge'
import { pathToFileUrl } from './importFiles'

type Slot = {
  v: HTMLVideoElement
  snap: HTMLCanvasElement | null
  settled: number | null
  pending: number | null
  /** 已跟采的片内帧号；同帧不重复 seek，避免元素拖着打转 */
  followFrame: number | null
}

const slots = new Map<string, Slot>()
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
  for (const s of slots.values()) {
    s.pending = null
    s.followFrame = null
    try {
      s.v.pause()
      s.v.muted = true
    } catch { /* */ }
  }
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
      const want = cur.pending
      if (capture(cur)) cur.settled = want ?? el.currentTime
      cur.pending = null
      bump()
    }), snap: null, settled: null, pending: null, followFrame: null }
    slots.set(clipId, s)
  }
  const src = playUrl(m)
  if (src && s.v.dataset.src !== src) {
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
  const v = s.v
  if (v.error) return still(s)

  const q = Math.round(t / step) * step
  const frame = Math.round(q / step)

  // 播放：只采样画面（声走 programAudio 混音）。
  // ⑤ 不堵：seeking / 未就绪立刻退回上一帧；主钟不在这里等。
  // seek 只跟播放头纠偏，元素绝不反推播放头。
  if (composePlay && !opts?.reverse) {
    const rate = Math.max(0.25, Math.min(4, opts?.speed ?? 1))
    try {
      v.playbackRate = rate
      v.volume = 0
      v.muted = true
    } catch { /* */ }

    if (s.followFrame !== frame && !v.seeking && v.readyState >= 1) {
      s.followFrame = frame
      // 连续解码；偏离超过 ~4 帧才纠（传统预览：跟主钟，不每帧硬钉）
      const drift = Math.abs(v.currentTime - q)
      if (drift > step * 4 || Number.isNaN(v.currentTime)) {
        try { v.currentTime = q } catch { /* */ }
      }
    }

    if (v.paused && !v.seeking && v.readyState >= 2) {
      void v.play().catch(() => { /* */ })
    }

    // 直接画 HTMLVideo，禁止每帧 capture→Canvas（那是 scrub 用的，叠层会拖死）
    if (!v.seeking && v.readyState >= 2 && v.videoWidth > 0) return v
    return still(s)
  }

  // 暂停/scrub：用户拖播放头 → 按播放头采样（同样不读元素时间当主钟）
  try {
    v.muted = true
    if (!v.paused) v.pause()
  } catch { /* */ }

  const eps = step
  if (s.settled != null && Math.abs(s.settled - q) <= eps && still(s)) return still(s)
  if (v.seeking || s.pending != null) return still(s)
  if (v.readyState >= 2 && Math.abs(v.currentTime - q) <= eps) {
    if (capture(s)) s.settled = q
    return still(s)
  }
  s.pending = q
  s.followFrame = frame
  try { v.currentTime = q } catch { s.pending = null }
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
  const id = clipId || `media:${m.id}`

  const html = htmlFrame(id, m, t, step, opts)
  if (html) return html
  if (m.url && slots.has(id)) return still(slots.get(id)!)

  if (!composePlay && m.path && m.kind === 'video' && desktop()?.decodeMediaFrame) {
    const native = nativeFrameAt(id, m, t, step)
    if (native) return native
    const hit = nativeSnaps.get(id)
    return hit && Math.abs(hit.t - t) < 0.35 ? hit.canvas : null
  }

  return null
}

export function dropVideo(id: string) {
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
    if (activeClipIds.has(id)) continue
    try {
      s.v.muted = true
      if (!s.v.paused) s.v.pause()
    } catch { /* */ }
  }
}
