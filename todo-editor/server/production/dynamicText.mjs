import { newElement, nextId, stableHash } from './doc.mjs'

export const isDynamicText = ctx => ctx.pack.runtime?.type === 'text' && ctx.pack.runtime.engine === 'jizura'
const EFFECTS = ['dynamic-pop', 'dynamic-type', 'dynamic-wave', 'dynamic-stack', 'dynamic-flow', 'dynamic-cross']

/** Preserve the transcript, split at punctuation or 12 characters, and retain phrase timing. */
export function timedTextScenes(phrases, duration) {
  const out = []
  for (const [i, phrase] of phrases.entries()) {
    const chars = Array.from(phrase.text)
    let from = 0
    while (from < chars.length) {
      let to = Math.min(chars.length, from + 12)
      for (let k = from; k < to - 1; k++) if (/[，。！？；、,!?;：:]/u.test(chars[k]) && k - from >= 3) { to = k + 1; break }
      const start = phrase.start + (phrase.end - phrase.start) * from / chars.length
      const end = phrase.start + (phrase.end - phrase.start) * to / chars.length
      out.push({ content: chars.slice(from, to).join(''), at: i, startMs: Math.round(start * 1000), endMs: Math.round(end * 1000) })
      from = to
    }
  }
  for (let i = 0; i < out.length; i++) out[i].endMs = i + 1 < out.length ? out[i + 1].startMs : Math.round(duration * 1000)
  if (out.length) out[0].startMs = 0
  for (let i = 0; i < out.length;) {
    if (out[i].endMs > out[i].startMs) { i++; continue }
    if (out[i + 1]) out[i + 1].content = out[i].content + out[i + 1].content
    else if (out[i - 1]) out[i - 1].content += out[i].content
    out.splice(i, 1)
  }
  // Punctuation alone stays attached to the spoken phrase; very short items
  // join their neighbor instead of flashing unreadably between larger scenes.
  for (let i = 0; i < out.length;) {
    const s = out[i]
    if (/^[\p{P}\p{Z}\s]+$/u.test(s.content) && i > 0) {
      out[i-1].content += s.content; out[i-1].endMs = s.endMs; out.splice(i,1); continue
    }
    if (s.endMs - s.startMs < 450 && out.length > 1) {
      if (out[i+1]) { s.content += out[i+1].content; s.endMs = out[i+1].endMs; out.splice(i+1,1); continue }
      out[i-1].content += s.content; out[i-1].endMs = s.endMs; out.splice(i,1); continue
    }
    i++
  }
  return out
}

export function planDynamicText(ctx, seg, hash) {
  seg.boards = timedTextScenes(seg.voice.phrases, seg.voice.duration).map(scene => {
    const element = newElement(ctx.doc, { at: scene.at, label: scene.content, draw: scene.content, role: 'hero' })
    element.label = scene.content
    element.variants = []
    return { id: nextId(ctx.doc, 'b'), start: scene.at, textTiming: { startMs: scene.startMs, endMs: scene.endMs }, elements: [element], render: null }
  })
  seg.plan = { hash, voiceHash: seg.voice.hash, source: 'fallback', notes: '按配音短语时间戳保留原文，自动拆成动态文字镜头。' }
}

export function dynamicRenderHash(ctx, seg, board) {
  return stableHash({ version: ctx.pack.version, voice: seg.voice.hash, timing: board.textTiming,
    content: board.elements.map(e => e.label), params: ctx.doc.params,
    sequence: ctx.doc.params.effect === 'full' ? seg.boards.map(b => [b.textTiming, b.elements.map(e => e.label)]) : null,
    index: ctx.doc.segments.slice(0, ctx.doc.segments.indexOf(seg)).reduce((n, s) => n + s.boards.length, 0) + seg.boards.indexOf(board),
    last: seg === ctx.doc.segments.at(-1) && board === seg.boards.at(-1) })
}

export function renderDynamicText(ctx, seg, board) {
  const params = ctx.doc.params
  const [width, height] = String(params.size).split('x').map(Number)
  const index = ctx.doc.segments.slice(0, ctx.doc.segments.indexOf(seg)).reduce((n, s) => n + s.boards.length, 0) + seg.boards.indexOf(board)
  const content = board.elements.map(e => e.label).join(' ')
  const available = EFFECTS.filter(id => id !== 'dynamic-cross' || Array.from(content).length <= 11)
  const presetId = params.effect === 'auto' ? available[index % available.length] : params.effect
  const endMs = board.textTiming.endMs + (seg === ctx.doc.segments.at(-1) && board === seg.boards.at(-1) ? Math.round((Number(params.tail) || 0) * 1000) : 0)
  const duration = Math.max(0.05, (endMs - board.textTiming.startMs) / 1000)
  const seed = parseInt(stableHash({ id: ctx.doc.id, board: board.id }).slice(0, 8), 16)
  const full = params.effect === 'full'
  const composition = full ? {
    style: params.style || 'noir', mood: params.mood || 'graphic', background: params.background || 'style', unify: params.unify !== 'off',
    parts: Object.fromEntries(['layout','enter','hold','exit','decor','treat','bg','cam','fx','trans'].filter(k => params[k] && params[k] !== 'auto').map(k => [k, params[k]])),
    fx: { decor: Number(params.decorStrength), chroma: Number(params.chroma), glitch: Number(params.glitch), texture: Number(params.texture), bgSwitch: Number(params.bgSwitch) },
    offset: board.textTiming.startMs / 1000,
    scenes: seg.boards.map(b => ({ content: b.elements.map(e => e.label).join(' '), start: b.textTiming.startMs / 1000,
      end: (b.textTiming.endMs + (seg === ctx.doc.segments.at(-1) && b === seg.boards.at(-1) ? Math.round((Number(params.tail) || 0) * 1000) : 0)) / 1000 }))
  } : undefined
  const config = full ? { version: 2, engine: 'jizura', presetId: 'dynamic-full',
    seed: parseInt(stableHash({ id: ctx.doc.id, segment: seg.id, seed: params.seed }).slice(0, 8), 16), duration, motion: Number(params.motion), accent: params.accent || '#ffb454', composition }
    : { version: 1, engine: 'jizura', presetId, seed, duration: Math.max(0.5, Math.min(12, duration)), motion: Number(params.motion), accent: params.accent || '#ffb454' }
  board.render = { hash: dynamicRenderHash(ctx, seg, board), result: {
    fps: Number(params.fps) || 30, width, height, ...board.textTiming, endMs, layout: full ? `完整编排 · ${params.style}` : presetId, elements: [],
    dynamicText: { content, fontFamily: params.font === 'MicrosoftYaHei' ? 'Microsoft YaHei' : params.font || 'Microsoft YaHei', fontSize: 96,
      fancy: { preset: full ? 'dynamic-full' : presetId, fontWeight: 700, fill: [params.textColor || '#f8f5e9'], fillAngle: 90, strokes: [],
        dynamic: config } },
  } }
}
