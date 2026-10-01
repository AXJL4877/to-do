/**
 * 成片 ↔ AI 任务队列：一次「运行」是队列里一条 kind=skill、pipeline=production 的任务，
 * 请求里只有成片 id + 范围；所有状态都在成片文档里，任务清单只放摘要。
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { cleanScript, getSkillEntry, resolveSkillParams } from '../skillPacks.mjs'
import { SKILL_OUTPUT_SPEC } from '../skillJobs.mjs'
import {
  PRODUCTION_SPEC, applyEdits, fileExists, isNodeId, loadProduction, newProductionId, saveProduction, summarize,
} from './doc.mjs'
import { defaultServices } from './layers.mjs'
import { ProductionCanceled, publicView, runProduction } from './runner.mjs'

export const STOP_AFTER = ['plan']

export function productionEntry(skillId) {
  const entry = getSkillEntry(skillId)
  if (entry.pack.pipeline !== 'production') throw new Error(`技能「${entry.pack.name}」不是成片类技能`)
  return entry
}

/** 新建成片文档（只有全文和参数，分段在第一次运行时做） */
export function createProduction({ skillId, script, params, title }) {
  const entry = productionEntry(skillId)
  const { pack } = entry
  const text = cleanScript(script)
  if (!text) throw new Error(`请填写「${pack.input.label}」`)
  if (text.length > pack.input.maxLength) throw new Error(`「${pack.input.label}」最多 ${pack.input.maxLength} 字`)
  if (!/[\p{L}\p{N}]/u.test(text)) throw new Error(`「${pack.input.label}」里没有可朗读的文字`)
  const t = String(title ?? '').replace(/[{}\r\n]/g, ' ').trim().slice(0, 24)
  const doc = {
    spec: PRODUCTION_SPEC,
    id: newProductionId(),
    skillId: pack.id,
    skillVersion: pack.version,
    title: t || text.replace(/\s+/g, '').slice(0, 12),
    titleLocked: !!t,
    createdAt: Date.now(),
    params: resolveSkillParams(pack, params),
    script: text,
    cast: [],
    outline: null,
    counters: { g: 0, b: 0, e: 0, v: 0 },
    lock: null,
    status: { running: false, phase: '待生成', pct: 0, failed: [], error: null },
    plate: null,
    hand: null,
    segments: [],
  }
  return saveProduction(doc)
}

export function normalizeScope(raw) {
  if (raw == null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('scope 须为对象')
  const out = {}
  for (const k of ['segments', 'boards', 'elements']) {
    if (raw[k] == null) continue
    if (!Array.isArray(raw[k]) || raw[k].length > 500 || raw[k].some((id) => !isNodeId(id))) throw new Error(`scope.${k} 须为节点 id 数组`)
    if (raw[k].length) out[k] = [...new Set(raw[k])]
  }
  return Object.keys(out).length ? out : null
}

/** 两次排队的范围合并：任一方不限范围就不限 */
export function mergeScope(a, b) {
  if (!a || !b) return null
  const out = {}
  for (const k of ['segments', 'boards', 'elements']) {
    const s = [...new Set([...(a[k] ?? []), ...(b[k] ?? [])])]
    if (s.length) out[k] = s
  }
  return out
}

/** 任务行的 params（aiJobs 入队用） */
export function productionJobParams(doc, entry, body) {
  const stopAfter = STOP_AFTER.includes(body.stopAfter) ? body.stopAfter : null
  const [w, h] = String(doc.params.size || '').split('x').map(Number)
  return {
    size: doc.params.size,
    model: '',
    quality: '',
    duration: 0,
    autoTimeline: body.autoTimeline !== false,
    placement: body.placement === 'playhead' || body.placement === 'end' ? body.placement : null,
    placeAt: body.placement === 'playhead' && Number.isFinite(Number(body.placeAt)) && Number(body.placeAt) >= 0 ? Number(body.placeAt) : null,
    width: w || null,
    height: h || null,
    skill: { id: entry.pack.id, version: entry.pack.version, name: entry.pack.name, pipeline: 'production', summary: doc.title, alpha: true },
    request: { skillId: entry.pack.id, productionId: doc.id, scope: normalizeScope(body.scope), stopAfter },
    output: null,
  }
}

/** 编辑：生成中不许改（改了也会被运行器的存盘覆盖） */
export function editProduction(id, ops, { isRunning, outDir }) {
  const doc = loadProduction(id)
  if (doc.lock && isRunning(doc.lock.jobId)) throw new Error('正在生成，等这一轮跑完（或先停止）再改')
  const entry = productionEntry(doc.skillId)
  const resolved = ops.map((op) => (op?.op === 'setParams'
    ? { ...op, params: resolveSkillParams(entry.pack, { ...doc.params, ...op.params }) }
    : op))
  applyEdits(doc, resolved, {
    maxElements: entry.pack.planner.maxElements,
    variants: Number(doc.params.variants) || 1,
    files: { exists: (name) => fileExists(outDir, name) },
  })
  if (resolved.some((op) => op?.op === 'setTitle')) doc.titleLocked = true
  doc.lock = null
  saveProduction(doc)
  return publicView(doc, entry, outDir)
}

/** 上传一张元素图：落盘后作为候选加进元素 */
export function uploadVariant(id, element, dataUrl, ctx) {
  const m = /^data:image\/(png|jpe?g|webp);base64,/.exec(String(dataUrl ?? ''))
  if (!m) throw new Error('图片须为 png / jpg / webp 的 dataUrl')
  const buf = Buffer.from(String(dataUrl).slice(m[0].length), 'base64')
  if (buf.length > 20 * 1024 * 1024) throw new Error('图片太大（上限 20MB）')
  const name = `${id}_up_${Date.now().toString(36)}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`
  writeFileSync(path.join(ctx.outDir, name), buf)
  return editProduction(id, [{ op: 'uploadVariant', element, file: name }], ctx)
}

/** worker 里执行一次运行；返回给任务行的清单只有摘要 */
export async function executeProductionJob(job, ctx) {
  const req = job.params.request
  const doc = loadProduction(req.productionId)
  const entry = productionEntry(doc.skillId)
  let canceled = false
  try {
    await runProduction(doc, {
      entry,
      outDir: ctx.outDir,
      services: ctx.services ?? defaultServices(ctx.config, ctx.withRetry),
      phase: ctx.phase,
    }, { scope: req.scope, stopAfter: req.stopAfter, jobId: job.id })
  } catch (e) {
    if (!(e instanceof ProductionCanceled)) throw e
    canceled = true
  }
  const s = summarize(doc)
  const [width, height] = String(doc.params.size).split('x').map(Number)
  return {
    spec: SKILL_OUTPUT_SPEC,
    jobId: job.id,
    skill: { id: entry.pack.id, version: entry.pack.version, name: entry.pack.name },
    production: s,
    phase: canceled ? '已停止' : doc.status?.phase ?? '完成',
    alpha: true,
    width,
    height,
    duration: s.duration,
  }
}
