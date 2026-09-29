import type { Clip, MediaItem, ProjectSettings, Sequence, Track } from '../types'
import { blendToComposite, clipCanvasFilter } from './clipFilters'
import { sampleKeyframes, resolveClipTransform, effectiveTransform } from './keyframeEval'
import type { SnapGuide } from './monitorSnap'
import { pauseUnusedVideoSlots, resetFrameSampleStability, videoFrameAt } from './videoCache'
import { mediaTimeAt, pictureClipsAt } from './programPlayer'
import { drawFancyText, fontStack } from './fancyText'
import { mayHaveAlpha } from './mediaAlpha'

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

/** 叠 N 轨时强制降预览分辨率 */
export function previewPerfForStack(
  base: 'quality' | 'balanced' | 'speed',
  videoLayers: number,
): 'quality' | 'balanced' | 'speed' {
  if (videoLayers >= 3) return 'speed'
  if (videoLayers >= 2) return 'balanced'
  return base
}

export function getPreviewSize(settings: ProjectSettings, perf: 'quality' | 'balanced' | 'speed') {
  // 叠层预览故意压分辨率；speed ≈ 360p 级，别按工程 4K 画
  const scale = perf === 'speed' ? 0.28 : perf === 'balanced' ? 0.5 : 1
  return {
    w: Math.max(320, Math.round(settings.width * scale)),
    h: Math.max(180, Math.round(settings.height * scale)),
  }
}

function isVideoClip(clip: Clip, media: MediaItem[]): boolean {
  const m = media.find((x) => x.id === clip.mediaId)
  return !!m && m.kind === 'video'
}

/** 近似铺满且不透明：可挡住下层，下层不必解码/绘制 */
function isOpaqueFullscreenCover(clip: Clip, playhead: number, media: MediaItem[], settings: ProjectSettings): boolean {
  if (clip.text) return false
  const tr = effectiveTransform(clip, playhead)
  if (tr.opacity < 1 || tr.rotation !== 0 || clip.mask || clip.effects.some(e => e.enabled)) return false
  if (clip.blend && clip.blend !== 'normal') return false
  if (tr.cropL !== 0 || tr.cropR !== 0 || tr.cropT !== 0 || tr.cropB !== 0) return false
  const m = media.find(item => item.id === clip.mediaId)
  if (!m?.width || !m.height || mayHaveAlpha(m)) return false
  const fit = Math.min(settings.width / m.width, settings.height / m.height)
  return m.width * fit * Math.abs(tr.scaleX) >= settings.width * (1 + Math.abs(tr.x))
    && m.height * fit * Math.abs(tr.scaleY) >= settings.height * (1 + Math.abs(tr.y))
}

/** 被上层遮挡时仍推进该层解码（超时用上一帧）；声不在这里出 */
function keepVideoAudible(
  clip: Clip,
  media: MediaItem[],
  playhead: number,
  fps: number,
  _trackMuted: boolean,
  live: boolean,
) {
  const m = media.find((x) => x.id === clip.mediaId)
  if (!m || m.kind !== 'video') return
  const mediaT = mediaTimeAt(clip, playhead, fps)
  const srcDur = m.duration > 0 ? m.duration : Infinity
  if (!(mediaT >= 0 && mediaT < srcDur - 1e-3 && mediaT <= clip.outPoint + 1e-4)) return
  videoFrameAt(m, mediaT, fps, clip.id, {
    speed: Math.max(0.05, clip.speed || 1),
    volume: 0,
    reverse: !!clip.reverse,
    live: true,
  })
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
  /** true：与导出一致，不画选中框/K帧路径/安全框等编辑装饰 */
  exportLook = false,
) {
  resetFrameSampleStability()
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true } as CanvasRenderingContext2DSettings)
    ?? canvas.getContext('2d')
  if (!ctx) return
  const w = rw ?? settings.width
  const h = rh ?? settings.height
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }

  ctx.fillStyle = settings.canvasBg === 'color' ? settings.canvasColor : '#0b0d10'
  ctx.fillRect(0, 0, w, h)

  // ① 调度：T 下全部 active 画面层；z-order 从下到上全合成（不 break、不只取一层）
  const visible = sortClipsByStack(pictureClipsAt(seq, playhead), seq.tracks)

  const videoLayers = visible.filter((c) => isVideoClip(c, media))
  // 上层不透明铺满时可跳过下层绘制，但解码槽仍推进（超时用上一帧）
  const skipDraw = new Set<string>()
  let covered = false
  for (let i = visible.length - 1; i >= 0; i--) {
    const c = visible[i]
    if (!isVideoClip(c, media)) continue
    if (covered) skipDraw.add(c.id)
    else if (isOpaqueFullscreenCover(c, playhead, media, settings)) covered = true
  }
  // ② 每活跃视频 clip 独立 HTMLVideo 槽；未活跃的暂停释放
  const liveIds = new Set(videoLayers.map((c) => c.id))
  pauseUnusedVideoSlots(liveIds)

  const sx = w / settings.width
  const sy = h / settings.height

  for (const clip of visible) {
    const ov = transformOverrides?.[clip.id]
    // 声一律走混音器；这里 volume=0，只采样画面
    if (skipDraw.has(clip.id)) {
      keepVideoAudible(clip, media, playhead, settings.fps, true, true)
      continue
    }
    drawClip(ctx, clip, media, w, h, sx, sy, cache, playhead, ov, settings.fps, true, true, false)
  }

  if (!exportLook) {
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

    if (settings.safeFrame) {
      ctx.strokeStyle = 'rgba(255,220,100,0.4)'
      ctx.lineWidth = 2
      ctx.strokeRect(w * 0.05, h * 0.05, w * 0.9, h * 0.9)
    }
  }

  // 无片段时给出可辨识的空态，避免「黑屏像坏了」
  if (visible.length === 0) {
    ctx.fillStyle = 'rgba(245,242,236,0.55)'
    ctx.font = `${Math.round(28 * sy)}px Syne, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('时间线此处无画面', w / 2, h / 2)
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
  trackMuted = false,
  live = true,
  audible = true,
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
    if (clip.solid) {
      ctx.fillStyle = clip.solid.color
      ctx.fillRect(-w / 2, -h / 2, w, h)
    } else if (m && (m.kind === 'image' || m.kind === 'sticker')) {
      const img = cache.get(m.id)
      const iw = img?.naturalWidth || m.width || w
      const ih = img?.naturalHeight || m.height || h
      if (img?.complete && img.naturalWidth > 0) {
        drawContainCenter(ctx, img, w, h, iw, ih)
      } else if (!mayHaveAlpha(m)) {
        drawMediaPlaceholder(ctx, clip.name, w, h, sy)
      }
    } else if (m && m.kind === 'video') {
      const speed = Math.max(0.05, clip.speed || 1)
      const srcDur = m.duration > 0 ? m.duration : Infinity
      // 勿把源时间 clamp 到片尾：超出素材时长应空，否则像「过了还有画面」；
      // 只有按帧取整进位到片尾的那一帧（片段最后半帧）取最后一帧，否则和下一段之间会漏一帧
      const rawT = mediaTimeAt(clip, playhead, fps)
      const step = 1 / Math.max(1, fps)
      const mediaT = rawT >= srcDur - 1e-3 && rawT < srcDur + step / 2 ? Math.max(0, srcDur - step) : rawT
      const inSrc = mediaT >= 0 && mediaT < srcDur - 1e-3
        && mediaT <= clip.outPoint + 1e-4
      const vol = !audible || trackMuted || clip.audio.mute
        ? 0
        : Math.max(0, Math.min(1, Math.pow(10, (clip.audio.gainDb || 0) / 20)))
      const frame = inSrc
        ? videoFrameAt(m, mediaT, fps, clip.id, {
          speed,
          volume: vol,
          reverse: !!clip.reverse,
          live,
        })
        : null
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
      } else if (!mayHaveAlpha(m)) {
        // 透明叠层还没解出帧时留空：占位块会盖住下层，播放时就是一闪的坏帧
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

export function drawTextClip(
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
  const k = h / 1080
  const lines = content.split('\n')
  const lh = fontPx * (t.lineHeight || 1.25)
  const blockH = lh * lines.length
  const y = bilingual ? -fontPx * 0.35 : 0
  if (t.fancy) {
    ctx.save()
    ctx.translate(0, y)
    drawFancyText(ctx, {
      lines, fontPx, family: t.fontFamily, align: t.align, lineHeight: t.lineHeight,
      letterSpacing: t.letterSpacing, fancy: t.fancy, k, time: localT,
    })
    ctx.restore()
  } else {
    ctx.font = `600 ${fontPx}px ${fontStack(t.fontFamily)}`
    ctx.textAlign = t.align
    ctx.textBaseline = 'middle'
    if (t.shadowBlur > 0) {
      ctx.shadowBlur = t.shadowBlur * k
      ctx.shadowColor = t.shadowColor
    }
    lines.forEach((line, i) => {
      const ly = y + (i - (lines.length - 1) / 2) * lh
      if (t.strokeWidth > 0) {
        ctx.lineWidth = t.strokeWidth * k
        ctx.strokeStyle = t.strokeColor
        ctx.strokeText(line, 0, ly)
      }
      ctx.fillStyle = t.color
      ctx.fillText(line, 0, ly)
    })
  }
  if (bilingual) {
    ctx.font = `400 ${Math.round(fontPx * 0.55)}px ${fontStack(t.fontFamily)}`
    ctx.textAlign = t.align
    ctx.textBaseline = 'middle'
    ctx.fillStyle = t.fancy?.fill[0] ?? t.color
    ctx.globalAlpha *= 0.85
    ctx.fillText(bilingual, 0, y + blockH / 2 + fontPx * 0.3)
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
