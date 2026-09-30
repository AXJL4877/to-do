/** 时间线缩放（px/秒）：1 px/s 时十分钟约 600px，一屏能看全 */
export const ZOOM_MIN = 1
export const ZOOM_MAX = 200

export function clampZoom(z: number) {
  // 取整太粗时触控板的细小滚动会被舍掉，缩放卡住不动
  return Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) * 100) / 100
}

/** 按比例缩放，长短时间线手感一致 */
export function stepZoom(z: number, dir: number, factor = 1.25) {
  return clampZoom(dir > 0 ? z * factor : z / factor)
}

/** 滚轮缩放按滚动量连续变化：鼠标一格（deltaY≈100）约 1.15 倍，触控板的小步滚动对应小幅缩放 */
export function wheelZoom(z: number, deltaY: number) {
  return clampZoom(z * Math.exp(-Math.max(-300, Math.min(300, deltaY)) * 0.0014))
}

export const fmtZoom = (z: number) => (z >= 10 ? String(Math.round(z)) : z.toFixed(1))

const RULER_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600]

/** 标尺刻度间隔（秒），保证相邻刻度文字不挤 */
export function rulerStep(pxPerSec: number, minGapPx = 44) {
  return RULER_STEPS.find((s) => s * pxPerSec >= minGapPx) ?? RULER_STEPS[RULER_STEPS.length - 1]
}

export function fmtRulerTime(t: number, step: number) {
  if (step < 60 && t < 60) return `${t}s`
  const m = Math.floor(t / 60)
  const s = Math.round(t % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}
