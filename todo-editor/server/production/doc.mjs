/**
 * 成片文档 todo-production/1：一条长口播从分段到入轨的全部状态，存在 $TODO_DATA_DIR/productions/<id>.json。
 *
 * 树：production → segments（口播段，各自一条配音）→ boards（镜头）→ elements（元素，带候选图 variants）。
 * 每个节点记着产出它时的输入哈希（hash）。输入一变（改文案 / 改画面描述 / 换参数），哈希就对不上，
 * 运行器（runner.mjs）只重做这些节点；产物文件名带哈希，旧产物不会被新产物覆盖，时间轴可以先用旧的、新的出来再替换。
 *
 * 编辑一律走 applyEdits（纯函数式地改文档，不跑任何生成）；生成一律走运行器。两者不同时进行（doc.lock）。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PRODUCTION_SPEC = 'todo-production/1'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DATA_DIR = process.env.TODO_DATA_DIR ? path.resolve(process.env.TODO_DATA_DIR) : path.join(ROOT, '.data')
export const PRODUCTION_DIR = path.join(DATA_DIR, 'productions')

export const ID_RE = /^p_[a-z0-9]+_[a-z0-9]+$/
const NODE_ID_RE = /^[gbev]\d{1,5}$/
export const LABEL_MAX = 12
export const DRAW_MAX = 240
export const SEGMENT_TEXT_MAX = 1200
export const MAX_VARIANTS = 6
export const ROLES = ['hero', 'support', 'accent']

/** 键排序后的 JSON 取 sha1 前 12 位：同样的输入永远同一个哈希 */
export function stableHash(value) {
  return createHash('sha1').update(stableJson(value)).digest('hex').slice(0, 12)
}

function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`
  }
  return JSON.stringify(v ?? null)
}

export const newProductionId = () => `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`

const fileOf = (id) => {
  if (!ID_RE.test(String(id || ''))) throw new Error('成片 id 不合法')
  return path.join(PRODUCTION_DIR, `${id}.json`)
}

export function loadProduction(id) {
  const file = fileOf(id)
  if (!existsSync(file)) throw new Error(`找不到成片 ${id}`)
  return JSON.parse(readFileSync(file, 'utf8'))
}

export function productionExists(id) {
  try { return existsSync(fileOf(id)) } catch { return false }
}

/** 先写临时文件再改名：前端轮询永远读不到半份文档 */
export function saveProduction(doc) {
  mkdirSync(PRODUCTION_DIR, { recursive: true })
  doc.updatedAt = Date.now()
  doc.rev = (doc.rev || 0) + 1
  const file = fileOf(doc.id)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(doc))
  renameSync(tmp, file)
  return doc
}

/** 只删文档；产物文件留在 ai-generated（时间线可能还引用着） */
export function deleteProduction(id) {
  const file = fileOf(id)
  if (!existsSync(file)) return false
  unlinkSync(file)
  return true
}

/** 列表只给摘要（前端按 updatedAt 判断要不要拉整份） */
export function listProductions(ids) {
  if (!existsSync(PRODUCTION_DIR)) return []
  const wanted = ids?.length ? new Set(ids) : null
  const out = []
  for (const name of readdirSync(PRODUCTION_DIR)) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -5)
    if (wanted && !wanted.has(id)) continue
    try {
      const doc = JSON.parse(readFileSync(path.join(PRODUCTION_DIR, name), 'utf8'))
      out.push(summarize(doc))
    } catch { /* 写到一半的文件下一轮再读 */ }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function summarize(doc) {
  const els = doc.segments.flatMap((s) => s.boards.flatMap((b) => b.elements))
  return {
    id: doc.id,
    skillId: doc.skillId,
    title: doc.title,
    updatedAt: doc.updatedAt,
    rev: doc.rev,
    lock: doc.lock ?? null,
    status: doc.status ?? null,
    segments: doc.segments.length,
    boards: doc.segments.reduce((n, s) => n + s.boards.length, 0),
    elements: els.length,
    duration: Math.round(doc.segments.reduce((t, s) => t + (s.voice?.duration ?? 0), 0) * 10) / 10,
  }
}

// ── 节点 ────────────────────────────────────────────────────────────

export function nextId(doc, kind) {
  doc.counters[kind] = (doc.counters[kind] || 0) + 1
  return `${kind}${doc.counters[kind]}`
}

export function newSegment(doc, { text, title = '' }) {
  return { id: nextId(doc, 'g'), title, text, voice: null, plan: null, subtitles: null, boards: [] }
}

export function newElement(doc, e, variants = 1) {
  const role = ROLES.includes(e.role) ? e.role : 'support'
  const w = Number(e.weight)
  return {
    id: nextId(doc, 'e'),
    at: Math.max(0, Math.round(Number(e.at) || 0)),
    label: String(e.label ?? '').trim().slice(0, LABEL_MAX) || '元素',
    draw: String(e.draw ?? '').trim().slice(0, DRAW_MAX),
    role,
    weight: Number.isFinite(w) ? Math.min(3, Math.max(0.5, w)) : role === 'hero' ? 1.5 : 1,
    variants: Array.from({ length: Math.max(1, variants) }, () => ({ id: nextId(doc, 'v'), source: 'ai', hash: null, file: null })),
    pick: 0,
  }
}

/** 按 id 找节点，带上它的父节点 */
export function findNode(doc, id) {
  for (const [gi, seg] of doc.segments.entries()) {
    if (seg.id === id) return { kind: 'segment', seg, gi }
    for (const [bi, board] of seg.boards.entries()) {
      if (board.id === id) return { kind: 'board', seg, gi, board, bi }
      for (const [ei, el] of board.elements.entries()) {
        if (el.id === id) return { kind: 'element', seg, gi, board, bi, el, ei }
      }
    }
  }
  return null
}

export function pickedVariant(el) {
  return el.variants[el.pick] ?? el.variants[0] ?? null
}

/**
 * 范围：segments / boards / elements 三个 id 列表，空 = 全部。
 * 节点在范围内 = 它自己或任一祖先被点名；元素被点名时它所在的镜头也要重渲（否则新图上不了时间轴）。
 */
export function scopeTester(doc, scope) {
  const s = scope && typeof scope === 'object' ? scope : {}
  const segs = new Set(s.segments ?? [])
  const boards = new Set(s.boards ?? [])
  const els = new Set(s.elements ?? [])
  const all = !segs.size && !boards.size && !els.size
  return {
    all,
    segment: (seg) => all || segs.has(seg.id) || seg.boards.some((b) => boards.has(b.id) || b.elements.some((e) => els.has(e.id))),
    /** 配音和分镜只在整段被点名（或不限范围）时重做 */
    segmentWhole: (seg) => all || segs.has(seg.id),
    board: (seg, b) => all || segs.has(seg.id) || boards.has(b.id) || b.elements.some((e) => els.has(e.id)),
    element: (seg, b, e) => all || segs.has(seg.id) || boards.has(b.id) || els.has(e.id),
  }
}

// ── 编辑操作 ────────────────────────────────────────────────────────

const text = (v, max) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/[{}]/g, '').trim().slice(0, max)

function need(doc, id, kind) {
  const hit = findNode(doc, String(id ?? ''))
  if (!hit || hit.kind !== kind) throw new Error(`找不到${{ segment: '口播段', board: '镜头', element: '元素' }[kind]} ${id}`)
  return hit
}

/** 分镜被人改过：之后配音不变就不再让 AI 重拆，免得把改动冲掉 */
const touchPlan = (seg) => { if (seg.plan) seg.plan.source = 'user' }

/**
 * 编辑操作（不跑生成，只改文档；改完哪些节点要重做由哈希自动算出来）：
 *   setTitle { title }                         setParams { params }（已按技能包校验过的完整参数）
 *   setSegmentText { segment, text }           改文案 → 该段重新配音 + 重拆分镜
 *   splitSegment { segment, at }               在第 at 个字处切成两段
 *   mergeSegment { segment }                   与下一段合并
 *   removeSegment { segment }
 *   replanSegment { segment }                  丢掉现有分镜，下次运行让 AI 重拆
 *   setElement { element, patch }              patch: label / draw / role / weight / at；改 draw 会新开一张候选
 *   addElement { board, element }              element: { label, draw, role?, at? }
 *   removeElement { element }
 *   moveElement { element, delta }             在本镜头内前后挪（书写顺序）
 *   addVariant { element }                     再来一张候选（下次运行生成）
 *   pickVariant { element, variant }           选定候选（锁定，参数变了也不会被自动重画）
 *   uploadVariant { element, file }            用上传的图当候选（file 为已落盘的文件名）
 *   addBoard { segment, after?, start }        在某段里加一块镜头（start 为该段短语编号）
 *   removeBoard { board }
 * @param {{ maxElements: number, variants: number, files?: { exists: (name: string) => boolean } }} limits
 */
export function applyEdits(doc, ops, limits) {
  if (!Array.isArray(ops) || !ops.length) throw new Error('没有编辑操作')
  if (ops.length > 200) throw new Error('一次最多 200 个编辑操作')
  for (const op of ops) applyEdit(doc, op, limits)
  return doc
}

function applyEdit(doc, op, limits) {
  const type = String(op?.op ?? '')
  switch (type) {
    case 'setTitle': {
      doc.title = text(op.title, 24) || doc.title
      return
    }
    case 'setParams': {
      if (!op.params || typeof op.params !== 'object') throw new Error('setParams 缺少 params')
      doc.params = op.params
      return
    }
    case 'setSegmentText': {
      const { seg } = need(doc, op.segment, 'segment')
      const t = text(op.text, SEGMENT_TEXT_MAX)
      if (!/[\p{L}\p{N}]/u.test(t)) throw new Error('口播段里没有可朗读的文字')
      if (t === seg.text) return
      seg.text = t
      // 配音变了，旧分镜的短语编号全部失效
      if (seg.plan) seg.plan.source = 'ai'
      syncScript(doc)
      return
    }
    case 'splitSegment': {
      const { seg, gi } = need(doc, op.segment, 'segment')
      const at = Math.round(Number(op.at))
      if (!(at > 0 && at < seg.text.length)) throw new Error('切分位置要在这段文字中间')
      const a = seg.text.slice(0, at).trim()
      const b = seg.text.slice(at).trim()
      if (!a || !b) throw new Error('切分后两边都要有文字')
      const second = newSegment(doc, { text: b, title: '' })
      seg.text = a
      if (seg.plan) seg.plan.source = 'ai'
      doc.segments.splice(gi + 1, 0, second)
      syncScript(doc)
      return
    }
    case 'mergeSegment': {
      const { seg, gi } = need(doc, op.segment, 'segment')
      const next = doc.segments[gi + 1]
      if (!next) throw new Error('已经是最后一段，没有可合并的下一段')
      const merged = `${seg.text}\n${next.text}`
      if (merged.length > SEGMENT_TEXT_MAX) throw new Error(`合并后超过 ${SEGMENT_TEXT_MAX} 字`)
      seg.text = merged
      if (seg.plan) seg.plan.source = 'ai'
      doc.segments.splice(gi + 1, 1)
      syncScript(doc)
      return
    }
    case 'removeSegment': {
      const { gi } = need(doc, op.segment, 'segment')
      if (doc.segments.length <= 1) throw new Error('至少要留一段口播')
      doc.segments.splice(gi, 1)
      syncScript(doc)
      return
    }
    case 'replanSegment': {
      const { seg } = need(doc, op.segment, 'segment')
      seg.plan = null
      return
    }
    case 'setElement': {
      const { seg, el } = need(doc, op.element, 'element')
      const p = op.patch && typeof op.patch === 'object' ? op.patch : {}
      if (p.label != null) el.label = text(p.label, LABEL_MAX) || el.label
      if (p.role != null) {
        if (!ROLES.includes(p.role)) throw new Error(`角色只能是 ${ROLES.join(' / ')}`)
        el.role = p.role
      }
      if (p.weight != null) {
        const w = Number(p.weight)
        if (!Number.isFinite(w)) throw new Error('权重须为数字')
        el.weight = Math.min(3, Math.max(0.5, Math.round(w * 10) / 10))
      }
      if (p.at != null) el.at = Math.max(0, Math.round(Number(p.at) || 0))
      if (p.draw != null) {
        const d = text(p.draw, DRAW_MAX)
        if (!d) throw new Error('画面描述不能为空')
        if (d !== el.draw) {
          el.draw = d
          // 新描述 = 新开一张候选并选中；旧候选留着，可以随时选回去
          if (el.variants.length >= MAX_VARIANTS) el.variants.splice(el.variants.findIndex((v, i) => i !== el.pick), 1)
          el.variants.push({ id: nextId(doc, 'v'), source: 'ai', hash: null, file: null })
          el.pick = el.variants.length - 1
        }
      }
      touchPlan(seg)
      return
    }
    case 'addElement': {
      const { seg, board } = need(doc, op.board, 'board')
      if (board.elements.length >= limits.maxElements) throw new Error(`每个镜头最多 ${limits.maxElements} 个元素`)
      const e = op.element ?? {}
      if (!text(e.draw, DRAW_MAX)) throw new Error('新元素要有画面描述')
      const at = e.at ?? board.elements.at(-1)?.at ?? board.start
      board.elements.push(newElement(doc, { role: board.elements.length ? 'support' : 'hero', ...e, draw: text(e.draw, DRAW_MAX), at }, 1))
      board.elements.sort((a, b) => a.at - b.at)
      touchPlan(seg)
      return
    }
    case 'removeElement': {
      const { seg, board, ei } = need(doc, op.element, 'element')
      board.elements.splice(ei, 1)
      if (!board.elements.length) seg.boards.splice(seg.boards.indexOf(board), 1)
      touchPlan(seg)
      return
    }
    case 'moveElement': {
      const { seg, board, ei } = need(doc, op.element, 'element')
      const j = ei + (Number(op.delta) < 0 ? -1 : 1)
      if (j < 0 || j >= board.elements.length) return
      const els = board.elements
      ;[els[ei], els[j]] = [els[j], els[ei]]
      // 书写顺序 = 锚点顺序：交换两者的起笔短语
      ;[els[ei].at, els[j].at] = [els[j].at, els[ei].at]
      touchPlan(seg)
      return
    }
    case 'addVariant': {
      const { el } = need(doc, op.element, 'element')
      if (el.variants.length >= MAX_VARIANTS) throw new Error(`每个元素最多留 ${MAX_VARIANTS} 张候选，先删掉一张`)
      el.variants.push({ id: nextId(doc, 'v'), source: 'ai', hash: null, file: null })
      el.pick = el.variants.length - 1
      return
    }
    case 'pickVariant': {
      const { el } = need(doc, op.element, 'element')
      const k = el.variants.findIndex((v) => v.id === op.variant)
      if (k < 0) throw new Error('找不到这张候选')
      el.pick = k
      el.variants[k].locked = true
      return
    }
    case 'removeVariant': {
      const { el } = need(doc, op.element, 'element')
      if (el.variants.length <= 1) throw new Error('至少留一张候选')
      const k = el.variants.findIndex((v) => v.id === op.variant)
      if (k < 0) throw new Error('找不到这张候选')
      el.variants.splice(k, 1)
      if (el.pick >= k) el.pick = Math.max(0, el.pick - 1)
      return
    }
    case 'uploadVariant': {
      const { el } = need(doc, op.element, 'element')
      const file = String(op.file ?? '')
      if (!/^p_[a-z0-9_]+\.(png|jpe?g|webp)$/.test(file) || !limits.files?.exists(file)) throw new Error('上传的图片不存在')
      if (el.variants.length >= MAX_VARIANTS) el.variants.splice(el.variants.findIndex((v, i) => i !== el.pick), 1)
      el.variants.push({ id: nextId(doc, 'v'), source: 'upload', hash: null, file, locked: true })
      el.pick = el.variants.length - 1
      return
    }
    case 'addBoard': {
      const { seg } = need(doc, op.segment, 'segment')
      const start = Math.max(0, Math.round(Number(op.start) || 0))
      const board = { id: nextId(doc, 'b'), start, elements: [], render: null }
      const e = op.element ?? { label: '新元素', draw: '' }
      if (!text(e.draw, DRAW_MAX)) throw new Error('新镜头至少要有一个带画面描述的元素')
      board.elements.push(newElement(doc, { role: 'hero', ...e, draw: text(e.draw, DRAW_MAX), at: start }, 1))
      seg.boards.push(board)
      seg.boards.sort((a, b) => a.start - b.start)
      touchPlan(seg)
      return
    }
    case 'removeBoard': {
      const { seg, bi } = need(doc, op.board, 'board')
      if (seg.boards.length <= 1) throw new Error('每段至少留一个镜头；不想要这段画面可以删掉整段')
      seg.boards.splice(bi, 1)
      touchPlan(seg)
      return
    }
    default:
      throw new Error(`不支持的编辑操作 "${type}"`)
  }
}

/** 全文 = 各段按顺序拼接（编辑段落后保持一致） */
function syncScript(doc) {
  doc.script = doc.segments.map((s) => s.text).join('\n\n')
}

// ── 给前端的视图 ───────────────────────────────────────────────────

const urlOf = (name) => (name ? `/ai-generated/${name}` : null)

/** 文件名换成 /ai-generated/ URL；顺带标出每个节点当前是否需要重做（dirty 由运行器的哈希函数给出） */
export function publicProduction(doc, dirty) {
  const d = dirty ?? { voice: () => false, plan: () => false, subtitles: () => false, asset: () => false, render: () => false }
  return {
    ...doc,
    plate: doc.plate ? { ...doc.plate, url: urlOf(doc.plate.file) } : null,
    hand: doc.hand ? { ...doc.hand, url: urlOf(doc.hand.file) } : null,
    segments: doc.segments.map((seg) => ({
      ...seg,
      dirty: { voice: d.voice(seg), plan: d.plan(seg), subtitles: d.subtitles(seg) },
      voice: seg.voice ? { ...seg.voice, audioUrl: urlOf(seg.voice.audio), timingUrl: urlOf(seg.voice.timing) } : null,
      boards: seg.boards.map((b) => ({
        ...b,
        dirty: d.render(seg, b),
        render: b.render ? {
          ...b.render,
          result: b.render.result ? {
            ...b.render.result,
            elements: b.render.result.elements.map((e) => ({ ...e, video: urlOf(e.video), hold: urlOf(e.hold) })),
          } : null,
        } : null,
        elements: b.elements.map((e) => ({
          ...e,
          dirty: d.asset(e),
          variants: e.variants.map((v) => ({ ...v, url: urlOf(v.file) })),
        })),
      })),
    })),
  }
}

export function isNodeId(id) {
  return NODE_ID_RE.test(String(id ?? ''))
}

export function fileExists(dir, name) {
  try { return !!name && existsSync(path.join(dir, name)) && statSync(path.join(dir, name)).isFile() } catch { return false }
}
