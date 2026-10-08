/**
 * 交互式口播备忘录 · 阶段编排（PRD v1.1 MVP）
 * 严格 JSON 输出；失败自动重试 ≤2。
 */
import { normalizeBaseUrl } from './huniuClient.mjs'
import { extractJson } from './fancyTextAi.mjs'
import { DEFAULT_CHAT_MODEL } from './huniuConfig.mjs'

export const SCRIPT_STAGE_MODEL = process.env.TODO_AI_SCRIPT_MODEL || process.env.TODO_AI_SKILL_MODEL || DEFAULT_CHAT_MODEL

function resolveModel(config) {
  return String(config?.chatModel || SCRIPT_STAGE_MODEL || DEFAULT_CHAT_MODEL)
}

function clean(s, max = 16000) {
  return String(s || '').replace(/\r\n/g, '\n').trim().slice(0, max)
}

function clip(s, max) {
  const t = String(s || '')
  if (t.length <= max) return t
  return `${t.slice(0, Math.floor(max / 2))}…${t.slice(-Math.floor(max / 2))}`
}

function j(v) {
  try { return JSON.stringify(v ?? null) } catch { return 'null' }
}

const P_SYS = `你是一名资深短视频口播编导，正在「交互式口播生成系统」中工作。
1. 每次只完成当前阶段一件事，不越界。
2. 选项之间要有本质差异，禁止同义改写。
3. 不得编造数据/案例/人名；只能用 material_bank 中 verified=true 的条目，没有就写「待补充」。
4. 禁止 AI 腔：排比堆砌、「让我们一起」「总而言之」「综上所述」「不难发现」「值得注意的是」、空洞金句。
5. 遵守 project_card.taboo。口播面向耳朵：单句尽量不超过 20 字。
6. 严格输出一个 JSON 对象，不要 Markdown 代码块，不要 JSON 以外文字。`

function baseCardShape() {
  return `{
  "stage": "string",
  "question_for_user": "一句话提问",
  "card_type": "single_select|multi_select|variants|diff_review|form|rank",
  "options": [{"id":"A","title":"","content":"","tags":[],"reason":"","risk":""}],
  "recommended_id": "A",
  "allow_custom": true,
  "custom_hint": "",
  "notes": ""
}`
}

function promptFor(substep, ctx) {
  const card = ctx.project_card
  const topic = ctx.topic
  const materials = ctx.material_bank || []
  const verified = materials.filter((m) => m.verified)

  if (substep === 'A.form') {
    return `任务：根据用户一句话需求预填项目卡，card_type=form。
用户需求：${ctx.user_brief || '（未填写，请给稳妥默认）'}
工程名：${ctx.project_name || ''}

用 fields 数组（不要用 options）每个字段含：
key(platform|duration_sec|audience|persona|goal|taboo)、label、suggested、choices(3～4个)、why
规则：
1. 未说明的字段给默认并在 why 里写「推断」。
2. 额外输出 target_chars = round(duration_sec/60*270)
3. notes 里给 1 个用户可能忽略的关键问题
4. platform 选项含：抖音/视频号/小红书/B站
输出 JSON：{ stage:"A", card_type:"form", question_for_user, fields, target_chars, notes, allow_custom:true, custom_hint }`
  }

  if (substep === 'B.topics') {
    return `任务：发散约 18 个选题并打分，输出总分最高 5 个。
project_card：${j(card)}
种子：${ctx.seed || ''}
用户方向：${ctx.user_instruction || ''}

步骤：覆盖至少 5 种角度（痛点/误区/反常识/对比/热点/故事），每种≥2；五维 1～5 分：受众相关度、新鲜感、可讲透度(${card?.duration_sec || 90}秒)、素材可得性、传播潜力。
Top5 角度类型至少 3 种。每个 option：title(≤20字)、content(一句话核心观点)、tags:[角度]、reason、risk、scores。
card_type=single_select。custom_hint：「也可直接输入你的选题」。
${baseCardShape()}`
  }

  if (substep === 'C.questions') {
    return `任务：列出素材调研问题清单（不要自己回答）。
选题：${j(topic)}
project_card：${j(card)}
列出 8～12 个问题，分 data/case/authority；每项 option：id、title(问题)、content(建议搜索词)、tags:[data|case|authority, must|nice]
card_type=multi_select。recommended_id 可为空。
${baseCardShape()}`
  }

  if (substep === 'C.materials') {
    return `任务：把用户粘贴的资料整理成素材库。只提取资料中明确存在的信息，不推断补数据。
选题：${j(topic)}
问题清单：${j(ctx.questions || [])}
资料：${clip(ctx.search_results || ctx.user_instruction || '', 8000)}

每条 option：id(m1..)、title(类型)、content(一句话摘要，保留数值口径)、tags:[data|case|analogy|authority]、reason(来源名)、risk(日期或口径问题)、以及字段 source、date、credibility(high|mid|low)、verified(boolean)
无法回答的列入 gaps 数组。可补充 1～2 条创作类比（type=analogy, verified=true, reason注明创作类比）。
card_type=multi_select，用户勾选保留。
${baseCardShape()}`
  }

  if (substep === 'D.hook') {
    return `任务：写 5 个开头钩子，类型各不相同：反常识、悬念、痛点直击、数字冲击、场景代入。
选题：${j(topic)}
素材摘要：${j(verified.slice(0, 12).map((m) => ({ id: m.id, content: m.content })))}
每个≤40字；数字冲击必须用 verified 素材。option：title=类型、content=钩子原文、reason、risk。
card_type=single_select。
${baseCardShape()}`
  }

  if (substep === 'D.logic') {
    return `任务：生成极简论点逻辑线。
选题：${j(topic)}
钩子：${j(ctx.hook)}
素材：${j(verified.slice(0, 16))}

输出 card_type=form，fields：
- claim：suggested 为一句主张
- q1..q3 或 q4：suggested 为「观众下一问」
- nail1..：suggested 为钉子说明，choices 可给可用 material id
并在 notes 写整体逻辑。
同时输出 logic_line 对象：{ claim, next_questions:[{id,text}], nails:[{question_id, material_ids, note}] }
不得引入素材外数据。`
  }

  if (substep === 'D.outline') {
    return `任务：基于逻辑线设计 2～3 套大纲方案。
选题：${j(topic)}
钩子：${j(ctx.hook)}
逻辑线：${j(ctx.logic_line)}
素材：${j(verified)}
目标字数：${card?.target_chars || 400}

每套 4～6 段，每段：role、key_point(仅1信息点)、target_chars、material_ids(仅 verified)、emotion
钩子为第1段；结尾回扣开头+行动引导；段落字数和 = 目标±10%。
option.content 为段落数组；另含 why_this、weakness。
card_type=single_select。
${baseCardShape()}`
  }

  if (substep === 'E.expand') {
    const seg = ctx.current_segment
    const mats = (seg?.material_ids || []).map((id) => materials.find((m) => m.id === id)).filter(Boolean)
    return `任务：撰写第 ${ctx.segment_index + 1} 段，提供 3 个差异化版本（表达策略不同，非同义改写）。
全文大纲：${j(ctx.outline)}
已确定前文：${clip(ctx.previous_text || '（开头）', 2000)}
本段设定：${j(seg)}
本段可用素材（只能用这些）：${j(mats)}
额外要求：${ctx.user_instruction || '无'}

内部：骨架→填充→自检。数据句末用 [m_id] 标注。
self_check：single_point、data_traceable、no_repeat、length_ok、transition_ok（均为 boolean）
option：title=策略名、content=正文、tags=[字数]、reason、risk、self_check
card_type=variants。禁止素材外数据。
${baseCardShape()}`
  }

  if (substep === 'E.polish') {
    return `任务：整稿打磨（口语+节奏；有人设则兼顾语气）。只改表达，不改事实/结构。
稿件：${clip(ctx.full_draft || '', 8000)}
人设：${card?.persona || ''}
强度：${ctx.intensity || 'medium'}（light=拆长句；medium=去书面词+数字口语化；heavy=再加对话感≤5处）
目标时长：${card?.duration_sec || 90}秒；目标字数：${card?.target_chars || 400}

输出 card_type=diff_review，options 每条：
{id, title:oral|style|pace, before, after, rule, accept_default:true}
另附 pace_summary：{char_count, est_sec, delta_pct, weak_windows:[]}
若 |delta_pct|>10，附 pace_options 三案（删段/删句/合并）。
summary：{change_count, char_delta}`
  }

  if (substep === 'E.fact') {
    return `任务：抽取可核查断言并与素材库比对。只比对素材库，不自行判断现实真伪。
稿件：${clip(ctx.full_draft || '', 8000)}
素材库：${j(materials)}

每条 option：id、claim、location、status(ok|limit|missing|mismatch)、material_id、fix_options(字符串数组)、title=status、content=claim
card_type=multi_select（用户勾选「已处理/接受」的项）。
绝对化表述 status=limit。`
  }

  if (substep === 'F.package') {
    return `任务：基于终稿生成发布包装。
终稿：${clip(ctx.full_draft || '', 6000)}
平台：${card?.platform || '抖音'}
核心观点：${topic?.core_claim || ''}

输出 JSON：
{
  "stage":"F",
  "card_type":"single_select",
  "question_for_user":"选一组标题与封面？",
  "options":[{"id":"T1","title":"悬念型","content":"标题"},{"id":"T2","title":"利益型","content":"标题"},{"id":"T3","title":"反常识型","content":"标题"}],
  "cover_texts":["","",""],
  "description":"≤60字含互动",
  "hashtags":["#..."],
  "recommended_id":"T1",
  "allow_custom":true,
  "notes":""
}
标题≤20字，封面≤12字，不得与正文事实不符。`
  }

  return `输出一个符合通用协议的 JSON 卡片。当前子步骤：${substep}\n${baseCardShape()}`
}

async function chatOnce(config, system, user) {
  const model = resolveModel(config)
  const res = await fetch(`${normalizeBaseUrl(config.baseUrl)}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.55,
    }),
    signal: AbortSignal.timeout(45000),
  })
  const raw = await res.text()
  let payload = {}
  try { payload = JSON.parse(raw) } catch { payload = { error: raw.slice(0, 300) } }
  if (!res.ok) {
    throw new Error(String(payload?.error?.message || payload?.error || `口播阶段 AI 失败 (${res.status})`))
  }
  return payload?.choices?.[0]?.message?.content
}

function normalizeCard(parsed, substep) {
  if (!parsed || typeof parsed !== 'object') throw new Error('AI 返回无效对象')
  const cardType = String(parsed.card_type || (Array.isArray(parsed.fields) ? 'form' : 'single_select'))
  let options = Array.isArray(parsed.options) ? parsed.options : []
  if (cardType === 'form' && Array.isArray(parsed.fields) && !options.length) {
    options = parsed.fields.map((f, i) => ({
      id: String(f.key || f.id || `F${i + 1}`),
      key: f.key,
      label: f.label || f.key,
      title: f.label || f.key,
      suggested: f.suggested,
      content: typeof f.suggested === 'string' ? f.suggested : j(f.suggested),
      choices: f.choices,
      why: f.why,
      reason: f.why,
    }))
  }
  options = options.map((o, i) => ({
    ...o,
    id: String(o.id || String.fromCharCode(65 + i)),
    title: o.title != null ? String(o.title) : undefined,
    content: o.content,
  }))
  return {
    stage: String(parsed.stage || substep.split('.')[0]),
    question_for_user: String(parsed.question_for_user || '请选择'),
    card_type: cardType,
    options,
    fields: parsed.fields,
    recommended_id: parsed.recommended_id != null ? String(parsed.recommended_id) : options[0]?.id,
    allow_custom: parsed.allow_custom !== false,
    custom_hint: parsed.custom_hint ? String(parsed.custom_hint) : '',
    notes: parsed.notes ? String(parsed.notes) : '',
    summary: parsed.summary || null,
    gaps: Array.isArray(parsed.gaps) ? parsed.gaps.map(String) : [],
    pace_options: Array.isArray(parsed.pace_options) ? parsed.pace_options : undefined,
    pace_summary: parsed.pace_summary || undefined,
    titles: Array.isArray(parsed.titles) ? parsed.titles.map(String) : undefined,
    cover_texts: Array.isArray(parsed.cover_texts) ? parsed.cover_texts.map(String) : undefined,
    description: parsed.description != null ? String(parsed.description) : undefined,
    hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags.map(String) : undefined,
    logic_line: parsed.logic_line || undefined,
    target_chars: parsed.target_chars,
  }
}

/**
 * @param {{ apiKey?: string, baseUrl?: string }} config
 * @param {{
 *   action?: string
 *   substep?: string
 *   workspace?: object
 *   project_name?: string
 *   user_instruction?: string
 *   seed?: string
 *   search_results?: string
 *   full_draft?: string
 *   current_segment?: object
 *   segment_index?: number
 *   previous_text?: string
 *   intensity?: string
 *   current_card_summary?: string
 *   user_text?: string
 * }} body
 */
export async function runScriptStage(config, body = {}) {
  if (!config?.apiKey) throw new Error('请先配置 API Key（AI 设置）')
  const action = String(body.action || 'generate')
  const ws = body.workspace && typeof body.workspace === 'object' ? body.workspace : {}
  const substep = String(body.substep || ws.substep || 'A.form')

  if (action === 'intent') {
    const system = `${P_SYS}\n你只做意图解析，不执行修改。`
    const user = `当前阶段：${substep}
当前卡片摘要：${clip(body.current_card_summary || j(ws.current_card), 2000)}
用户输入：${clean(body.user_text, 800)}
可用操作：select|combine|regenerate|refine|add_constraint|lock|unlock|goto_stage|ask
输出 JSON：
{"intent":"...","target":{"type":"option|sentence|segment|material|global","id":""},"params":{"direction":"","constraint":"","scope":""},"confidence":0.0,"clarify_question":"","operations":[]}`
    let lastErr
    for (let i = 0; i < 3; i++) {
      try {
        const content = await chatOnce(config, system, user + (i ? `\n上次错误：${lastErr}，请修正 JSON。` : ''))
        const parsed = extractJson(content)
        return { ok: true, action: 'intent', intent: parsed, model: resolveModel(config) }
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e)
      }
    }
    throw new Error(lastErr || '意图解析失败')
  }

  const ctx = {
    user_brief: body.user_brief || ws.user_brief || '',
    project_name: body.project_name || '',
    project_card: ws.project_card,
    topic: ws.topic,
    questions: ws.questions,
    material_bank: ws.material_bank || [],
    hook: ws.hook,
    logic_line: ws.logic_line,
    outline: ws.outline || [],
    intensity: body.intensity || ws.intensity || 'medium',
    user_instruction: body.user_instruction || '',
    seed: body.seed || '',
    search_results: body.search_results || '',
    full_draft: body.full_draft || '',
    current_segment: body.current_segment,
    segment_index: Number(body.segment_index) || 0,
    previous_text: body.previous_text || '',
  }

  const system = `${P_SYS}\n【项目上下文】${j(ctx.project_card)}`
  const user = promptFor(substep, ctx)
  let lastErr
  for (let i = 0; i < 3; i++) {
    try {
      const content = await chatOnce(config, system, user + (i ? `\n上次 JSON 错误：${lastErr}，请只输出合法 JSON。` : ''))
      const parsed = extractJson(content)
      const card = normalizeCard(parsed, substep)
      return {
        ok: true,
        action: 'generate',
        substep,
        card,
        logic_line: parsed.logic_line || card.logic_line,
        target_chars: parsed.target_chars ?? card.target_chars,
        model: resolveModel(config),
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
    }
  }
  throw new Error(lastErr || '阶段生成失败')
}
