/**
 * 交互式口播备忘录 · ProjectState（PRD v1.1）
 * 与工程 script 字段并存：无 workspace 时保持纯文本编辑。
 */

export type ScriptMode = 'standard' | 'fast' | 'polish_only' | 'chain'
export type ChainStep = 'theme' | 'outline' | 'weave' | 'draft'
export type OutlineInsertKind = 'data' | 'story' | 'interaction'
export type ScriptStage = 'A' | 'B' | 'C' | 'D' | 'E' | 'F'

export type ScriptSubstep =
  | 'A.form'
  | 'B.topics'
  | 'C.questions'
  | 'C.materials'
  | 'D.hook'
  | 'D.logic'
  | 'D.outline'
  | 'E.expand'
  | 'E.polish'
  | 'E.fact'
  | 'F.package'

export type CardType =
  | 'single_select'
  | 'multi_select'
  | 'variants'
  | 'diff_review'
  | 'form'
  | 'rank'
  | 'free_input'

export const STAGE_LABELS: Record<ScriptStage, string> = {
  A: '立项',
  B: '选题',
  C: '素材',
  D: '结构',
  E: '成稿',
  F: '定稿',
}

export const STAGE_ORDER: ScriptStage[] = ['A', 'B', 'C', 'D', 'E', 'F']

export const SUBSTEP_LABELS: Record<ScriptSubstep, string> = {
  'A.form': '项目卡',
  'B.topics': '选题',
  'C.questions': '问题清单',
  'C.materials': '素材库',
  'D.hook': '钩子',
  'D.logic': '逻辑线',
  'D.outline': '大纲',
  'E.expand': '分段扩写',
  'E.polish': '整稿打磨',
  'E.fact': '事实复核',
  'F.package': '导出包装',
}

/** 语速与备忘录顶栏一致：4.5 字/秒 = 270 字/分。界面必须标明这是估算。 */
export const CHARS_PER_SEC = 4.5
export const CHARS_PER_MIN = 270

export const FIELD_LABELS: Record<string, string> = {
  platform: '平台',
  duration_sec: '时长（秒）',
  target_chars: '目标字数',
  audience: '受众',
  persona: '口吻',
  goal: '目标',
  taboo: '禁区',
  claim: '主张',
  title: '标题',
  cover: '封面文字',
  description: '简介',
  hashtags: '标签',
}

export interface ProjectCard {
  platform: string
  duration_sec: number
  target_chars: number
  audience: string
  persona: string
  goal: string
  taboo: string[]
}

export interface Topic {
  title: string
  core_claim: string
  angle: string
  scores?: Record<string, number>
  risk?: string
}

/** 有来源 / 待核验 / 已人工核验 / 创作类比。模型自称 verified 不能写成已人工核验。 */
export type MaterialProvenance = 'sourced' | 'pending' | 'human_verified' | 'analogy'

export interface MaterialItem {
  id: string
  type: 'data' | 'case' | 'analogy' | 'authority' | 'other'
  content: string
  source: string
  date?: string
  credibility: 'high' | 'mid' | 'low'
  /** 仅表示人工核验通过。 */
  verified: boolean
  provenance?: MaterialProvenance
  used_in?: string[]
}

export interface LogicNail {
  question_id: string
  material_ids: string[]
  note: string
}

export interface LogicLine {
  claim: string
  next_questions: { id: string; text: string }[]
  nails: LogicNail[]
}

export interface OutlineInsert {
  id: string
  kind: OutlineInsertKind
  text: string
}

export interface OutlineSeg {
  id: string
  role: string
  key_point: string
  target_chars: number
  material_ids: string[]
  emotion?: string
  locked?: boolean
  /** 挂在这一段大纲上的数据、故事、互动。不单独进正文标题。 */
  inserts?: OutlineInsert[]
}

export const CHAIN_STEPS: { id: ChainStep; label: string; hint: string }[] = [
  { id: 'theme', label: '大主题', hint: '先定赛道和这一期讲什么' },
  { id: 'outline', label: '大纲', hint: '按主题拆成要讲的几段' },
  { id: 'weave', label: '穿插', hint: '每段再补数据、故事、互动' },
  { id: 'draft', label: '正文', hint: '按大纲和穿插写成口播' },
]

export const THEME_TRACKS = ['财经赛道', '职场赛道', '情感赛道', '知识赛道', '生活赛道', '测评赛道']

export const INSERT_KINDS: { id: OutlineInsertKind; label: string; hint: string }[] = [
  { id: 'data', label: '数据例子', hint: '一个数字、对比或具体例子' },
  { id: 'story', label: '故事', hint: '一个具体的人或场景' },
  { id: 'interaction', label: '互动', hint: '一句让观众接话或点头的话' },
]

export interface DraftVersion {
  v: number
  stage: string
  text: string
  self_check?: Record<string, boolean>
  /** 失焦、保存、AI 应用或阶段确认后封存，下一次手改另起版本。 */
  sealed?: boolean
}

export interface DraftSeg {
  id: string
  versions: DraftVersion[]
  current: number
  locked?: boolean
}

export type FactAction = 'add_source' | 'soften' | 'delete' | 'human_verify'

export interface FactItem {
  id: string
  claim: string
  status: 'ok' | 'limit' | 'missing' | 'mismatch'
  material_id?: string
  location?: string
  /** 断言所在段落。 */
  paragraph_id?: string
  /** 断言写入时的正文版本，正文再改后要重新评估。 */
  body_revision?: number
  fix_options?: string[]
  resolved?: boolean
  resolution?: { action: FactAction; at_revision: number; source?: string }
}

export interface ScriptOption {
  id: string
  title?: string
  content?: string | unknown
  tags?: string[]
  reason?: string
  risk?: string
  scores?: Record<string, number>
  self_check?: Record<string, boolean>
  before?: string
  after?: string
  rule?: string
  accept_default?: boolean
  key?: string
  label?: string
  suggested?: unknown
  choices?: unknown[]
  why?: string
  status?: string
  material_id?: string
  fix_options?: string[]
  claim?: string
  location?: string
  source?: string
  date?: string
  credibility?: 'high' | 'mid' | 'low'
  verified?: boolean | string
  target_chars?: number
}

export interface ScriptCard {
  stage: string
  question_for_user: string
  card_type: CardType
  options: ScriptOption[]
  fields?: ScriptOption[]
  recommended_id?: string
  allow_custom?: boolean
  custom_hint?: string
  notes?: string
  summary?: Record<string, unknown>
  gaps?: string[]
  pace_options?: ScriptOption[]
  pace_summary?: Record<string, unknown>
  titles?: string[]
  cover_texts?: string[]
  description?: string
  hashtags?: string[]
  logic_line?: LogicLine
  target_chars?: number
}

export interface ScriptSnapshot {
  script: string
  project_card: ProjectCard | null
  topic: Topic | null
  material_bank: MaterialItem[]
  hook: { type: string; text: string } | null
  logic_line: LogicLine | null
  outline: OutlineSeg[]
  draft: DraftSeg[]
  fact_check: FactItem[]
  package: {
    titles: string[]
    cover_texts: string[]
    description: string
    hashtags: string[]
  } | null
  selected_ids: string[]
  stage: ScriptStage
  substep: ScriptSubstep
}

export interface HistoryNode {
  id: string
  parent_id: string | null
  stage: ScriptStage
  substep: ScriptSubstep
  action: string
  ts: number
  summary?: string
  chars?: number
  named?: boolean
  /** 较早的自动节点合并成一条，命名版本不会进这里。 */
  archived?: boolean
  snapshot?: ScriptSnapshot
}

export type StageVisual = 'idle' | 'active' | 'confirmed' | 'stale' | 'failed'

export interface ScriptWorkspace {
  schema_version: 1
  active: boolean
  mode: ScriptMode
  stage: ScriptStage
  substep: ScriptSubstep
  expand_index: number
  user_brief: string
  /** 财经、职场这类赛道。链式写作的第一步，大纲和穿插都挂在它下面。 */
  track: string
  chain_step: ChainStep
  project_card: ProjectCard | null
  topic: Topic | null
  questions: { id: string; text: string; priority: 'must' | 'nice'; keywords?: string }[]
  material_bank: MaterialItem[]
  hook: { type: string; text: string } | null
  logic_line: LogicLine | null
  outline: OutlineSeg[]
  draft: DraftSeg[]
  fact_check: FactItem[]
  package: {
    titles: string[]
    cover_texts: string[]
    description: string
    hashtags: string[]
  } | null
  current_card: ScriptCard | null
  selected_ids: string[]
  custom_text: string
  history: HistoryNode[]
  intensity: 'light' | 'medium' | 'heavy'
  /** 与工程 script 同步的正文镜像，供阶段快照使用。权威正文仍以工程 script 为准。 */
  body: string
  chars_per_sec: number
  stale_settings: boolean
  stale_from: ScriptStage | null
  analogy_only: boolean
  failed_stage: ScriptStage | null
  /** 递增的正文版本，任务提交时钉住当时的值。 */
  revision: number
}

export function targetChars(durationSec: number) {
  return Math.round((Math.max(15, durationSec) / 60) * CHARS_PER_MIN)
}

export function emptyWorkspace(partial?: Partial<ScriptWorkspace>): ScriptWorkspace {
  return {
    schema_version: 1,
    active: false,
    mode: 'standard',
    stage: 'A',
    substep: 'A.form',
    expand_index: 0,
    user_brief: '',
    track: '',
    chain_step: 'theme',
    project_card: null,
    topic: null,
    questions: [],
    material_bank: [],
    hook: null,
    logic_line: null,
    outline: [],
    draft: [],
    fact_check: [],
    package: null,
    current_card: null,
    selected_ids: [],
    custom_text: '',
    history: [],
    intensity: 'medium',
    body: '',
    chars_per_sec: CHARS_PER_SEC,
    stale_settings: false,
    stale_from: null,
    analogy_only: false,
    failed_stage: null,
    revision: 0,
    ...partial,
  }
}

export function parseWorkspace(raw: unknown): ScriptWorkspace | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.schema_version !== 1) return null
  const base = emptyWorkspace()
  return {
    ...base,
    ...o,
    schema_version: 1,
    active: !!o.active,
    mode: (['standard', 'fast', 'polish_only', 'chain'].includes(String(o.mode)) ? o.mode : 'standard') as ScriptMode,
    stage: (STAGE_ORDER.includes(o.stage as ScriptStage) ? o.stage : 'A') as ScriptStage,
    substep: (typeof o.substep === 'string' ? o.substep : 'A.form') as ScriptSubstep,
    expand_index: Math.max(0, Number(o.expand_index) || 0),
    user_brief: String(o.user_brief || ''),
    track: String(o.track || ''),
    chain_step: (['theme', 'outline', 'weave', 'draft'].includes(String(o.chain_step)) ? o.chain_step : 'theme') as ChainStep,
    project_card: (o.project_card as ProjectCard) || null,
    topic: (o.topic as Topic) || null,
    questions: Array.isArray(o.questions) ? o.questions as ScriptWorkspace['questions'] : [],
    material_bank: Array.isArray(o.material_bank) ? o.material_bank as MaterialItem[] : [],
    hook: (o.hook as ScriptWorkspace['hook']) || null,
    logic_line: (o.logic_line as LogicLine) || null,
    outline: Array.isArray(o.outline) ? o.outline as OutlineSeg[] : [],
    draft: Array.isArray(o.draft) ? o.draft as DraftSeg[] : [],
    fact_check: Array.isArray(o.fact_check) ? o.fact_check as FactItem[] : [],
    package: (o.package as ScriptWorkspace['package']) || null,
    current_card: (o.current_card as ScriptCard) || null,
    selected_ids: Array.isArray(o.selected_ids) ? o.selected_ids.map(String) : [],
    custom_text: String(o.custom_text || ''),
    history: Array.isArray(o.history) ? o.history as HistoryNode[] : [],
    intensity: (['light', 'medium', 'heavy'].includes(String(o.intensity)) ? o.intensity : 'medium') as ScriptWorkspace['intensity'],
    body: typeof o.body === 'string' ? o.body : '',
    chars_per_sec: clampCharsPerSec(o.chars_per_sec),
    stale_settings: !!o.stale_settings,
    stale_from: STAGE_ORDER.includes(o.stale_from as ScriptStage) ? o.stale_from as ScriptStage : null,
    analogy_only: !!o.analogy_only,
    failed_stage: STAGE_ORDER.includes(o.failed_stage as ScriptStage) ? o.failed_stage as ScriptStage : null,
    revision: Math.max(0, Number(o.revision) || 0),
  }
}

export function clampCharsPerSec(value: unknown) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return CHARS_PER_SEC
  return Math.min(8, Math.max(2, n))
}

export function startWorkspace(mode: ScriptMode, brief: string, existingScript?: string): ScriptWorkspace {
  if (mode === 'polish_only') {
    const text = String(existingScript || '').trim()
    return emptyWorkspace({
      active: true,
      mode,
      stage: 'E',
      substep: 'E.polish',
      user_brief: brief || '打磨现有口播稿',
      project_card: {
        platform: '抖音',
        duration_sec: Math.max(60, Math.round(countSpeakChars(text) / CHARS_PER_SEC)),
        target_chars: Math.max(120, countSpeakChars(text)),
        audience: '短视频观众',
        persona: '靠谱朋友',
        goal: '讲清楚',
        taboo: [],
      },
      body: text,
      draft: text
        ? [{ id: 'p1', versions: [{ v: 1, stage: 'filled', text }], current: 1 }]
        : [],
    })
  }
  if (mode === 'chain') {
    return emptyWorkspace({
      active: true,
      mode,
      stage: 'A',
      substep: 'A.form',
      chain_step: 'theme',
      user_brief: brief.trim(),
    })
  }
  return emptyWorkspace({
    active: true,
    mode,
    stage: 'A',
    substep: 'A.form',
    user_brief: brief.trim(),
  })
}

export function countSpeakChars(text: string) {
  return text.replace(/[\s\p{P}\p{S}]/gu, '').length
}

export function draftFullText(ws: ScriptWorkspace): string {
  if (!ws.draft.length) return ''
  return ws.outline.length
    ? ws.outline.map((seg) => {
      const d = ws.draft.find((x) => x.id === seg.id)
      const ver = d?.versions.find((v) => v.v === d.current) || d?.versions[d.versions.length - 1]
      return ver?.text || ''
    }).filter(Boolean).join('\n\n')
    : ws.draft.map((d) => {
      const ver = d.versions.find((v) => v.v === d.current) || d.versions[d.versions.length - 1]
      return ver?.text || ''
    }).filter(Boolean).join('\n\n')
}

export function canEnterChainStep(ws: Pick<ScriptWorkspace, 'track' | 'user_brief' | 'outline'>, step: ChainStep): boolean {
  if (step === 'theme') return true
  if (!ws.track.trim() || !ws.user_brief.trim()) return false
  if (step === 'outline') return true
  return ws.outline.some((seg) => seg.key_point.trim() || (seg.inserts || []).some((ins) => ins.text.trim()))
}

const CHAIN_ROLES = ['开场', '展开', '转折', '收束']

export function ensureChainOutline(outline: OutlineSeg[]): OutlineSeg[] {
  if (outline.length) return outline
  return [0, 1, 2].map((index) => ({
    id: `c${index + 1}`,
    role: CHAIN_ROLES[index],
    key_point: '',
    target_chars: 80,
    material_ids: [],
    inserts: [],
  }))
}

/** 大纲句在前，数据、故事、互动按这个顺序接在同一段后面。标签留在面板里，不写进正文。 */
export function composeChainBody(outline: OutlineSeg[]): string {
  const order: OutlineInsertKind[] = ['data', 'story', 'interaction']
  return outline.map((seg) => {
    const parts = [String(seg.key_point || '').trim()]
    for (const kind of order) {
      for (const ins of seg.inserts || []) {
        if (ins.kind === kind && ins.text.trim()) parts.push(ins.text.trim())
      }
    }
    return parts.filter(Boolean).join('\n\n')
  }).filter(Boolean).join('\n\n')
}

export function stripMaterialMarks(text: string) {
  return text.replace(/\s*\[[mM][\w-]+\]/g, '')
}

export function nextSubstepAfterConfirm(ws: ScriptWorkspace): { stage: ScriptStage; substep: ScriptSubstep; expand_index?: number } {
  const { stage, substep, mode } = ws
  if (substep === 'A.form') return { stage: 'B', substep: 'B.topics' }
  if (substep === 'B.topics') {
    if (mode === 'fast') return { stage: 'C', substep: 'C.materials' }
    return { stage: 'C', substep: 'C.questions' }
  }
  if (substep === 'C.questions') return { stage: 'C', substep: 'C.materials' }
  if (substep === 'C.materials') return { stage: 'D', substep: 'D.hook' }
  if (substep === 'D.hook') return { stage: 'D', substep: 'D.logic' }
  if (substep === 'D.logic') return { stage: 'D', substep: 'D.outline' }
  if (substep === 'D.outline') return { stage: 'E', substep: 'E.expand', expand_index: 0 }
  if (substep === 'E.expand') {
    const next = ws.expand_index + 1
    if (next < ws.outline.length) return { stage: 'E', substep: 'E.expand', expand_index: next }
    return { stage: 'E', substep: 'E.polish' }
  }
  if (substep === 'E.polish') return { stage: 'E', substep: 'E.fact' }
  if (substep === 'E.fact') return { stage: 'F', substep: 'F.package' }
  return { stage: 'F', substep: 'F.package' }
}

export function takeSnapshot(ws: ScriptWorkspace, script = ws.body): ScriptSnapshot {
  return {
    script,
    project_card: ws.project_card,
    topic: ws.topic,
    material_bank: ws.material_bank,
    hook: ws.hook,
    logic_line: ws.logic_line,
    outline: ws.outline,
    draft: ws.draft,
    fact_check: ws.fact_check,
    package: ws.package,
    selected_ids: ws.selected_ids,
    stage: ws.stage,
    substep: ws.substep,
  }
}

/** 最近 50 个自动节点；更早的自动节点合并成一条归档。命名版本全部保留。 */
export function retainHistory(nodes: HistoryNode[]): HistoryNode[] {
  const named = nodes.filter((n) => n.named)
  const autos = nodes.filter((n) => !n.named)
  if (autos.length <= 50) return nodes
  const kept = autos.slice(-(50 - 1))
  const dropped = autos.slice(0, autos.length - kept.length)
  const first = dropped[0]
  const archive: HistoryNode = {
    ...first,
    id: `arch_${first.id}`,
    action: `归档 ${dropped.length} 个自动节点`,
    summary: `已合并 ${dropped.length} 个较早的自动记录`,
    chars: first.chars,
    archived: true,
    named: false,
    snapshot: first.snapshot,
    ts: first.ts,
  }
  return [...named, archive, ...kept].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id))
}

export function pushHistory(ws: ScriptWorkspace, action: string, script = ws.body): ScriptWorkspace {
  const node: HistoryNode = {
    id: `h_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    parent_id: ws.history[ws.history.length - 1]?.id ?? null,
    stage: ws.stage,
    substep: ws.substep,
    action,
    ts: Date.now(),
    summary: action,
    chars: countSpeakChars(script),
    snapshot: takeSnapshot(ws, script),
  }
  return { ...ws, history: retainHistory([...ws.history, node]) }
}

export function stageVisual(ws: ScriptWorkspace): Record<ScriptStage, StageVisual> {
  const cur = STAGE_ORDER.indexOf(ws.stage)
  const staleAt = ws.stale_from ? STAGE_ORDER.indexOf(ws.stale_from) : -1
  const out = {} as Record<ScriptStage, StageVisual>
  for (const st of STAGE_ORDER) {
    const idx = STAGE_ORDER.indexOf(st)
    const confirmed = ws.history.some((h) => h.snapshot?.stage === st && !h.archived && h.action.startsWith('confirm:'))
      || ws.history.some((h) => h.stage === st && h.action.startsWith('confirm:') && !h.archived)
    if (ws.failed_stage === st) out[st] = 'failed'
    else if (staleAt >= 0 && idx > staleAt && (confirmed || idx < cur)) out[st] = 'stale'
    else if (idx === cur) out[st] = 'active'
    else if (confirmed || (idx < cur && ws.mode !== 'polish_only')) out[st] = 'confirmed'
    else out[st] = 'idle'
  }
  return out
}

const STAGE_VISUAL_LABEL: Record<StageVisual, string> = {
  idle: '未开始',
  active: '进行中',
  confirmed: '已确认',
  stale: '需重新确认',
  failed: '失败',
}

export function stageVisualLabel(status: StageVisual) {
  return STAGE_VISUAL_LABEL[status]
}

export function materialProvenance(m: MaterialItem): MaterialProvenance {
  if (m.provenance) return m.provenance
  if (m.type === 'analogy') return 'analogy'
  if (m.verified) return 'human_verified'
  if (m.source.trim()) return 'sourced'
  return 'pending'
}

export function materialHasSource(m: MaterialItem) {
  const p = materialProvenance(m)
  return p === 'sourced' || p === 'human_verified'
}

export function materialGateOk(ws: ScriptWorkspace): { ok: boolean; reason?: string } {
  if (ws.analogy_only) return { ok: true, reason: '已声明仅创作类比，类比不会被当成已核验事实' }
  const sourced = ws.material_bank.filter((m) => materialHasSource(m) && m.type !== 'analogy')
  if (ws.mode === 'polish_only') return { ok: true }
  if (sourced.length < 1 && ws.mode === 'fast') {
    return { ok: false, reason: '快速模式也需要至少 1 条带来源的材料，或明确声明仅创作类比。缺：来源。' }
  }
  if (sourced.length < 1) {
    return { ok: false, reason: '还缺带来源的数据或案例。无来源内容不会自动标成已核验。可以补来源，或声明仅创作类比。' }
  }
  return { ok: true }
}

export function unresolvedFacts(ws: ScriptWorkspace) {
  return ws.fact_check.filter((f) => {
    if (f.status !== 'missing' && f.status !== 'mismatch') return false
    if (!f.resolved || !f.resolution) return true
    return f.resolution.at_revision !== ws.revision
  })
}

function segmentText(d: DraftSeg): string {
  const ver = d.versions.find((v) => v.v === d.current) || d.versions[d.versions.length - 1]
  return ver?.text ?? ''
}

function visibleSegments(ws: ScriptWorkspace): DraftSeg[] {
  if (!ws.draft.length) return []
  const ordered = ws.outline.length
    ? ws.outline.flatMap((seg) => {
      const d = ws.draft.find((item) => item.id === seg.id)
      return d ? [d] : []
    })
    : ws.draft
  return ordered.filter((d) => segmentText(d).length > 0)
}

function writeManual(seg: DraftSeg, text: string): DraftSeg {
  const cur = seg.versions.find((v) => v.v === seg.current) || seg.versions[seg.versions.length - 1]
  if (cur && cur.stage === 'manual' && !cur.sealed && seg.current === cur.v) {
    return {
      ...seg,
      versions: seg.versions.map((v) => (v.v === cur.v ? { ...v, text } : v)),
    }
  }
  const v = Math.max(0, ...seg.versions.map((x) => x.v), 0) + 1
  return { ...seg, current: v, versions: [...seg.versions, { v, stage: 'manual', text }] }
}

/** 封存当前手改版本。下一次输入会新开版本，而不是继续改同一条。 */
export function sealManualDraft(ws: ScriptWorkspace): ScriptWorkspace {
  let changed = false
  const draft = ws.draft.map((seg) => {
    const cur = seg.versions.find((v) => v.v === seg.current)
    if (!cur || cur.stage !== 'manual' || cur.sealed) return seg
    changed = true
    return {
      ...seg,
      versions: seg.versions.map((v) => (v.v === cur.v ? { ...v, sealed: true } : v)),
    }
  })
  return changed ? { ...ws, draft } : ws
}

function planSegmentTexts(texts: string[], next: string): (string | null)[] {
  const n = texts.length
  const result: (string | null)[] = texts.map(() => null)
  let prefix = 0
  let pos = 0
  for (let i = 0; i < n; i++) {
    const sep = i === 0 ? '' : '\n\n'
    if (i > 0 && !next.startsWith('\n\n', pos)) break
    const start = pos + sep.length
    if (!next.startsWith(texts[i], start)) break
    const after = start + texts[i].length
    if (i === n - 1) {
      if (after !== next.length) break
      prefix++
      pos = after
      break
    }
    if (!next.startsWith('\n\n', after)) break
    prefix++
    pos = after
  }

  let suffix = 0
  let end = next.length
  for (let i = n - 1; i >= prefix; i--) {
    const chunk = texts[i]
    if (end < chunk.length || next.slice(end - chunk.length, end) !== chunk) break
    const before = end - chunk.length
    if (i > 0) {
      if (before < 2 || next.slice(before - 2, before) !== '\n\n') break
      end = before - 2
    } else {
      end = before
    }
    suffix++
  }
  if (prefix + suffix > n) suffix = n - prefix

  const middle = n - prefix - suffix
  const prefixStr = texts.slice(0, prefix).join('\n\n')
  const suffixStr = texts.slice(n - suffix).join('\n\n')
  let mid = next
  if (prefixStr) {
    if (!mid.startsWith(prefixStr)) return texts.map((_, i) => (i === 0 ? next : ''))
    mid = mid.slice(prefixStr.length)
    if ((suffix > 0 || middle > 0) && mid.startsWith('\n\n')) mid = mid.slice(2)
    else if (mid.length) return texts.map((_, i) => (i === 0 ? next : ''))
  }
  if (suffixStr) {
    if (prefix === 0 && middle === 0) {
      if (mid !== suffixStr) return texts.map((_, i) => (i === 0 ? next : ''))
      mid = ''
    } else if (mid.endsWith(`\n\n${suffixStr}`)) {
      mid = mid.slice(0, -(suffixStr.length + 2))
    } else {
      return texts.map((_, i) => (i === 0 ? next : ''))
    }
  }

  if (middle === 1) {
    result[prefix] = mid
    return result
  }
  if (middle === 0) {
    if (!mid) return result
    if (prefix > 0) {
      result[prefix - 1] = `${texts[prefix - 1]}\n\n${mid}`
      return result
    }
    if (suffix > 0) {
      result[0] = `${mid}\n\n${texts[0]}`
      return result
    }
    return texts.map((_, i) => (i === 0 ? next : ''))
  }
  result[prefix] = mid
  for (let i = 1; i < middle; i++) result[prefix + i] = ''
  return result
}

/**
 * 把用户看到的整段正文写回段落。未改动的段落保持对象身份；
 * 连续手改合并进当前 manual 版本；空字符串是明确清空，不回退旧稿。
 */
export function syncDraftBody(ws: ScriptWorkspace, nextText: string): ScriptWorkspace {
  const old = draftFullText(ws)
  if (nextText === old) return ws
  const visible = visibleSegments(ws)
  if (!visible.length) {
    if (!nextText) {
      if (!ws.draft.length) return { ...ws, body: '' }
      return {
        ...ws,
        body: '',
        draft: ws.draft.map((d) => (segmentText(d) ? writeManual(d, '') : d)),
      }
    }
    const id = ws.outline[0]?.id || 'p1'
    const existing = ws.draft.find((d) => d.id === id)
    const draft = existing
      ? ws.draft.map((d) => (d.id === id ? writeManual(d, nextText) : d))
      : [...ws.draft, { id, versions: [{ v: 1, stage: 'manual', text: nextText }], current: 1 }]
    return { ...ws, body: nextText, draft }
  }

  const texts = visible.map(segmentText)
  const planned = planSegmentTexts(texts, nextText)
  const replacement = new Map<string, string | null>()
  visible.forEach((seg, i) => replacement.set(seg.id, planned[i]))
  const draft = ws.draft.map((d) => {
    if (!replacement.has(d.id)) return d
    const text = replacement.get(d.id)
    if (text == null || text === segmentText(d)) return d
    return writeManual(d, text)
  })
  const updated = { ...ws, body: nextText, draft }
  if (draftFullText(updated) !== nextText) {
    const fallback = new Map<string, string>()
    visible.forEach((seg, i) => fallback.set(seg.id, i === 0 ? nextText : ''))
    return {
      ...ws,
      body: nextText,
      draft: ws.draft.map((d) => {
        if (!fallback.has(d.id)) return d
        const text = fallback.get(d.id) ?? ''
        if (text === segmentText(d)) return d
        return writeManual(d, text)
      }),
    }
  }
  return updated
}

export function restoreSnapshot(ws: ScriptWorkspace, node: HistoryNode): ScriptWorkspace | null {
  const snap = node.snapshot
  if (!snap) return null
  return {
    ...ws,
    body: snap.script,
    project_card: snap.project_card,
    topic: snap.topic,
    material_bank: snap.material_bank,
    hook: snap.hook,
    logic_line: snap.logic_line,
    outline: snap.outline,
    draft: snap.draft,
    fact_check: snap.fact_check,
    package: snap.package,
    selected_ids: snap.selected_ids,
    stage: snap.stage,
    substep: snap.substep,
    current_card: null,
  }
}
