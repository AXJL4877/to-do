/**
 * 音频混音：T 下全部活跃音源 → 各自 HTMLAudio → 浏览器混到一声卡。
 * 不阻塞；主钟在 Monitor 墙钟，这里只跟采。
 * 代理画面无声（-an）：声走原片 url；HTMLVideo 永不承担出声。
 */
import type { Clip, MediaItem, Sequence } from '../types'
import { muteAllVideos, pauseAllVideos } from './videoCache'
import { mediaTimeAt, videoNeedsDirectAudio } from './programPlayer'
import { activeClipsAt, indexMedia, indexTracks } from './sequenceIndex'

const mixSlots = new Map<string, HTMLAudioElement>()
const followFrame = new Map<string, number>()
let videosMutedOnce = false

function ensureAudio(clipId: string, url: string): HTMLAudioElement {
  let a = mixSlots.get(clipId)
  if (!a) {
    a = new Audio()
    a.preload = 'auto'
    mixSlots.set(clipId, a)
  }
  if (a.dataset.src !== url) {
    a.dataset.src = url
    a.src = url
    followFrame.delete(clipId)
  }
  return a
}

function gainToVolume(db: number) {
  return Math.max(0, Math.min(1, Math.pow(10, db / 20)))
}

function inRange(c: Clip, t: number) {
  return t >= c.start && t < c.start + c.duration
}

type MixWant = {
  clipId: string
  url: string
  mediaT: number
  vol: number
  speed: number
  frame: number
}

function audibleAt(seq: Sequence, media: MediaItem[], t: number, fps: number): MixWant[] {
  const byId = indexMedia(media)
  const tracks = indexTracks(seq.tracks)
  const active = activeClipsAt(seq, t)
  const out: MixWant[] = []
  const step = 1 / Math.max(1, fps)
  const seen = new Set<string>()

  const push = (c: Clip, url: string) => {
    if (seen.has(c.id)) return
    seen.add(c.id)
    const speed = Math.max(0.25, Math.min(4, c.speed || 1))
    const mediaT = mediaTimeAt(c, t, fps)
    out.push({
      clipId: c.id,
      url,
      mediaT,
      vol: gainToVolume(c.audio.gainDb),
      speed,
      frame: Math.round(mediaT / step),
    })
  }

  for (const c of active) {
    if (!c.enabled || !c.mediaId || c.audio.mute || !inRange(c, t)) continue
    const track = tracks.get(c.trackId)
    if (!track || track.kind !== 'audio' || track.muted) continue
    const m = byId.get(c.mediaId)
    if (!m?.url || m.offline) continue
    push(c, m.url)
  }

  for (const c of active) {
    if (!videoNeedsDirectAudio(seq, c, t, media)) continue
    const m = byId.get(c.mediaId!)
    if (!m?.url) continue
    push(c, m.url)
  }

  return out
}

export function syncProgramAudio(seq: Sequence, media: MediaItem[], t: number, playing: boolean, fps = 30) {
  // 只静音一次；绝不能每帧 pause 视频槽
  if (!videosMutedOnce) {
    muteAllVideos()
    videosMutedOnce = true
  }

  const want = playing ? audibleAt(seq, media, t, fps) : []
  const wantIds = new Set(want.map((w) => w.clipId))
  const step = 1 / Math.max(1, fps)

  for (const [id, a] of mixSlots) {
    if (!wantIds.has(id)) {
      try { a.pause() } catch { /* */ }
      followFrame.delete(id)
    }
  }

  for (const w of want) {
    const a = ensureAudio(w.clipId, w.url)
    a.volume = w.vol
    try { a.playbackRate = w.speed } catch { /* */ }
    // 连续播；偏离 >4 帧才 seek（与视频同策略）
    if (followFrame.get(w.clipId) !== w.frame && !a.seeking) {
      followFrame.set(w.clipId, w.frame)
      const drift = Math.abs(a.currentTime - w.mediaT)
      if (drift > step * 4 || Number.isNaN(a.currentTime)) {
        try { a.currentTime = w.mediaT } catch { /* */ }
      }
    }
    if (a.paused) void a.play().catch(() => { /* */ })
  }
}

export function stopProgramAudio() {
  videosMutedOnce = false
  for (const a of mixSlots.values()) {
    try { a.pause() } catch { /* */ }
  }
  followFrame.clear()
  pauseAllVideos()
}
