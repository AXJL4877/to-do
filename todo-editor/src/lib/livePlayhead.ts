/** 播放中的播放头：不走 Zustand，避免整页重渲染卡掉监视器 */
let t = 0
const subs = new Set<() => void>()

export function setLivePlayhead(next: number) {
  if (Math.abs(next - t) < 1e-4) return
  t = next
  subs.forEach((cb) => cb())
}

export function getLivePlayhead() {
  return t
}

export function subscribeLivePlayhead(cb: () => void) {
  subs.add(cb)
  return () => { subs.delete(cb) }
}
