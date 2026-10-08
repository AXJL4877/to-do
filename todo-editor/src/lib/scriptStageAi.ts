/**
 * 口播阶段 AI 客户端
 */
import { aiFetch } from './aiFetch'
import type { ScriptCard, ScriptWorkspace } from './scriptWorkspace'

export type ScriptStageAction = 'generate' | 'intent'

export type ScriptStageResult = {
  ok: boolean
  action: ScriptStageAction
  substep?: string
  card?: ScriptCard
  logic_line?: ScriptWorkspace['logic_line']
  target_chars?: number
  intent?: {
    intent: string
    target?: { type?: string; id?: string }
    params?: { direction?: string; constraint?: string; scope?: string }
    confidence?: number
    clarify_question?: string
    operations?: unknown[]
  }
  model?: string
}

export async function requestScriptStage(input: {
  action?: ScriptStageAction
  workspace: ScriptWorkspace
  substep?: string
  project_name?: string
  user_instruction?: string
  seed?: string
  search_results?: string
  full_draft?: string
  current_segment?: unknown
  segment_index?: number
  previous_text?: string
  intensity?: string
  current_card_summary?: string
  user_text?: string
}, signal?: AbortSignal): Promise<ScriptStageResult> {
  const res = await aiFetch('/api/ai-script-stage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(55000)]) : AbortSignal.timeout(55000),
  })
  const j = await res.json().catch(() => ({})) as ScriptStageResult & { error?: string }
  if (!res.ok || j.ok === false) throw new Error(String(j.error || res.statusText || '口播阶段 AI 失败'))
  return j
}
