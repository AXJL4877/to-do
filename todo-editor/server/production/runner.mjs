/**
 * 成片运行器：把文档里「需要重做」的节点按层跑完。
 *
 *   分段（文档还没有口播段时）→ 每段：配音 → 分镜 → 字幕 ∥ 每个镜头：元素候选图 → 渲染
 *
 * 每层一个先进先出的并发闸（配音 2、分镜 2、生图 TODO_AI_CONCURRENCY、渲染 1、字幕 1），排在前面的段先拿到名额：
 * 第 1 段在渲染时，后面的段还在配音 / 生图，产物一出来就存盘，编辑器轮询文档流式入轨。
 * 单个节点失败不牵连别的节点：错误记在节点上并汇总，最后整体报错；重试时只有失败和没做完的节点会再跑。
 *
 * scope 限定只处理哪些段 / 镜头 / 元素（局部重做）；上游没准备好的依赖（比如改了文案的那段配音）会一并补上。
 * stopAfter='plan' 时只做到分镜（先审分镜再生成）。
 */
import { cleanScript } from '../skillPacks.mjs'
import { newSegment, pickedVariant, publicProduction, saveProduction, scopeTester } from './doc.mjs'
import { asset, plate, render, segmentSchedule, storyboard, subtitles, voice } from './layers.mjs'
import { segmentScript } from './segment.mjs'

const IMAGE_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.TODO_AI_CONCURRENCY) || 4))
const WEIGHT = { voice: 1, plan: 1, asset: 2, render: 3, subtitles: 0.5 }
const LAYER_LABEL = { segment: '分段', voice: '配音', plan: '分镜', asset: '生图', render: '渲染', subtitles: '字幕', plate: '底板' }

const cancels = new Set()
export class ProductionCanceled extends Error {}

/** 停止正在跑的成片：已开始的那一步做完，排队中的不再开始 */
export function requestCancel(id) {
  cancels.add(id)
}

function gate(n, doc) {
  let active = 0
  const waiting = []
  const next = () => {
    while (active < n && waiting.length) {
      const { fn, resolve, reject } = waiting.shift()
      if (cancels.has(doc.id)) { reject(new ProductionCanceled('已停止')); continue }
      active++
      fn().then(resolve, reject).finally(() => { active--; next() })
    }
  }
  return (fn) => new Promise((resolve, reject) => { waiting.push({ fn, resolve, reject }); next() })
}

function throttle(fn, ms) {
  let timer = null
  let pending = false
  const run = () => { timer = null; if (pending) { pending = false; fn() } }
  const call = () => { pending = true; if (!timer) timer = setTimeout(run, ms) }
  call.flush = () => { if (timer) clearTimeout(timer); timer = null; pending = false; fn() }
  return call
}

const errText = (e) => String(e instanceof Error ? e.message : e).slice(0, 160)

/** 当前文档各节点是否需要重做（给前端显示「待生成」） */
export function dirtyView(doc, entry, outDir) {
  const ctx = { doc, pack: entry.pack, entry, outDir }
  const scheds = new Map()
  const schedOf = (seg) => {
    if (!seg.voice) return null
    if (!scheds.has(seg.id)) {
      try { scheds.set(seg.id, segmentSchedule(ctx, seg, seg === doc.segments.at(-1))) } catch { scheds.set(seg.id, null) }
    }
    return scheds.get(seg.id)
  }
  return {
    voice: (seg) => voice.dirty(ctx, seg),
    plan: (seg) => storyboard.dirty(ctx, seg),
    subtitles: (seg) => subtitles.dirty(ctx, seg),
    asset: (el) => asset.dirty(ctx, el),
    render: (seg, b) => {
      const s = schedOf(seg)
      const k = seg.boards.indexOf(b)
      return !s?.[k] || render.dirty(ctx, seg, b, s[k])
    },
  }
}

export function publicView(doc, entry, outDir) {
  return publicProduction(doc, dirtyView(doc, entry, outDir))
}

/**
 * @param {object} doc 成片文档（运行期间就地修改、节流存盘）
 * @param {{ entry: object, outDir: string, services: object, phase: (s: string) => void }} env
 * @param {{ scope?: object, stopAfter?: 'plan'|null, jobId?: string }} opts
 */
export async function runProduction(doc, env, opts = {}) {
  const ctx = { doc, pack: env.entry.pack, entry: env.entry, outDir: env.outDir, services: env.services }
  const save = throttle(() => saveProduction(doc), 400)
  const failed = []
  const done = { voice: 0, plan: 0, asset: 0, render: 0, subtitles: 0 }
  const todo = { voice: 0, plan: 0, asset: 0, render: 0, subtitles: 0 }
  let lastPct = 0
  let current = ''

  const report = (what) => {
    if (what) current = what
    const total = Object.keys(todo).reduce((t, k) => t + WEIGHT[k] * todo[k], 0)
    const got = Object.keys(done).reduce((t, k) => t + WEIGHT[k] * done[k], 0)
    lastPct = Math.max(lastPct, total ? Math.round((100 * got) / total) : 0)
    const parts = ['voice', 'plan', 'asset', 'render'].filter((k) => todo[k]).map((k) => `${LAYER_LABEL[k]} ${done[k]}/${todo[k]}`)
    const text = `${current}${parts.length ? ` · ${parts.join(' · ')}` : ''}（${Math.min(99, lastPct)}%）`
    doc.status = { ...doc.status, running: true, phase: text, pct: lastPct }
    env.phase(text)
    save()
  }
  const fail = (layer, node, label, e) => {
    if (e instanceof ProductionCanceled) throw e
    failed.push({ layer, id: node.id, label, error: errText(e) })
    doc.status = { ...doc.status, failed: [...failed] }
    report()
  }

  cancels.delete(doc.id)
  doc.lock = { jobId: opts.jobId ?? null, since: Date.now() }
  doc.status = { running: true, phase: '开始', pct: 0, failed: [], error: null, stopAfter: opts.stopAfter ?? null }
  saveProduction(doc)

  try {
    // 0. 分段：新建的文档只有全文
    if (!doc.segments.length) {
      report('AI 分段')
      const params = doc.params
      const r = await segmentScript(cleanScript(doc.script), {
        mode: params.split ?? 'semantic', target: Number(params.segmentChars) || 120, max: Math.max(Number(params.segmentChars) || 120, Number(params.segmentMax) || 200),
        chat: env.services.chat, title: doc.title,
      })
      if (!doc.titleLocked && r.title) doc.title = r.title
      doc.cast = r.cast
      doc.outline = { source: r.source, notes: r.notes }
      doc.segments = r.segments.map((s) => newSegment(doc, s))
      saveProduction(doc)
    }

    const t = scopeTester(doc, opts.scope)
    const segs = doc.segments.filter((s) => t.segment(s))
    const planOnly = opts.stopAfter === 'plan'
    const gates = { voice: gate(2, doc), plan: gate(2, doc), asset: gate(IMAGE_CONCURRENCY, doc), render: gate(1, doc), subtitles: gate(1, doc) }

    const planCounted = new Set()
    for (const seg of segs) {
      if (voice.dirty(ctx, seg)) todo.voice++
      if (!seg.voice || storyboard.dirty(ctx, seg) || voice.dirty(ctx, seg)) { todo.plan++; planCounted.add(seg.id) }
    }
    report('排队')

    const platePromise = plate.dirty(ctx) && !planOnly
      ? gates.render(() => plate.run(ctx)).then(save, (e) => fail('plate', { id: 'plate' }, '底板', e))
      : Promise.resolve()

    const runSegment = async (seg) => {
      const gi = doc.segments.indexOf(seg)
      const label = seg.title || `第 ${gi + 1} 段`
      if (voice.dirty(ctx, seg)) {
        try {
          await gates.voice(async () => { report(`${label} 配音`); await voice.run(ctx, seg) })
          done.voice++
          report()
        } catch (e) { fail('voice', seg, label, e); return }
      }
      if (storyboard.dirty(ctx, seg)) {
        try {
          await gates.plan(async () => { report(`${label} 拆分镜`); await storyboard.run(ctx, seg, gi) })
        } catch (e) { fail('plan', seg, label, e); return }
      }
      if (planCounted.has(seg.id)) done.plan++
      report()
      const subs = subtitles.dirty(ctx, seg)
        ? gates.subtitles(() => subtitles.run(ctx, seg)).then(save, (e) => fail('subtitles', seg, `${label} 字幕`, e))
        : null
      if (planOnly) { await subs; return }

      const sched = segmentSchedule(ctx, seg, seg === doc.segments.at(-1))
      const boards = seg.boards.filter((b) => t.board(seg, b))
      // 本段要做的生图 / 渲染一次性记账
      for (const b of boards) {
        for (const e of b.elements) if (wantAsset(seg, b, e)) todo.asset++
        if (render.dirty(ctx, seg, b, sched[seg.boards.indexOf(b)])) todo.render++
      }
      report()
      await Promise.all(boards.map(async (b) => {
        const k = seg.boards.indexOf(b)
        const blabel = `${label} 镜头 ${k + 1}`
        const ok = await Promise.all(b.elements.map(async (e) => {
          if (!wantAsset(seg, b, e)) return asset.usable(ctx, e)
          try {
            await gates.asset(async () => { report(`${blabel} 生图「${e.label}」`); await asset.run(ctx, e) })
            done.asset++
            report()
            return true
          } catch (err) {
            done.asset++
            fail('asset', e, `${blabel}「${e.label}」`, err)
            return asset.usable(ctx, e)
          }
        }))
        if (!ok.every(Boolean) || !render.dirty(ctx, seg, b, sched[k])) return
        try {
          await gates.render(async () => { report(`${blabel} 渲染`); await render.run(ctx, seg, b, sched[k]) })
          done.render++
          report()
        } catch (err) {
          done.render++
          fail('render', b, blabel, err)
        }
      }))
      await subs
    }

    /** 元素要不要生图：被点名或整镜头在范围内时，补齐所有待生成候选；否则只在选中的图不能用时补 */
    const wantAsset = (seg, b, e) => (t.element(seg, b, e) ? asset.dirty(ctx, e) : !asset.usable(ctx, e))

    // 停止时也要等已经开始的步骤收尾，免得后台还在改文档
    const settled = await Promise.allSettled([platePromise, ...segs.map((seg) => runSegment(seg))])
    for (const [i, r] of settled.entries()) {
      if (r.status === 'rejected' && !(r.reason instanceof ProductionCanceled)) {
        const seg = segs[i - 1]
        failed.push({ layer: 'segment', id: seg?.id ?? 'plate', label: seg?.title || seg?.id || '底板', error: errText(r.reason) })
      }
    }

    const canceled = cancels.has(doc.id)
    const missing = canceled ? 0 : countMissing(ctx, planOnly)
    doc.status = {
      running: false,
      pct: 100,
      phase: canceled ? '已停止' : failed.length ? `${failed.length} 处失败` : planOnly ? '分镜已就绪，待生成画面' : missing ? `完成 · 还有 ${missing} 处待生成` : '完成',
      failed,
      error: failed.length ? summarizeFailures(failed) : null,
      stopAfter: opts.stopAfter ?? null,
    }
    if (canceled) throw new ProductionCanceled('已停止')
    if (failed.length) throw new Error(doc.status.error)
    return doc
  } catch (e) {
    if (!(e instanceof ProductionCanceled) && !failed.length) {
      doc.status = { running: false, pct: lastPct, phase: '失败', failed, error: errText(e), stopAfter: opts.stopAfter ?? null }
    } else if (e instanceof ProductionCanceled) {
      doc.status = { running: false, pct: lastPct, phase: '已停止', failed, error: null, stopAfter: opts.stopAfter ?? null }
    }
    throw e
  } finally {
    cancels.delete(doc.id)
    doc.lock = null
    save.flush()
  }
}

/** 范围外还没生成的节点数（局部重做后告诉用户还剩多少） */
function countMissing(ctx, planOnly) {
  let n = 0
  for (const [gi, seg] of ctx.doc.segments.entries()) {
    if (voice.dirty(ctx, seg) || storyboard.dirty(ctx, seg)) { n++; continue }
    if (planOnly) continue
    const sched = segmentSchedule(ctx, seg, gi === ctx.doc.segments.length - 1)
    seg.boards.forEach((b, k) => { if (render.dirty(ctx, seg, b, sched[k]) || b.elements.some((e) => !asset.usable(ctx, e) || !pickedVariant(e))) n++ })
  }
  return n
}

function summarizeFailures(failed) {
  const head = failed.slice(0, 4).map((f) => `${LAYER_LABEL[f.layer] ?? f.layer}「${f.label}」${f.error}`).join('；')
  return `${failed.length} 处失败（成功的已保留，重试只补失败的）：${head}${failed.length > 4 ? '…' : ''}`
}
