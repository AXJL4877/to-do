import type { Clip, MediaItem, Sequence } from '../types'
import { muteAllVideos } from './videoCache'

/** 声音单独走 HTMLAudio，跟画面解码器分开，只对齐序列钟 */
const audioOnly = new Map<string, HTMLAudioElement>()

function ensureAudio(mediaId: string, url: string): HTMLAudioElement {
  let a = audioOnly.get(mediaId)
  if (!a) {
    a = new Audio()
    a.preload = 'auto'
    audioOnly.set(mediaId, a)
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

function audibleAt(seq: Sequence, media: MediaItem[], t: number): { media: MediaItem; mediaT: number; vol: number }[] {
  const byId = new Map(media.map((m) => [m.id, m]))
  const out: { media: MediaItem; mediaT: number; vol: number }[] = []
  const seen = new Set<string>()

  const consider = (c: Clip, trackMuted: boolean) => {
    if (!c.enabled || trackMuted || !c.mediaId || c.audio.mute) return
    if (t < c.start || t >= c.start + c.duration) return
    const m = byId.get(c.mediaId)
    if (!m?.url || m.offline) return
    if (seen.has(m.id)) return
    seen.add(m.id)
    const local = (t - c.start) * (c.speed || 1) + c.inPoint
    out.push({ media: m, mediaT: Math.max(0, local), vol: gainToVolume(c.audio.gainDb) })
  }

  for (const c of seq.clips) {
    const track = seq.tracks.find((tr) => tr.id === c.trackId)
    if (!track || track.kind !== 'audio') continue
    consider(c, track.muted)
  }

  for (const c of seq.clips) {
    const track = seq.tracks.find((tr) => tr.id === c.trackId)
    if (!track || track.kind !== 'video') continue
    if (c.linkedId && seq.clips.some((x) => x.id === c.linkedId)) continue
    const m = c.mediaId ? byId.get(c.mediaId) : undefined
    if (!m || m.kind !== 'video' || m.hasAudio === false) continue
    consider(c, track.muted)
  }

  return out
}

export function syncProgramAudio(seq: Sequence, media: MediaItem[], t: number, playing: boolean) {
  const want = playing ? audibleAt(seq, media, t) : []
  const wantIds = new Set(want.map((w) => w.media.id))

  for (const [id, a] of audioOnly) {
    if (!wantIds.has(id)) {
      try { a.pause() } catch { /* */ }
    }
  }

  for (const w of want) {
    const m = w.media
    // 视频画面元素保持 muted 只负责画；声音统一走独立 Audio，避免抢 play/pause
    if (m.kind === 'video' || m.kind === 'audio') {
      const a = ensureAudio(m.id, m.url)
      a.volume = w.vol
      if (Math.abs(a.currentTime - w.mediaT) > 0.12) {
        try { a.currentTime = w.mediaT } catch { /* */ }
      }
      if (a.paused) void a.play().catch(() => { /* */ })
    }
  }

}

export function stopProgramAudio() {
  for (const a of audioOnly.values()) {
    try { a.pause() } catch { /* */ }
  }
  muteAllVideos()
}
