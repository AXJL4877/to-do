import type { MediaItem } from '../types'
import { desktop } from './desktop'
import { clearNativePlayBridge } from './nativePlayBridge'

type Slot = {
  v: HTMLVideoElement
  snap: HTMLCanvasElement | null
  /** 已画到 snap 上的时钟目标 */
  settled: number | null
  /** 正在飞向的时钟目标 */
  pending: number | null
}

/** 一路解码器 = 一个片段，禁止两段片子共用一个 HTMLVideo */
const slots = new Map<string, Slot>()
/** 无 clip 时的预热（素材库） */
const warmup = new Map<string, HTMLVideoElement>()
const nativeSnaps = new Map<string, { t: number; canvas: HTMLCanvasElement }>()
const nativePending = new Map<string, number>()
let onReady: (() => void) | null = null
/** true = 节目正在播：只跟序列钟，禁止 HTMLVideo.play */
let clockPlay = false

export function setVideoCacheListener(cb: (() => void) | null) {
  onReady = cb
}

export function beginVideoCompose(_priorityMediaIds: string[] = []) {}

/** true = 进入时钟播放，false = 暂停/scrub */
export function setVideoSeekQuiet(on: boolean) {
  clockPlay = on
  for (const s of slots.values()) {
    s.pending = null
    try {
      s.v.muted = true
      s.v.pause()
    } catch { /* */ }
  }
}

export function muteAllVideos() {
  for (const s of slots.values()) {
    try { s.v.muted = true; s.v.pause() } catch { /* */ }
  }
  for (const v of warmup.values()) {
    try { v.muted = true; v.pause() } catch { /* */ }
  }
}

function bump() {
  if (!clockPlay) onReady?.()
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
  if (sheet.width !== v.videoWidth || sheet.height !== v.videoHeight) {
    sheet.width = v.videoWidth
    sheet.height = v.videoHeight
  }
  const ctx = sheet.getContext('2d')
  if (!ctx) return false
  ctx.drawImage(v, 0, 0)
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
    }), snap: null, settled: null, pending: null }
    slots.set(clipId, s)
  }
  if (s.v.dataset.src !== m.url) {
    s.v.dataset.src = m.url
    s.v.src = m.url
    s.snap = null
    s.settled = null
    s.pending = null
  }
  return s
}

/** 素材预热：不参与合成，避免和片段解码器抢同一元素 */
export function ensureVideo(m: MediaItem): HTMLVideoElement {
  let v = warmup.get(m.id)
  if (!v) {
    v = makeVideo((el) => {
      try { el.pause() } catch { /* */ }
      bump()
    })
    warmup.set(m.id, v)
  }
  if (v.dataset.src !== m.url) {
    v.dataset.src = m.url
    v.src = m.url
  }
  try { v.muted = true; v.pause() } catch { /* */ }
  return v
}

function htmlFrame(clipId: string, m: MediaItem, t: number, step: number): CanvasImageSource | null {
  if (!m.url) return null
  const s = slotOf(clipId, m)
  const v = s.v
  if (v.error) return still(s)

  try {
    v.muted = true
    if (!v.paused) v.pause()
  } catch { /* */ }

  const q = Math.round(t / step) * step
  const eps = clockPlay ? step * 1.25 : Math.max(step * 2, 0.08)

  // 已对准这一帧：只出冻帧，绝不把正在 seek 的 video 画进合成
  if (s.settled != null && Math.abs(s.settled - q) <= eps && still(s)) {
    return still(s)
  }

  if (v.seeking || s.pending != null) {
    return still(s)
  }

  if (v.readyState >= 2 && Math.abs(v.currentTime - q) <= eps) {
    if (capture(s)) s.settled = q
    return still(s)
  }

  s.pending = q
  try {
    v.currentTime = q
  } catch {
    s.pending = null
  }
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
): CanvasImageSource | null {
  const step = 1 / Math.max(1, fps)
  const t = Math.max(0, mediaTime)
  const id = clipId || `media:${m.id}`

  const html = htmlFrame(id, m, t, step)
  if (html) return html

  if (m.url && slots.has(id)) return still(slots.get(id)!)

  if (!clockPlay && m.path && m.kind === 'video' && desktop()?.decodeMediaFrame) {
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
