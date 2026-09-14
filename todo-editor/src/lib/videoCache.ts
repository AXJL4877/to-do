import type { MediaItem } from '../types'

const videos = new Map<string, HTMLVideoElement>()
const snapshots = new Map<string, HTMLCanvasElement>()
const pendingSeek = new Map<string, number>()
let onReady: (() => void) | null = null
/** 播放 rAF 已在画，seeked 不必再 bump，避免闪 */
let quiet = false

export function setVideoCacheListener(cb: (() => void) | null) {
  onReady = cb
}

/** 播放循环内开启：只 seek/画，不触发 React 重绘风暴 */
export function setVideoSeekQuiet(on: boolean) {
  quiet = on
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
  }
  return v
}

/**
 * 返回可绘制的上一稳帧（canvas）。seek 中不闪占位图。
 * mediaTime 会按 fps 量化，减少无意义 seek。
 * 目标与缓存帧相差过大时不沿用旧帧，避免时间轴错位观感。
 */
export function videoFrameAt(
  m: MediaItem,
  mediaTime: number,
  fps = 30,
): CanvasImageSource | null {
  const v = ensureVideo(m)
  if (v.error) return snapshots.get(m.id) ?? null

  const step = 1 / Math.max(1, fps)
  const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null
  let t = Math.max(0, mediaTime)
  if (dur != null) t = Math.min(Math.max(0, dur - 1e-3), t)
  t = Math.round(t / step) * step

  const snap = snapshots.get(m.id)
  const near = !v.seeking && v.readyState >= 2 && Math.abs(v.currentTime - t) <= step * 0.55

  // 已在目标帧附近且不在 seek：刷新快照并返回
  if (near) {
    captureFrame(m.id, v)
    return snapshots.get(m.id) ?? v
  }

  // 发起 seek（避免 seek 中叠加重置）
  if (!v.seeking) {
    const prev = pendingSeek.get(m.id)
    if (prev == null || Math.abs(prev - t) > step * 0.45) {
      pendingSeek.set(m.id, t)
      try {
        v.currentTime = t
      } catch { /* */ }
    }
  }

  // 仅当旧帧与目标足够近才沿用，否则宁可空一帧，也不把 5s 的画贴到 0s
  if (snap && snap.width > 0 && Math.abs(v.currentTime - t) < 0.35) {
    return snap
  }
  if (v.readyState >= 2 && v.videoWidth > 0 && Math.abs(v.currentTime - t) < 0.35) {
    captureFrame(m.id, v)
    return snapshots.get(m.id) ?? v
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
}
