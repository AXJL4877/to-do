/**
 * 口播稿正文 → 配音任务。只朗读 readSpokenBody 得到的正文，
 * 不带发布标题、封面和材料编号。入轨位置由调用方在点击时写入。
 */
import { readSpokenBody, type ScriptMemoMeta } from './scriptMemoDocument'
import type { VoiceChoice } from './ttsVoicePrefs'

export const TTS_PROMPT_MAX = 5000
export const CLONE_ID_RE = /^S_[A-Za-z0-9_-]{2,60}$/

export type SpokenTts =
  | { ok: true; prompt: string; params: { voice: VoiceChoice['voice']; cloneId: string } }
  | { ok: false; error: string }

/** 与 server/skillPacks.mjs cleanScript 一致：保留换行，其余空白压成一个空格。 */
export function cleanSpokenPrompt(value: string) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function prepareSpokenTts(script: string, memo: ScriptMemoMeta | null, voice: VoiceChoice): SpokenTts {
  const prompt = cleanSpokenPrompt(readSpokenBody(script, memo))
  if (!prompt || !/[\p{L}\p{N}]/u.test(prompt)) return { ok: false, error: '正文里还没有可朗读的文字' }
  if (prompt.length > TTS_PROMPT_MAX) return { ok: false, error: `正文最多 ${TTS_PROMPT_MAX} 字` }
  const cloneId = voice.cloneId.trim().slice(0, 64)
  if (voice.voice === 'clone' && !CLONE_ID_RE.test(cloneId)) return { ok: false, error: '克隆音 ID 须为 S_ 开头' }
  return { ok: true, prompt, params: { voice: voice.voice, cloneId } }
}
