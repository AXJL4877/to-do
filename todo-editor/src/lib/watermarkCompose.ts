/**
 * 把选中的图层（图 / 贴纸 / 字）合成一张透明底 PNG，存进媒体库当水印素材。
 */
import type { Clip, MediaItem, ProjectSettings, Track } from '../types'
import { blendToComposite, clipCanvasFilter } from './clipFilters'
import { effectiveTransform } from './keyframeEval'
import { drawTextClip } from './monitorDraw'
import { sortClipsByStack } from './monitorDraw'

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片加载失败'))
    img.src = url
  })
}

function drawContainCenter(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  fw: number,
  fh: number,
  iw: number,
  ih: number,
) {
  const s = Math.min(fw / iw, fh / ih)
  const dw = iw * s
  const dh = ih * s
  ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh)
}

export type WatermarkComposeResult = {
  dataUrl: string
  width: number
  height: number
  clipCount: number
}

/** 只画选中层，背景全透明。适合 logo / 角标 / 花字叠层。 */
export async function composeWatermarkPng(input: {
  clips: Clip[]
  tracks: Track[]
  media: MediaItem[]
  settings: ProjectSettings
  selectedIds: string[]
  playhead: number
}): Promise<WatermarkComposeResult> {
  const { settings, playhead } = input
  const selected = new Set(input.selectedIds)
  const mediaById = new Map(input.media.map((m) => [m.id, m]))
  const picks = sortClipsByStack(
    input.clips.filter((c) => selected.has(c.id) && c.enabled),
    input.tracks,
  ).filter((c) => {
    if (c.text) return true
    if (c.solid) return true
    const m = c.mediaId ? mediaById.get(c.mediaId) : undefined
    return m && (m.kind === 'image' || m.kind === 'sticker')
  })
  if (!picks.length) throw new Error('请先选中图片、贴纸或文字片段')

  const w = Math.max(16, settings.width | 0)
  const h = Math.max(16, settings.height | 0)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建画布')
  ctx.clearRect(0, 0, w, h)

  const images = new Map<string, HTMLImageElement>()
  await Promise.all(picks.map(async (c) => {
    const m = c.mediaId ? mediaById.get(c.mediaId) : undefined
    if (!m?.url || (m.kind !== 'image' && m.kind !== 'sticker')) return
    if (images.has(m.id)) return
    images.set(m.id, await loadImage(m.url))
  }))

  for (const clip of picks) {
    const tr = effectiveTransform(clip, playhead)
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
    } else if (clip.solid) {
      ctx.fillStyle = clip.solid.color
      ctx.fillRect(-w / 2, -h / 2, w, h)
    } else {
      const m = clip.mediaId ? mediaById.get(clip.mediaId) : undefined
      const img = m ? images.get(m.id) : undefined
      if (img?.naturalWidth) {
        const cropW = 1 - tr.cropL - tr.cropR
        const cropH = 1 - tr.cropT - tr.cropB
        if (cropW > 0.05 && cropH > 0.05) {
          ctx.beginPath()
          ctx.rect(-w * cropW / 2, -h * cropH / 2, w * cropW, h * cropH)
          ctx.clip()
        }
        drawContainCenter(ctx, img, w, h, img.naturalWidth, img.naturalHeight)
      }
    }
    ctx.restore()
  }

  return {
    dataUrl: canvas.toDataURL('image/png'),
    width: w,
    height: h,
    clipCount: picks.length,
  }
}
