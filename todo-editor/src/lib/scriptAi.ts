/**
 * 口播稿 AI 客户端：选词提问 / 改写 / 插入。
 */
import { aiFetch } from './aiFetch'

export type ScriptAiMode = 'ask' | 'rewrite' | 'insert' | 'explain'

export type ScriptAiResult = {
  mode: ScriptAiMode
  text: string
  reply: string
  model?: string
}

export async function requestScriptAi(input: {
  mode: ScriptAiMode
  fullText: string
  selection?: string
  instruction?: string
  cursorBefore?: string
  cursorAfter?: string
}): Promise<ScriptAiResult> {
  const res = await aiFetch('/api/ai-script', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const j = await res.json().catch(() => ({})) as {
    ok?: boolean
    error?: string
    mode?: ScriptAiMode
    text?: string
    reply?: string
    model?: string
  }
  if (!res.ok || j.ok === false) throw new Error(String(j.error || res.statusText || '口播 AI 失败'))
  return {
    mode: (j.mode || input.mode) as ScriptAiMode,
    text: String(j.text || ''),
    reply: String(j.reply || ''),
    model: j.model,
  }
}
