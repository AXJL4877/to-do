/**
 * AI 动画导演：一句自然语言 → 动画包表单（角色 / 分段动作 / 分镜 / 播放设置），经 LLM。
 * LLM 输出一律按动画包白名单清洗并跑一遍 compileAnimById 校验，不信任模型。
 */
import { normalizeBaseUrl } from './huniuClient.mjs'
import { compileAnimById, listAnimPacks } from './animPacks.mjs'
import { extractJson } from './fancyTextAi.mjs'

export const ANIM_DIRECTOR_MODEL = process.env.TODO_AI_ANIM_MODEL || 'gemini-3.8-flash'

const IDEA_MAX = 400
const BEAT_MAX = 80

function str(v, max) {
  return typeof v === 'string' ? v.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

/** @param {ReturnType<typeof listAnimPacks>['anims'][number]} pack 公开描述 */
export function buildDirectorMessages(pack, idea) {
  const grid = pack.sprite.grid
  const frames = grid * grid
  const segInput = pack.sprite.segmentInput
  const maxSegs = segInput ? pack.sprite.maxSegments : 1
  const textInputs = pack.inputs.filter((i) => i.type === 'text' && i.id !== segInput)
  const selects = pack.inputs.filter((i) => i.type === 'select')
  const secPerSeg = (frames / pack.playback.defaultFps).toFixed(1)
  const system = [
    `你是 2D 手绘动画导演。用户用一句话描述想要的动画，你把它拆成可以直接生成的分镜方案，只输出一个 JSON 对象，不要解释。`,
    `生成方式：每一段是一张 ${grid}×${grid} 精灵图（${frames} 帧，默认 ${pack.playback.defaultFps}fps 约 ${secPerSeg} 秒），同一个角色在白底上做一个连续动作；多段按顺序接力，下一段第 1 帧接上一段最后一帧。动画包：${pack.name}——${pack.description}`,
    '字段：',
    '{',
    '  "title": "不超过12字的中文标题",',
    ...textInputs.map((i) => `  "${i.id}": "${i.label}，中文，不超过 ${i.maxLength} 字",`),
    `  "segments": ["第 1 段动作", ...] 1~${maxSegs} 段，每段中文不超过 ${pack.inputs.find((i) => i.id === segInput)?.maxLength ?? 80} 字,`,
    `  "beats": [${grid} 个字符串] 第 1 段精灵图每一行（${grid} 帧）的阶段，按时间顺序，每个不超过 20 字,`,
    ...selects.map((i) => `  "${i.id}": ${i.label}，从 ${JSON.stringify(i.options.map((o) => `${o.value}(${o.label})`))} 选 value,`),
    `  "fps": 从 ${JSON.stringify(pack.playback.fps)} 选,`,
    `  "loop": "forward"(顺序) 或 "pingpong"(往返，只适合点头、摆动这类来回动作),`,
    `  "repeat": 1~${pack.playback.maxRepeat} 播放次数,`,
    pack.cutout ? '  "alpha": true 透明底（默认，便于叠加到视频上）；用户明确要背景/纸张质感时才 false,' : '',
    '  "notes": "一句话说明你怎么拆的"',
    '}',
    '要求：',
    '- 角色写成具体、可复现的外观：体型、发型、衣服颜色款式、手持道具；不要写动作和场景。每段都会参照同一角色设定图。',
    `- 每段只写一个连贯动作，约 ${secPerSeg} 秒能完成：写清起始姿势→过程→结束姿势，用具体的身体部位和方向（如"右手举起杯子到嘴边，仰头喝"）。不要镜头运动、转场、特写、多人。`,
    `- 简单或循环动作（走路、跑步、挥手、待机呼吸）只用 1 段，循环动作 repeat 2~4；有先后情节的长动作才拆多段（最多 ${maxSegs} 段），相邻段的动作要自然衔接，最后一段收在一个稳定姿势。`,
    '- 需要循环播放的动作，动作结束姿势要回到开始姿势。',
    '- 用户没提的风格选项按描述气质挑最合适的；fps 一般 12，想要顿挫手绘感用 8~10，流畅用 15。',
  ].filter(Boolean).join('\n')
  return [{ role: 'system', content: system }, { role: 'user', content: String(idea).slice(0, IDEA_MAX) }]
}

/**
 * LLM 结果 → 前端 AnimValues 的子集；越界值丢弃或夹紧。
 * @returns {{ title: string, notes: string, values: { inputs: Record<string,string>, segments: string[], beats: string[], fps: number, loop: string, repeat: number, alpha: boolean } }}
 */
export function sanitizeDirection(raw, pack) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
  if (!r) throw new Error('AI 返回的不是对象')
  const grid = pack.sprite.grid
  const segInput = pack.sprite.segmentInput
  const maxSegs = segInput ? pack.sprite.maxSegments : 1
  const inputs = {}
  for (const inp of pack.inputs) {
    if (inp.type === 'select') {
      inputs[inp.id] = inp.options.some((o) => o.value === r[inp.id]) ? r[inp.id] : inp.default
    } else if (inp.id !== segInput) {
      inputs[inp.id] = str(r[inp.id], inp.maxLength)
    }
  }
  const segMax = pack.inputs.find((i) => i.id === segInput)?.maxLength ?? 80
  const segs = (Array.isArray(r.segments) ? r.segments : [r.segments]).map((s) => str(s, segMax)).filter(Boolean).slice(0, maxSegs)
  if (!segs.length) throw new Error('AI 没有给出动作')
  if (segInput) inputs[segInput] = segs[0]
  const beats = Array.from({ length: grid }, (_, i) => (Array.isArray(r.beats) ? str(r.beats[i], BEAT_MAX) : ''))
  const fps = pack.playback.fps.includes(Number(r.fps)) ? Number(r.fps) : pack.playback.defaultFps
  const loop = pack.playback.loops.includes(r.loop) ? r.loop : pack.playback.defaultLoop
  const rep = Math.round(Number(r.repeat))
  const repeat = Number.isFinite(rep) ? Math.min(pack.playback.maxRepeat, Math.max(1, rep)) : 1
  const alpha = pack.cutout ? (typeof r.alpha === 'boolean' ? r.alpha : pack.cutout.default) : false
  return {
    title: str(r.title, 12) || 'AI 动画',
    notes: str(r.notes, 120),
    values: { inputs, segments: segInput ? segs.slice(1) : [], beats, fps, loop, repeat, alpha },
  }
}

export async function directAnim(config, { animId, idea }) {
  if (!config?.apiKey) throw new Error('请先配置 API Key')
  const text = String(idea || '').trim()
  if (!text) throw new Error('请描述想要的动画')
  const pack = listAnimPacks().anims.find((a) => a.id === animId)
  if (!pack) throw new Error(`未找到动画包 ${animId}`)
  const res = await fetch(`${normalizeBaseUrl(config.baseUrl)}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: ANIM_DIRECTOR_MODEL, messages: buildDirectorMessages(pack, text), temperature: 0.7 }),
    signal: AbortSignal.timeout(90_000),
  })
  const raw = await res.text()
  let payload = {}
  try { payload = JSON.parse(raw) } catch { payload = { error: raw.slice(0, 300) } }
  if (!res.ok) throw new Error(String(payload?.error?.message || payload?.error || `AI 导演请求失败 (${res.status})`))
  const out = sanitizeDirection(extractJson(payload?.choices?.[0]?.message?.content), pack)
  const v = out.values
  compileAnimById(animId, { inputs: v.inputs, segments: v.segments, beats: v.beats, fps: v.fps, loop: v.loop, repeat: v.repeat, alpha: v.alpha })
  return out
}
