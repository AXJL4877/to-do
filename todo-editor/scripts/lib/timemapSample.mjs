/**
 * 与 src/lib/programPlayer.ts mediaTimeCore 同步（供 crosscheck；勿改语义）。
 */
export function mediaTimeCore(clip, absT) {
  if (clip.freeze !== undefined) return clip.freeze
  const speed = Math.max(0.05, clip.speed <= 0 ? 1 : (clip.speed || 1))
  const local = Math.max(0, absT - clip.start)
  if (clip.reverse) {
    const span = clip.outPoint > clip.inPoint
      ? (clip.outPoint - clip.inPoint)
      : Math.max(0.04, clip.duration) * speed
    return Math.max(0, clip.inPoint + span - local * speed)
  }
  return Math.max(0, clip.inPoint + local * speed)
}
