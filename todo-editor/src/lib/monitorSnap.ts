import type { Clip } from '../types'
import { resolveClipTransform } from './keyframeEval'

/** 归一化坐标下的辅助线（画面中心为 0，约 ±1 为边缘） */
export type SnapGuide = {
  orient: 'h' | 'v'
  /** 竖线用 x，横线用 y */
  at: number
  strong?: boolean
}

const FRAME_V = [-1, -0.5, 0, 0.5, 1]
const FRAME_H = [-1, -0.5, 0, 0.5, 1]
const THRESH = 0.038

/** 与选中框/命中盒一致的半宽高（归一化） */
export function clipHalfNorm(clip: Clip, playhead: number, xy?: { x: number; y: number }) {
  const tr = resolveClipTransform(clip, playhead)
  const sx = Math.max(0.05, tr.scaleX)
  const sy = Math.max(0.05, tr.scaleY)
  return {
    x: xy?.x ?? tr.x,
    y: xy?.y ?? tr.y,
    hx: 0.35 * sx,
    hy: 0.28 * sy,
  }
}

type Box = { x: number; y: number; hx: number; hy: number }

function nearest(value: number, targets: number[], thresh: number): number | null {
  let best: number | null = null
  let bestD = thresh
  for (const t of targets) {
    const d = Math.abs(value - t)
    if (d <= bestD) {
      bestD = d
      best = t
    }
  }
  return best
}

/**
 * Shift 拖拽智能吸附：画面中线/四分线/边缘 + 其它元素边对齐/中心重合。
 * 返回吸附后的中心坐标与应绘制的辅助线。
 */
export function snapWithGuides(
  x: number,
  y: number,
  moving: Box,
  others: Box[],
  opts?: { showFrameGrid?: boolean },
): { x: number; y: number; guides: SnapGuide[] } {
  const hx = moving.hx
  const hy = moving.hy
  let outX = x
  let outY = y
  const guides: SnapGuide[] = []

  // 画面参考线（始终可作为吸附目标；showFrameGrid 时淡显）
  if (opts?.showFrameGrid) {
    for (const at of FRAME_V) guides.push({ orient: 'v', at, strong: false })
    for (const at of FRAME_H) guides.push({ orient: 'h', at, strong: false })
  }

  // —— X：中心 / 左右边 对齐画面与其它元素 ——
  const xTargets: { at: number; guideAt: number }[] = []
  for (const fx of FRAME_V) {
    xTargets.push({ at: fx, guideAt: fx }) // 中心贴竖线
    xTargets.push({ at: fx + hx, guideAt: fx }) // 左边贴线 → 中心 = 线 + hx
    xTargets.push({ at: fx - hx, guideAt: fx }) // 右边贴线
  }
  for (const o of others) {
    xTargets.push({ at: o.x, guideAt: o.x }) // 中心重合
    xTargets.push({ at: o.x + o.hx + hx, guideAt: o.x + o.hx }) // 左贴右
    xTargets.push({ at: o.x - o.hx - hx, guideAt: o.x - o.hx }) // 右贴左
    xTargets.push({ at: o.x + o.hx - hx, guideAt: o.x + o.hx }) // 左边对齐
    xTargets.push({ at: o.x - o.hx + hx, guideAt: o.x - o.hx }) // 右边对齐
  }
  const snapX = nearest(x, xTargets.map((t) => t.at), THRESH)
  if (snapX != null) {
    outX = snapX
    const hit = xTargets.find((t) => t.at === snapX)
    if (hit) guides.push({ orient: 'v', at: hit.guideAt, strong: true })
  }

  // —— Y ——
  const yTargets: { at: number; guideAt: number }[] = []
  for (const fy of FRAME_H) {
    yTargets.push({ at: fy, guideAt: fy })
    yTargets.push({ at: fy + hy, guideAt: fy })
    yTargets.push({ at: fy - hy, guideAt: fy })
  }
  for (const o of others) {
    yTargets.push({ at: o.y, guideAt: o.y })
    yTargets.push({ at: o.y + o.hy + hy, guideAt: o.y + o.hy })
    yTargets.push({ at: o.y - o.hy - hy, guideAt: o.y - o.hy })
    yTargets.push({ at: o.y + o.hy - hy, guideAt: o.y + o.hy })
    yTargets.push({ at: o.y - o.hy + hy, guideAt: o.y - o.hy })
  }
  const snapY = nearest(y, yTargets.map((t) => t.at), THRESH)
  if (snapY != null) {
    outY = snapY
    const hit = yTargets.find((t) => t.at === snapY)
    if (hit) guides.push({ orient: 'h', at: hit.guideAt, strong: true })
  }

  // 去重：同一位置只留 strong 优先
  const dedup = new Map<string, SnapGuide>()
  for (const g of guides) {
    const key = `${g.orient}:${g.at.toFixed(4)}`
    const prev = dedup.get(key)
    if (!prev || (g.strong && !prev.strong)) dedup.set(key, g)
  }

  return {
    x: Math.max(-1.2, Math.min(1.2, outX)),
    y: Math.max(-1.2, Math.min(1.2, outY)),
    guides: [...dedup.values()],
  }
}
