import type { FancyText } from '../types'
/** 预览/导出共用的时间线描述（v1）。compose / export / Monitor 均消费此结构。 */
export const EDIT_GRAPH_VERSION = 1 as const

export type EditGraphKfHandle = { x: number; y: number }

export type EditGraphKeyframe = {
  t: number
  value: number
  /** 缺省 linear；为 linear 时可省略以保持旧 fixture JSON 不变 */
  ease?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'hold' | 'bezier'
  oh?: EditGraphKfHandle
  ih?: EditGraphKfHandle
}

export type EditGraphText = {
  fancy?: FancyText
  lineHeight?: number
  letterSpacing?: number
  animIn?: string
  animOut?: string
  animInDur?: number
  animOutDur?: number
  content: string
  fontFamily?: string
  fontSize?: number
  color?: string
  align?: string
  bilingual?: string
  strokeWidth?: number
  strokeColor?: string
}

export type EditGraphEffect = {
  type: string
  strength: number
  enabled?: boolean
}

export type EditGraphMask = {
  type: string
  feather: number
  expand: number
  invert: boolean
  points?: Array<{ x: number; y: number }>
}

export type EditGraphClip = {
  id?: string
  mediaPath: string
  start: number
  duration: number
  inPoint: number
  outPoint?: number
  trackId: string
  enabled?: boolean
  kind?: string
  speed?: number
  reverse?: boolean
  /** 定格源媒体时间（秒）；字段存在即生效，可为 0 */
  freeze?: number
  /** 静态变换（无关键帧或关键帧兜底）；坐标与监视器一致：中心归一化、角度° */
  x?: number
  y?: number
  scaleX?: number
  scaleY?: number
  rotation?: number
  opacity?: number
  cropL?: number
  cropR?: number
  cropT?: number
  cropB?: number
  /** 与监视器 CSS filter 对齐的简化调色参数 */
  exposure?: number
  contrast?: number
  saturation?: number
  temperature?: number
  tint?: number
  blend?: string
  /** kind === 'solid' 时的填充色 #RRGGBB */
  solidColor?: string
  text?: EditGraphText
  effects?: EditGraphEffect[]
  mask?: EditGraphMask
  chromaKey?: { color: string; tolerance: number; enabled: boolean }
  transitionIn?: { type: string; duration: number }
  transitionOut?: { type: string; duration: number }
  keyframes?: {
    x?: EditGraphKeyframe[]
    y?: EditGraphKeyframe[]
    scale?: EditGraphKeyframe[]
    scaleY?: EditGraphKeyframe[]
    rotation?: EditGraphKeyframe[]
    opacity?: EditGraphKeyframe[]
  }
}

export type EditGraphTrack = {
  id: string
  kind: string
  muted?: boolean
}

export type EditGraph = {
  version: typeof EDIT_GRAPH_VERSION
  clips: EditGraphClip[]
  tracks: EditGraphTrack[]
  settings: { width: number; height: number; fps: number }
  workIn: number
  workOut: number
  rangeOnly?: boolean
  audioOnly?: boolean
}

type ClipIn = {
  id?: string
  mediaId?: string
  start: number
  duration: number
  inPoint: number
  outPoint?: number
  trackId: string
  enabled?: boolean
  speed?: number
  reverse?: boolean
  freeze?: number
  transform?: {
    x: number; y: number; scaleX: number; scaleY: number; rotation: number; opacity: number
    cropL?: number; cropR?: number; cropT?: number; cropB?: number
  }
  color?: {
    exposure: number; contrast: number; saturation: number
    temperature: number; tint: number
    highlights?: number; shadows?: number; whites?: number; blacks?: number; hueShift?: number
  }
  blend?: string
  solid?: { color: string }
  text?: {
    fancy?: FancyText; lineHeight?: number; letterSpacing?: number; animIn?: string; animOut?: string; animInDur?: number; animOutDur?: number
    content: string; fontFamily: string; fontSize: number; color: string
    align: string; bilingual?: string; strokeWidth: number; strokeColor: string
  }
  effects?: Array<{ type: string; strength: number; enabled: boolean }>
  mask?: EditGraphMask
  chromaKey?: { color: string; tolerance: number; enabled: boolean }
  transitionIn?: { type: string; duration: number }
  transitionOut?: { type: string; duration: number }
  keyframes?: Record<string, Array<{
    t: number
    value: number
    ease?: EditGraphKeyframe['ease']
    oh?: EditGraphKfHandle
    ih?: EditGraphKfHandle
  }>>
}

export function buildEditGraph(input: {
  clips: ClipIn[]
  tracks: Array<{ id: string; kind: string; muted?: boolean }>
  media: Array<{ id: string; path?: string; kind?: string }>
  settings: { width: number; height: number; fps: number }
  workIn: number
  workOut: number
  rangeOnly?: boolean
  audioOnly?: boolean
  preset?: string
}): EditGraph {
  const mediaById = new Map(input.media.map((m) => [m.id, m]))
  const settings =
    input.preset === '9x16'
      ? { width: 1080, height: 1920, fps: input.settings.fps }
      : { width: input.settings.width, height: input.settings.height, fps: input.settings.fps }

  return {
    version: EDIT_GRAPH_VERSION,
    clips: input.clips.map((c) => {
      const m = c.mediaId ? mediaById.get(c.mediaId) : undefined
      const tr = c.transform
      const col = c.color
      const kf = c.keyframes
      const mapKf = (prop: string): EditGraphKeyframe[] =>
        (kf?.[prop] ?? []).map((k) => {
          const out: EditGraphKeyframe = { t: k.t, value: k.value }
          const ease = k.ease ?? 'linear'
          if (ease !== 'linear') out.ease = ease
          if (k.oh) out.oh = { x: k.oh.x, y: k.oh.y }
          if (k.ih) out.ih = { x: k.ih.x, y: k.ih.y }
          return out
        })
      const kind = c.text ? 'text' : c.solid ? 'solid' : (m?.kind || undefined)
      return {
        ...(c.id ? { id: c.id } : {}),
        mediaPath: m?.path || '',
        start: c.start,
        duration: c.duration,
        inPoint: c.inPoint,
        outPoint: c.outPoint,
        trackId: c.trackId,
        enabled: c.enabled,
        kind,
        speed: c.speed ?? 1,
        reverse: !!c.reverse,
        ...(c.freeze !== undefined ? { freeze: c.freeze } : {}),
        x: tr?.x ?? 0,
        y: tr?.y ?? 0,
        scaleX: tr?.scaleX ?? 1,
        scaleY: tr?.scaleY ?? 1,
        rotation: tr?.rotation ?? 0,
        opacity: tr?.opacity ?? 1,
        cropL: tr?.cropL ?? 0,
        cropR: tr?.cropR ?? 0,
        cropT: tr?.cropT ?? 0,
        cropB: tr?.cropB ?? 0,
        exposure: col?.exposure ?? 0,
        contrast: col?.contrast ?? 0,
        saturation: col?.saturation ?? 0,
        temperature: col?.temperature ?? 0,
        tint: col?.tint ?? 0,
        blend: c.blend || 'normal',
        ...(c.solid ? { solidColor: c.solid.color } : {}),
        text: c.text
          ? {
              ...c.text,
              content: c.text.content,
              fontFamily: c.text.fontFamily,
              fontSize: c.text.fontSize,
              color: c.text.color,
              align: c.text.align,
              bilingual: c.text.bilingual,
              strokeWidth: c.text.strokeWidth,
              strokeColor: c.text.strokeColor,
            }
          : undefined,
        effects: (c.effects ?? [])
          .filter((e) => e.enabled && e.strength > 0)
          .map((e) => ({ type: e.type, strength: e.strength, enabled: true })),
        mask: c.mask
          ? {
              type: c.mask.type,
              feather: c.mask.feather,
              expand: c.mask.expand,
              invert: !!c.mask.invert,
              points: c.mask.points,
            }
          : undefined,
        chromaKey: c.chromaKey?.enabled ? c.chromaKey : undefined,
        transitionIn: c.transitionIn?.duration
          ? { type: c.transitionIn.type, duration: c.transitionIn.duration }
          : undefined,
        transitionOut: c.transitionOut?.duration
          ? { type: c.transitionOut.type, duration: c.transitionOut.duration }
          : undefined,
        keyframes: kf
          ? {
              x: mapKf('x'),
              y: mapKf('y'),
              scale: mapKf('scale'),
              scaleY: mapKf('scaleY'),
              rotation: mapKf('rotation'),
              opacity: mapKf('opacity'),
              ...(c.text?.fancy ? { fontSize: mapKf('fontSize') } : {}),
            }
          : undefined,
      }
    }),
    tracks: input.tracks.map((t) => ({ id: t.id, kind: t.kind, muted: t.muted })),
    settings,
    workIn: input.workIn,
    workOut: input.workOut,
    rangeOnly: input.rangeOnly,
    audioOnly: input.audioOnly,
  }
}
