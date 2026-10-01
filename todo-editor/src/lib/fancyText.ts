import { drawChalkText } from './chalkText'
import type { FancyText } from '../types'

/* ---------------- 字体 ---------------- */

export type FontChoice = { family: string; label: string }

/** Windows 常见中文字体 + 项目自带字体；实际可用的由 availableFonts() 过滤 */
const FONT_CANDIDATES: FontChoice[] = [
  { family: 'Smiley Sans Oblique', label: '得意黑' },
  { family: 'Microsoft YaHei', label: '微软雅黑' },
  { family: 'SimHei', label: '黑体' },
  { family: 'DengXian', label: '等线' },
  { family: 'KaiTi', label: '楷体' },
  { family: 'SimSun', label: '宋体' },
  { family: 'FangSong', label: '仿宋' },
  { family: 'YouYuan', label: '幼圆' },
  { family: 'LiSu', label: '隶书' },
  { family: 'STHupo', label: '华文琥珀' },
  { family: 'STXingkai', label: '华文行楷' },
  { family: 'STCaiyun', label: '华文彩云' },
  { family: 'STXinwei', label: '华文新魏' },
  { family: 'FZShuTi', label: '方正舒体' },
  { family: 'FZYaoti', label: '方正姚体' },
  { family: 'Impact', label: 'Impact' },
  { family: 'Syne', label: 'Syne' },
  { family: 'DM Sans', label: 'DM Sans' },
]

const fontCache = new Map<string, boolean>()

export function fontAvailable(family: string): boolean {
  const hit = fontCache.get(family)
  if (hit != null) return hit
  let ok = false
  try {
    const ctx = document.createElement('canvas').getContext('2d')
    if (ctx) {
      const sample = '花字质感Abg'
      ok = ['monospace', 'serif'].some((base) => {
        ctx.font = `72px ${base}`
        const a = ctx.measureText(sample).width
        ctx.font = `72px "${family}", ${base}`
        return Math.abs(ctx.measureText(sample).width - a) > 0.5
      })
    }
  } catch { /* */ }
  fontCache.set(family, ok)
  return ok
}

export function availableFonts(): FontChoice[] {
  return FONT_CANDIDATES.filter((f) => fontAvailable(f.family))
}

/** 从偏好列表里取第一个本机可用的字体 */
export function pickFont(prefs: string[] | undefined, fallback = 'Microsoft YaHei'): string {
  for (const f of prefs ?? []) if (fontAvailable(f)) return f
  return fallback
}

export function fontStack(family: string) {
  return `"${family}", "Microsoft YaHei", "PingFang SC", sans-serif`
}

/* ---------------- 纹理缓存 ---------------- */

const textures = new Map<string, HTMLImageElement>()
const textureListeners = new Set<() => void>()

export function onFancyTextureLoaded(cb: () => void) {
  textureListeners.add(cb)
  return () => { textureListeners.delete(cb) }
}

function textureImage(src: string): HTMLImageElement | null {
  let img = textures.get(src)
  if (!img) {
    img = new Image()
    img.onload = () => textureListeners.forEach((cb) => cb())
    img.src = src
    textures.set(src, img)
  }
  return img.complete && img.naturalWidth > 0 ? img : null
}

/** 把任意图片 URL 压成方形小 JPEG dataURL，存进工程 */
export async function textureToDataUrl(url: string, size = 384): Promise<string> {
  const img = new Image()
  img.crossOrigin = 'anonymous'
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('纹理图片加载失败'))
    img.src = url
  })
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const ctx = c.getContext('2d')!
  const s = Math.min(img.naturalWidth, img.naturalHeight)
  ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size)
  return c.toDataURL('image/jpeg', 0.86)
}

/* ---------------- 渲染 ---------------- */

export type FancyDrawOpts = {
  lines: string[]
  fontPx: number
  family: string
  align: CanvasTextAlign
  lineHeight: number
  /** 1080p 像素 */
  letterSpacing: number
  fancy: FancyText
  /** 1080p 像素 → 画布像素 */
  k: number
  time?: number
}

function setLetterSpacing(ctx: CanvasRenderingContext2D, px: number) {
  const c = ctx as CanvasRenderingContext2D & { letterSpacing?: string }
  if ('letterSpacing' in c) c.letterSpacing = `${px}px`
}

function fillStyleFor(
  ctx: CanvasRenderingContext2D,
  f: FancyText,
  box: { l: number; t: number; r: number; b: number },
): string | CanvasGradient {
  const colors = f.fill.length ? f.fill : ['#ffffff']
  if (colors.length === 1) return colors[0]
  const cx = (box.l + box.r) / 2
  const cy = (box.t + box.b) / 2
  const a = ((f.fillAngle ?? 90) * Math.PI) / 180
  const dx = Math.cos(a)
  const dy = Math.sin(a)
  const len = Math.abs((box.r - box.l) / 2 * dx) + Math.abs((box.b - box.t) / 2 * dy)
  const g = ctx.createLinearGradient(cx - dx * len, cy - dy * len, cx + dx * len, cy + dy * len)
  colors.forEach((c, i) => g.addColorStop(i / (colors.length - 1), c))
  return g
}

/** 在当前坐标原点画一段多行花字（textBaseline=middle，行组整体垂直居中） */
export function drawFancyText(ctx: CanvasRenderingContext2D, o: FancyDrawOpts) {
  const { lines, fontPx, fancy: f, k } = o
  if (!lines.length) return
  if (f.chalk) {
    drawChalkText(ctx, { lines, family: o.family, fontPx, weight: f.fontWeight || 400,
      align: o.align, lineHeight: o.lineHeight || 1.25, spacing: o.letterSpacing * k,
      color: f.fill[0] || '#ffffff', chalk: f.chalk, time: o.time })
    return
  }
  ctx.save()
  ctx.font = `${f.italic ? 'italic ' : ''}${f.fontWeight || 700} ${fontPx}px ${fontStack(o.family)}`
  ctx.textAlign = o.align
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.miterLimit = 2
  setLetterSpacing(ctx, (o.letterSpacing || 0) * k)

  const lh = fontPx * (o.lineHeight || 1.25)
  const ys = lines.map((_, i) => (i - (lines.length - 1) / 2) * lh)
  const maxW = Math.max(...lines.map((l) => ctx.measureText(l).width))
  const left = o.align === 'center' ? -maxW / 2 : o.align === 'right' || o.align === 'end' ? -maxW : 0
  const box = { l: left, r: left + maxW, t: ys[0] - fontPx * 0.55, b: ys[ys.length - 1] + fontPx * 0.55 }
  const strokes = f.strokes ?? []
  const outer = strokes.reduce((s, x) => s + Math.max(0, x.width), 0) * k

  const silhouette = (color: string, dx: number, dy: number) => {
    ctx.fillStyle = color
    ctx.strokeStyle = color
    ctx.lineWidth = outer * 2
    lines.forEach((line, i) => {
      if (outer > 0) ctx.strokeText(line, dx, ys[i] + dy)
      ctx.fillText(line, dx, ys[i] + dy)
    })
  }

  if (f.bg) {
    const px = f.bg.padX * k + outer
    const py = f.bg.padY * k + outer
    ctx.fillStyle = f.bg.color
    ctx.beginPath()
    ctx.roundRect(box.l - px, box.t - py, box.r - box.l + px * 2, box.b - box.t + py * 2, f.bg.radius * k)
    ctx.fill()
  }

  if (f.shadow) {
    ctx.save()
    if (f.shadow.blur > 0) ctx.filter = `blur(${f.shadow.blur * k}px)`
    silhouette(f.shadow.color, f.shadow.x * k, f.shadow.y * k)
    ctx.restore()
  }

  if (f.extrude && f.extrude.depth > 0) {
    const a = (f.extrude.angle * Math.PI) / 180
    const steps = Math.max(1, Math.round(f.extrude.depth * k))
    const step = (f.extrude.depth * k) / steps
    for (let i = steps; i >= 1; i--) silhouette(f.extrude.color, Math.cos(a) * step * i, Math.sin(a) * step * i)
  }

  if (f.glow && f.glow.blur > 0) {
    ctx.save()
    ctx.shadowColor = f.glow.color
    ctx.shadowBlur = f.glow.blur * k
    silhouette(f.glow.color, 0, 0)
    silhouette(f.glow.color, 0, 0)
    ctx.restore()
  }

  let r = outer
  for (let i = strokes.length - 1; i >= 0; i--) {
    if (r <= 0) break
    ctx.strokeStyle = strokes[i].color
    ctx.lineWidth = r * 2
    lines.forEach((line, j) => ctx.strokeText(line, 0, ys[j]))
    r -= Math.max(0, strokes[i].width) * k
  }

  ctx.fillStyle = fillStyleFor(ctx, f, box)
  lines.forEach((line, i) => ctx.fillText(line, 0, ys[i]))

  const tex = f.texture ? textureImage(f.texture) : null
  if (tex) {
    const pattern = ctx.createPattern(tex, 'repeat')
    if (pattern) {
      const s = (fontPx * 2.2) / tex.naturalWidth
      pattern.setTransform(new DOMMatrix().translateSelf(box.l, box.t).scaleSelf(s, s))
      ctx.save()
      ctx.globalAlpha *= Math.max(0, Math.min(1, f.textureOpacity ?? 1))
      if (f.textureBlend === 'multiply' || f.textureBlend === 'overlay') ctx.globalCompositeOperation = f.textureBlend
      ctx.fillStyle = pattern
      lines.forEach((line, i) => ctx.fillText(line, 0, ys[i]))
      ctx.restore()
    }
  }

  if (f.gloss && f.gloss > 0) {
    lines.forEach((line, i) => {
      const g = ctx.createLinearGradient(0, ys[i] - fontPx * 0.5, 0, ys[i] + fontPx * 0.05)
      g.addColorStop(0, `rgba(255,255,255,${Math.min(1, f.gloss!)})`)
      g.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = g
      ctx.fillText(line, 0, ys[i])
    })
  }

  ctx.restore()
}

/* ---------------- 预设 ---------------- */

export type FancyCategory = string
export type FancyPreset = { id: string; name: string; category?: FancyCategory; fonts?: string[]; fancy: FancyText }

export const FANCY_CATEGORIES: { id: FancyCategory; name: string; desc?: string }[] = [
  { id: 'chalk', name: '粉笔字', desc: '逐字书写动画' },
]

export const FANCY_PRESETS: FancyPreset[] = [
  ['chalk-white', '白粉笔', '#f8f5e9'],
  ['chalk-yellow', '暖黄粉笔', '#f9d876'],
  ['chalk-pink', '樱粉粉笔', '#f6a9b8'],
  ['chalk-blue', '天蓝粉笔', '#8ad4ef'],
].map(([id, name, color]) => ({ id, name, category: 'chalk', fonts: ['KaiTi', 'STKaiti', 'STXingkai'],
  fancy: { fontWeight: 400, fill: [color], fillAngle: 90, strokes: [],
    chalk: { duration: 2, grain: 0.55, hand: false } },
}))

export function presetCategory(id: string | undefined): FancyCategory {
  return FANCY_PRESETS.find(p => p.id === id)?.category ?? FANCY_CATEGORIES[0].id
}

export function clonePresetFancy(p: FancyPreset): FancyText {
  return { ...JSON.parse(JSON.stringify(p.fancy)), preset: p.id }
}

/** AI 质感纹理快捷词 */
export const TEXTURE_IDEAS = ['金箔', '大理石', '熔岩', '糖果条纹', '星空', '木纹', '牛仔布', '冰裂', '镭射全息', '奶油蛋糕']

/* ---------------- 我的花字（本机） ---------------- */

const USER_KEY = 'todo-fancy-presets'

export function loadUserFancy(): FancyPreset[] {
  try {
    const list = JSON.parse(localStorage.getItem(USER_KEY) || '[]')
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

export function saveUserFancy(list: FancyPreset[]) {
  try { localStorage.setItem(USER_KEY, JSON.stringify(list.slice(0, 40))) } catch { /* */ }
}
