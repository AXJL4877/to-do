/**
 * 与 src/lib/keyframeEval.ts 同步的纯采样实现（供 crosscheck；勿改语义）。
 * 公式源：easeT / sampleBezierSegment / sampleKeyframes / defaultHandles
 */

export function defaultHandles(ease) {
  switch (ease) {
    case 'easeIn': return { oh: { x: 0.42, y: 0 }, ih: { x: -0.15, y: -0.15 } }
    case 'easeOut': return { oh: { x: 0.15, y: 0.15 }, ih: { x: -0.42, y: 0 } }
    case 'easeInOut': return { oh: { x: 0.42, y: 0 }, ih: { x: -0.42, y: 0 } }
    case 'hold': return { oh: { x: 0.001, y: 0 }, ih: { x: -0.001, y: 0 } }
    case 'bezier':
    case 'linear':
    default: return { oh: { x: 1 / 3, y: 1 / 3 }, ih: { x: -1 / 3, y: -1 / 3 } }
  }
}

function easeT(t, ease) {
  const x = Math.max(0, Math.min(1, t))
  switch (ease) {
    case 'easeIn': return x * x
    case 'easeOut': return x * (2 - x)
    case 'easeInOut': return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2
    case 'hold': return 0
    case 'bezier':
    case 'linear':
    default: return x
  }
}

function cubic1d(p0, p1, p2, p3, u) {
  const t = 1 - u
  return t * t * t * p0 + 3 * t * t * u * p1 + 3 * t * u * u * p2 + u * u * u * p3
}

export function sampleBezierSegment(a, b, tn) {
  const t = Math.max(0, Math.min(1, tn))
  const oh = a.oh ?? defaultHandles(a.ease === 'bezier' ? 'easeInOut' : a.ease).oh
  const ih = b.ih ?? defaultHandles(b.ease === 'bezier' ? 'easeInOut' : b.ease).ih
  const x1 = Math.max(0.001, Math.min(0.999, oh.x))
  const y1 = oh.y
  const x2 = Math.max(0.001, Math.min(0.999, 1 + ih.x))
  const y2 = 1 + ih.y
  let lo = 0
  let hi = 1
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (cubic1d(0, x1, x2, 1, mid) < t) lo = mid
    else hi = mid
  }
  const u = (lo + hi) / 2
  const y = cubic1d(0, y1, y2, 1, u)
  return a.value + (b.value - a.value) * y
}

export function sampleKeyframes(kfs, localT, fallback) {
  if (!kfs?.length) return fallback
  const sorted = [...kfs].sort((a, b) => a.t - b.t)
  if (localT <= sorted[0].t) return sorted[0].value
  if (localT >= sorted[sorted.length - 1].t) return sorted[sorted.length - 1].value
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]
    const b = sorted[i + 1]
    if (localT >= a.t && localT <= b.t) {
      const span = b.t - a.t
      if (span <= 1e-6) return b.value
      if (a.ease === 'hold') return a.value
      const tn = (localT - a.t) / span
      if (a.ease === 'bezier') return sampleBezierSegment(a, b, tn)
      const u = easeT(tn, a.ease)
      return a.value + (b.value - a.value) * u
    }
  }
  return fallback
}
