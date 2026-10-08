import { createJizura } from './engine.js'
import { JIZURA_CATALOG, type JizuraGroup } from './catalog'
import type { DynamicText, TextStyle } from '../../types'

type Composition = NonNullable<DynamicText['composition']>
const clamp = (v: unknown, a: number, b: number, d: number) => typeof v === 'number' && Number.isFinite(v) ? Math.max(a, Math.min(b, v)) : d
const moods = ['chaos', 'glitch', 'calm', 'pop', 'graphic', 'editorial', 'emotional', 'horror']
export function normalizeComposition(raw: unknown): Composition | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<Composition>
  if (!Array.isArray(r.scenes) || !r.scenes.length || r.scenes.length > 2000) return null
  const scenes: Composition['scenes'] = []
  for (const s of r.scenes) {
    if (!s || typeof s.content !== 'string' || s.content.length > 300 || !Number.isFinite(s.start) || !Number.isFinite(s.end) || s.start < 0 || s.end <= s.start || s.end > 7200) return null
    if (scenes.length && s.start < scenes.at(-1)!.end - 0.001) return null
    scenes.push({ content: s.content, start: s.start, end: s.end })
  }
  const parts: Composition['parts'] = {}
  for (const group of Object.keys(JIZURA_CATALOG.groups) as JizuraGroup[]) {
    const id = r.parts?.[group]
    if (typeof id === 'string' && (id === 'none' || JIZURA_CATALOG.groups[group].some(x => x.id === id))) parts[group] = id
  }
  return { scenes, offset: clamp(r.offset, 0, scenes.at(-1)!.end, 0),
    style: JIZURA_CATALOG.styles.some(s => s.id === r.style) ? r.style! : 'noir',
    mood: moods.includes(r.mood!) ? r.mood! : 'graphic', background: r.background === 'transparent' ? 'transparent' : 'style',
    unify: r.unify !== false, parts,
    fx: { decor: clamp(r.fx?.decor, 0, 1, 0.6), chroma: clamp(r.fx?.chroma, 0, 1, 0.4),
      glitch: clamp(r.fx?.glitch, 0, 1, 0.25), texture: clamp(r.fx?.texture, 0, 1, 0.5), bgSwitch: clamp(r.fx?.bgSwitch, 0, 1, 0.5) } }
}

let engine: any, renderer: any, surface: HTMLCanvasElement | undefined, font = ''
let renderedPlan: any
const plans = new Map<string, any>()
export function invalidateFullCompositionFonts() { font = ''; plans.clear(); engine?.metrics.clear(); engine?.glyphs.clear() }
function getEngine(text: TextStyle) {
  engine ??= createJizura()
  const family = text.fontFamily.replace(/["\\\r\n]/g, '')
  const weight = text.fancy?.fontWeight || 700
  const sig = `${family}/${weight}`
  if (sig !== font) {
    engine.fontCSS = (key: string, px: number) => {
      const f = /mono|code|typewriter/.test(key) ? 'Consolas' : /mincho|serif/.test(key) ? 'SimSun' : family
      return `${weight} ${px}px "${f}", "Microsoft YaHei", sans-serif`
    }
    engine.varFontCSS = (key: string, px: number) => engine.fontCSS(key, px)
    engine.metrics.clear(); engine.glyphs.clear(); font = sig
  }
  engine.setLang('zh-Hans')
  // Keep the host-only stationary camera out of the public/random catalogue.
  engine.CAMERA.hostStill = { get: () => ({ s: 1 }) }
  return engine
}

export function buildFullCompositionPlan(text: TextStyle, cfg: DynamicText, w: number, h: number) {
  const J = getEngine(text), source = cfg.composition!
  const c = { ...source, scenes: source.scenes.map(s => source.offset >= s.start - 0.001 && source.offset < s.end ? { ...s, content: text.content } : s) }
  const { offset: _offset, ...effective } = c
  const key = JSON.stringify([effective, cfg.seed, cfg.motion, text.fontFamily, text.fancy?.fontWeight, w / h])
  if (plans.has(key)) return plans.get(key)
  const project = J.defaultProject()
  Object.assign(project, { seed: cfg.seed, style: c.style, mood: c.mood, lang: 'zh-Hans', extra: true, wa: true,
    typo: true, kinetic: true, horror: c.mood === 'horror' || J.STYLES[c.style]?.set === 'horror', unify: c.unify,
    typeset: false, title: '', artist: '', lyrics: '', fps: 30, aspect: w >= h ? '16:9' : '9:16' })
  for (const [g, id] of Object.entries(c.parts)) if (id && J.registry(g)?.[id]?.set === 'horror') project.horror = true
  project.fx = { ...project.fx, ...c.fx, motion: cfg.motion, hideNo: true, hideTime: true, hud: 'off', koma: 0, flash: false }
  project.timing = { ...project.timing, tail: 0, offset: 0, snap: false, useAudioLength: false }
  c.scenes.forEach((s, i) => {
    const ov: any = { single: true }
    for (const [group, id] of Object.entries(c.parts)) {
      if (group === 'fx') continue
      if (id === 'none') {
        project.enabled[group] = Object.fromEntries(J.order(group).map((k: string) => [k, false]))
        continue
      }
      if (group === 'decor') ov.decor = [id]
      else ov[group] = id
    }
    if (ov.layout && typeof J.LAYOUTS[ov.layout]?.fits === 'function' && !J.LAYOUTS[ov.layout].fits(Array.from(s.content.replace(/\s/g, '')).length)) ov.layout = 'center'
    project.overrides[i] = ov
  })
  // Literal spoken text bypasses lyric control syntax; exact timestamps bypass estimated timing.
  const parse = J.parseLyrics, timing = J.computeTiming, design = J.designSize
  let plan: any
  try {
    J.parseLyrics = () => ({ meta: {}, lines: c.scenes.map(s => ({ src: s.content, text: s.content, note: null, emph: [], impact: /[！!]$/.test(s.content), manual: [s.content] })) })
    J.computeTiming = () => ({ starts: c.scenes.map(s => s.start), ends: c.scenes.map(s => s.end), duration: c.scenes.at(-1)!.end })
    J.designSize = () => [1080 * w / h, 1080]
    plan = J.plan(project, null)
  } finally { J.parseLyrics = parse; J.computeTiming = timing; J.designSize = design }
  if (c.parts.fx === 'none') plan.events = []
  else if (c.parts.fx) plan.events = c.scenes.map(s => ({ t: s.start + 0.03, type: c.parts.fx, amp: 0.8, dur: Math.min(0.3, (s.end - s.start) * 0.3) }))
  // A complete scene holds to its narration boundary, including long pauses/tail.
  for (const cut of plan.cuts) {
    const scene = c.scenes[cut.line]
    if (scene) { cut.end = scene.end; cut.dur = cut.end - cut.start }
    // Upstream unification may replace overrides; explicit host choices win last.
    const rng = J.rng(J.h(cut.seed, 0x484f5354))
    const P = c.parts
    if (P.layout) {
      const fits = J.LAYOUTS[P.layout]?.fits
      const id = P.layout === 'none' || (typeof fits === 'function' && !fits(Array.from(cut.text.replace(/\s/g, '')).length)) ? 'center' : P.layout
      cut.layout = id
      cut.params = J.LAYOUTS[id].plan(rng, { text: cut.text, n: Array.from(cut.text).length, W: plan.W, H: plan.H, dur: cut.dur }, plan.style)
    }
    if (P.enter) {
      cut.enter = P.enter === 'none' ? 'cut' : P.enter
      cut.inDur = cut.enter === 'cut' ? 0.12 : J.ENTER[cut.enter].inDur?.(cut.dur, Array.from(cut.text).length) ?? Math.min(0.6, cut.dur * 0.36)
    }
    if (P.exit) {
      cut.exit = P.exit === 'none' ? 'cut' : P.exit
      cut.outDur = cut.exit === 'cut' ? 0 : J.EXIT[cut.exit].outDur?.(cut.dur, Array.from(cut.text).length) ?? Math.min(0.55, cut.dur * 0.3)
    }
    if (P.hold) cut.hold = P.hold === 'none' ? 'still' : P.hold
    if (P.treat) { cut.treat = P.treat; cut.treatP = J.TREAT[P.treat]?.plan?.(rng, plan.style) ?? {} }
    if (P.bg) { cut.bg = P.bg; cut.bgP = J.BG[P.bg]?.plan?.(rng, plan.style) ?? {} }
    if (P.cam) { cut.cam = P.cam === 'none' ? 'hostStill' : P.cam; cut.camP = J.CAMERA[cut.cam]?.plan?.(rng, plan.style) ?? {} }
    if (P.decor) {
      const id = P.decor
      cut.decor = id === 'none' ? [] : [{ id, seed: rng.int(1, 1e9), n: rng.int(1, 3) + (id === 'shapes' ? 3 : 0) + (id === 'sparks' ? 4 : 0),
        right: rng.chance(0.5), low: rng.chance(0.5), accent: rng.chance(0.4), corner: rng.chance(0.5), big: rng.chance(0.4),
        mode: rng.pick(['count', 'index']), from: rng.int(0, 20), to: rng.int(30, 999), v: rng.int(0, 5), r: rng() }]
    }
    if (P.trans) {
      cut.morph = null
      cut.trans = P.trans === 'none' || cut.index === 0 ? null : P.trans
      cut.transP = cut.trans ? J.TRANS[cut.trans].plan?.(rng, plan.style) ?? {} : {}
      cut.transDur = cut.trans ? Math.max(0.01, Math.min(J.TRANS[cut.trans].dur || 0.35, cut.dur * 0.45, 0.6)) : 0
    }
  }
  for (const cut of plan.cuts) if (cut.trans && c.parts.trans && c.parts.trans !== 'none') {
    cut.enter = 'cut'; cut.inDur = 0.12
    const previous = plan.cuts[cut.index - 1]
    if (previous) { previous.exit = 'cut'; previous.outDur = 0 }
  }
  if (plans.size >= 24) plans.delete(plans.keys().next().value!)
  plans.set(key, plan)
  return plan
}

export function drawFullComposition(ctx: CanvasRenderingContext2D, text: TextStyle, cfg: DynamicText, w: number, h: number, time: number, fontSize: number) {
  const plan = buildFullCompositionPlan(text, cfg, w, h), c = cfg.composition!
  if (renderedPlan !== plan) { renderer = new engine.Renderer(); renderedPlan = plan }
  surface ??= document.createElement('canvas')
  if (surface.width !== w || surface.height !== h) { surface.width = w; surface.height = h }
  const x = surface.getContext('2d', { willReadFrequently: true })!
  const t = Math.max(0, Math.min(plan.duration - 1 / plan.fps, c.offset + time))
  renderer.frame(x, plan, t, { scale: h / 1080, transparent: c.background === 'transparent', noHud: true })
  ctx.save()
  const k = Math.max(0.05, Math.min(4, fontSize / 96))
  ctx.scale(k, k); ctx.drawImage(surface, -w / 2, -h / 2); ctx.restore()
}
