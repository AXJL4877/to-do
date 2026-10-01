/**
 * 成片（todo-production/1，见 server/production/PROTOCOL.md）：长口播 → 口播段 → 镜头 → 元素（多张候选图）。
 * 文档在服务端，前端只读视图、发编辑操作和运行请求；每个节点是否「待生成」由服务端按输入指纹算好。
 */
import { aiFetch } from './aiFetch'
import type { SkillParams, SubtitleCue, TimelinePlacement } from './aiSkills'
import type { TextStyle } from '../types'

export type ProductionRole = 'hero' | 'support' | 'accent'

export type ProductionVariant = {
  id: string
  source: 'ai' | 'upload'
  hash: string | null
  file: string | null
  url: string | null
  locked?: boolean
  error?: string
}

export type ProductionElement = {
  id: string
  label: string
  draw: string
  role: ProductionRole
  weight: number
  /** 起笔短语编号（本段配音的短语表） */
  at: number
  pick: number
  variants: ProductionVariant[]
  dirty: boolean
}

export type RenderedElement = {
  id: string
  label: string
  role: string
  box: number[]
  crop?: number[]
  startMs: number
  durationMs: number
  frames: number
  video: string
  hold: string
  tip?: number[][]
}

export type ProductionBoard = {
  id: string
  textTiming?: { startMs: number; endMs: number }
  /** 换板短语编号 */
  start: number
  elements: ProductionElement[]
  render: { hash: string; result: { fps: number; width: number; height: number; startMs: number; endMs: number; layout: string; elements: RenderedElement[]; dynamicText?: Partial<TextStyle> } | null } | null
  dirty: boolean
}

export type ProductionPhrase = { text: string; start: number; end: number; sentence: number }

export type ProductionSegment = {
  id: string
  title: string
  text: string
  voice: { hash: string; audio: string; audioUrl: string; timing: string; duration: number; speaker: string | null; phrases: ProductionPhrase[] } | null
  plan: { hash: string; voiceHash: string; source: 'ai' | 'user' | 'fallback'; notes: string } | null
  subtitles: { hash: string; params: SkillParams; cues: (SubtitleCue & { keywords?: string[] })[] } | null
  boards: ProductionBoard[]
  dirty: { voice: boolean; plan: boolean; subtitles: boolean }
}

export type ProductionFailure = { layer: string; id: string; label: string; error: string }

export type ProductionStatus = {
  running: boolean
  phase: string
  pct: number
  failed: ProductionFailure[]
  error: string | null
  stopAfter?: 'plan' | null
}

export type Production = {
  id: string
  skillId: string
  title: string
  script: string
  params: SkillParams
  cast: { name: string; look: string }[]
  outline: { source: string; notes: string } | null
  rev: number
  updatedAt: number
  status: ProductionStatus | null
  lock: { jobId: string | null; since: number } | null
  plate: { hash: string; file: string; url: string; width: number; height: number } | null
  hand: { file: string; url: string; width: number; height: number; tipX: number; tipY: number } | null
  segments: ProductionSegment[]
  queuedJobId: string | null
  runningJobId: string | null
}

export type ProductionSummary = Pick<Production, 'id' | 'skillId' | 'title' | 'updatedAt' | 'rev' | 'lock' | 'status' | 'queuedJobId' | 'runningJobId'> & {
  segments: number
  boards: number
  elements: number
  duration: number
}

export type ProductionScope = { segments?: string[]; boards?: string[]; elements?: string[] }

export type ProductionOp =
  | { op: 'setTitle'; title: string }
  | { op: 'setParams'; params: SkillParams }
  | { op: 'setSegmentText'; segment: string; text: string }
  | { op: 'splitSegment'; segment: string; at: number }
  | { op: 'mergeSegment'; segment: string }
  | { op: 'removeSegment'; segment: string }
  | { op: 'replanSegment'; segment: string }
  | { op: 'setElement'; element: string; patch: Partial<Pick<ProductionElement, 'label' | 'draw' | 'role' | 'weight' | 'at'>> }
  | { op: 'addElement'; board: string; element: { label: string; draw: string; role?: ProductionRole; at?: number } }
  | { op: 'removeElement'; element: string }
  | { op: 'moveElement'; element: string; delta: -1 | 1 }
  | { op: 'addVariant'; element: string }
  | { op: 'pickVariant'; element: string; variant: string }
  | { op: 'removeVariant'; element: string; variant: string }
  | { op: 'addBoard'; segment: string; start: number; element: { label: string; draw: string } }
  | { op: 'removeBoard'; board: string }

export const isProductionRunning = (p: Pick<Production, 'status' | 'runningJobId' | 'queuedJobId'>) =>
  !!p.runningJobId || !!p.queuedJobId

async function call<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {}
  const r = await aiFetch(url, json === undefined ? rest : {
    ...rest,
    method: rest.method ?? 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(json),
  })
  const data = await r.json().catch(() => ({ ok: false, error: `请求失败 (${r.status})` }))
  if (!data.ok) throw new Error(data.error || `请求失败 (${r.status})`)
  return data as T
}

export async function listProductions(ids: string[]): Promise<ProductionSummary[]> {
  if (!ids.length) return []
  const data = await call<{ items: ProductionSummary[] }>(`/api/ai-productions?ids=${ids.map(encodeURIComponent).join(',')}`)
  return data.items
}

export async function getProduction(id: string): Promise<Production> {
  return (await call<{ production: Production }>(`/api/ai-productions/${encodeURIComponent(id)}`)).production
}

export async function createProduction(body: {
  skillId: string
  script: string
  params: SkillParams
  title?: string
  run?: boolean
  stopAfter?: 'plan'
  autoTimeline: boolean
  placement?: TimelinePlacement
  placeAt?: number
}) {
  return call<{ production: Production; job: { id: string } | null }>('/api/ai-productions', { json: body })
}

export async function editProduction(id: string, ops: ProductionOp[]): Promise<Production> {
  return (await call<{ production: Production }>(`/api/ai-productions/${encodeURIComponent(id)}/edit`, { json: { ops } })).production
}

export async function runProduction(id: string, body: { scope?: ProductionScope; stopAfter?: 'plan' } = {}) {
  return call<{ production: Production; job: { id: string } }>(`/api/ai-productions/${encodeURIComponent(id)}/run`, { json: body })
}

export async function cancelProduction(id: string) {
  return call<{ dequeued: boolean; stopping: boolean }>(`/api/ai-productions/${encodeURIComponent(id)}/cancel`, { json: {} })
}

export async function uploadProductionVariant(id: string, element: string, dataUrl: string): Promise<Production> {
  return (await call<{ production: Production }>(`/api/ai-productions/${encodeURIComponent(id)}/upload`, { json: { element, dataUrl } })).production
}

export async function deleteProduction(id: string) {
  return call<{ ok: boolean }>(`/api/ai-productions/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export const pickedVariant = (e: ProductionElement) => e.variants[e.pick] ?? e.variants[0] ?? null

/** 待生成的节点数（给按钮显示「生成改动（N）」） */
export function pendingCount(p: Production) {
  let n = 0
  for (const s of p.segments) {
    if (!s.voice || s.dirty.voice || s.dirty.plan) { n++; continue }
    if (s.dirty.subtitles) n++
    for (const b of s.boards) {
      if (b.dirty) n++
      for (const e of b.elements) if (e.dirty) n++
    }
  }
  return n
}

/** 镜头的时间范围（秒，相对本段配音）：从换板短语开口到下一块换板 */
export function boardSpan(seg: ProductionSegment, k: number) {
  const ph = seg.voice?.phrases ?? []
  const b = seg.boards[k]
  if (b.textTiming) return { start: b.textTiming.startMs / 1000, end: b.textTiming.endMs / 1000 }
  const next = seg.boards[k + 1]
  const start = k === 0 ? 0 : ph[b.start]?.start ?? 0
  const end = next ? ph[next.start]?.start ?? seg.voice?.duration ?? 0 : seg.voice?.duration ?? 0
  return { start, end }
}
