/**
 * AI 花字：自然语言描述 → 花字参数（经 LLM），以及字内质感纹理的生图提示词。
 * LLM 输出一律经 sanitizeFancyStyle 清洗，越界值夹紧、非法值丢弃，不信任模型。
 */
import { normalizeBaseUrl } from './huniuClient.mjs'

export const FANCY_CHAT_MODEL = process.env.TODO_AI_CHAT_MODEL || 'gpt-6-astra'

const COLOR_RE = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|#[0-9a-f]{8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/i

function color(v, fallback) {
  const s = typeof v === 'string' ? v.trim() : ''
  return COLOR_RE.test(s) ? s : fallback
}

function num(v, min, max, fallback) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n * 100) / 100))
}

function obj(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null
}

/**
 * @param {unknown} raw LLM 解析出的对象
 * @param {string[]} fonts 可选字体白名单（客户端本机可用）
 */
export function sanitizeFancyStyle(raw, fonts = []) {
  const r = obj(raw)
  if (!r) throw new Error('AI 返回的不是对象')
  const fill = (Array.isArray(r.fill) ? r.fill : [r.fill])
    .map((c) => color(c, null)).filter(Boolean).slice(0, 4)
  if (!fill.length) fill.push('#FFFFFF')
  const strokes = (Array.isArray(r.strokes) ? r.strokes : [])
    .map(obj).filter(Boolean)
    .map((s) => ({ color: color(s.color, null), width: num(s.width, 0, 16, 0) }))
    .filter((s) => s.color && s.width > 0)
    .slice(0, 4)
  const fancy = {
    fontWeight: Math.round(num(r.fontWeight, 100, 900, 800) / 100) * 100,
    italic: r.italic === true,
    fill,
    fillAngle: num(r.fillAngle, 0, 360, 90),
    strokes,
  }
  const sh = obj(r.shadow)
  if (sh && color(sh.color, null)) {
    fancy.shadow = { color: color(sh.color), blur: num(sh.blur, 0, 40, 0), x: num(sh.x, -30, 30, 0), y: num(sh.y, -30, 30, 4) }
  }
  const ex = obj(r.extrude)
  if (ex && color(ex.color, null) && num(ex.depth, 0, 24, 0) > 0) {
    fancy.extrude = { color: color(ex.color), depth: num(ex.depth, 0, 24, 0), angle: num(ex.angle, 0, 360, 90) }
  }
  const gl = obj(r.glow)
  if (gl && color(gl.color, null) && num(gl.blur, 0, 60, 0) > 0) {
    fancy.glow = { color: color(gl.color), blur: num(gl.blur, 0, 60, 0) }
  }
  const gloss = num(r.gloss, 0, 1, 0)
  if (gloss > 0) fancy.gloss = gloss
  const bg = obj(r.bg)
  if (bg && color(bg.color, null)) {
    fancy.bg = { color: color(bg.color), radius: num(bg.radius, 0, 40, 8), padX: num(bg.padX, 0, 60, 20), padY: num(bg.padY, 0, 40, 10) }
  }
  const font = typeof r.font === 'string' && fonts.includes(r.font) ? r.font : null
  const name = typeof r.name === 'string' ? r.name.trim().slice(0, 12) : ''
  const textureIdea = typeof r.textureIdea === 'string' ? r.textureIdea.trim().slice(0, 30) : ''
  return { name: name || 'AI 花字', font, fancy, textureIdea: textureIdea || null }
}

/** 从模型回复里取出第一个 JSON 对象（兼容 ```json 包裹与前后废话） */
export function extractJson(text) {
  const s = String(text || '')
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('AI 没有返回 JSON')
  return JSON.parse(s.slice(start, end + 1))
}

export function buildFancyMessages({ prompt, text, fonts }) {
  const system = [
    '你是短视频花字设计师。根据用户描述，为一段文字设计有质感的花字样式，只输出一个 JSON 对象，不要解释。',
    '所有尺寸按 1080p 画面像素计。字段：',
    '{',
    '  "name": "不超过6字的样式名",',
    `  "font": 从 ${JSON.stringify(fonts)} 中选一个最合适的,`,
    '  "fontWeight": 400~900,',
    '  "italic": false,',
    '  "fill": ["#RRGGBB", ...] 1~4 个颜色，多色即渐变,',
    '  "fillAngle": 渐变方向角度，90 为自上而下,',
    '  "strokes": [{"color":"#RRGGBB","width":1~12}, ...] 0~3 层，由内向外，常见是深色内描边+浅色外描边,',
    '  "shadow": {"color":"rgba(...)或#RRGGBBAA","blur":0~30,"x":-20~20,"y":-20~20} 或 null,',
    '  "extrude": {"color":"#RRGGBB","depth":2~16,"angle":90~135} 或 null（立体厚度，颜色比填充更深）,',
    '  "glow": {"color":"#RRGGBB","blur":10~40} 或 null（霓虹/发光类才用）,',
    '  "gloss": 0~0.6（顶部高光，塑料/糖果/金属感时用）,',
    '  "bg": {"color":"rgba(...)","radius":0~30,"padX":10~40,"padY":6~20} 或 null（仅字幕条/标签类）,',
    '  "textureIdea": 若适合在字里填充材质纹理，给出2~8字中文材质描述，如"金箔""大理石"，否则 null',
    '}',
    '要求：配色协调且在视频画面上清晰可读；不要同时堆满所有效果，挑 2~4 种最能体现描述的。',
  ].join('\n')
  const user = `文字内容：「${String(text || '标题文字').slice(0, 60)}」\n想要的效果：${String(prompt).slice(0, 200)}`
  return [{ role: 'system', content: system }, { role: 'user', content: user }]
}

export async function designFancyText(config, { prompt, text, fonts }) {
  if (!config?.apiKey) throw new Error('请先配置 API Key')
  const p = String(prompt || '').trim()
  if (!p) throw new Error('请描述想要的花字效果')
  const fontList = (Array.isArray(fonts) ? fonts : []).filter((f) => typeof f === 'string').slice(0, 30)
  const res = await fetch(`${normalizeBaseUrl(config.baseUrl)}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: FANCY_CHAT_MODEL,
      messages: buildFancyMessages({ prompt: p, text, fonts: fontList }),
      temperature: 0.8,
    }),
  })
  const raw = await res.text()
  let payload = {}
  try { payload = JSON.parse(raw) } catch { payload = { error: raw.slice(0, 300) } }
  if (!res.ok) {
    throw new Error(String(payload?.error?.message || payload?.error || `AI 花字请求失败 (${res.status})`))
  }
  const content = payload?.choices?.[0]?.message?.content
  return sanitizeFancyStyle(extractJson(content), fontList)
}

/** 字内纹理：无缝、平铺、满幅的材质特写 */
export function texturePrompt(desc) {
  const d = String(desc || '').replace(/[{}]/g, '').trim().slice(0, 60)
  if (!d) throw new Error('请描述纹理材质')
  return `Seamless tileable texture swatch of ${d}. Extreme close-up material surface filling the entire square frame edge to edge, flat front-on view, even soft lighting, rich fine detail, vivid but clean colors. No objects, no text, no letters, no border, no vignette, no perspective.`
}
