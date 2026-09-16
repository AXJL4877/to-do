import type { Clip, MediaItem, ProjectSettings, Sequence, Track } from '../types'
import { blendToComposite, clipCanvasFilter } from './clipFilters'
import { sampleKeyframes, resolveClipTransform, effectiveTransform } from './keyframeEval'
import type { SnapGuide } from './monitorSnap'
import { videoFrameAt } from './videoCache'

export type ImageCache = Map<string, HTMLImageElement>
export type { SnapGuide } from './monitorSnap'

/**
 * 节目叠层顺序：时间轴列表越靠上（index 越小）越在上层。
 * 返回值越大越靠前（后画）。字幕 > 特效 > 视频。
 */
export function clipStackRank(clip: Clip, tracks: Track[]): number {
  const idx = tracks.findIndex((t) => t.id === clip.trackId)
  const track = idx >= 0 ? tracks[idx] : undefined
  const base = 10000 - (idx >= 0 ? idx : 999)
  if (clip.text || track?.kind === 'subtitle') return 30000 + base
  if (track?.kind === 'effect' || track?.kind === 'adjustment') return 20000 + base
  return base
}

export function sortClipsByStack(clips: Clip[], tracks: Track[]): Clip[] {
  return [...clips].sort((a, b) => clipStackRank(a, tracks) - clipStackRank(b, tracks))
}

export function getPreviewSize(settings: ProjectSettings, perf: 'quality' | 'balanced' | 'speed') {
  const scale = perf === 'speed' ? 0.5 : perf === 'balanced' ? 0.66 : 1
  return {
    w: Math.max(320, Math.round(settings.width * scale)),
    h: Math.max(180, Math.round(settings.height * scale)),
  }
}

function drawContain(ctx: CanvasRenderingContext2D, img: CanvasImageSource, fw: number, fh: number, iw: number, ih: number) {
  const s = Math.min(fw / iw, fh / ih)
  const dw = iw * s
  const dh = ih * s
  ctx.drawImage(img, (fw - dw) / 2, (fh - dh) / 2, dw, dh)
}

function drawContainCenter(ctx: CanvasRenderingContext2D, img: CanvasImageSource, fw: number, fh: number, iw: number, ih: number) {
  const s = Math.min(fw / iw, fh / ih)
  const dw = iw * s
  const dh = ih * s
  ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh)
}

export function renderProgramFrame(
  canvas: HTMLCanvasElement,
  seq: Sequence,
  media: MediaItem[],
  settings: ProjectSettings,
  playhead: number,
  cache: ImageCache,
  rw?: number,
  rh?: number,
  selectedIds: string[] = [],
  transformOverrides?: Record<string, { x: number; y: number }>,
  showMotionPath = false,
  snapGuides?: SnapGuide[],
) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const w = rw ?? settings.width
  const h = rh ?? settings.height
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }

  ctx.fillStyle = settings.canvasBg === 'color' ? settings.canvasColor : '#0b0d10'
  ctx.fillRect(0, 0, w, h)

  // 下层先画、上层后画：时间轴越靠上（列表越前）越后画
  const visible = sortClipsByStack(
    seq.clips.filter((c) => {
      if (!c.enabled) return false
      if (playhead < c.start || playhead >= c.start + c.duration) return false
      const tr = seq.tracks.find((t) => t.id === c.trackId)
      if (!tr || tr.hidden) return false
      // 音轨只出声，不进节目画面
      if (tr.kind === 'audio') return false
      return true
    }),
    seq.tracks,
  )

  const sx = w / settings.width
  const sy = h / settings.height

  for (const clip of visible) {
    const ov = transformOverrides?.[clip.id]
    drawClip(ctx, clip, media, w, h, sx, sy, cache, playhead, ov, settings.fps)
  }

  // 选中框（与画面同一套 transform 计算）
  for (const clip of visible) {
    if (!selectedIds.includes(clip.id)) continue
    const ov = transformOverrides?.[clip.id]
    drawSelection(ctx, clip, w, h, playhead, ov)
  }

  // K帧模式：运动路径（点 + 线）
  if (showMotionPath) {
    for (const clip of seq.clips) {
      if (!selectedIds.includes(clip.id)) continue
      drawMotionPath(ctx, clip, w, h)
    }
  }

  if (snapGuides?.length) drawSnapGuides(ctx, w, h, snapGuides)

  // 无片段时给出可辨识的空态，避免「黑屏像坏了」
  if (visible.length === 0) {
    ctx.fillStyle = 'rgba(245,242,236,0.55)'
    ctx.font = `${Math.round(28 * sy)}px Syne, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('时间线此处无画面', w / 2, h / 2)
  }

  if (settings.safeFrame) {
    ctx.strokeStyle = 'rgba(255,220,100,0.4)'
    ctx.lineWidth = 2
    ctx.strokeRect(w * 0.05, h * 0.05, w * 0.9, h * 0.9)
  }
}

/** compose 底图之上：选中框 / 运动路径 / 安全框（不再重绘媒体） */
export function renderProgramOverlay(
  canvas: HTMLCanvasElement,
  seq: Sequence,
  settings: ProjectSettings,
  playhead: number,
  rw: number,
  rh: number,
  selectedIds: string[] = [],
  showMotionPath = false,
  snapGuides?: SnapGuide[],
) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const w = rw
  const h = rh
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
  const visible = seq.clips.filter((c) => {
    if (!c.enabled) return false
    if (playhead < c.start || playhead >= c.start + c.duration) return false
    const tr = seq.tracks.find((t) => t.id === c.trackId)
    if (!tr || tr.hidden || tr.kind === 'audio') return false
    return true
  })
  for (const clip of visible) {
    if (!selectedIds.includes(clip.id)) continue
    drawSelection(ctx, clip, w, h, playhead)
  }
  if (showMotionPath) {
    for (const clip of seq.clips) {
      if (!selectedIds.includes(clip.id)) continue
      drawMotionPath(ctx, clip, w, h)
    }
  }
  if (snapGuides?.length) drawSnapGuides(ctx, w, h, snapGuides)
  if (settings.safeFrame) {
    ctx.strokeStyle = 'rgba(255,220,100,0.4)'
    ctx.lineWidth = 2
    ctx.strokeRect(w * 0.05, h * 0.05, w * 0.9, h * 0.9)
  }
}

function drawSnapGuides(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  guides: SnapGuide[],
) {
  const toX = (nx: number) => w / 2 + nx * w / 2
  const toY = (ny: number) => h / 2 + ny * h / 2
  ctx.save()
  for (const g of guides) {
    ctx.strokeStyle = g.strong ? 'rgba(226,106,44,0.95)' : 'rgba(245,242,236,0.22)'
    ctx.lineWidth = g.strong ? 1.5 : 1
    ctx.setLineDash(g.strong ? [] : [4, 4])
    ctx.beginPath()
    if (g.orient === 'v') {
      const x = toX(g.at)
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h)
    } else {
      const y = toY(g.at)
      ctx.moveTo(0, y)
      ctx.lineTo(w, y)
    }
    ctx.stroke()
  }
  ctx.restore()
}

/** 位置关键帧运动路径：虚线轨迹 + 关键帧圆点 */
function drawMotionPath(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  w: number,
  h: number,
) {
  const xs = clip.keyframes.x ?? []
  const ys = clip.keyframes.y ?? []
  if (!xs.length && !ys.length) return

  const toCanvas = (nx: number, ny: number) => ({
    x: w / 2 + nx * w / 2,
    y: h / 2 + ny * h / 2,
  })

  const samples: { x: number; y: number }[] = []
  const steps = Math.max(24, Math.round(clip.duration * 20))
  for (let i = 0; i <= steps; i++) {
    const localT = (i / steps) * clip.duration
    const tr = resolveClipTransform(clip, clip.start + localT)
    samples.push(toCanvas(tr.x, tr.y))
  }

  ctx.save()
  ctx.strokeStyle = 'rgba(226,106,44,0.75)'
  ctx.lineWidth = Math.max(1.5, Math.round(Math.min(w, h) * 0.003))
  ctx.setLineDash([6, 5])
  ctx.beginPath()
  samples.forEach((p, i) => {
    if (i === 0) ctx.moveTo(p.x, p.y)
    else ctx.lineTo(p.x, p.y)
  })
  ctx.stroke()
  ctx.setLineDash([])

  const times = motionPathTimes(clip)
  const r = Math.max(3.5, Math.min(w, h) * 0.008)
  ctx.fillStyle = '#E26A2C'
  ctx.strokeStyle = 'rgba(245,242,236,0.9)'
  ctx.lineWidth = 1.5
  for (const t of times) {
    const tr = resolveClipTransform(clip, clip.start + t)
    const pt = toCanvas(tr.x, tr.y)
    ctx.beginPath()
    ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }
  ctx.restore()
}

export function motionPathTimes(clip: Clip): number[] {
  const xs = clip.keyframes.x ?? []
  const ys = clip.keyframes.y ?? []
  return [...new Set([...xs.map((k) => k.t), ...ys.map((k) => k.t)])].sort((a, b) => a - b)
}

/** 命中运动路径上的位置关键帧点（归一化坐标） */
export function hitTestMotionPathKf(
  clip: Clip,
  nx: number,
  ny: number,
  thresh = 0.045,
): { t: number; x: number; y: number } | null {
  const times = motionPathTimes(clip)
  if (!times.length) return null
  let best: { t: number; x: number; y: number } | null = null
  let bestD = thresh
  for (const t of times) {
    const tr = resolveClipTransform(clip, clip.start + t)
    const d = Math.hypot(tr.x - nx, tr.y - ny)
    if (d <= bestD) {
      bestD = d
      best = { t, x: tr.x, y: tr.y }
    }
  }
  return best
}

function drawSelection(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  w: number,
  h: number,
  playhead: number,
  xyOverride?: { x: number; y: number },
) {
  const tr = effectiveTransform(clip, playhead, xyOverride)
  const cx = w / 2 + tr.x * w / 2
  const cy = h / 2 + tr.y * h / 2
  const bw = Math.min(w, h) * 0.22 * tr.scaleX
  const bh = Math.min(w, h) * 0.16 * tr.scaleY
  ctx.save()
  ctx.translate(cx, cy)
  ctx.rotate((tr.rotation * Math.PI) / 180)
  ctx.strokeStyle = '#E26A2C'
  ctx.lineWidth = Math.max(2, Math.round(Math.min(w, h) * 0.004))
  ctx.setLineDash([8, 5])
  ctx.strokeRect(-bw, -bh, bw * 2, bh * 2)
  ctx.setLineDash([])
  ctx.fillStyle = '#E26A2C'
  for (const [hx, hy] of [[-bw, -bh], [bw, -bh], [-bw, bh], [bw, bh], [0, -bh], [0, bh], [-bw, 0], [bw, 0]]) {
    ctx.fillRect(hx - 4, hy - 4, 8, 8)
  }
  ctx.restore()
}

/** 命中检测：归一化坐标 nx/ny ∈ [-1,1]（画布中心为 0） */
export function hitTestProgramClips(
  seq: Sequence,
  playhead: number,
  nx: number,
  ny: number,
  preferIds: string[] = [],
): string | null {
  const visible = sortClipsByStack(
    seq.clips.filter((c) => {
      if (!c.enabled) return false
      if (playhead < c.start || playhead >= c.start + c.duration) return false
      const tr = seq.tracks.find((t) => t.id === c.trackId)
      if (!tr || tr.hidden || tr.kind === 'audio') return false
      return true
    }),
    seq.tracks,
  )
  // 顶层优先命中
  const ordered = [...visible].reverse()
  const prefer = new Set(preferIds)
  const candidates = [
    ...ordered.filter((c) => prefer.has(c.id)),
    ...ordered.filter((c) => !prefer.has(c.id)),
  ]
  for (const clip of candidates) {
    const tr = effectiveTransform(clip, playhead)
    const dx = (nx - tr.x) / Math.max(0.05, tr.scaleX)
    const dy = (ny - tr.y) / Math.max(0.05, tr.scaleY)
    // 粗略命中盒（与选中框比例接近）
    if (Math.abs(dx) <= 0.35 && Math.abs(dy) <= 0.28) return clip.id
  }
  return null
}

function drawClip(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  media: MediaItem[],
  w: number,
  h: number,
  sx: number,
  sy: number,
  cache: ImageCache,
  playhead: number,
  xyOverride?: { x: number; y: number },
  fps = 30,
) {
  const tr = effectiveTransform(clip, playhead, xyOverride)
  ctx.save()
  ctx.globalAlpha = tr.opacity
  ctx.globalCompositeOperation = blendToComposite(clip.blend)
  const filter = clipCanvasFilter(clip)
  if (filter) ctx.filter = filter
  ctx.translate(w / 2 + tr.x * w / 2, h / 2 + tr.y * h / 2)
  ctx.rotate((tr.rotation * Math.PI) / 180)
  ctx.scale(tr.flipH ? -tr.scaleX : tr.scaleX, tr.flipV ? -tr.scaleY : tr.scaleY)

  if (clip.text) {
    drawTextClip(ctx, clip, w, h, playhead)
  } else {
    const cropW = 1 - tr.cropL - tr.cropR
    const cropH = 1 - tr.cropT - tr.cropB
    if (cropW > 0.05 && cropH > 0.05) {
      ctx.beginPath()
      ctx.rect(-w * cropW / 2, -h * cropH / 2, w * cropW, h * cropH)
      ctx.clip()
    }
    const m = media.find((x) => x.id === clip.mediaId)
    if (m && (m.kind === 'image' || m.kind === 'sticker')) {
      const img = cache.get(m.id)
      const iw = img?.naturalWidth || m.width || w
      const ih = img?.naturalHeight || m.height || h
      if (img?.complete && img.naturalWidth > 0) {
        drawContainCenter(ctx, img, w, h, iw, ih)
      } else {
        drawMediaPlaceholder(ctx, clip.name, w, h, sy)
      }
    } else if (m && m.kind === 'video') {
      const localT = Math.max(0, playhead - clip.start)
      const speed = Math.max(0.05, clip.speed || 1)
      const mediaT = clip.reverse
        ? Math.max(0, clip.outPoint - localT * speed)
        : clip.inPoint + localT * speed
      // 勿把源时间 clamp 到片尾：超出素材时长应空，否则像「过了还有画面」
      const srcDur = m.duration > 0 ? m.duration : Infinity
      const inSrc = mediaT >= 0 && mediaT < srcDur - 1e-3
        && mediaT <= clip.outPoint + 1e-4
      const frame = inSrc ? videoFrameAt(m, mediaT, fps, clip.id) : null
      if (frame) {
        const iw = (frame as HTMLVideoElement).videoWidth
          || (frame as HTMLCanvasElement).width
          || m.width
          || w
        const ih = (frame as HTMLVideoElement).videoHeight
          || (frame as HTMLCanvasElement).height
          || m.height
          || h
        drawContainCenter(ctx, frame, w, h, iw, ih)
      } else {
        drawMediaPlaceholder(ctx, clip.name, w, h, sy)
      }
    } else {
      drawMediaPlaceholder(ctx, clip.name, w, h, sy)
    }
  }
  // 暗角等画在片段局部坐标内
  const vignette = clip.effects.find((e) => e.enabled && e.type === 'vignette' && e.strength > 0)
  if (vignette) {
    const g = ctx.createRadialGradient(0, 0, Math.min(w, h) * 0.15, 0, 0, Math.min(w, h) * 0.55)
    g.addColorStop(0, 'rgba(0,0,0,0)')
    g.addColorStop(1, `rgba(0,0,0,${(vignette.strength * 0.75).toFixed(3)})`)
    ctx.fillStyle = g
    ctx.fillRect(-w / 2, -h / 2, w, h)
  }
  ctx.restore()
}

function drawMediaPlaceholder(
  ctx: CanvasRenderingContext2D,
  name: string,
  w: number,
  h: number,
  sy: number,
) {
  const g = ctx.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2)
  g.addColorStop(0, '#2a3a4e')
  g.addColorStop(1, '#5a6f88')
  ctx.fillStyle = g
  ctx.fillRect(-w * 0.36, -h * 0.36, w * 0.72, h * 0.72)
  ctx.fillStyle = '#F5F2EC'
  ctx.font = `${Math.round(22 * sy)}px DM Sans, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(name.slice(0, 22), 0, 0)
}

function drawTextClip(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  w: number,
  h: number,
  playhead: number,
) {
  const t = clip.text!
  const localT = Math.max(0, playhead - clip.start)
  const fontSize = sampleKeyframes(clip.keyframes.fontSize, localT, t.fontSize)
  const fontPx = Math.max(12, fontSize * (h / 1080))
  const inDur = Math.max(0.05, t.animInDur ?? 0.8)
  const outDur = Math.max(0.05, t.animOutDur ?? 0.4)

  let alphaMul = 1
  let content = t.content
  let bilingual = t.bilingual

  if (t.animIn === 'fade' && localT < inDur) {
    alphaMul = localT / inDur
  }
  if (t.animIn === 'pop' && localT < inDur) {
    const p = Math.min(1, localT / inDur)
    const s = 0.65 + 0.35 * (1 - Math.pow(1 - p, 2))
    ctx.scale(s, s)
    alphaMul = Math.min(1, p * 1.4)
  }
  if (t.animIn === 'typewriter') {
    const n = t.content.length
    const chars = n === 0 ? 0 : Math.min(n, Math.floor((localT / inDur) * n) + (localT > 0 ? 1 : 0))
    content = t.content.slice(0, Math.min(n, chars))
    if (bilingual) {
      const bn = bilingual.length
      const bc = bn === 0 ? 0 : Math.min(bn, Math.floor((localT / inDur) * bn) + (localT > 0 ? 1 : 0))
      bilingual = bilingual.slice(0, Math.min(bn, bc))
    }
  }
  if (t.animOut === 'fade') {
    const left = clip.duration - localT
    if (left < outDur) alphaMul *= Math.max(0, left / outDur)
  }

  ctx.globalAlpha *= alphaMul
  ctx.font = `600 ${fontPx}px ${t.fontFamily}, "Segoe UI", sans-serif`
  ctx.textAlign = t.align
  ctx.textBaseline = 'middle'
  if (t.shadowBlur > 0) {
    ctx.shadowBlur = t.shadowBlur * (h / 1080)
    ctx.shadowColor = t.shadowColor
  }
  const y = bilingual ? -fontPx * 0.35 : 0
  if (t.strokeWidth > 0) {
    ctx.lineWidth = t.strokeWidth * (h / 1080)
    ctx.strokeStyle = t.strokeColor
    ctx.strokeText(content, 0, y)
  }
  ctx.fillStyle = t.color
  ctx.fillText(content, 0, y)
  if (bilingual) {
    ctx.font = `400 ${Math.round(fontPx * 0.55)}px ${t.fontFamily}, "Segoe UI", sans-serif`
    ctx.fillStyle = t.color
    ctx.globalAlpha *= 0.85
    ctx.fillText(bilingual, 0, fontPx * 0.55)
  }
  ctx.shadowBlur = 0
}

export function renderSourceFrame(
  canvas: HTMLCanvasElement,
  media: MediaItem[],
  sourceMediaId: string | null,
  cache: ImageCache,
  label?: string,
) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const w = canvas.width
  const h = canvas.height
  ctx.fillStyle = '#10141c'
  ctx.fillRect(0, 0, w, h)
  const m = media.find((x) => x.id === sourceMediaId)
  if (m && (m.kind === 'image' || m.kind === 'sticker')) {
    const img = cache.get(m.id)
    if (img?.complete && img.naturalWidth) drawContain(ctx, img, w, h, img.naturalWidth, img.naturalHeight)
  } else if (m && m.kind === 'video') {
    const frame = videoFrameAt(m, 0, 30)
    if (frame) {
      const iw = (frame as HTMLVideoElement).videoWidth || (frame as HTMLCanvasElement).width || w
      const ih = (frame as HTMLVideoElement).videoHeight || (frame as HTMLCanvasElement).height || h
      drawContain(ctx, frame, w, h, iw, ih)
    }
  }
  if (label) {
    ctx.textAlign = 'center'
    ctx.fillStyle = 'rgba(208,214,224,0.85)'
    ctx.font = '600 18px Syne, sans-serif'
    ctx.fillText(label, w / 2, h - 28)
  }
}
