import type { MediaItem } from '../types'

/** 可能带透明通道：明确标过的按标记；没标过的 WebM / PNG（旧工程、没探测到）按透明处理 */
export function mayHaveAlpha(
  m: Pick<MediaItem, 'kind' | 'url' | 'path' | 'alpha' | 'chromaKey'> | undefined,
): boolean {
  if (!m) return false
  const file = m.path || m.url
  if (m.kind === 'image' || m.kind === 'sticker') return m.alpha ?? /\.png(?:[?#]|$)/i.test(file)
  if (m.kind !== 'video') return false
  // H.264 黑底 + 近黑抠像：合成时当透明叠层（未出帧勿画占位黑块）
  if (m.chromaKey === 'nearblack') return true
  if (m.alpha != null) return m.alpha
  return /\.webm(?:[?#]|$)/i.test(file)
}
