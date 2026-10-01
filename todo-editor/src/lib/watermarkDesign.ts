/**
 * 可自定义的文字水印：文案 / 字号 / 排版 → 透明底 PNG。
 * 默认预设「小薇说交易」免责文案，可随时改。
 */

export type WatermarkAlign = 'left' | 'center' | 'right'
export type WatermarkPlacement = 'bottom' | 'top' | 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right'

export type WatermarkDesign = {
  name: string
  /** 多行文案；第一行当标题略大 */
  lines: string[]
  /** 标题字号（相对 1080p 高度） */
  titleSize: number
  /** 正文字号 */
  bodySize: number
  align: WatermarkAlign
  placement: WatermarkPlacement
  /** 是否画半透明底带 */
  band: boolean
  /** 整层不透明度 0~1 */
  opacity: number
  color: string
}

export const DEFAULT_WATERMARK_DESIGN: WatermarkDesign = {
  name: '小薇说交易·水印',
  lines: [
    '小薇说交易',
    '内容仅供参考，不构成投资建议',
    '投资有风险，决策需谨慎',
  ],
  titleSize: 28,
  bodySize: 22,
  align: 'center',
  placement: 'bottom',
  band: true,
  opacity: 0.92,
  color: '#FFFFFF',
}

const STORAGE_KEY = 'todo.watermarkDesign'

export function loadWatermarkDesign(): WatermarkDesign {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_WATERMARK_DESIGN, lines: [...DEFAULT_WATERMARK_DESIGN.lines] }
    const parsed = JSON.parse(raw) as Partial<WatermarkDesign>
    return {
      ...DEFAULT_WATERMARK_DESIGN,
      ...parsed,
      lines: Array.isArray(parsed.lines) && parsed.lines.length
        ? parsed.lines.map((l) => String(l ?? ''))
        : [...DEFAULT_WATERMARK_DESIGN.lines],
      titleSize: clamp(Number(parsed.titleSize) || DEFAULT_WATERMARK_DESIGN.titleSize, 12, 96),
      bodySize: clamp(Number(parsed.bodySize) || DEFAULT_WATERMARK_DESIGN.bodySize, 10, 72),
      opacity: clamp(Number(parsed.opacity) || DEFAULT_WATERMARK_DESIGN.opacity, 0.2, 1),
      align: parsed.align === 'left' || parsed.align === 'right' ? parsed.align : 'center',
      placement: isPlacement(parsed.placement) ? parsed.placement : 'bottom',
      band: parsed.band !== false,
      color: typeof parsed.color === 'string' && parsed.color ? parsed.color : '#FFFFFF',
      name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : DEFAULT_WATERMARK_DESIGN.name,
    }
  } catch {
    return { ...DEFAULT_WATERMARK_DESIGN, lines: [...DEFAULT_WATERMARK_DESIGN.lines] }
  }
}

export function saveWatermarkDesign(design: WatermarkDesign) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(design))
  } catch { /* */ }
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n))
}

function isPlacement(v: unknown): v is WatermarkPlacement {
  return v === 'bottom' || v === 'top' || v === 'bottom-left' || v === 'bottom-right'
    || v === 'top-left' || v === 'top-right'
}

export type WatermarkRenderResult = {
  dataUrl: string
  width: number
  height: number
}

/** 按设计画一张工程分辨率透明水印 */
export function renderWatermarkPng(
  design: WatermarkDesign,
  width: number,
  height: number,
): WatermarkRenderResult {
  const w = Math.max(16, Math.round(width) || 1920)
  const h = Math.max(16, Math.round(height) || 1080)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建画布')
  ctx.clearRect(0, 0, w, h)

  const lines = design.lines.map((l) => l.trim()).filter(Boolean)
  if (!lines.length) throw new Error('请至少写一行水印文字')

  const sy = h / 1080
  const titlePx = Math.max(12, Math.round(design.titleSize * sy))
  const bodyPx = Math.max(10, Math.round(design.bodySize * sy))
  const pad = Math.round(28 * sy)
  const lineGap = Math.round(8 * sy)
  const sizes = lines.map((_, i) => (i === 0 ? titlePx : bodyPx))
  const blockH = sizes.reduce((s, px) => s + px, 0) + lineGap * Math.max(0, lines.length - 1) + pad * 2

  const corner = design.placement.includes('-')
  const atTop = design.placement.startsWith('top')
  const atLeft = design.placement.endsWith('left')
  const atRight = design.placement.endsWith('right')

  let bandTop = atTop ? 0 : h - blockH
  let bandH = blockH
  if (corner) {
    // 角标：按内容宽估算一块更紧的区域
    ctx.font = `600 ${titlePx}px "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif`
    let maxW = 0
    lines.forEach((line, i) => {
      ctx.font = `${i === 0 ? 600 : 400} ${sizes[i]}px "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif`
      maxW = Math.max(maxW, ctx.measureText(line).width)
    })
    const boxW = Math.min(w, Math.ceil(maxW + pad * 2))
    const boxH = blockH
    const boxX = atLeft ? 0 : atRight ? w - boxW : (w - boxW) / 2
    const boxY = atTop ? 0 : h - boxH
    if (design.band) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)'
      ctx.fillRect(boxX, boxY, boxW, boxH)
    }
    drawLines(ctx, lines, sizes, {
      align: atLeft ? 'left' : atRight ? 'right' : 'center',
      x: atLeft ? boxX + pad : atRight ? boxX + boxW - pad : boxX + boxW / 2,
      y0: boxY + pad,
      gap: lineGap,
      color: design.color,
      sy,
    })
  } else {
    if (design.band) {
      const band = ctx.createLinearGradient(0, bandTop, 0, bandTop + bandH)
      if (atTop) {
        band.addColorStop(0, 'rgba(0,0,0,0.62)')
        band.addColorStop(0.65, 'rgba(0,0,0,0.45)')
        band.addColorStop(1, 'rgba(0,0,0,0)')
      } else {
        band.addColorStop(0, 'rgba(0,0,0,0)')
        band.addColorStop(0.35, 'rgba(0,0,0,0.45)')
        band.addColorStop(1, 'rgba(0,0,0,0.62)')
      }
      ctx.fillStyle = band
      ctx.fillRect(0, bandTop, w, bandH)
    }
    const x = design.align === 'left' ? pad : design.align === 'right' ? w - pad : w / 2
    drawLines(ctx, lines, sizes, {
      align: design.align,
      x,
      y0: bandTop + pad,
      gap: lineGap,
      color: design.color,
      sy,
    })
  }

  return { dataUrl: canvas.toDataURL('image/png'), width: w, height: h }
}

function drawLines(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  sizes: number[],
  opts: { align: WatermarkAlign; x: number; y0: number; gap: number; color: string; sy: number },
) {
  ctx.textAlign = opts.align
  ctx.textBaseline = 'top'
  ctx.shadowColor = 'rgba(0,0,0,0.55)'
  ctx.shadowBlur = Math.round(6 * opts.sy)
  ctx.shadowOffsetY = Math.round(1 * opts.sy)
  let y = opts.y0
  lines.forEach((line, i) => {
    const px = sizes[i]
    ctx.fillStyle = i === 0 ? opts.color : withAlpha(opts.color, 0.86)
    ctx.font = `${i === 0 ? 600 : 400} ${px}px "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif`
    ctx.fillText(line, opts.x, y)
    y += px + opts.gap
  })
  ctx.shadowBlur = 0
}

function withAlpha(hex: string, a: number) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return hex
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgba(${r},${g},${b},${a})`
}
