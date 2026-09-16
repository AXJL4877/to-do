import type { Clip, MediaItem, Sequence } from '../types'
import { muteAllVideos } from './videoCache'

/** 纯音轨才走 HTMLAudio；视频声跟该 clip 的 HTMLVideo，避免同一文件解两遍 */
const audioOnly = new Map<string, HTMLAudioElement>()

function ensureAudio(clipId: string, url: string): HTMLAudioElement {
  let a = audioOnly.get(clipId)
  if (!a) {
    a = new Audio()
    a.preload = 'auto'
    audioOnly.set(clipId, a)
  }
  if (a.dataset.src !== url) {
    a.dataset.src = url
    a.src = url
  }
  return a
}

function gainToVolume(db: number) {
  return Math.max(0, Math.min(1, Math.pow(10, db / 20)))
}

function inRange(c: Clip, t: number) {
  return t >= c.start && t < c.start + c.duration
}

/** 成片音已由对应视频元素在播，这条链接音轨不要再解一遍 */
function videoAlreadySounds(seq: Sequence, clip: Clip, t: number) {
  const partner = seq.clips.find((x) => x.id === clip.linkedId)
    ?? seq.clips.find((x) => x.linkedId === clip.id && x.id !== clip.id)
  if (!partner || !inRange(partner, t) || partner.audio.mute) return false
  const tr = seq.tracks.find((x) => x.id === partner.trackId)
  return !!tr && tr.kind === 'video' && !tr.muted && !tr.hidden
}

function audibleAt(seq: Sequence, media: MediaItem[], t: number): { clipId: string; url: string; mediaT: number; vol: number; speed: number }[] {
  const byId = new Map(media.map((m) => [m.id, m]))
  const out: { clipId: string; url: string; mediaT: number; vol: number; speed: number }[] = []

  for (const c of seq.clips) {
    if (!c.enabled || !c.mediaId || c.audio.mute || !inRange(c, t)) continue
    const track = seq.tracks.find((tr) => tr.id === c.trackId)
    if (!track || track.kind !== 'audio' || track.muted) continue
    if (videoAlreadySounds(seq, c, t)) continue
    const m = byId.get(c.mediaId)
    if (!m?.url || m.offline) continue
    const speed = Math.max(0.25, Math.min(4, c.speed || 1))
    const mediaT = Math.max(0, (t - c.start) * speed + c.inPoint)
    out.push({ clipId: c.id, url: m.url, mediaT, vol: gainToVolume(c.audio.gainDb), speed })
  }
  return out
}

export function syncProgramAudio(seq: Sequence, media: MediaItem[], t: number, playing: boolean) {
  const want = playing ? audibleAt(seq, media, t) : []
  const wantIds = new Set(want.map((w) => w.clipId))

  for (const [id, a] of audioOnly) {
    if (!wantIds.has(id)) {
      try { a.pause() } catch { /* */ }
    }
  }

  for (const w of want) {
    const a = ensureAudio(w.clipId, w.url)
    a.volume = w.vol
    try { a.playbackRate = w.speed } catch { /* */ }
    if (Math.abs(a.currentTime - w.mediaT) > 0.25) {
      try { a.currentTime = w.mediaT } catch { /* */ }
    }
    if (a.paused) void a.play().catch(() => { /* */ })
  }
}

export function stopProgramAudio() {
  for (const a of audioOnly.values()) {
    try { a.pause() } catch { /* */ }
  }
  muteAllVideos()
}
