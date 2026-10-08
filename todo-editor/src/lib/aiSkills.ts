import { aiFetch, aiUrl } from './aiFetch'

/** 与 server/skillPacks.mjs 的 publicSkill 对齐（todo-skill-pack/1） */
export type SkillOption = { value: string; label: string; hint?: string }
type SkillParamBase = { id: string; group: SkillGroup; label: string; hint?: string; when?: Record<string, string[]> }
export type SkillParam =
  | (SkillParamBase & { type: 'select'; default: string; options: SkillOption[] })
  | (SkillParamBase & { type: 'number'; default: number; min: number; max: number; step: number; unit?: string })
  | (SkillParamBase & { type: 'text'; default: string; pattern: string; maxLength: number; placeholder?: string })
export type SkillGroup = 'story' | 'scene' | 'voice' | 'text' | 'timing' | 'stroke' | 'output'
export type SkillParams = Record<string, string | number>

export type SkillPack = {
  id: string
  name: string
  version: string
  author: string
  description: string
  tags: string[]
  previews: string[]
  input: { label: string; maxLength: number; placeholder?: string }
  output: { mime: string; codec: string; alphaWhen?: Record<string, string[]> }
  params: SkillParam[]
  /** 侧栏快捷露出的参数 id；null 时取前几个可见参数 */
  quick: string[] | null
  /**
   * elements = 规划 → 元素生图 → 渲染；tts = 文案配音；subtitle = 按一条配音的时间戳出字幕；
   * narrated = 口播 → 配音 → 分板对时书写（2.x 老任务）；production = 长口播成片，分层生成、可局部重做
   */
  pipeline: 'elements' | 'tts' | 'subtitle' | 'narrated' | 'production'
  planner: { maxElements: number; countParam: string | null } | null
}

export type SkillRole = 'hero' | 'support' | 'accent'
export type SkillElement = { label: string; draw: string; role: SkillRole; weight: number }
export type SkillPlan = { title: string; notes: string; elements: SkillElement[] }

export type SkillOutput = {
  spec: 'todo-skill-output/1'
  alpha: boolean
  width: number
  height: number
  duration: number
  video: string
  still: string
  layout?: string
  plan?: { title: string; notes: string; source: 'ai' | 'user' | 'fallback' }
  elements?: Array<{ id: string; label: string; role: SkillRole; startMs: number; durationMs: number; image: string }>
  /** subtitle 管线：字幕条目 + 对应的配音 */
  subtitles?: { url: string; ass: string; cues: SubtitleCue[] }
  source?: { jobId: string; audio: string; duration: number }
  /** 整段只出一条：透明画布，进度条画在顶部，其余透明 */
  chapterBar?: { video: string; width: number; height: number; barH: number; duration: number; placeAt: number }
  params?: SkillParams
}

export type SubtitleCue = { text: string; start: number; end: number }

/** tts 管线的产出：只有配音和时间戳 */
export type TtsOutput = {
  spec: 'todo-skill-output/1'
  jobId: string
  prompt: string
  duration: number
  audio: string
  narration: { text: string; duration: number; speaker: string | null; audio: string; timing: string }
}

/** 自动入轨从哪开始：提交时的播放头，或接在时间线末尾 */
export type TimelinePlacement = 'playhead' | 'end'

/** /api/ai-jobs 里 kind = 'skill' 的一行 */
export type SkillJob<O = SkillOutput> = {
  id: string
  kind: string
  status: 'queued' | 'running' | 'done' | 'error' | 'imported'
  prompt: string
  params: {
    duration?: number
    autoTimeline?: boolean
    placement?: TimelinePlacement | null
    placeAt?: number | null
    width?: number | null
    height?: number | null
    skill?: { id: string; name: string; summary: string; alpha: boolean; pipeline?: SkillPack['pipeline'] | 'voice' } | null
    request?: { plan: SkillPlan | null; params: SkillParams }
    output?: O | null
  }
  resultName?: string | null
  resultUrl?: string | null
  resultKind?: 'image' | 'video' | null
  duration?: number | null
  error?: string | null
  phase?: string | null
}

export const GROUP_LABELS: Record<SkillGroup, string> = { story: '分段与分镜', scene: '画面', voice: '音色', text: '字幕', timing: '节奏', stroke: '笔触', output: '输出' }

/** 中文口播约每秒 4.5 字，只用于预估 */
export const speechSeconds = (text: string) => text.replace(/[\p{P}\s]/gu, '').length / 4.5
export const ROLE_LABELS: Record<SkillRole, string> = { hero: '主视觉', support: '配景', accent: '标题字' }
export const CHALK_SKILL_ID = 'builtin.chalk-hand'
export const SUBTITLE_SKILL_ID = 'builtin.voice-subtitle'
export const TTS_SKILL_ID = 'builtin.tts-voice'

/** 与 server/skills/voice-subtitle/render.py 的 FONTS / font_px / margin_px 对齐 */
export const SUBTITLE_FONT: Record<string, string> = {
  smiley: 'Smiley Sans Oblique', yahei: 'Microsoft YaHei', heiti: 'SimHei', kaiti: 'KaiTi',
  xingkai: 'STXingkai', lishu: 'LiSu', hupo: 'STHupo',
}
const LEGACY_FONT_SCALE: Record<string, number> = { s: 0.04, m: 0.05, l: 0.062 }
const LEGACY_MARGIN_SCALE: Record<string, number> = { bottom: 0.06, raised: 0.16 }

/** 实际像素字号（画面短边 1080 换算） */
export function subtitleFontPx(params: SkillParams, width: number, height: number) {
  const scale = params.fontPx != null ? Number(params.fontPx) / 1080 : LEGACY_FONT_SCALE[String(params.fontSize)] ?? 0.05
  return Math.max(16, Math.round(Math.min(width, height) * scale))
}

/** 字幕底边离画面底部的像素 */
export function subtitleMarginPx(params: SkillParams, height: number) {
  const pct = params.bottomPct != null ? Number(params.bottomPct) / 100 : LEGACY_MARGIN_SCALE[String(params.position)] ?? 0.06
  return Math.round(height * pct)
}

/** 烧录参数 → 编辑器文字片段样式（字号按 1080 高换算，y 为画面中心起的归一化偏移） */
export function subtitleClipStyle(params: SkillParams, width: number, height: number) {
  const px = subtitleFontPx(params, width, height)
  const outline = Math.max(2, Math.round(px / 18))
  const margin = subtitleMarginPx(params, height)
  const k = 1080 / height
  return {
    text: {
      fontFamily: SUBTITLE_FONT[String(params.font)] ?? SUBTITLE_FONT.smiley,
      fontSize: Math.round(px * k),
      color: '#FFFFFF',
      strokeWidth: Math.round(outline * 2 * k * 10) / 10,
      strokeColor: '#000000',
      align: 'center' as const,
    },
    transform: { y: (height - margin - px * 0.6 - height / 2) / (height / 2) },
  }
}

export async function fetchSkills(): Promise<SkillPack[]> {
  const r = await aiFetch('/api/ai-skills')
  const data = await r.json()
  if (!data.ok) throw new Error(data.error || '技能包读取失败')
  return (data.skills as SkillPack[]).map((s) => ({ ...s, previews: s.previews.map((p) => aiUrl(p)) }))
}

export function defaultSkillParams(pack: SkillPack): SkillParams {
  return Object.fromEntries(pack.params.map((p) => [p.id, p.default]))
}

export function paramVisible(p: SkillParam, values: SkillParams) {
  return !p.when || Object.entries(p.when).every(([k, vals]) => vals.includes(String(values[k])))
}

export function skillHasAlpha(pack: SkillPack, values: SkillParams) {
  const w = pack.output.alphaWhen
  return !!w && Object.entries(w).every(([k, vals]) => vals.includes(String(values[k])))
}

export function optionLabel(pack: SkillPack, id: string, values: SkillParams) {
  const p = pack.params.find((x) => x.id === id)
  if (!p) return ''
  if (p.type === 'number') return `${values[id]}${p.unit ?? ''}`
  if (p.type === 'text') return String(values[id] ?? '')
  return p.options.find((o) => o.value === String(values[id]))?.label ?? String(values[id])
}

/** 书写时间轴预估：按权重分（服务端还会乘墨迹面积） */
export function estimateTimings(plan: SkillPlan, duration: number, hold: number) {
  const writeMs = Math.max(0, duration - hold) * 1000
  const total = plan.elements.reduce((s, e) => s + e.weight, 0) || 1
  let t = 0
  return plan.elements.map((e) => {
    const d = (writeMs * e.weight) / total
    const out = { startMs: t, durationMs: d }
    t += d
    return out
  })
}

export async function planSkill(skillId: string, prompt: string, params: SkillParams): Promise<SkillPlan> {
  const r = await aiFetch('/api/ai-skill-plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skillId, prompt, params }),
  })
  const data = await r.json()
  if (!data.ok) throw new Error(data.error || 'AI 规划失败')
  return data.plan as SkillPlan
}

/** 语音识别的素材：AI 生成的按 url 找文件，本机导入的用 path（仅桌面版有） */
export interface SubtitleSourceMedia { url: string; path?: string; name?: string }

export async function enqueueSkill(body: {
  skillId: string
  prompt: string
  params: SkillParams
  plan?: SkillPlan | null
  autoTimeline: boolean
  /** 自动入轨位置；playhead 时 placeAt 为提交那一刻的播放头（生成期间挪动播放头不影响） */
  placement?: TimelinePlacement
  placeAt?: number
  /** subtitle 管线：字幕对应的配音任务（没有时给素材文件，走语音识别），以及要对齐的时间线片段 */
  sourceJobId?: string
  sourceMedia?: SubtitleSourceMedia
  anchorClipId?: string
  /** 只挂在第一段任务上：整段进度条，时间相对 placeAt */
  chapters?: { titles: string[]; duration: number; ranges: [number, number][]; placeAt: number }
}) {
  const r = await aiFetch('/api/ai-jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'skill', ...body, plan: body.plan ?? undefined }),
  })
  const data = await r.json()
  if (!data.ok) throw new Error(data.error || '入队失败')
  return data.job as { id: string }
}

/** 从「书写渲染（62%）」这类阶段文本里取整体百分比 */
export function phasePercent(phase?: string | null): number | null {
  const m = /（(\d+)%）/.exec(phase || '')
  return m ? Number(m[1]) : null
}

export function phaseText(phase?: string | null) {
  return (phase || '').replace(/（\d+%）$/, '')
}
