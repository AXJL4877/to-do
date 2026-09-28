import type { Clip, Ease, Keyframe, KfHandle, Transform2D } from '../types'
import { uid } from '../types'

/** 与播放头同一套帧网格，避免选中关键帧后竖线偏半帧 */
export function snapToFrame(t: number, fps: number) {
  const f = Math.max(1, fps)
  return Math.max(0, Math.round(t * f) / f)
}

function easeT(t: number, ease: Ease): number {
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

/** 按预设缓动给出默认可编辑手柄（单位方内） */
export function defaultHandles(ease: Ease): { oh: KfHandle; ih: KfHandle } {
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

function cubic1d(p0: number, p1: number, p2: number, p3: number, u: number) {
  const t = 1 - u
  return t * t * t * p0 + 3 * t * t * u * p1 + 3 * t * u * u * p2 + u * u * u * p3
}

/** 在单位时间 tn∈[0,1] 上采样贝塞尔段 a→b 的数值 */
export function sampleBezierSegment(a: Keyframe, b: Keyframe, tn: number): number {
  const t = Math.max(0, Math.min(1, tn))
  const oh = a.oh ?? defaultHandles(a.ease === 'bezier' ? 'easeInOut' : a.ease).oh
  const ih = b.ih ?? defaultHandles(b.ease === 'bezier' ? 'easeInOut' : b.ease).ih
  const x1 = Math.max(0.001, Math.min(0.999, oh.x))
  const y1 = oh.y
  const x2 = Math.max(0.001, Math.min(0.999, 1 + ih.x))
  const y2 = 1 + ih.y

  // 二分求 Bx(u)=t，要求 x 单调（手柄约束保证）
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

function segmentUsesBezier(a: Keyframe, _b: Keyframe) {
  // 仅当起点明确标成 bezier 才走曲线；切回线性等预设时不再被残留 oh/ih 绑架
  return a.ease === 'bezier'
}

/** 在片段局部时间 localT 采样关键帧；无关键帧时返回 fallback */
export function sampleKeyframes(kfs: Keyframe[] | undefined, localT: number, fallback: number): number {
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
      // 定格：保持 a 的值直到下一帧
      if (a.ease === 'hold') return a.value
      const tn = (localT - a.t) / span
      if (segmentUsesBezier(a, b)) return sampleBezierSegment(a, b, tn)
      // 缓动由起点关键帧决定（选中该点后点「线性」即改离开它的这一段）
      const u = easeT(tn, a.ease)
      return a.value + (b.value - a.value) * u
    }
  }
  return fallback
}

/** 采样整条曲线用于绘制（0..1 归一化坐标）；强制经过每个关键帧时刻，避免菱形「脱线」 */
export function sampleCurvePoints(
  kfs: Keyframe[],
  duration: number,
  steps = 64,
): { x: number; y: number }[] {
  if (!kfs.length || duration <= 0) return []
  const sorted = [...kfs].sort((a, b) => a.t - b.t)
  const vals = sorted.map((k) => k.value)
  let vmin = Math.min(...vals)
  let vmax = Math.max(...vals)
  if (Math.abs(vmax - vmin) < 1e-6) {
    vmin -= 1
    vmax += 1
  }
  const pad = (vmax - vmin) * 0.12
  vmin -= pad
  vmax += pad
  const times = new Set<number>()
  for (let i = 0; i <= steps; i++) times.add((i / steps) * duration)
  for (const k of sorted) times.add(Math.max(0, Math.min(duration, k.t)))
  const out: { x: number; y: number }[] = []
  for (const t of [...times].sort((a, b) => a - b)) {
    const v = sampleKeyframes(sorted, t, sorted[0].value)
    out.push({ x: t / duration, y: 1 - (v - vmin) / (vmax - vmin) })
  }
  return out
}

/**
 * 速度曲线采样：单轨 → 带符号的变化率（单位/秒）；多轨（XY）→ 合速度大小。
 * 关键帧两侧各取单侧差分，保证 hold / 折角处的跳变画成竖边而不是尖刺。
 */
export function sampleSpeedCurve(
  tracks: Keyframe[][],
  duration: number,
  steps = 160,
): { t: number; v: number }[] {
  const live = tracks.filter((k) => k.length)
  if (!live.length || duration <= 0) return []
  const sortedTracks = live.map((k) => [...k].sort((a, b) => a.t - b.t))
  const keyTimes = [...new Set(sortedTracks.flat().map((k) => k.t))].sort((a, b) => a - b)
  let minGap = duration
  for (let i = 1; i < keyTimes.length; i++) minGap = Math.min(minGap, keyTimes[i] - keyTimes[i - 1] || minGap)
  const h = Math.max(1e-5, Math.min(1e-3, minGap / 20))
  const signed = sortedTracks.length === 1

  const valueAt = (t: number) => sortedTracks.map((k) => sampleKeyframes(k, t, k[0].value))
  const speed = (t0: number, t1: number) => {
    const a = valueAt(t0)
    const b = valueAt(t1)
    const dt = t1 - t0
    if (signed) return (b[0] - a[0]) / dt
    return Math.hypot(...a.map((v, i) => b[i] - v)) / dt
  }

  const out: { t: number; v: number }[] = []
  const nearKey = (t: number) => keyTimes.some((k) => Math.abs(k - t) < 3 * h)
  const samples = new Set<number>()
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * duration
    if (!nearKey(t)) samples.add(t)
  }
  for (const k of keyTimes) {
    if (k - 3 * h >= 0) samples.add(k - 2 * h)
    if (k + 3 * h <= duration) samples.add(k + 2 * h)
  }
  for (const t of [...samples].sort((a, b) => a - b)) {
    out.push({ t, v: speed(Math.max(0, t - h), Math.min(duration, t + h)) })
  }
  return out
}

/** 关键帧两侧的单侧速度（入 / 出），用于放置菱形与手柄 */
export function keyframeSideSpeeds(tracks: Keyframe[][], t: number, duration: number) {
  const live = tracks.filter((k) => k.length).map((k) => [...k].sort((a, b) => a.t - b.t))
  const signed = live.length === 1
  const h = 1e-4
  const valueAt = (x: number) => live.map((k) => sampleKeyframes(k, x, k[0].value))
  const rate = (t0: number, t1: number) => {
    const a = valueAt(t0)
    const b = valueAt(t1)
    return signed ? (b[0] - a[0]) / (t1 - t0) : Math.hypot(...a.map((v, i) => b[i] - v)) / (t1 - t0)
  }
  return {
    inSpeed: t - 2 * h >= 0 ? rate(t - 2 * h, t - h) : null,
    outSpeed: t + 2 * h <= duration ? rate(t + h, t + 2 * h) : null,
  }
}

/**
 * 自动贝塞尔（Fritsch–Carlson 单调三次）：首尾、极值点与定格边界切线为 0，
 * 其余按两侧割线的加权调和平均，间隔不均也不过冲，速度在关键帧处连续。
 * 只改 ids 内的关键帧（定格保持定格），邻居若不是 bezier 会按原缓动转成等效手柄。
 */
export function autoBezierKeyframes(list: Keyframe[], ids: Set<string>): Keyframe[] {
  const s = [...list].sort((a, b) => a.t - b.t)
  if (s.length < 2) return s
  const secant = (i: number) => {
    const dt = s[i + 1].t - s[i].t
    return dt > 1e-9 ? (s[i + 1].value - s[i].value) / dt : 0
  }
  const slope = (i: number) => {
    if (i === 0 || i === s.length - 1) return 0
    if (s[i - 1].ease === 'hold' || s[i].ease === 'hold') return 0
    const d0 = secant(i - 1)
    const d1 = secant(i)
    if (d0 * d1 <= 0) return 0
    const h0 = s[i].t - s[i - 1].t
    const h1 = s[i + 1].t - s[i].t
    const w1 = 2 * h1 + h0
    const w2 = h1 + 2 * h0
    return (w1 + w2) / (w1 / d0 + w2 / d1)
  }
  const out = s.map((k) => ({ ...k }))
  for (let i = 0; i < s.length; i++) {
    if (!ids.has(s[i].id)) continue
    const m = slope(i)
    const k = out[i]
    if (k.ease !== 'hold') k.ease = 'bezier'
    if (i < s.length - 1) {
      const spanT = s[i + 1].t - s[i].t
      const spanV = s[i + 1].value - s[i].value
      k.oh = { x: 1 / 3, y: Math.abs(spanV) > 1e-9 ? (m * spanT) / (3 * spanV) : 0 }
    } else {
      k.oh = k.oh ?? defaultHandles('linear').oh
    }
    if (i > 0) {
      const spanT = s[i].t - s[i - 1].t
      const spanV = s[i].value - s[i - 1].value
      k.ih = { x: -1 / 3, y: Math.abs(spanV) > 1e-9 ? -(m * spanT) / (3 * spanV) : 0 }
      const prev = out[i - 1]
      if (prev.ease !== 'bezier' && prev.ease !== 'hold' && !ids.has(prev.id)) {
        const d = defaultHandles(prev.ease)
        out[i - 1] = { ...prev, ease: 'bezier', oh: d.oh, ih: prev.ih ?? d.ih }
      }
    } else {
      k.ih = k.ih ?? defaultHandles('linear').ih
    }
  }
  return out
}

/** 段 a→b 在单位方内的三次贝塞尔控制点（缓入/缓出/线性可精确表示；缓入出需先拆成两段） */
function segmentControls(a: Keyframe, b: Keyframe): [number, number, number, number] {
  switch (a.ease) {
    case 'bezier': {
      const oh = a.oh ?? defaultHandles('easeInOut').oh
      const ih = b.ih ?? defaultHandles(b.ease === 'bezier' ? 'easeInOut' : b.ease).ih
      return [
        Math.max(0.001, Math.min(0.999, oh.x)), oh.y,
        Math.max(0.001, Math.min(0.999, 1 + ih.x)), 1 + ih.y,
      ]
    }
    case 'easeIn': return [1 / 3, 0, 2 / 3, 1 / 3]
    case 'easeOut': return [1 / 3, 2 / 3, 2 / 3, 1]
    default: return [1 / 3, 1 / 3, 2 / 3, 2 / 3]
  }
}

/**
 * 在片段局部时间 T 把关键帧轨切成两段，保证每一帧的取值与切前完全一致：
 * 左段保留 T 之前的关键帧并在 T 补帧；右段时间平移到从 0 开始并在 0 补帧；
 * 切点所在的曲线段按原形状细分（de Casteljau），不是简单截断。
 */
export function splitKeyframes(list: Keyframe[] | undefined, T: number): { left: Keyframe[]; right: Keyframe[] } {
  const s = [...(list ?? [])].sort((a, b) => a.t - b.t)
  if (!s.length) return { left: [], right: [] }
  const eps = 1e-6
  const shift = (k: Keyframe): Keyframe => ({ ...k, t: Math.max(0, k.t - T) })
  if (T <= s[0].t + eps) {
    return { left: [{ id: uid('kf'), t: 0, value: s[0].value, ease: 'linear' }], right: s.map(shift) }
  }
  const last = s[s.length - 1]
  if (T >= last.t - eps) {
    return { left: s, right: [{ id: uid('kf'), t: 0, value: last.value, ease: 'linear' }] }
  }
  const i = s.findIndex((k, j) => j < s.length - 1 && T >= k.t - eps && T < s[j + 1].t - eps)
  const a = s[i]
  if (Math.abs(a.t - T) <= eps) {
    return { left: s.slice(0, i + 1), right: [{ ...a, id: uid('kf') }, ...s.slice(i + 1)].map(shift) }
  }
  const b = s[i + 1]
  // 改 a 的缓动前先钉住它实际生效的入手柄，否则前一段（若为曲线）会因默认手柄变化而变形
  const pinnedIh = a.ih ?? defaultHandles(a.ease === 'bezier' ? 'easeInOut' : a.ease).ih

  // 缓入出 = 前半缓入 + 后半缓出（中点处补帧），这样每段都是精确的三次曲线
  if (a.ease === 'easeInOut') {
    const mid: Keyframe = { id: uid('kf'), t: (a.t + b.t) / 2, value: (a.value + b.value) / 2, ease: 'easeOut' }
    const expanded = [...s.slice(0, i), { ...a, ease: 'easeIn' as Ease, ih: pinnedIh }, mid, ...s.slice(i + 1)]
    return splitKeyframes(expanded, T)
  }

  const value = sampleKeyframes(s, T, a.value)
  if (a.ease === 'hold') {
    return {
      left: [...s.slice(0, i + 1), { id: uid('kf'), t: T, value: a.value, ease: 'hold' }],
      right: [{ id: uid('kf'), t: 0, value: a.value, ease: 'hold' }, ...s.slice(i + 1).map(shift)],
    }
  }

  const tn = (T - a.t) / (b.t - a.t)
  const [x1, y1, x2, y2] = segmentControls(a, b)
  let lo = 0
  let hi = 1
  for (let n = 0; n < 40; n++) {
    const mid = (lo + hi) / 2
    if (cubic1d(0, x1, x2, 1, mid) < tn) lo = mid
    else hi = mid
  }
  const u = (lo + hi) / 2
  const lerp = (p: number, q: number) => p + (q - p) * u
  const ax = lerp(0, x1), ay = lerp(0, y1)
  const bx = lerp(x1, x2), by = lerp(y1, y2)
  const cx = lerp(x2, 1), cy = lerp(y2, 1)
  const dx = lerp(ax, bx), dy = lerp(ay, by)
  const ex = lerp(bx, cx), ey = lerp(by, cy)
  const X = lerp(dx, ex), Y = lerp(dy, ey)
  const ny = (v: number, span: number) => (Math.abs(span) > 1e-9 ? v / span : 0)

  const leftA: Keyframe = { ...a, ease: 'bezier', ih: pinnedIh, oh: { x: ax / X, y: ny(ay, Y) } }
  const cutL: Keyframe = { id: uid('kf'), t: T, value, ease: 'linear', ih: { x: (dx - X) / X, y: ny(dy - Y, Y) } }
  const cutR: Keyframe = { id: uid('kf'), t: 0, value, ease: 'bezier', oh: { x: (ex - X) / (1 - X), y: ny(ey - Y, 1 - Y) } }
  const rightB: Keyframe = { ...shift(b), ih: { x: (cx - 1) / (1 - X), y: ny(cy - 1, 1 - Y) } }
  return {
    left: [...s.slice(0, i), leftA, cutL],
    right: [cutR, rightB, ...s.slice(i + 2).map(shift)],
  }
}

export function valueRange(kfs: Keyframe[]) {
  if (!kfs.length) return { vmin: 0, vmax: 1 }
  const vals = kfs.map((k) => k.value)
  let vmin = Math.min(...vals)
  let vmax = Math.max(...vals)
  if (Math.abs(vmax - vmin) < 1e-6) {
    vmin -= 1
    vmax += 1
  }
  const pad = (vmax - vmin) * 0.12
  return { vmin: vmin - pad, vmax: vmax + pad }
}

export function keyframeCount(kfs: Record<string, Keyframe[]>): number {
  return Object.values(kfs).reduce((n, arr) => n + arr.length, 0)
}

export function hasKeyframeNear(kfs: Keyframe[] | undefined, localT: number, thresh = 0.08): boolean {
  if (!kfs?.length) return false
  return kfs.some((k) => Math.abs(k.t - localT) < thresh)
}

/** 播放头时刻的实际变换（关键帧插值 + 静态 transform 兜底） */
export function resolveClipTransform(clip: Clip, playhead: number): Transform2D {
  const localT = Math.max(0, playhead - clip.start)
  const kf = clip.keyframes
  const tr = clip.transform
  const scale = sampleKeyframes(kf.scale, localT, tr.scaleX)
  return {
    ...tr,
    x: sampleKeyframes(kf.x, localT, tr.x),
    y: sampleKeyframes(kf.y, localT, tr.y),
    scaleX: scale,
    scaleY: kf.scale?.length ? scale : sampleKeyframes(kf.scaleY, localT, tr.scaleY),
    rotation: sampleKeyframes(kf.rotation, localT, tr.rotation),
    opacity: sampleKeyframes(kf.opacity, localT, tr.opacity),
  }
}

export function effectiveTransform(
  clip: Clip,
  playhead: number,
  xyOverride?: { x: number; y: number },
): Transform2D {
  const tr = resolveClipTransform(clip, playhead)
  if (!xyOverride) return tr
  return { ...tr, x: xyOverride.x, y: xyOverride.y }
}

function upsertKeyframeAt(
  keyframes: Record<string, Keyframe[]>,
  prop: string,
  localT: number,
  value: number,
  fps = 30,
): Record<string, Keyframe[]> {
  const t = snapToFrame(localT, fps)
  let list = [...(keyframes[prop] ?? [])]
  const thresh = 0.5 / Math.max(1, fps)
  const idx = list.findIndex((k) => Math.abs(k.t - t) < thresh)
  if (idx >= 0) list[idx] = { ...list[idx], value, t }
  else list.push({ id: uid('kf'), t, value, ease: 'linear' })
  list.sort((a, b) => a.t - b.t)
  return { ...keyframes, [prop]: list }
}

/** 在播放头钉住当前位置关键帧（K帧模式开启时用） */
export function seedPositionKeyframes(clip: Clip, playhead: number): Clip {
  const localT = Math.max(0, playhead - clip.start)
  const live = resolveClipTransform(clip, playhead)
  let keyframes = clip.keyframes
  if (!(keyframes.x?.length) && localT > 0.08) {
    const at0 = resolveClipTransform(clip, clip.start)
    keyframes = upsertKeyframeAt(keyframes, 'x', 0, at0.x)
    keyframes = upsertKeyframeAt(keyframes, 'y', 0, at0.y)
  }
  keyframes = upsertKeyframeAt(keyframes, 'x', localT, live.x)
  keyframes = upsertKeyframeAt(keyframes, 'y', localT, live.y)
  return { ...clip, keyframes }
}

const TRANSFORM_KF: Partial<Record<keyof Transform2D, string>> = {
  x: 'x', y: 'y', scaleX: 'scale', scaleY: 'scale', rotation: 'rotation', opacity: 'opacity',
}

/** 修改 transform 时同步当前播放头处的关键帧（若该属性有关键帧轨） */
export function patchClipTransform(clip: Clip, playhead: number, patch: Partial<Transform2D>): Clip {
  const localT = Math.max(0, playhead - clip.start)
  const transform = { ...clip.transform, ...patch }
  let keyframes = clip.keyframes
  for (const [key, val] of Object.entries(patch)) {
    if (val === undefined || typeof val !== 'number') continue
    const kfProp = TRANSFORM_KF[key as keyof Transform2D]
    if (!kfProp) continue
    const kfVal = kfProp === 'scale' ? transform.scaleX : val
    if ((keyframes[kfProp]?.length ?? 0) > 0) {
      keyframes = upsertKeyframeAt(keyframes, kfProp, localT, kfVal)
    }
  }
  return { ...clip, transform, keyframes }
}

/** 节目监视器拖拽提交；forceKf=true 时始终写入 x/y 关键帧（K帧模式） */
export function patchClipXY(
  clip: Clip,
  playhead: number,
  x: number,
  y: number,
  opts?: { forceKf?: boolean },
): Clip {
  const localT = Math.max(0, playhead - clip.start)
  let keyframes = clip.keyframes
  const transform = { ...clip.transform, x, y }
  const force = opts?.forceKf === true
  const hadX = (keyframes.x?.length ?? 0) > 0
  const hadY = (keyframes.y?.length ?? 0) > 0

  if (force) {
    if (!hadX && localT > 0.08) {
      const at0 = resolveClipTransform(clip, clip.start)
      keyframes = upsertKeyframeAt(keyframes, 'x', 0, at0.x)
    }
    if (!hadY && localT > 0.08) {
      const at0 = resolveClipTransform(clip, clip.start)
      keyframes = upsertKeyframeAt(keyframes, 'y', 0, at0.y)
    }
    keyframes = upsertKeyframeAt(keyframes, 'x', localT, x)
    keyframes = upsertKeyframeAt(keyframes, 'y', localT, y)
  } else {
    if (hadX) keyframes = upsertKeyframeAt(keyframes, 'x', localT, x)
    if (hadY) keyframes = upsertKeyframeAt(keyframes, 'y', localT, y)
  }
  return { ...clip, transform, keyframes }
}
