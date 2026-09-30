import type { MediaItem, ProjectSettings, Sequence } from '../types'

type Picture = { id: string; start: number; end: number; signature: string }
type Identity = { version: number; base: string; tracks: string[]; pictures: Picture[]; fps: number }

/** Only picture dependencies belong here: job status, names and audio cannot change pixels. */
export function pictureIdentity(seq: Sequence, settings: ProjectSettings, w: number, h: number, media: MediaItem[]) {
  const tracks = new Map(seq.tracks.map(t => [t.id, t]))
  const sources = new Map(media.map(m => [m.id, [m.path || m.url, m.kind, m.width, m.height, m.duration, m.alpha, m.offline]]))
  const pictures = seq.clips.flatMap(c => {
    const track = tracks.get(c.trackId)
    if (!c.enabled || !track || track.hidden || track.kind === 'audio') return []
    const chalk = c.meta?.source?.chalk
    return [{ id: c.id, start: c.start, end: c.start + c.duration,
      signature: JSON.stringify([c.trackId, track.kind, c.mediaId, sources.get(c.mediaId ?? ''),
        c.start, c.duration, c.inPoint, c.outPoint, c.speed, c.reverse, c.freeze, c.speedKeyframes,
        c.transform, c.keyframes, c.color, c.text, c.solid, c.effects, c.mask, c.blend,
        c.transitionIn, c.transitionOut, c.chromaKey, c.threeD, c.transform3d,
        chalk, sources.get(chalk?.hand.mediaId ?? '')]) }]
  })
  return JSON.stringify({ version: 2,
    base: JSON.stringify([seq.id, w, h, settings.width, settings.height, settings.fps,
      settings.canvasBg, settings.canvasColor, seq.scene3d]),
    tracks: seq.tracks.filter(t => t.kind !== 'audio').map(t => t.id), pictures, fps: settings.fps,
  } satisfies Identity)
}

/** null means incompatible surfaces; otherwise only these intervals need recomposition. */
export function changedPictureRanges(before: string, after: string): { start: number; end: number }[] | null {
  if (before === after) return []
  try {
    const a: Identity = JSON.parse(before), b: Identity = JSON.parse(after)
    if (a.version !== 2 || b.version !== 2 || a.base !== b.base) return null
    const sameOrder = (old: string[], next: string[]) => {
      const oldSet = new Set(old), nextSet = new Set(next)
      return JSON.stringify(old.filter(id => nextSet.has(id))) === JSON.stringify(next.filter(id => oldSet.has(id)))
    }
    // Stacking follows track order only (clipStackRank); same-track clips never overlap, so clip array order is irrelevant.
    if (!sameOrder(a.tracks, b.tracks)) return null
    const old = new Map(a.pictures.map(c => [c.id, c]))
    const next = new Map(b.pictures.map(c => [c.id, c]))
    const ranges: { start: number; end: number }[] = []
    const pad = 1 / Math.max(1, b.fps)
    for (const id of new Set([...old.keys(), ...next.keys()])) {
      const prev = old.get(id), curr = next.get(id)
      if (prev?.signature === curr?.signature) continue
      for (const c of [prev, curr]) if (c) ranges.push({ start: c.start - pad, end: c.end + pad })
    }
    return ranges
  } catch { return null }
}

export function retainedPictureFrame(before: string, after: string): (frame: number) => boolean {
  const ranges = changedPictureRanges(before, after)
  if (!ranges) return () => false
  const fps = Math.max(1, (JSON.parse(after) as Identity).fps)
  return frame => !ranges.some(r => frame / fps >= r.start && frame / fps < r.end)
}
