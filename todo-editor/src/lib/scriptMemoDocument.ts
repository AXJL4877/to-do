/**
 * 口播正文访问层。工程里的 script 在迁移后只保存可朗读正文；
 * 项目、素材、大纲、发布标题、封面和标签留在阶段状态里。
 */
import {
  CHARS_PER_SEC,
  FIELD_LABELS,
  clampCharsPerSec,
  countSpeakChars,
  draftFullText,
  emptyWorkspace,
  stripMaterialMarks,
  type ScriptWorkspace,
} from './scriptWorkspace'

export { FIELD_LABELS }

export const MEMO_SCHEMA = 2
export const BODY_MARK = '--- 口播正文 ---'
export const PUBLISH_MARK = '--- 发布 ---'

export interface ScriptPublishMeta {
  titles: string[]
  cover_texts: string[]
  description: string
  hashtags: string[]
}

export interface ScriptMemoMeta {
  schema: 2
  /** 迁移前的原文。已迁移的稿再次打开不再拆分。 */
  legacy_raw?: string
  chars_per_sec: number
  revision: number
  stale_settings: boolean
  publish?: ScriptPublishMeta | null
}

export function emptyScriptMemo(partial?: Partial<ScriptMemoMeta>): ScriptMemoMeta {
  return {
    schema: MEMO_SCHEMA,
    chars_per_sec: CHARS_PER_SEC,
    revision: 0,
    stale_settings: false,
    publish: null,
    ...partial,
  }
}

export function parseScriptMemo(raw: unknown): ScriptMemoMeta | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.schema !== MEMO_SCHEMA) return null
  const publish = o.publish && typeof o.publish === 'object' ? o.publish as ScriptPublishMeta : null
  return emptyScriptMemo({
    legacy_raw: typeof o.legacy_raw === 'string' ? o.legacy_raw : undefined,
    chars_per_sec: clampCharsPerSec(o.chars_per_sec),
    revision: Math.max(0, Number(o.revision) || 0),
    stale_settings: !!o.stale_settings,
    publish: publish
      ? {
        titles: Array.isArray(publish.titles) ? publish.titles.map(String) : [],
        cover_texts: Array.isArray(publish.cover_texts) ? publish.cover_texts.map(String) : [],
        description: String(publish.description || ''),
        hashtags: Array.isArray(publish.hashtags) ? publish.hashtags.map(String) : [],
      }
      : null,
  })
}

function lineIndex(script: string, mark: string): number {
  const re = new RegExp(`^${mark.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm')
  const found = re.exec(script)
  return found ? found.index : -1
}

/** 只有整行精确标记才算旧稿结构。普通横线、相似标题都不会截断正文。 */
export function extractLegacyParts(script: string): { body: string; publishRaw: string } | null {
  const at = lineIndex(script, BODY_MARK)
  if (at < 0) return null
  const rest = script.slice(at + BODY_MARK.length).replace(/^\r?\n/, '')
  const pub = lineIndex(rest, PUBLISH_MARK)
  if (pub < 0) return { body: rest.trim(), publishRaw: '' }
  return {
    body: rest.slice(0, pub).trim(),
    publishRaw: rest.slice(pub + PUBLISH_MARK.length).replace(/^\r?\n/, '').trim(),
  }
}

export function parsePublishBlock(raw: string): ScriptPublishMeta | null {
  if (!raw.trim()) return null
  const titles: string[] = []
  const cover: string[] = []
  const tags: string[] = []
  let description = ''
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim()
    if (!text) continue
    const title = text.match(/^标题[:：]\s*(.+)$/)
    const coverLine = text.match(/^封面[:：]\s*(.+)$/)
    const desc = text.match(/^简介[:：]\s*(.+)$/)
    if (title) titles.push(...title[1].split(/\s*[|｜]\s*/).filter(Boolean))
    else if (coverLine) cover.push(...coverLine[1].split(/\s*[|｜]\s*/).filter(Boolean))
    else if (desc) description = desc[1]
    else if (/^#/.test(text) || /^标签[:：]/.test(text)) {
      tags.push(...text.replace(/^标签[:：]\s*/, '').split(/\s+/).filter(Boolean))
    }
  }
  if (!titles.length && !cover.length && !description && !tags.length) return null
  return { titles, cover_texts: cover, description, hashtags: tags }
}

/** 从旧备忘录取出正文。没有精确正文标记时返回空，调用方应把原稿当正文而不是空稿。 */
export function extractMemoBody(script: string): string {
  return extractLegacyParts(script)?.body ?? ''
}

/** 未迁移文本的朗读层：旧标记只取正文，普通稿整段保留，并去掉材料编号。 */
export function spokenScript(script: string, memo?: ScriptMemoMeta | null): string {
  if (memo?.schema === MEMO_SCHEMA) return stripMaterialMarks(script)
  const legacy = extractLegacyParts(script)
  return stripMaterialMarks(legacy ? legacy.body : script)
}

export function readSpokenBody(script: string, memo?: ScriptMemoMeta | null) {
  return spokenScript(script, memo)
}

export function estimateSpeech(text: string, charsPerSec = CHARS_PER_SEC) {
  const rate = clampCharsPerSec(charsPerSec)
  const chars = countSpeakChars(text)
  return {
    chars,
    seconds: chars / rate,
    charsPerSec: rate,
    estimated: true as const,
  }
}

export function migrateScriptDocument(
  script: string,
  memo: ScriptMemoMeta | null,
  workspace: ScriptWorkspace | null,
): { script: string; memo: ScriptMemoMeta; workspace: ScriptWorkspace | null } {
  if (memo?.schema === MEMO_SCHEMA) {
    return { script, memo: emptyScriptMemo(memo), workspace }
  }
  const legacy = extractLegacyParts(script)
  if (!legacy) {
    return {
      script,
      memo: emptyScriptMemo({ legacy_raw: script, revision: memo?.revision ?? 0 }),
      workspace,
    }
  }
  const publish = parsePublishBlock(legacy.publishRaw)
  let nextWs = workspace
  if (publish && nextWs && !nextWs.package) nextWs = { ...nextWs, package: publish }
  if (publish && !nextWs) {
    nextWs = emptyWorkspace({ active: false, package: publish, body: legacy.body })
  } else if (nextWs) {
    nextWs = { ...nextWs, body: legacy.body }
  }
  return {
    script: legacy.body,
    memo: emptyScriptMemo({ legacy_raw: script, publish, revision: 0, stale_settings: false }),
    workspace: nextWs,
  }
}

export function initialMemo(_brief: string, _projectName: string) {
  return ''
}

/** 正文权威是 draft 里的当前版本。没有段落时保留传入正文；有段落时即使是空字符串也不回退旧稿。 */
export function buildMemoFromWorkspace(ws: ScriptWorkspace, existingScript?: string): string {
  const hasDraft = ws.draft.some((seg) => seg.versions.length > 0)
  if (hasDraft) return stripMaterialMarks(draftFullText(ws))
  if (existingScript != null) return spokenScript(existingScript)
  return ''
}

export function buildCreativeBrief(ws: ScriptWorkspace | null, body: string, publish?: ScriptPublishMeta | null): string {
  const lines: string[] = ['# 创作简报', '']
  if (ws?.project_card) {
    const p = ws.project_card
    lines.push('【项目】')
    lines.push(`${p.platform} · ${p.duration_sec} 秒 · 目标 ${p.target_chars} 字`)
    lines.push(`受众：${p.audience}`)
    lines.push(`口吻：${p.persona} · 目标：${p.goal}`)
    if (p.taboo.length) lines.push(`禁区：${p.taboo.join('、')}`)
    lines.push('')
  }
  if (ws?.topic) {
    lines.push('【选题】')
    lines.push(ws.topic.title)
    if (ws.topic.core_claim) lines.push(ws.topic.core_claim)
    if (ws.topic.angle) lines.push(`角度：${ws.topic.angle}`)
    if (ws.topic.scores) lines.push('评分仅供参考，不是事实背书')
    lines.push('')
  }
  if (ws?.material_bank.length) {
    lines.push('【素材】')
    for (const m of ws.material_bank) {
      lines.push(`· ${m.content}${m.source ? `（来源：${m.source}）` : ''}`)
    }
    lines.push('')
  }
  if (ws?.logic_line?.claim) {
    lines.push('【主张】')
    lines.push(ws.logic_line.claim)
    lines.push('')
  }
  if (ws?.outline.length) {
    lines.push('【大纲】')
    ws.outline.forEach((seg, i) => lines.push(`${i + 1}. ${seg.role}：${seg.key_point}`))
    lines.push('')
  }
  lines.push('【正文】')
  lines.push(body)
  const pkg = ws?.package || publish || null
  if (pkg && (pkg.titles.length || pkg.cover_texts.length || pkg.description || pkg.hashtags.length)) {
    lines.push('')
    lines.push('【发布】')
    if (pkg.titles.length) lines.push(`标题：${pkg.titles.join(' ｜ ')}`)
    if (pkg.cover_texts.length) lines.push(`封面：${pkg.cover_texts.join(' ｜ ')}`)
    if (pkg.description) lines.push(`简介：${pkg.description}`)
    if (pkg.hashtags.length) lines.push(pkg.hashtags.join(' '))
  }
  return lines.join('\n').trimEnd() + '\n'
}

export interface RewriteHold {
  projectId: string
  revision: number
  start: number
  end: number
  selected: string
  fullText: string
}

export type RewritePlan =
  | { action: 'fresh'; start: number; end: number }
  | { action: 'shifted'; start: number; end: number }
  | { action: 'stale'; reason: string }

/** 返回时决定能否写回。对不上的建议留在面板里，不自动覆盖。 */
export function classifyRewrite(
  hold: RewriteHold,
  now: { projectId: string; revision: number; fullText: string },
): RewritePlan {
  if (now.projectId !== hold.projectId) return { action: 'stale', reason: '工程已切换，建议基于旧版本' }
  const sameText = now.fullText === hold.fullText
  const sameRev = now.revision === hold.revision
  if (sameText && sameRev) return { action: 'fresh', start: hold.start, end: hold.end }
  if (!hold.selected) {
    if (sameText) return { action: 'fresh', start: 0, end: now.fullText.length }
    return { action: 'stale', reason: '正文已变化，全文建议基于旧版本' }
  }
  const at = now.fullText.indexOf(hold.selected)
  if (at >= 0 && now.fullText.indexOf(hold.selected, at + 1) < 0) {
    return { action: 'shifted', start: at, end: at + hold.selected.length }
  }
  return { action: 'stale', reason: '无法确定原文范围，建议基于旧版本' }
}

export function rewriteFailureKind(error: unknown): 'cancel' | 'timeout' | 'network' | 'invalid' | 'error' {
  if (error && typeof error === 'object' && (error as { name?: string }).name === 'AbortError') return 'cancel'
  const message = error instanceof Error ? error.message : String(error || '')
  if (/timeout|超时|aborted/i.test(message) && /timeout|超时/i.test(message)) return 'timeout'
  if (/failed to fetch|network|网络|ECONN|load failed/i.test(message)) return 'network'
  if (/校验|invalid|未返回/i.test(message)) return 'invalid'
  return 'error'
}

export function rewriteFailureText(kind: ReturnType<typeof rewriteFailureKind>) {
  if (kind === 'cancel') return '已取消'
  if (kind === 'timeout') return '请求超时'
  if (kind === 'network') return '网络失败'
  if (kind === 'invalid') return '内容校验失败'
  return '系统错误'
}
