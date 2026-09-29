/**
 * 「粉笔手书写」入场动画的渲染：元素片段上开了粉笔手时，预览 / 导出在渲染那一刻按笔尖轨迹
 * 生成一个只存在于渲染里的手图层（紧贴元素所在轨的上方），时间轴上没有这个片段。
 * 元素挪到哪、缩放多大、改到哪个时间，手都按元素当下的样子现算。
 */
import type { ChalkStroke, Clip, Keyframe, Track, Transform2D } from '../types'
import { defaultAudio, defaultColor, defaultTransform } from '../types'
import { resolveClipTransform } from './keyframeEval'

type Size = { width: number; height: number }
type MediaLike = { id: string; width?: number; height?: number }

/** 生成画幅 → 工程画面：等比放进去居中 */
function frameMap(frame: Size, proj: Size) {
  const k = Math.min(proj.width / frame.width, proj.height / frame.height)
  return { k, ox: (proj.width - frame.width * k) / 2, oy: (proj.height - frame.height * k) / 2 }
}

const fitOf = (w: number, h: number, proj: Size) => Math.min(proj.width / w, proj.height / h)

/** 裁好的元素素材放回它在生成画面里的位置和大小（片段默认是等比铺满画面居中） */
export function elementTransform(crop: number[], frame: Size, proj: Size): Partial<Transform2D> {
  const [x, y, w, h] = crop
  const { k, ox, oy } = frameMap(frame, proj)
  const s = k / fitOf(w, h, proj)
  const cx = ox + (x + w / 2) * k
  const cy = oy + (y + h / 2) * k
  return { x: (cx - proj.width / 2) / (proj.width / 2), y: (cy - proj.height / 2) / (proj.height / 2), scaleX: s, scaleY: s }
}

/** 按元素片段当前的时间和变换算手：start/duration 为时间线绝对秒，关键帧为手图层内时间 */
export function handTrack(elem: Clip, chalk: ChalkStroke, mediaSize: Size, proj: Size, fps: number, scale = 1) {
  const speed = elem.speed || 1
  const inP = elem.inPoint
  const tip = chalk.tip.filter(([t]) => t >= inP - 1e-3 && (t - inP) / speed <= elem.duration + 1e-3)
  if (!tip.length) return null
  const t0 = tip[0][0]
  const { k } = frameMap(chalk.frame, proj)
  const hand = chalk.hand
  const hw = hand.width * k * scale
  const hh = hand.height * k * scale
  const hs = (k * scale) / fitOf(hand.width, hand.height, proj)
  const fitE = fitOf(mediaSize.width, mediaSize.height, proj)
  const xs: Keyframe[] = []
  const ys: Keyframe[] = []
  tip.forEach(([t, u, v], i) => {
    const tr = resolveClipTransform(elem, elem.start + (t - inP) / speed)
    const dw = mediaSize.width * fitE * Math.abs(tr.scaleX)
    const dh = mediaSize.height * fitE * Math.abs(tr.scaleY)
    const px = proj.width / 2 + tr.x * proj.width / 2 + (u - 0.5) * dw
    const py = proj.height / 2 + tr.y * proj.height / 2 + (v - 0.5) * dh
    const cx = px + (0.5 - hand.tipX) * hw
    const cy = py + (0.5 - hand.tipY) * hh
    const lt = (t - t0) / speed
    xs.push({ id: `hx${i}`, t: lt, value: (cx - proj.width / 2) / (proj.width / 2), ease: 'linear' })
    ys.push({ id: `hy${i}`, t: lt, value: (cy - proj.height / 2) / (proj.height / 2), ease: 'linear' })
  })
  return {
    start: elem.start + (t0 - inP) / speed,
    duration: Math.max(1 / fps, xs[xs.length - 1].t + 1 / fps),
    transform: { x: xs[0].value, y: ys[0].value, scaleX: hs, scaleY: hs } as Partial<Transform2D>,
    keyframes: { x: xs, y: ys } as Clip['keyframes'],
  }
}

export const HAND_TRACK_PREFIX = '__chalkhand__'

const cache = new WeakMap<Clip, { key: string; layer: Clip | null }>()

function handLayer(c: Clip, media: MediaLike[], proj: Size, fps: number): Clip | null {
  const chalk = c.meta?.source?.chalk
  if (!chalk?.on || !chalk.hand.mediaId || !media.some((m) => m.id === chalk.hand.mediaId)) return null
  const key = `${proj.width}x${proj.height}@${fps}`
  const hit = cache.get(c)
  if (hit?.key === key) return hit.layer
  const m = media.find((x) => x.id === c.mediaId)
  const track = m?.width && m.height ? handTrack(c, chalk, { width: m.width, height: m.height }, proj, fps, chalk.scale ?? 1) : null
  const layer: Clip | null = track && {
    id: `${c.id}${HAND_TRACK_PREFIX}`, trackId: `${HAND_TRACK_PREFIX}${c.trackId}`, mediaId: chalk.hand.mediaId, name: `${c.name} · 粉笔手`,
    start: track.start, duration: track.duration, inPoint: 0, outPoint: track.duration,
    enabled: c.enabled, speed: 1, reverse: false, speedKeyframes: [],
    transform: { ...defaultTransform(), ...track.transform, opacity: c.transform.opacity },
    color: defaultColor(), audio: defaultAudio(), effects: [], blend: 'normal', keyframes: track.keyframes,
  }
  cache.set(c, { key, layer })
  return layer
}

/** 渲染用：把开了粉笔手的元素展开出手图层，每条元素轨正上方插一条同属性的虚拟轨 */
export function withChalkHands<C, T extends Pick<Track, 'id'> & Partial<Pick<Track, 'name'>>>(
  clips: C[], tracks: T[], media: MediaLike[], proj: Size & { fps: number },
): { clips: C[]; tracks: T[] } {
  const layers = clips.flatMap((c) => {
    const l = handLayer(c as unknown as Clip, media, proj, proj.fps)
    return l ? [l as unknown as C] : []
  })
  if (!layers.length) return { clips, tracks }
  const withHands = new Set(layers.map((l) => (l as unknown as Clip).trackId))
  const outTracks = tracks.flatMap((t) => {
    const id = `${HAND_TRACK_PREFIX}${t.id}`
    return withHands.has(id) ? [{ ...t, id, name: `${t.name ?? ''} 粉笔手` } as T, t] : [t]
  })
  return { clips: [...clips, ...layers], tracks: outTracks }
}
