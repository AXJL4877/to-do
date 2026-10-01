import { createJizura } from './jizura/engine.js'
import type { DynamicText, TextStyle } from '../types'

export const DYNAMIC_PRESETS = [
  { id: 'dynamic-pop', name: '弹入标题', layout: 'center' },
  { id: 'dynamic-type', name: '打字显现', layout: 'type' },
  { id: 'dynamic-wave', name: '波浪文字', layout: 'wave' },
  { id: 'dynamic-stack', name: '逐词叠入', layout: 'knSlamStack' },
  { id: 'dynamic-flow', name: '流动归位', layout: 'knFlowSnap' },
  { id: 'dynamic-cross', name: '十字排版', layout: 'tyCross' },
] as const

const color = (v: unknown, fallback: string) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback
const num = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback
export function normalizeDynamicText(raw: unknown): DynamicText | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<DynamicText>
  if (r.version !== 1 || r.engine !== 'jizura' || !DYNAMIC_PRESETS.some(p => p.id === r.presetId)) return null
  return { version: 1, engine: 'jizura', presetId: r.presetId!,
    seed: num(r.seed, 0, 0xffffffff, 20261002) >>> 0,
    duration: num(r.duration, 0.5, 12, 3), motion: num(r.motion, 0, 1, 0.7), accent: color(r.accent, '#ffb454') }
}

let engine: any
let activeFont = ''
let surface: HTMLCanvasElement | undefined
const plans = new Map<string, any>()
const LIMIT = 32
const SOURCE_DURATION = 3
const SOURCE_HOLD = 2.6
function getEngine(family: string, weight: number) {
  if (!engine) {
    engine = createJizura()
    const main = engine.mainDraw, drawFx = engine.drawFx
    // Scale spatial motion, not reveal progress. Typing remains timed at every positive strength.
    engine.mainDraw = (env: any, item: any) => {
      item.motionBase = { ...item }
      return main(env, item)
    }
    engine.drawFx = (env: any, item: any) => {
      const m = env.fx.motion, base = item.motionBase
      if (base && m < 1) {
        for (const k of ['x', 'y', 'size', 'rot', 'track', 'sx', 'sy']) {
          if (typeof item[k] !== 'number') continue
          const rest = typeof base[k] === 'number' ? base[k] : k === 'sx' || k === 'sy' ? 1 : 0
          item[k] = rest + (item[k] - rest) * m
        }
        if (item.charFn) {
          const fn = item.charFn
          item.charFn = (...args: any[]) => {
            const c = fn(...args)
            if (!c) return c
            const scaled = { ...c }
            for (const k of ['dx', 'dy', 'rot', 'skew', 'blur']) if (typeof c[k] === 'number') scaled[k] = c[k] * m
            for (const k of ['s', 'sx', 'sy']) if (typeof c[k] === 'number') scaled[k] = 1 + (c[k] - 1) * m
            return scaled
          }
        }
        if (item.streak) item.streak = { ...item.streak, dx: item.streak.dx * m, dy: (item.streak.dy || 0) * m, a: item.streak.a * m }
      }
      return drawFx(env, item)
    }
  }
  const cssFamily = `"${family.replace(/["\\\r\n]/g, '')}", "Microsoft YaHei", sans-serif`
  const signature = `${cssFamily}:${weight}`
  if (activeFont !== signature) {
    engine.fontCSS = (_key: string, px: number) => `${weight} ${px}px ${cssFamily}`
    engine.varFontCSS = (_key: string, px: number) => engine.fontCSS(_key, px)
    engine.metrics.clear(); engine.glyphs.clear()
    activeFont = signature
  }
  engine.setLang('zh-Hans')
  engine.setTypeset(false)
  return engine
}
export function invalidateDynamicTextFonts() {
  activeFont = ''; plans.clear()
  if (engine) { engine.metrics.clear(); engine.glyphs.clear() }
}

function layoutFor(J: any, text: string, config: DynamicText) {
  const key = DYNAMIC_PRESETS.find(p => p.id === config.presetId)!.layout
  const count = Array.from(text.replace(/\s/g, '')).length
  return text.includes('\n') || count > 30 || !J.LAYOUTS[key].fits(count) ? 'center' : key
}
export function dynamicTextWarning(text: TextStyle): string | null {
  if (!text.fancy?.dynamic) return null
  const cfg = normalizeDynamicText(text.fancy.dynamic)
  if (!cfg) return '这个动态样式版本暂不支持，已使用普通文字显示。'
  const p = DYNAMIC_PRESETS.find(p => p.id === cfg.presetId)!
  const n = Array.from(text.content.replace(/\s/g, '')).length
  const limits: Record<string, [number, number]> = { type: [1, 28], wave: [2, 16], knSlamStack: [2, 18], knFlowSnap: [3, 16], tyCross: [3, 11] }
  const range = limits[p.layout]
  return text.content.includes('\n') || n > 30 || (range && (n < range[0] || n > range[1]))
    ? '这段文字较长、包含多行或不适合当前构图，已改用完整文字排版。' : null
}

function makePlan(J: any, text: TextStyle, cfg: DynamicText, W: number, H: number) {
  const layout = layoutFor(J, text.content, cfg)
  const st = structuredClone(J.STYLES.noir)
  const fg = color(text.fancy?.fill[0], color(text.color, '#ffffff'))
  const sc = { ...st.schemes[0], fg, sub: fg, accent: cfg.accent, accent2: cfg.accent, ink: fg, ghostA: cfg.accent, ghostB: cfg.accent }
  st.schemes = [sc]; st.texture = { grain: 0, paper: 0, scan: 0 }; st.ghost = 0; st.hud = false
  const rng = J.rng(cfg.seed)
  const params = J.LAYOUTS[layout].plan(rng, { text: text.content, n: Array.from(text.content).length, W, H, dur: SOURCE_DURATION }, st)
  // User colour and readable placement take priority over random palette switches.
  if (layout === 'center') Object.assign(params, { accent: false, ox: 0, oy: 0, sub: false })
  if (layout === 'type') Object.assign(params, { align: 'center', prompt: false })
  if (layout === 'wave') { params.amp *= cfg.motion; params.travel *= cfg.motion; params.trail = Math.round(params.trail * cfg.motion) }
  if (layout === 'knFlowSnap') params.amp *= cfg.motion
  if (layout === 'knSlamStack') params.tilt *= cfg.motion
  const enters = layout === 'type' ? ['type'] : layout.startsWith('kn') ? ['cut'] : ['pop', 'slide', 'stretch']
  const enter = rng.pick(enters.filter((k: string) => J.ENTER[k]))
  const hold = cfg.motion === 0 || layout.startsWith('kn') ? 'still' : layout === 'wave' ? 'wave' : 'drift'
  const cut = { text: text.content, lineText: text.content, line: 0, index: 0, start: 0,
    end: SOURCE_DURATION, dur: SOURCE_DURATION, layout, params, seed: cfg.seed, enter, hold, exit: 'cut',
    inDur: 0.65, outDur: 0, stagger: 0.025,
    decor: [], scheme: 0, words: J.chunkText(text.content), treat: 'none', treatP: {}, bg: 'none', bgP: {}, cam: 'push', camP: {} }
  return { W, H, fps: 30, style: st, cuts: [cut], fx: { motion: cfg.motion, chroma: 0, glitch: 0, texture: 0, decor: 0, hideNo: true, hideTime: true }, lang: 'zh-Hans', typeset: false }
}

/** Draw a transparent single-cut JIZURA composition into the caller's centred text coordinates. */
export function drawDynamicText(ctx: CanvasRenderingContext2D, text: TextStyle, w: number, h: number,
  localTime: number, clipDuration: number, fontSize = text.fontSize): boolean {
  const cfg = normalizeDynamicText(text.fancy?.dynamic)
  if (!cfg) return false
  if (!text.content.trim()) return true
  const J = getEngine(text.fontFamily, text.fancy?.fontWeight ?? 700)
  const W = 1080 * w / h, H = 1080
  const key = JSON.stringify([text.content, text.fontFamily, text.fancy?.fontWeight, text.fancy?.fill, text.color, cfg, W, H])
  let plan = plans.get(key)
  if (!plan) {
    plan = makePlan(J, text, cfg, W, H)
    if (plans.size >= LIMIT) plans.delete(plans.keys().next().value!)
    plans.set(key, plan)
  }
  surface ??= document.createElement('canvas')
  if (surface.width !== w || surface.height !== h) { surface.width = w; surface.height = h }
  const x = surface.getContext('2d')!
  x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, w, h)
  x.save(); x.scale(h / 1080, h / 1080)
  const t = Math.max(0, Number.isFinite(localTime) ? localTime : 0)
  const outDuration = Math.min(0.4, cfg.duration * 0.18)
  // Extend the hold; shift the exit to the host clip's tail. Trimmed clips simply crop the source motion.
  const exitStart = Math.max(cfg.duration - outDuration, clipDuration - outDuration)
  // Complete the same source motion even at 0.5s; zero is an explicitly still composition.
  const sourceTime = Math.min(t * SOURCE_DURATION / cfg.duration, SOURCE_HOLD)
  const lt = cfg.motion === 0 ? SOURCE_HOLD : sourceTime
  const env = J.Renderer.prototype.makeEnv.call({}, x, plan, plan.cuts[0], plan.style.schemes[0],
    { pass: 'main', t: lt, lt, ltb: lt, step: Math.floor(lt * 24), scale: h / 1080, allowFilter: true, energy: null, beat: null })
  const draw = env.draw
  env.draw = (item: any) => { if (!/^LINE \d/.test(item.text)) return draw(item) }
  J.LAYOUTS[plan.cuts[0].layout].render(env)
  x.restore()
  ctx.save()
  if (clipDuration >= cfg.duration && t > exitStart) ctx.globalAlpha *= Math.max(0, 1 - (t - exitStart) / outDuration)
  const size = Math.max(0.05, Math.min(4, fontSize / 96))
  ctx.scale(size, size); ctx.drawImage(surface, -w / 2, -h / 2)
  ctx.restore()
  return true
}
