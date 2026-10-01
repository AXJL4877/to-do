/**
 * 口播稿 AI：选词提问 / 按指示改写 / 在光标处插入。
 * 默认模型 gemini-3.8-flash（与技能规划一致）。
 */
import { normalizeBaseUrl } from './huniuClient.mjs'
import { extractJson } from './fancyTextAi.mjs'

export const SCRIPT_AI_MODEL = process.env.TODO_AI_SCRIPT_MODEL || process.env.TODO_AI_SKILL_MODEL || 'gemini-3.8-flash'

const MODES = new Set(['ask', 'rewrite', 'insert', 'explain'])

function clean(s, max = 12000) {
  return String(s || '').replace(/\r\n/g, '\n').trim().slice(0, max)
}

function clip(s, max) {
  const t = String(s || '')
  if (t.length <= max) return t
  return `${t.slice(0, Math.floor(max / 2))}…${t.slice(-Math.floor(max / 2))}`
}

/**
 * @param {{ apiKey?: string, baseUrl?: string }} config
 * @param {{
 *   mode?: string
 *   fullText?: string
 *   selection?: string
 *   instruction?: string
 *   cursorBefore?: string
 *   cursorAfter?: string
 * }} body
 */
export async function assistScript(config, body = {}) {
  if (!config?.apiKey) throw new Error('请先配置 API Key（AI 设置）')
  let mode = MODES.has(body.mode) ? body.mode : 'rewrite'
  if (mode === 'explain') mode = 'ask'
  const fullText = clean(body.fullText, 12000)
  const selection = clean(body.selection, 4000)
  const isExplain = body.mode === 'explain'
  const instruction = clean(body.instruction, 800) || (
    isExplain ? '用一两句口语解释这个词/说法在本段口播里是什么意思，必要时补一句背景'
      : mode === 'ask' ? '解释这段在讲什么，并给出口播上可加强的点'
        : mode === 'insert' ? '根据上下文续写一小段自然口播'
          : '润色得更顺口、适合短视频口播，保留原意'
  )
  const before = clean(body.cursorBefore, 1500)
  const after = clean(body.cursorAfter, 1500)

  if (mode === 'rewrite' && !selection && !fullText) throw new Error('没有可改写的文案')
  if (mode === 'ask' && !selection && !fullText) throw new Error('请先选一段文字或写一些口播稿')
  if (mode === 'insert' && !instruction && !fullText) throw new Error('请写一句插入指示')

  const system = [
    '你是短视频口播文案助手。根据用户模式完成任务，只输出一个 JSON 对象，不要解释、不要 markdown。',
    '{',
    '  "text": "改写或插入后的正文（ask 模式可为空字符串）",',
    '  "reply": "对用户的简短中文回复（ask 必填；rewrite/insert 可给一句说明）"',
    '}',
    '要求：口语化、句式适合朗读；不要编造收益承诺；不要加「以下是改写」之类套话。',
    mode === 'rewrite' ? 'rewrite：text 必须是改写结果，只对应「选中片段」；若无选中则改写全文。不要把未选中的上下文抄进 text。' : '',
    mode === 'insert' ? 'insert：text 是要插入光标处的新段落（可多句），不要重复 before/after 已有句子。' : '',
    mode === 'ask' ? 'ask：针对选中内容回答 instruction；text 可为空；reply 回答问题。' : '',
  ].filter(Boolean).join('\n')

  const userParts = [
    `模式：${mode}`,
    `指示：${instruction}`,
    selection ? `选中片段：\n${selection}` : '（无选中，以全文为对象）',
    fullText ? `全文上下文（供理解，勿整段复述）：\n${clip(fullText, 3500)}` : '',
    mode === 'insert' ? `光标前：\n${before || '（开头）'}\n\n光标后：\n${after || '（结尾）'}` : '',
  ].filter(Boolean)

  const res = await fetch(`${normalizeBaseUrl(config.baseUrl)}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: SCRIPT_AI_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userParts.join('\n\n') },
      ],
      temperature: mode === 'ask' ? 0.4 : 0.55,
    }),
  })
  const raw = await res.text()
  let payload = {}
  try { payload = JSON.parse(raw) } catch { payload = { error: raw.slice(0, 300) } }
  if (!res.ok) {
    throw new Error(String(payload?.error?.message || payload?.error || `口播 AI 失败 (${res.status})`))
  }
  const content = payload?.choices?.[0]?.message?.content
  let parsed
  try {
    parsed = extractJson(content)
  } catch {
    // 模型偶尔直接吐纯文本
    parsed = mode === 'ask' ? { text: '', reply: clean(content, 2000) } : { text: clean(content, 8000), reply: '' }
  }
  const text = clean(parsed?.text, 8000)
  const reply = clean(parsed?.reply, 2000)
  if (mode === 'ask' && !reply) throw new Error('AI 没有返回回答')
  if (mode !== 'ask' && !text) throw new Error('AI 没有返回可用文案')
  return {
    mode,
    text,
    reply: reply || (mode === 'rewrite' ? '已改写选区' : mode === 'insert' ? '已生成插入文案' : ''),
    model: SCRIPT_AI_MODEL,
  }
}
