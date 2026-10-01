/**
 * 抖音发布元数据 + 封面生图提示词（虎妞 chat / image）。
 * 封面硬锁：大标题必须画进画面，禁止后期贴字。
 */
import { normalizeBaseUrl } from './huniuClient.mjs'
import { extractJson } from './fancyTextAi.mjs'

export const DOUYIN_CHAT_MODEL = process.env.TODO_AI_DOUYIN_MODEL || process.env.TODO_AI_CHAT_MODEL || 'gpt-6-astra'

function clean(s, max = 2000) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

export function sanitizeDouyinMeta(raw, fallbackTitle = '成片') {
  const r = raw && typeof raw === 'object' ? raw : {}
  let title = clean(r.title, 40) || clean(fallbackTitle, 40) || '成片'
  // 封面大标题宜短
  if (title.length > 22) title = title.slice(0, 22)
  let caption = clean(r.caption, 500)
  if (!caption) caption = `${title}。仅供参考，不构成投资建议。`
  if (!/投资建议|仅供参考/.test(caption)) {
    caption = `${caption.replace(/[。．.]*$/, '')}。仅供参考，不构成投资建议。`
  }
  let tags = r.tags
  if (typeof tags === 'string') tags = tags.split(/[\s,#，,]+/)
  if (!Array.isArray(tags)) tags = []
  tags = tags.map((t) => clean(String(t), 20)).filter(Boolean).slice(0, 8)
  if (!tags.length) tags = ['财经', 'A股']
  return { title, caption, tags }
}

export function buildDouyinMetaMessages({ projectName, script, hint }) {
  const system = [
    '你是抖音财经短视频运营编辑。根据素材信息写发布元数据，只输出一个 JSON 对象，不要解释。',
    '{',
    '  "title": "不超过18字的吸睛标题，可作封面大标题，不要标点堆砌",',
    '  "caption": "80~160字简介：说清看点，结尾必须含「仅供参考，不构成投资建议」",',
    '  "tags": ["话题1","话题2",...] 3~6 个中文话题，不要带 #',
    '}',
    '要求：口语化、有信息量；紧扣给定的项目主题与口播原文；不要夸大收益；不要承诺赚钱；不要写联系方式/二维码。',
    '禁止：抛开口播另起炉灶、写成别的题材、用近期热点替换本片主题。',
  ].join('\n')
  const user = [
    `项目主题/成片名：${clean(projectName, 80) || '未命名成片'}`,
    hint ? `补充说明：${clean(hint, 200)}` : '',
    script
      ? `本工程口播/文稿（简介与封面必须围绕这些内容，不要改题材）：\n${clean(script, 2400)}`
      : '（暂无口播稿——请仅根据项目主题写中性标题，不要编造具体新闻事件）',
  ].filter(Boolean).join('\n')
  return [{ role: 'system', content: system }, { role: 'user', content: user }]
}

export async function designDouyinMeta(config, body = {}) {
  if (!config?.apiKey) throw new Error('请先配置 API Key（AI 设置）')
  const projectName = clean(body.projectName || body.title, 80)
  const script = clean(body.script, 2400)
  const hint = clean(body.hint, 200)
  const res = await fetch(`${normalizeBaseUrl(config.baseUrl)}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: DOUYIN_CHAT_MODEL,
      messages: buildDouyinMetaMessages({ projectName, script, hint }),
      temperature: 0.55,
    }),
  })
  const raw = await res.text()
  let payload = {}
  try { payload = JSON.parse(raw) } catch { payload = { error: raw.slice(0, 300) } }
  if (!res.ok) {
    throw new Error(String(payload?.error?.message || payload?.error || `写文案失败 (${res.status})`))
  }
  const content = payload?.choices?.[0]?.message?.content
  return sanitizeDouyinMeta(extractJson(content), projectName)
}

/** 竖封面 3:4：大标题必须画进画面 */
export function buildDouyinCoverPrompt({ title, styleHint }) {
  const t = clean(title, 22) || '今日速报'
  const style = clean(styleHint, 120) || '财经短视频黑板粉笔风，深色黑板底，粉笔白字与橙强调色'
  return [
    `Vertical Douyin cover image, exact aspect ratio 3:4 portrait.`,
    `The large readable Chinese title text exactly 「${t}」 must be painted INTO the artwork as the main hero headline (bold, high contrast, thumbnail-legible).`,
    `Visual style: ${style}.`,
    `Clean composition, strong focal title in upper-middle or center, subtle market/chart motifs allowed.`,
    `No watermark, no QR code, no tiny disclaimer walls, no English Lorem ipsum, no blank empty title area.`,
    `Do not leave the title as a separate overlay — the characters are part of the rendered pixels.`,
  ].join(' ')
}
