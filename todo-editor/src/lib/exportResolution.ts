import type { MediaItem, Sequence } from '../types'
import { mayHaveAlpha } from './mediaAlpha'

/** 导出分辨率：按工程 / 按主素材原尺寸 / 按短边档位。画面比例始终跟工程一致（片段位置按画面比例存） */
export type ExportResolution = 'project' | 'source' | '720' | '1080' | '1440' | '2160'

export const EXPORT_RESOLUTIONS: { value: ExportResolution; label: string }[] = [
  { value: 'project', label: '按工程' },
  { value: 'source', label: '按素材原尺寸' },
  { value: '720', label: '720p' },
  { value: '1080', label: '1080p' },
  { value: '1440', label: '2K' },
  { value: '2160', label: '4K' },
]

const even = (v: number) => Math.max(16, Math.round(v / 2) * 2)

/** 时间线上占时最长的不透明视频素材（透明叠层、图片不算）的短边；没有就 null */
export function mainSourceShortEdge(seq: Sequence, media: MediaItem[]): number | null {
  const videoTracks = new Set(seq.tracks.filter((t) => t.kind === 'video' && !t.hidden).map((t) => t.id))
  const byId = new Map(media.map((m) => [m.id, m]))
  const used = new Map<string, number>()
  for (const c of seq.clips) {
    if (!c.enabled || !c.mediaId || !videoTracks.has(c.trackId)) continue
    const m = byId.get(c.mediaId)
    if (m?.kind !== 'video' || !m.width || !m.height || mayHaveAlpha(m)) continue
    used.set(m.id, (used.get(m.id) ?? 0) + c.duration)
  }
  let best: MediaItem | null = null
  let bestDur = 0
  for (const [id, dur] of used) {
    if (dur > bestDur) { bestDur = dur; best = byId.get(id)! }
  }
  return best ? Math.min(best.width!, best.height!) : null
}

/** 工程画幅按短边等比缩放到目标分辨率 */
export function exportSize(res: ExportResolution, project: { width: number; height: number }, sourceShort: number | null) {
  const projShort = Math.min(project.width, project.height)
  const short = res === 'project' ? projShort : res === 'source' ? (sourceShort ?? projShort) : Number(res)
  const k = short / projShort
  return { width: even(project.width * k), height: even(project.height * k) }
}
