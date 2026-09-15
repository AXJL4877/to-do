/**
 * 播放 quiet 模式下：C++ play-session 写入的最新帧，供 videoFrameAt 直接取用。
 *
 * 主时钟：引擎 waveOut PCM → AUDIO_CLOCK；视频 PTS 追音频。
 * 无音频时回退墙钟 mediaT。每 tick 少量 READ，禁止狂读追帧。
 */
import type { Clip, MediaItem, Sequence } from '../types'
import { desktop } from './desktop'

const frames = new Map<string, { t: number; canvas: HTMLCanvasElement }>()

export function putNativePlayFrame(mediaId: string, t: number, dataUrl: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      let canvas = frames.get(mediaId)?.canvas
      if (!canvas) canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth || 1
      canvas.height = img.naturalHeight || 1
      const ctx = canvas.getContext('2d')
      if (ctx) ctx.drawImage(img, 0, 0)
      frames.set(mediaId, { t, canvas })
      resolve()
    }
    img.onerror = () => resolve()
    img.src = dataUrl
  })
}

export function getNativePlayFrame(
  mediaId: string,
  t: number,
  step: number,
): HTMLCanvasElement | null {
  const hit = frames.get(mediaId)
  if (!hit || hit.canvas.width <= 0) return null
  if (Math.abs(hit.t - t) <= Math.max(step * 1.25, 0.08)) return hit.canvas
  // 顺序播放时 pts 略落后也可先画
  if (hit.t <= t + 1e-3 && t - hit.t < 0.35) return hit.canvas
  return null
}

export function clearNativePlayBridge(mediaId?: string) {
  if (mediaId) frames.delete(mediaId)
  else frames.clear()
}

export function hasNativePlayBridge(mediaId: string) {
  return frames.has(mediaId)
}

/**
 * 单层可见、有本机 path 的视频 clip。
 * 倒放 / 多视频叠层 → null（保持 HTMLVideo）。
 * playPath：代理模式下可传 proxyPath。
 */
export function topNativePlayTarget(
  seq: Sequence,
  media: MediaItem[],
  t: number,
  opts?: { useProxy?: boolean },
): { clip: Clip; media: MediaItem; mediaT: number; playPath: string } | null {
  const videos: { clip: Clip; media: MediaItem }[] = []
  for (const c of seq.clips) {
    if (!c.enabled || t < c.start || t >= c.start + c.duration) continue
    const track = seq.tracks.find((tr) => tr.id === c.trackId)
    if (track?.hidden) continue
    const m = media.find((x) => x.id === c.mediaId)
    if (!m || m.kind !== 'video') continue
    videos.push({ clip: c, media: m })
  }
  if (videos.length === 0) return null
  // ponytail: 多视频叠层仍走 HTML；单层 + path 才用 play-session
  if (videos.length > 1) return null
  const top = videos[0]
  const playPath = (opts?.useProxy && top.media.proxyPath) || top.media.path
  if (!playPath || top.clip.reverse) return null

  const localT = Math.max(0, t - top.clip.start)
  const speed = Math.max(0.05, top.clip.speed || 1)
  const mediaT = top.clip.inPoint + localT * speed
  const srcDur = top.media.duration > 0 ? top.media.duration : Infinity
  if (!(mediaT >= 0 && mediaT < srcDur - 1e-3 && mediaT <= top.clip.outPoint + 1e-4)) {
    return null
  }
  return { clip: top.clip, media: top.media, mediaT, playPath }
}

type SessionState = {
  path: string
  mediaId: string
  pts: number
  audioPts: number | null
  busy: boolean
}

const session: SessionState = { path: '', mediaId: '', pts: -1, audioPts: null, busy: false }

/** 换片 open、大跳 seek；视频跟 AUDIO_CLOCK（PCM/waveOut），无音频则跟 mediaT。 */
export async function pumpNativePlay(
  target: { clip: Clip; media: MediaItem; mediaT: number; playPath: string } | null,
): Promise<void> {
  const api = desktop()
  if (!api?.nativePlayOpen || !api?.nativePlayRead || !api?.nativePlaySeek) return
  if (session.busy) return
  session.busy = true
  try {
    if (!target?.playPath) {
      if (session.path) {
        await api.nativePlayClose?.()
        clearNativePlayBridge(session.mediaId || undefined)
        session.path = ''
        session.mediaId = ''
        session.pts = -1
        session.audioPts = null
      }
      return
    }
    const filePath = target.playPath
    const mediaId = target.media.id
    const mediaT = target.mediaT

    if (session.path !== filePath || session.mediaId !== mediaId) {
      const opened = await api.nativePlayOpen(filePath, 10000)
      if (!opened.ok) return
      session.path = filePath
      session.mediaId = mediaId
      session.pts = -1
      session.audioPts = null
      clearNativePlayBridge()
      const sk = await api.nativePlaySeek(Math.max(0, mediaT), 8000)
      if (!sk.ok) return
    } else if (session.pts >= 0 && (mediaT + 0.05 < session.pts || mediaT - session.pts > 0.85)) {
      const sk = await api.nativePlaySeek(Math.max(0, mediaT), 8000)
      if (!sk.ok) return
      session.pts = -1
      session.audioPts = null
    }

    // 泵 PCM 并取音频主时钟
    const ac = await api.nativePlayAudioClock?.(2000)
    if (ac?.ok && ac.sec != null && Number.isFinite(ac.sec)) session.audioPts = ac.sec

    const targetT = session.audioPts != null ? session.audioPts : mediaT

    if (session.pts >= 0 && session.pts + 1e-4 >= targetT) {
      return
    }

    const behind = session.pts < 0 ? targetT : targetT - session.pts
    const maxReads = behind > 0.25 ? 6 : 2
    for (let i = 0; i < maxReads; i++) {
      const r = await api.nativePlayRead(8000)
      if (!r.ok || !r.dataUrl || r.pts == null) break
      session.pts = r.pts
      await putNativePlayFrame(mediaId, r.pts, r.dataUrl)
      if (r.pts + 1e-4 >= targetT) break
    }
  } finally {
    session.busy = false
  }
}

export function getNativePlayAudioPts() {
  return session.audioPts
}

export async function stopNativePlaySession() {
  const api = desktop()
  try {
    await api?.nativePlayClose?.()
  } catch { /* */ }
  clearNativePlayBridge()
  session.path = ''
  session.mediaId = ''
  session.pts = -1
  session.audioPts = null
  session.busy = false
}
