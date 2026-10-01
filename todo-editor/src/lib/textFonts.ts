/**
 * 应用内文字字体：水印 / 字幕预览共用。
 * 得意黑（Smiley Sans）优先从 Electron 注入的本机路径加载，其次 /fonts/。
 */
import { availableFonts, fontStack as fancyFontStack, type FontChoice } from './fancyText'

export const SMILEY_FAMILY = 'Smiley Sans Oblique'
export const SMILEY_LABEL = '得意黑'

let smileyLoad: Promise<boolean> | null = null

function smileyUrls(): string[] {
  const urls: string[] = []
  const w = window as unknown as {
    __TODO_SMILEY_FONT_URL__?: string
    todoDesktop?: { smileyFontUrl?: () => string }
  }
  const injected = w.__TODO_SMILEY_FONT_URL__ || w.todoDesktop?.smileyFontUrl?.() || ''
  if (injected) urls.push(injected)
  urls.push('/fonts/SmileySans-Oblique.otf')
  return urls
}

/** 尝试把得意黑注册进 document.fonts */
export function ensureSmileyFont(): Promise<boolean> {
  if (typeof document === 'undefined') return Promise.resolve(false)
  try {
    if (document.fonts.check(`16px "${SMILEY_FAMILY}"`)) return Promise.resolve(true)
  } catch { /* */ }
  if (smileyLoad) return smileyLoad
  smileyLoad = (async () => {
    for (const url of smileyUrls()) {
      try {
        const face = new FontFace(SMILEY_FAMILY, `url("${url}")`)
        const loaded = await face.load()
        document.fonts.add(loaded)
        if (document.fonts.check(`16px "${SMILEY_FAMILY}"`)) return true
      } catch { /* next */ }
    }
    try {
      return document.fonts.check(`16px "${SMILEY_FAMILY}"`)
    } catch {
      return false
    }
  })()
  return smileyLoad
}

/** 水印字体列表（含得意黑） */
export function watermarkFontChoices(): FontChoice[] {
  void ensureSmileyFont()
  const base = availableFonts()
  if (base.some((f) => f.family === SMILEY_FAMILY)) return base
  return [{ family: SMILEY_FAMILY, label: SMILEY_LABEL }, ...base]
}

export function watermarkFontStack(family?: string): string {
  const f = (family || SMILEY_FAMILY).trim() || SMILEY_FAMILY
  if (f === SMILEY_FAMILY) return `"${SMILEY_FAMILY}", "Smiley Sans", "Microsoft YaHei", sans-serif`
  return fancyFontStack(f)
}

export const SUBTITLE_CSS_FONT: Record<string, string> = {
  smiley: `"${SMILEY_FAMILY}", "Smiley Sans"`,
  yahei: '"Microsoft YaHei"',
  heiti: 'SimHei, "黑体"',
  kaiti: 'KaiTi, "楷体"',
  xingkai: 'STXingkai, "华文行楷"',
  lishu: 'LiSu, "隶书"',
  hupo: 'STHupo, "华文琥珀"',
}

export function subtitleCssFont(key: unknown): string {
  const k = String(key || 'smiley')
  return `${SUBTITLE_CSS_FONT[k] ?? '"Microsoft YaHei"'}, sans-serif`
}
