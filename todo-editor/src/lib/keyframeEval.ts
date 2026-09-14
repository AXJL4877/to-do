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
