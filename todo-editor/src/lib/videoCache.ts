import type { MediaItem } from '../types'
import { desktop } from './desktop'
import { clearNativePlayBridge, getNativePlayFrame } from './nativePlayBridge'

const videos = new Map<string, HTMLVideoElement>()
const snapshots = new Map<string, HTMLCanvasElement>()
const pendingSeek = new Map<string, number>()
/** C++ 引擎 scrub 帧：仅 HTML 失败时兜底 */
const nativeSnaps = new Map<string, { t: number; canvas: HTMLCanvasElement }>()
const nativePending = new Map<string, number>()
let onReady: (() => void) | null = null
/** 播放 rAF 已在画，seeked 不必再 bump，避免闪 */
let quiet = false

export function setVideoCacheListener(cb: (() => void) | null) {
  onReady = cb
}

/** 播放循环内开启：只 seek/画，不触发 React 重绘风暴 */
export function setVideoSeekQuiet(on: boolean) {
  if (!on && quiet) {
    // 停播前冻当前帧，避免 pause/seek 空窗黑屏
    for (const [id, v] of videos) {
      captureFrame(id, v)
    }
  }
  quiet = on
  if (!on) {
    for (const v of videos.values()) {
      try {
        v.muted = true
        v.pause()
      } catch { /* */ }
    }
  }
}

/** 节目停播：全部回到静音 */
export function muteAllVideos() {
  for (const v of videos.values()) {
    try { v.muted = true } catch { /* */ }
  }
}

function bump() {
  if (!quiet) onReady?.()
}

function captureFrame(id: string, v: HTMLVideoElement) {
  if (v.readyState < 2 || !v.videoWidth) return
  let sheet = snapshots.get(id)
  if (!sheet) {
    sheet = document.createElement('canvas')
    snapshots.set(id, sheet)
  }
  if (sheet.width !== v.videoWidth || sheet.height !== v.videoHeight) {
    sheet.width = v.videoWidth
    sheet.height = v.videoHeight
  }
  const ctx = sheet.getContext('2d')
  if (!ctx) return
  ctx.drawImage(v, 0, 0)
}

/** 懒加载 video 元素；同一素材复用 */
export function ensureVideo(m: MediaItem): HTMLVideoElement {
  let v = videos.get(m.id)
  if (!v) {
    v = document.createElement('video')
    v.muted = true
    v.playsInline = true
    v.preload = 'auto'
    v.addEventListener('seeked', () => {
      captureFrame(m.id, v!)
      pendingSeek.delete(m.id)
      bump()
    })
    v.addEventListener('loadeddata', () => {
      captureFrame(m.id, v!)
      bump()
    })
    v.addEventListener('error', bump)
    videos.set(m.id, v)
  }
  if (v.dataset.src !== m.url) {
    v.dataset.src = m.url
    v.src = m.url
    pendingSeek.delete(m.id)
    snapshots.delete(m.id)
    nativeSnaps.delete(m.id)
    nativePending.delete(m.id)
  }
  return v
}

function htmlVideoFrameAt(m: MediaItem, mediaTime: number, step: number): CanvasImageSource | null {
  if (!m.url) return null
  const v = ensureVideo(m)
  if (v.error) return snapshots.get(m.id) ?? null

  let t = Math.max(0, mediaTime)
  const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null
  if (dur != null) t = Math.min(Math.max(0, dur - 1e-3), t)

  // 播放：让 HTMLVideo 自己跑，只在偏差大时纠一次，避免每帧硬 seek
  if (quiet) {
    if (Math.abs(v.currentTime - t) > 0.15) {
      try { v.currentTime = t } catch { /* */ }
    }
    if (v.paused && v.readyState >= 2) {
      void v.play().catch(() => { /* */ })
    }
    if (v.readyState >= 2 && v.videoWidth > 0) return v
    const snap = snapshots.get(m.id)
    return snap && snap.width > 0 ? snap : null
  }

  const snap = snapshots.get(m.id)
  const near = !v.seeking && v.readyState >= 2 && Math.abs(v.currentTime - t) <= step * 0.55

  if (near) {
    captureFrame(m.id, v)
    return snapshots.get(m.id) ?? v
  }

  if (!v.seeking) {
    const prev = pendingSeek.get(m.id)
    if (prev == null || Math.abs(prev - t) > step * 0.45) {
      pendingSeek.set(m.id, t)
      try {
        v.currentTime = t
      } catch { /* */ }
    }
  }

  // seek 中优先用冻帧，避免暂停/scrub 黑屏
  if (snap && snap.width > 0) return snap
  if (v.readyState >= 2 && v.videoWidth > 0 && Math.abs(v.currentTime - t) < 0.35) {
    captureFrame(m.id, v)
    return snapshots.get(m.id) ?? v
  }
  if (v.readyState >= 2 && v.videoWidth > 0) return v
  return null
}

function nativeFrameAt(m: MediaItem, t: number, step: number): CanvasImageSource | null {
  const api = desktop()
  if (!api?.decodeMediaFrame || !m.path) return null
  const hit = nativeSnaps.get(m.id)
  if (hit && Math.abs(hit.t - t) <= step * 0.55) return hit.canvas

  const pending = nativePending.get(m.id)
  if (pending == null || Math.abs(pending - t) > step * 0.45) {
    nativePending.set(m.id, t)
    const mediaPath = m.path
    const id = m.id
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

/**
 * 返回可绘制的稳帧。
 * 优先 HTMLVideo（跟手）；播放时可选用 nativePlayBridge；无 url 再 C++ 取帧。
 */
export function videoFrameAt(
  m: MediaItem,
  mediaTime: number,
  fps = 30,
): CanvasImageSource | null {
  const step = 1 / Math.max(1, fps)
  let t = Math.max(0, mediaTime)
  t = Math.round(t / step) * step

  // 播放：若已有原生泵帧可用则用（可选）；否则 HTMLVideo
  if (quiet && m.path && m.kind === 'video') {
    const bridge = getNativePlayFrame(m.id, t, step)
    if (bridge) return bridge
  }

  const html = htmlVideoFrameAt(m, t, step)
  if (html) return html

  // 无 file URL / HTML 失败：C++ 单帧兜底（勿在热路径优先）
  if (!quiet && m.path && m.kind === 'video' && desktop()?.decodeMediaFrame) {
    const native = nativeFrameAt(m, t, step)
    if (native) return native
    const hit = nativeSnaps.get(m.id)
    return hit && Math.abs(hit.t - t) < 0.35 ? hit.canvas : null
  }

  return null
}

export function dropVideo(id: string) {
  const v = videos.get(id)
  if (v) {
    v.removeAttribute('src')
    v.load()
    videos.delete(id)
  }
  pendingSeek.delete(id)
  snapshots.delete(id)
  nativeSnaps.delete(id)
  nativePending.delete(id)
  clearNativePlayBridge(id)
}
