import type { MediaItem, ProjectSettings, Sequence, Track } from '../types'
import { HAND_TRACK_PREFIX, withChalkHands } from './chalkHandLayers'
import { clipsOverlappingRange } from './sequenceIndex'

const protectedTrack = (t: Track) => t.locked || t.muted || t.hidden || t.solo

export function tidyTimeline(
  seq: Sequence,
  media: MediaItem[] = [],
  settings: Pick<ProjectSettings, 'width' | 'height' | 'fps'> = { width: 1920, height: 1080, fps: 30 },
): Sequence {
  const positions = new Map(seq.tracks.map((t, i) => [t.id, i]))
  const clips = [...seq.clips]
  const clipPositions = new Map(clips.map((c, i) => [c.id, i]))
  // Export's generated hands can outlive their parent by a frame. Include their
  // full bounds when testing both occupancy and relative layer order.
  const expanded = withChalkHands(seq.clips, seq.tracks, media, settings)
  const layers = new Map(expanded.clips.map(c => [c.id, c]))
  const occupancy = { ...seq, clips: clips.map(c => {
    const hand = layers.get(`${c.id}${HAND_TRACK_PREFIX}`)
    if (!hand) return c
    const start = Math.min(c.start, hand.start)
    return { ...c, start, duration: Math.max(c.start + c.duration, hand.start + hand.duration) - start }
  }) }
  let changed = false
  // Move only upwards. Every successful move strictly lowers a track index,
  // so repeated passes terminate and expose slots freed by earlier moves.
  let moved: boolean
  do {
    moved = false
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i]
      const from = positions.get(c.trackId)
      if (from == null || !Number.isFinite(c.start) || !(c.duration > 0)) continue
      const source = seq.tracks[from]
      if (protectedTrack(source) || !['video', 'audio', 'subtitle'].includes(source.kind)) continue
      const bounds = occupancy.clips[i]
      const overlaps = clipsOverlappingRange(occupancy, bounds.start, bounds.start + bounds.duration)
        .filter(other => other.id !== c.id)
      for (let to = 0; to < from; to++) {
        const target = seq.tracks[to]
        if (target.kind !== source.kind || protectedTrack(target)) continue
        const safe = overlaps.every(bounds => {
          const other = clips[clipPositions.get(bounds.id)!]
          const at = positions.get(other.trackId)
          if (at == null) return false
          if (at === to || at === from) return false
          // Preserve relative order against ALL overlapping picture layers,
          // including hidden/disabled ones (they may be enabled again later).
          if (source.kind === 'audio' || seq.tracks[at].kind === 'audio') return true
          return Math.sign(from - at) === Math.sign(to - at)
        })
        if (!safe) continue
        clips[i] = { ...c, trackId: target.id, ...(c.meta ? {
          meta: { ...c.meta, trackId: target.id, trackName: target.name, trackKind: target.kind,
            trackHidden: target.hidden, trackMuted: target.muted, visible: c.enabled !== false && !target.hidden },
        } : {}) }
        moved = changed = true
        break
      }
    }
  } while (moved)
  const used = new Set(clips.map(c => c.trackId))
  // Keep configured/locked empty tracks and at least one existing video/audio track.
  for (const kind of ['video', 'audio']) {
    const ofKind = seq.tracks.filter(t => t.kind === kind)
    if (!ofKind.some(t => used.has(t.id) || protectedTrack(t)) && ofKind[0]) used.add(ofKind[0].id)
  }
  const tracks = seq.tracks.filter(t => used.has(t.id) || protectedTrack(t) || !['video', 'audio', 'subtitle'].includes(t.kind))
  if (!changed && tracks.length === seq.tracks.length) return seq
  return { ...seq, tracks, clips: changed ? clips : seq.clips }
}
