/**
 * 节目预览 = 时间线合成播放器（对齐多轨架构）
 *
 * 时间线 → 调度(T 下全部 active clips)
 *   → 每层独立 HTMLVideo 采样（超时用上一帧，不堵全局）
 *   → z-order 合成 → 节目窗
 *   → 全部活跃音轨 → 混音 → 一个输出
 *
 * 主钟：播放时用系统/墙钟推进 absT；元素绝不能反推播放头。
 * 音频异常时不挂住视频（本来就不挂音频钟）。
 */
import type { Clip, MediaItem, Sequence, Track } from '../types'

export function quantizeAbsT(absT: number, fps: number): number {
  const f = Math.max(1, fps)
  return Math.round(absT * f) / f
}

export function frameIndex(absT: number, fps: number): number {
  return Math.round(quantizeAbsT(absT, fps) * Math.max(1, fps))
}

/** 绝对时间 → 该 clip 片内时间（帧对齐） */
export function mediaTimeAt(clip: Clip, absT: number, fps: number): number {
  const speed = Math.max(0.05, clip.speed || 1)
  const local = Math.max(0, absT - clip.start)
  const raw = clip.reverse
    ? Math.max(0, clip.outPoint - local * speed)
    : clip.inPoint + local * speed
  const step = 1 / Math.max(1, fps)
  return Math.max(0, Math.round(raw / step) * step)
}

export function clipCoversAbsT(clip: Clip, absT: number): boolean {
  return !!clip.enabled && absT >= clip.start && absT < clip.start + clip.duration
}

export function trackVisible(seq: Sequence, trackId: string): Track | undefined {
  const tr = seq.tracks.find((t) => t.id === trackId)
  if (!tr || tr.hidden) return undefined
  return tr
}

/** ① 播放头 T 下全部画面层（不含纯音轨），供合成器按 z-order 全画 */
export function pictureClipsAt(seq: Sequence, absT: number): Clip[] {
  return seq.clips.filter((c) => {
    if (!clipCoversAbsT(c, absT)) return false
    const tr = trackVisible(seq, c.trackId)
    return !!tr && tr.kind !== 'audio'
  })
}

/** ③ 播放头 T 下应进混音器的片段（音轨 + 无链接 A 的视频声源） */
export function audibleClipsAt(seq: Sequence, absT: number): Clip[] {
  return seq.clips.filter((c) => {
    if (!clipCoversAbsT(c, absT) || c.audio.mute) return false
    const tr = trackVisible(seq, c.trackId)
    return !!tr && !tr.muted
  })
}

/** 视频轨上、此刻需要单独拉原片声的 clip（无可用链接 A） */
export function videoNeedsDirectAudio(
  seq: Sequence,
  clip: Clip,
  absT: number,
  media: MediaItem[],
): boolean {
  const tr = seq.tracks.find((t) => t.id === clip.trackId)
  if (!tr || tr.kind !== 'video' || tr.muted || tr.hidden) return false
  if (!clipCoversAbsT(clip, absT) || clip.audio.mute) return false
  const m = media.find((x) => x.id === clip.mediaId)
  if (!m || m.kind !== 'video' || !m.url || m.offline) return false

  const partner = (clip.linkedId ? seq.clips.find((x) => x.id === clip.linkedId) : undefined)
    ?? seq.clips.find((x) => x.linkedId === clip.id && x.id !== clip.id)
  if (!partner || !clipCoversAbsT(partner, absT) || partner.audio.mute) return true
  const ptr = seq.tracks.find((t) => t.id === partner.trackId)
  if (!ptr || ptr.kind !== 'audio' || ptr.muted) return true
  return false
}
