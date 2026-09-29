/** 时间线缩放（px/秒）：1 px/s 时十分钟约 600px，一屏能看全 */
export const ZOOM_MIN = 1
export const ZOOM_MAX = 200

export function clampZoom(z: number) {
  const v = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))
  return v >= 10 ? Math.round(v) : Math.round(v * 10) / 10
}

/** 按比例缩放，长短时间线手感一致 */
export function stepZoom(z: number, dir: number, factor = 1.25) {
  return clampZoom(dir > 0 ? z * factor : z / factor)
}

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
