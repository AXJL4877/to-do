import type { Clip, MediaItem, Sequence, Track } from '../types'

// Store edits replace arrays/objects. Weak keys let old undo snapshots be collected.
// Index timing once per clips array, not once per playback frame.
type Entry = { clip: Clip; order: number; start: number; end: number }
type ClipIndex = {
  sorted: Entry[]
  maxEnd: Float64Array
  size: number
  end: number
  byId: Map<string, Clip>
  linkedTo: Map<string, Clip>
  byTrack: Map<string, Clip[]>
}
const clipCache = new WeakMap<Clip[], ClipIndex>()
const trackCache = new WeakMap<Track[], Map<string, Track>>()
const mediaCache = new WeakMap<MediaItem[], Map<string, MediaItem>>()

export function indexClips(clips: Clip[]): ClipIndex {
  const hit = clipCache.get(clips)
  if (hit) return hit
  const byId = new Map<string, Clip>()
  const linkedTo = new Map<string, Clip>()
  const byTrack = new Map<string, Clip[]>()
  let end = 0
  const sorted = clips.map((clip, order) => {
    byId.set(clip.id, clip)
    if (clip.linkedId && clip.linkedId !== clip.id && !linkedTo.has(clip.linkedId)) linkedTo.set(clip.linkedId, clip)
    const row = byTrack.get(clip.trackId) ?? []
    row.push(clip)
    byTrack.set(clip.trackId, row)
    const start = clip.start
    const clipEnd = start + clip.duration
    end = Math.max(end, clipEnd)
    return { clip, order, start, end: clipEnd }
  }).sort((a, b) => a.start - b.start || a.order - b.order)
  let size = 1
  while (size < sorted.length) size *= 2
  const maxEnd = new Float64Array(size * 2).fill(-Infinity)
  sorted.forEach((e, i) => { maxEnd[size + i] = e.end })
  for (let i = size - 1; i > 0; i--) maxEnd[i] = Math.max(maxEnd[i * 2], maxEnd[i * 2 + 1])
  const index = { sorted, maxEnd, size, end, byId, linkedTo, byTrack }
  clipCache.set(clips, index)
  return index
}

export function indexTracks(tracks: Track[]): Map<string, Track> {
  let index = trackCache.get(tracks)
  if (!index) { index = new Map(tracks.map(t => [t.id, t])); trackCache.set(tracks, index) }
  return index
}

export function indexMedia(media: MediaItem[]): Map<string, MediaItem> {
  let index = mediaCache.get(media)
  if (!index) { index = new Map(media.map(m => [m.id, m])); mediaCache.set(media, index) }
  return index
}

function upperBound(entries: Entry[], time: number, inclusive = true): number {
  let lo = 0, hi = entries.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (entries[mid].start < time || (inclusive && entries[mid].start === time)) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** All clips covering t, in original array order (including disabled clips). */
export function activeClipsAt(seq: Sequence, time: number): Clip[] {
  return queryClips(seq, time, time, true)
}

/** Half-open interval intersection; touching cuts do not overlap. */
export function clipsOverlappingRange(seq: Sequence, start: number, end: number): Clip[] {
  if (end <= start) return []
  return queryClips(seq, start, end, false)
}

function queryClips(seq: Sequence, start: number, end: number, inclusiveEnd: boolean): Clip[] {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return []
  const { sorted, maxEnd, size } = indexClips(seq.clips)
  const limit = upperBound(sorted, end, inclusiveEnd)
  const hits: Entry[] = []
  const visit = (node: number, lo: number, hi: number) => {
    if (lo >= limit || maxEnd[node] <= start) return
    if (hi - lo === 1) { hits.push(sorted[lo]); return }
    const mid = (lo + hi) >>> 1
    visit(node * 2, lo, mid)
    visit(node * 2 + 1, mid, hi)
  }
  visit(1, 0, size)
  hits.sort((a, b) => a.order - b.order)
  return hits.map(e => e.clip)
}

/** Starts in (time, time + horizon], earliest first for decoder preroll. */
export function upcomingClips(seq: Sequence, time: number, horizon: number): Clip[] {
  const { sorted } = indexClips(seq.clips)
  return sorted.slice(upperBound(sorted, time), upperBound(sorted, time + horizon)).map(e => e.clip)
}
