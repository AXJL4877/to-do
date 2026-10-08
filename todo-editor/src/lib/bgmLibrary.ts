/**
 * 应用级配乐曲库（所有工程共用）+ 铺到成片时的时长计算。
 * 曲目文件留在用户自己的路径上，这里只存清单。
 */
import { pathToFileUrl } from './importFiles'

export const BGM_LIBRARY_KEY = 'todo.bgm.library'
export const BGM_MOODS = ['沉稳', '轻快', '紧张', '收尾'] as const
export type BgmMood = (typeof BGM_MOODS)[number]
export type BgmEnergy = 'low' | 'mid'

export type BgmEntry = {
  id: string
  title: string
  /** 本机绝对路径；重启后靠它恢复播放 */
  path: string
  /** 没有路径时的播放地址（浏览器里的 blob） */
  url?: string
  duration: number
  moods: BgmMood[]
  energy: BgmEnergy
  /** 短于成片时按整段接龙，最后一段裁齐 */
  loop: boolean
  /** 垫在口播下的增益，通常 -18 到 -24 */
  gainDb: number
  sourceNote: string
}

export type BgmPiece = { start: number; duration: number; inPoint: number; outPoint: number }

const EPS = 0.05

export function bgmPlaybackUrl(entry: { path: string; url?: string }) {
  if (entry.path) return pathToFileUrl(entry.path)
  return entry.url || ''
}

/** 曲子相对成片区间：更长就裁尾；更短且可循环就接龙，否则只放一遍。 */
export function planBgmPieces(musicDuration: number, spanStart: number, spanEnd: number, loop: boolean): BgmPiece[] {
  const span = spanEnd - spanStart
  if (!(musicDuration > EPS) || !(span > EPS)) return []
  const one = (start: number, duration: number): BgmPiece => ({
    start, duration, inPoint: 0, outPoint: duration,
  })
  if (!loop || musicDuration >= span - 0.001) return [one(spanStart, Math.min(musicDuration, span))]
  const out: BgmPiece[] = []
  let t = spanStart
  while (t < spanEnd - EPS) {
    const duration = Math.min(musicDuration, spanEnd - t)
    if (duration < EPS) break
    out.push(one(t, duration))
    t += duration
  }
  return out
}

type SpanClip = {
  trackId: string
  start: number
  duration: number
  enabled?: boolean
  mediaId?: string
  linkedId?: string
  meta?: { role?: 'bgm' }
}
type SpanTrack = { id: string; kind: string; role?: 'bgm' }

/**
 * 铺配乐的时间范围。
 * 有独立音频（配音，不含视频拆出来的音轨、不含配乐本身）就包住这些片段；
 * 否则从 0 铺到时间线末尾。只有旧配乐时也给出范围，方便换一首。
 */
export function bedSpan(seq: { tracks: SpanTrack[]; clips: SpanClip[] }): { start: number; end: number } | null {
  const tracks = new Map(seq.tracks.map((t) => [t.id, t]))
  const bgmTracks = new Set(seq.tracks.filter((t) => t.role === 'bgm').map((t) => t.id))
  const live = seq.clips.filter((c) => c.enabled !== false && c.duration > EPS)
  const narration = live.filter((c) => {
    if (!c.mediaId || c.linkedId || c.meta?.role === 'bgm' || bgmTracks.has(c.trackId)) return false
    const track = tracks.get(c.trackId)
    return !!track && track.kind === 'audio' && track.role !== 'bgm'
  })
  const endOf = (c: SpanClip) => c.start + c.duration
  if (narration.length) {
    const start = Math.min(...narration.map((c) => c.start))
    const end = Math.max(...narration.map(endOf))
    return end - start > EPS ? { start, end } : null
  }
  if (!live.length) return null
  const end = Math.max(...live.map(endOf))
  return end > EPS ? { start: 0, end } : null
}

function asMoods(raw: unknown): BgmMood[] {
  if (!Array.isArray(raw)) return []
  const allow = new Set<string>(BGM_MOODS)
  return [...new Set(raw.filter((m): m is BgmMood => typeof m === 'string' && allow.has(m)))]
}

function parseEntry(raw: unknown): BgmEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const duration = Number(o.duration)
  const title = String(o.title ?? '').trim().slice(0, 80)
  const id = String(o.id ?? '').trim()
  if (!id || !(duration > EPS)) return null
  const gain = Number(o.gainDb)
  return {
    id,
    title: title || '未命名',
    path: typeof o.path === 'string' ? o.path : '',
    ...(typeof o.url === 'string' && o.url ? { url: o.url } : {}),
    duration,
    moods: asMoods(o.moods),
    energy: o.energy === 'low' ? 'low' : 'mid',
    loop: o.loop !== false,
    gainDb: Number.isFinite(gain) ? Math.max(-60, Math.min(0, gain)) : -20,
    sourceNote: typeof o.sourceNote === 'string' ? o.sourceNote.trim().slice(0, 80) : '',
  }
}

export function parseBgmLibrary(raw: unknown): BgmEntry[] {
  const items = raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items)
    ? (raw as { items: unknown[] }).items
    : []
  const out: BgmEntry[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const entry = parseEntry(item)
    if (!entry || seen.has(entry.id)) continue
    seen.add(entry.id)
    out.push(entry)
  }
  return out
}

export function loadBgmLibrary(): BgmEntry[] {
  try {
    return parseBgmLibrary(JSON.parse(localStorage.getItem(BGM_LIBRARY_KEY) || 'null'))
  } catch {
    return []
  }
}

export function saveBgmLibrary(items: BgmEntry[]) {
  try {
    localStorage.setItem(BGM_LIBRARY_KEY, JSON.stringify({ version: 1, items }))
  } catch { /* 配额满了就只留在内存里 */ }
}
