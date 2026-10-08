import { isDynamicText, planDynamicText, dynamicRenderHash, renderDynamicText } from './dynamicText.mjs'
/**
 * 成片的生成层。每层只管一种产物，接口一致：
 *   hash(...)   这一层的输入指纹（输入不变 → 产物可复用）
 *   dirty(...)  是否需要重做（没有产物 / 指纹对不上 / 文件丢了）
 *   run(...)    生成并把结果写回文档节点（不负责存盘和排队，那是 runner 的事）
 *
 *   voice     口播段 → 配音 wav + 逐字时间戳（TTS_timeline）
 *   storyboard 口播段 + 时间戳 → 镜头 + 元素（LLM，按短语编号定换镜点和起笔点）
 *   asset     元素 → 候选图（生图；可多张候选，选中的那张进渲染）
 *   render    镜头 → 每个元素的透明书写片段 + 定格图 + 笔尖轨迹（技能包的渲染端，todo-skill-render/1）
 *   subtitles 口播段 → 字幕条（字幕技能包的渲染端，只对时不烧录）
 *   plate     整片底板图（渲染端可选提供，例如黑板底）
 *
 * 技能包只需提供 skill.json（规划提示词、素材模板、参数）和渲染端；其余全是宿主的通用层。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { resolveFfmpeg } from '../animBuild.mjs'
import {
  NARRATED_MAX_SCENES, assetPrompt, chatPlanner, fallbackNarrationPlan, getSkillEntry, resolveSkillParams,
  sanitizeNarrationPlan, timingPhrases,
} from '../skillPacks.mjs'
import { SKILL_RENDER_SPEC, generateElementImage, narrationSchedule, runRenderer, ttsVoice } from '../skillJobs.mjs'
import { synthTimeline } from '../ttsTimeline.mjs'
import { DRAW_MAX, LABEL_MAX, fileExists, newElement, nextId, pickedVariant, stableHash } from './doc.mjs'

export const SUBTITLE_SKILL_ID = 'builtin.voice-subtitle'
/** 影响渲染结果的参数；改了就要重渲 */
export const RENDER_PARAM_KEYS = ['size', 'fps', 'layout', 'tone', 'drawSpeed', 'stroke', 'fill', 'quality', 'handSize', 'enter']

const has = (ctx, name) => fileExists(ctx.outDir, name)
const errText = (e) => String(e instanceof Error ? e.message : e).slice(0, 160)

// ── 配音 ────────────────────────────────────────────────────────────

export const voice = {
  hash: (ctx, seg) => stableHash({ text: seg.text, ...ttsVoice(ctx.doc.params) }),
  names(ctx, seg) {
    const base = `${ctx.doc.id}_${seg.id}_${this.hash(ctx, seg).slice(0, 8)}`
    return { script: `${base}_script.txt`, audio: `${base}_voice.wav`, timing: `${base}_timing.json` }
  },
  dirty(ctx, seg) {
    const v = seg.voice
    return !v || v.hash !== this.hash(ctx, seg) || !has(ctx, v.audio) || !has(ctx, v.timing)
  },
  async run(ctx, seg) {
    const hash = this.hash(ctx, seg)
    const n = this.names(ctx, seg)
    const file = (k) => path.join(ctx.outDir, n[k])
    if (!has(ctx, n.audio) || !has(ctx, n.timing)) {
      await ctx.services.synth(seg.text, {
        job: `todo_${ctx.doc.id}_${seg.id}`, textFile: file('script'), audioFile: file('audio'), timingFile: file('timing'), ...ttsVoice(ctx.doc.params),
      })
    }
    const timing = JSON.parse(readFileSync(file('timing'), 'utf8'))
    const phrases = timingPhrases(timing)
    if (!phrases.length) throw new Error('配音没有返回时间戳，无法对时')
    seg.voice = {
      hash, audio: n.audio, timing: n.timing,
      duration: Number(timing.duration) || phrases.at(-1).end,
      speaker: timing.speaker ?? null,
      phrases: phrases.map(({ text, start, end, sentence }) => ({ text, start, end, sentence })),
    }
  },
}

// ── 分镜规划 ────────────────────────────────────────────────────────

export function buildBoardMessages(pack, phrases, o) {
  const perBoard = pack.planner.maxElements
  const total = phrases.at(-1)?.end ?? 0
  const suggest = Math.max(1, Math.round(total / o.boardSec))
  const system = [
    pack.planner.system,
    '',
    '这是整条口播中的一段。输入是本段的短语表，每行「[编号] 开始秒数 | 短语」，空行分隔句子。短语编号就是时间锚点。',
    '只输出一个 JSON 对象，不要解释：',
    '{',
    '  "scenes": [ 按时间先后排列的镜头，每块：',
    '    { "start": 这块从哪个短语编号开始（第一块必须是 0）,',
    `      "elements": [ 1~${perBoard} 个，按出现先后排列，每个：`,
    `        { "at": 说到哪个短语时开始画（编号，须落在本块的短语范围内）, "label": "不超过 ${LABEL_MAX} 字的中文名", "draw": "英文画面描述，具体到物件、人物动作和短标签文字，不超过 ${DRAW_MAX} 字符", "role": "hero | support | accent" } ] }`,
    '  ],',
    '  "notes": "一句话说明怎么拆的"',
    '}',
    '拆分规则：',
    '1. 按意思换镜：一块讲一件事，话题转折、进入下一个要点时才换；换镜点只能落在句子开头。',
    `2. 本段约 ${Math.round(total)} 秒，大约每 ${o.boardSec} 秒一块，建议 ${suggest} 块，最多 ${o.maxBoards} 块；本段很短时一块就够。`,
    '3. 元素要在讲到它的那一刻出现：at 选第一次提到这个东西的短语；同一块里 at 递增，相邻元素最好隔开一两个短语，给书写留时间。',
    '4. 每块第一个元素 role=hero；关键数字、结论可以用 accent 写成 ≤6 字的大字。',
    '5. 只画本段口播里说到的东西，不要发明数字和概念；上下文只用来保持画面连贯。',
    o.cast?.length ? '6. 角色设定：画到下面这些角色时，draw 里必须带上它的外观描述（英文原样），保证全片同一个人长得一样：' : '',
    ...(o.cast ?? []).map((c) => `   - ${c.name}：${c.look}`),
    '',
    `全片：${o.title || '（未定）'}${o.segTitle ? ` · 本段：${o.segTitle}` : ''}`,
    o.prev ? `上一段结尾：${o.prev}` : '',
    o.next ? `下一段开头：${o.next}` : '',
  ].filter((l) => l !== '').join('\n')
  const lines = []
  for (const [k, p] of phrases.entries()) {
    if (k > 0 && p.sentence !== phrases[k - 1].sentence) lines.push('')
    lines.push(`[${k}] ${p.start.toFixed(1)}s | ${p.text}`)
  }
  return [{ role: 'system', content: system }, { role: 'user', content: lines.join('\n') }]
}

const phrasesOf = (seg) => (seg.voice?.phrases ?? []).map((p, i) => ({ ...p, i }))

export const storyboard = {
  hash: (ctx, seg) => stableHash({
    ...(isDynamicText(ctx) ? { textPlan: 2 } : {}),
    voice: seg.voice?.hash ?? null, boardSec: ctx.doc.params.boardSec, cast: ctx.doc.cast, planner: ctx.pack.planner.system, max: ctx.pack.planner.maxElements,
  }),
  dirty(ctx, seg) {
    const p = seg.plan
    if (!p || !seg.voice || p.voiceHash !== seg.voice.hash) return true
    // 人改过的分镜，配音没变就不让 AI 重拆
    return p.source !== 'user' && p.hash !== this.hash(ctx, seg)
  },
  async run(ctx, seg, gi) {
    const { doc, pack } = ctx
    if (isDynamicText(ctx)) { planDynamicText(ctx, seg, this.hash(ctx, seg)); return }
    const phrases = phrasesOf(seg)
    const boardSec = Number(doc.params.boardSec) || 10
    const maxBoards = Math.min(NARRATED_MAX_SCENES, Math.max(1, Math.ceil((phrases.at(-1)?.end ?? 0) / (boardSec * 0.6))))
    const neighbor = (k, tail) => {
      const t = doc.segments[k]?.text ?? ''
      return tail ? t.slice(-40) : t.slice(0, 40)
    }
    let plan
    let source = 'ai'
    let notes = ''
    try {
      const raw = await ctx.services.chat(buildBoardMessages(pack, phrases, {
        boardSec, maxBoards, cast: doc.cast, title: doc.title, segTitle: seg.title, prev: neighbor(gi - 1, true), next: neighbor(gi + 1, false),
      }))
      plan = sanitizeNarrationPlan(raw, pack, phrases, { maxScenes: maxBoards })
      notes = plan.notes
    } catch (e) {
      plan = fallbackNarrationPlan(pack, phrases)
      source = 'fallback'
      notes = `AI 拆分镜失败，按句各画一块：${errText(e)}`
    }
    // 重拆时画面描述没变的元素沿用原来的候选图和选择
    const old = new Map(seg.boards.flatMap((b) => b.elements).map((e) => [e.draw, e]))
    const variants = Math.max(1, Number(doc.params.variants) || 1)
    seg.boards = plan.scenes.map((s) => ({
      id: nextId(doc, 'b'),
      start: s.start,
      render: null,
      elements: s.elements.map((e) => {
        const el = newElement(doc, e, variants)
        const prev = old.get(el.draw)
        if (prev) { el.variants = prev.variants; el.pick = prev.pick }
        return el
      }),
    }))
    seg.plan = { hash: this.hash(ctx, seg), voiceHash: seg.voice.hash, source, notes }
  },
}

// ── 素材（候选图） ──────────────────────────────────────────────────

export const asset = {
  prompt: (ctx, el) => assetPrompt(ctx.pack, el, ctx.doc.params),
  hash(ctx, el) {
    return stableHash({ prompt: this.prompt(ctx, el), model: ctx.pack.assets.models[0], q: ctx.pack.assets.resolution })
  },
  /** 选中的那张能不能直接用：有文件，且（锁定 / 上传 / 指纹相符） */
  usable(ctx, el) {
    if (isDynamicText(ctx)) return true
    const v = pickedVariant(el)
    if (!v?.file || !has(ctx, v.file)) return false
    return v.locked || v.source === 'upload' || v.hash === this.hash(ctx, el)
  },
  /** 还要生成的候选：没文件的 AI 候选；选中那张过期了也算 */
  pending(ctx, el) {
    return el.variants.filter((v) => v.source === 'ai' && !(v.file && has(ctx, v.file)))
  },
  dirty(ctx, el) {
    if (isDynamicText(ctx)) return false
    return !this.usable(ctx, el) || this.pending(ctx, el).length > 0
  },
  async run(ctx, el) {
    const hash = this.hash(ctx, el)
    if (!this.usable(ctx, el) && !this.pending(ctx, el).includes(pickedVariant(el))) {
      // 选中的是过期的 AI 图（参数或描述变了）：新开一张并选中，旧的留作候选
      el.variants.push({ id: nextId(ctx.doc, 'v'), source: 'ai', hash: null, file: null })
      el.pick = el.variants.length - 1
    }
    const errors = []
    for (const v of this.pending(ctx, el)) {
      // 同一份提示词的第一张图按指纹命名：重拆分镜后描述没变的元素直接复用，不重复扣费
      const base = `${ctx.doc.id}_img_${hash}.png`
      const name = el.variants.some((x) => x !== v && x.file === base) ? `${ctx.doc.id}_img_${hash}_${v.id}.png` : base
      try {
        if (!has(ctx, name)) {
          await ctx.services.image({
            prompt: this.prompt(ctx, el), model: ctx.pack.assets.models[0], size: '1:1', quality: ctx.pack.assets.resolution,
          }, path.join(ctx.outDir, name))
        }
        Object.assign(v, { file: name, hash, error: undefined })
      } catch (e) {
        v.error = errText(e)
        errors.push(v.error)
      }
    }
    if (errors.length) throw new Error(errors[0])
  },
}

// ── 动画渲染（镜头） ────────────────────────────────────────────────

/** 一段里所有镜头的时间表（毫秒，相对本段配音 0 秒）；最后一段末尾留 tail 秒 */
export function segmentSchedule(ctx, seg, isLast) {
  const phrases = phrasesOf(seg)
  const plan = { scenes: seg.boards.map((b) => ({ start: b.start, elements: b.elements.map((e) => ({ at: e.at })) })) }
  const clamp = (i) => Math.min(phrases.length - 1, Math.max(0, i))
  plan.scenes = plan.scenes.map((s) => ({ start: clamp(s.start), elements: s.elements.map((e) => ({ at: clamp(e.at) })) }))
  return narrationSchedule(plan, phrases, seg.voice.duration, isLast ? Number(ctx.doc.params.tail) || 0 : 0)
}

export const render = {
  hash(ctx, seg, board, sched) {
    if (isDynamicText(ctx)) return dynamicRenderHash(ctx, seg, board)
    const p = Object.fromEntries(RENDER_PARAM_KEYS.map((k) => [k, ctx.doc.params[k]]))
    return stableHash({
      sched, p, v: ctx.pack.version,
      els: board.elements.map((e) => ({ id: e.id, role: e.role, weight: e.weight, image: pickedVariant(e)?.file ?? null })),
    })
  },
  dirty(ctx, seg, board, sched) {
    if (!board.elements.length) return false
    const r = board.render
    if (!r?.result || r.hash !== this.hash(ctx, seg, board, sched)) return true
    if (isDynamicText(ctx)) return !r.result.dynamicText
    return !r.result.elements.every((e) => has(ctx, e.video) && has(ctx, e.hold))
  },
  async run(ctx, seg, board, sched) {
    if (isDynamicText(ctx)) { renderDynamicText(ctx, seg, board); return }
    const { doc, entry } = ctx
    const hash = this.hash(ctx, seg, board, sched)
    const prefix = `${doc.id}_${hash.slice(0, 8)}`
    const handName = `${doc.id}_hand_${String(doc.params.handSize ?? 1).replace('.', '_')}.png`
    const request = {
      spec: SKILL_RENDER_SPEC,
      jobId: doc.id,
      mode: 'scene-clips',
      outDir: ctx.outDir,
      ffmpeg: resolveFfmpeg(),
      params: doc.params,
      scene: {
        id: board.id,
        startMs: sched.startMs,
        endMs: sched.endMs,
        elements: board.elements.map((e, j) => ({
          id: e.id, label: e.label, role: e.role, weight: e.weight, image: path.join(ctx.outDir, pickedVariant(e).file), ...sched.elements[j],
        })),
      },
      outputs: { prefix, hand: handName },
    }
    const requestFile = path.join(ctx.outDir, `${prefix}_${board.id}_request.json`)
    writeFileSync(requestFile, JSON.stringify(request, null, 2))
    const result = await ctx.services.render(entry, requestFile, { timeoutSec: entry.pack.runtime.timeoutSec, onProgress: () => {} })
    if (result.hand) doc.hand = { ...result.hand }
    board.render = {
      hash,
      result: {
        fps: result.fps, width: result.width, height: result.height,
        startMs: result.scene.startMs, endMs: result.scene.endMs, layout: result.scene.layout,
        elements: result.scene.elements.map(({ mask: _m, cut: _c, ...e }) => e),
      },
    }
  },
}

// ── 字幕 ────────────────────────────────────────────────────────────

const subtitleParams = (ctx) => {
  const entry = getSkillEntry(SUBTITLE_SKILL_ID)
  return { entry, params: resolveSkillParams(entry.pack, { size: ctx.doc.params.size, maxChars: ctx.doc.params.subtitleChars ?? 18 }) }
}

export const subtitles = {
  enabled: (ctx) => ctx.doc.params.subtitles === 'on',
  hash: (ctx, seg) => stableHash({ voice: seg.voice?.hash ?? null, size: ctx.doc.params.size, chars: ctx.doc.params.subtitleChars ?? 18 }),
  dirty(ctx, seg) {
    return this.enabled(ctx) && !!seg.voice && seg.subtitles?.hash !== this.hash(ctx, seg)
  },
  async run(ctx, seg) {
    const hash = this.hash(ctx, seg)
    const { entry, params } = subtitleParams(ctx)
    const prefix = `${ctx.doc.id}_${seg.id}_${hash.slice(0, 8)}`
    const request = {
      spec: SKILL_RENDER_SPEC, jobId: ctx.doc.id, outDir: ctx.outDir, ffmpeg: resolveFfmpeg(), params,
      mode: 'cues', script: seg.text,
      audio: path.join(ctx.outDir, seg.voice.audio), timing: path.join(ctx.outDir, seg.voice.timing),
      outputs: { prefix, subtitles: `${prefix}_subtitles.json` },
    }
    const requestFile = path.join(ctx.outDir, `${prefix}_sub_request.json`)
    writeFileSync(requestFile, JSON.stringify(request, null, 2))
    const result = await ctx.services.render(entry, requestFile, { timeoutSec: 600, onProgress: () => {} })
    const cues = JSON.parse(readFileSync(path.join(ctx.outDir, result.subtitles), 'utf8'))
    seg.subtitles = { hash, params: { font: params.font, fontPx: params.fontPx, bottomPct: params.bottomPct }, cues: cues.map(({ text, start, end, keywords }) => ({ text, start, end, keywords: keywords ?? [] })) }
  },
}

// ── 底板 ────────────────────────────────────────────────────────────

export const plate = {
  enabled: (ctx) => ctx.doc.params.plate === 'board',
  hash: (ctx) => stableHash({ size: ctx.doc.params.size, v: ctx.pack.version }),
  dirty(ctx) {
    return this.enabled(ctx) && (ctx.doc.plate?.hash !== this.hash(ctx) || !has(ctx, ctx.doc.plate?.file))
  },
  async run(ctx) {
    const hash = this.hash(ctx)
    const name = `${ctx.doc.id}_plate_${hash.slice(0, 8)}.png`
    const request = {
      spec: SKILL_RENDER_SPEC, jobId: ctx.doc.id, mode: 'plate', outDir: ctx.outDir, ffmpeg: resolveFfmpeg(),
      params: ctx.doc.params, outputs: { prefix: ctx.doc.id, plate: name },
    }
    const requestFile = path.join(ctx.outDir, `${ctx.doc.id}_plate_request.json`)
    writeFileSync(requestFile, JSON.stringify(request, null, 2))
    const result = await ctx.services.render(ctx.entry, requestFile, { timeoutSec: 120, onProgress: () => {} })
    ctx.doc.plate = { hash, file: result.plate, width: result.width, height: result.height }
  },
}

/** 运行时依赖：默认走真实的 TTS / LLM / 生图 / 渲染端，自检时整组换掉 */
export function defaultServices(config, withRetry) {
  return {
    synth: (text, o) => withRetry(() => synthTimeline(text, o)),
    chat: (messages) => withRetry(() => chatPlanner(config, messages)),
    image: (request, out) => generateElementImage(config, withRetry, request, out),
    render: (entry, requestFile, o) => runRenderer(entry, requestFile, o),
  }
}
