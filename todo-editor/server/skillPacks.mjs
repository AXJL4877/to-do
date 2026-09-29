/**
 * 技能包（Skill Pack）加载 / 严格校验 / 参数编译 / AI 规划。
 * 规范：todo-skill-pack/1 —— skill.json 声明「自然语言输入 + 可调参数 + 本地运行时」，按 pipeline 分三种宿主流程：
 *   elements（默认）：规划器 + 素材模板，宿主按 规划 → 元素生图 → 渲染 执行（server/skills/chalk-hand/PROTOCOL.md）
 *   tts：输入即口播文案，宿主只调 TTS_timeline 出 wav + 逐字时间戳，无渲染端（server/skills/tts-voice/PROTOCOL.md）
 *   subtitle：输入是一条已完成的 tts 配音，渲染端按它的逐字时间戳切条对时并烧录（server/skills/voice-subtitle/PROTOCOL.md）
 *   narrated：输入是口播，宿主 配音 → 按短语时间戳分板拆元素 → 元素生图 → 渲染端逐板对时书写并混入配音（server/skills/chalk-hand/PROTOCOL.md §5）
 *
 * 目录：server/skills/<name>/skill.json（内置）、$TODO_DATA_DIR/skills/<name>/skill.json（用户，同 id 覆盖内置）
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ID_RE, PLACEHOLDER_RE, PackError, RESOLUTIONS, SEMVER_RE,
  checkPackImage, cleanText, fail, onlyKeys, str, strList,
} from './stylePacks.mjs'
import { normalizeBaseUrl } from './huniuClient.mjs'
import { extractJson } from './fancyTextAi.mjs'

export const SKILL_SPEC = 'todo-skill-pack/1'
export const SKILL_PLANNER_MODEL = process.env.TODO_AI_SKILL_MODEL || 'gemini-3.8-flash'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = process.env.TODO_DATA_DIR
  ? path.resolve(process.env.TODO_DATA_DIR)
  : path.join(ROOT, '.data')

export const BUILTIN_SKILL_DIR = path.join(ROOT, 'server', 'skills')
export const USER_SKILL_DIR = path.join(DATA_DIR, 'skills')

export const PARAM_GROUPS = ['scene', 'voice', 'text', 'timing', 'stroke', 'output']
export const PIPELINES = ['elements', 'tts', 'subtitle', 'narrated']
const INPUT_MAX = { elements: 1000, tts: 5000, subtitle: 5000, narrated: 3600 }
/** narrated：整条口播最多拆几块黑板、总共画几个元素（每个元素一次生图） */
/** 10 分钟口播约 40~75 块黑板 */
export const NARRATED_MAX_SCENES = 80
export const NARRATED_MAX_ELEMENTS = 200
export const ROLES = ['hero', 'support', 'accent']
const PARAM_ID_RE = /^[a-z][a-zA-Z0-9]{0,31}$/
const OPTION_RE = /^[a-zA-Z0-9_.:-]{1,32}$/
const PREVIEW_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif']
const ASSET_VARS = ['draw', 'label', 'role']
const LABEL_MAX = 12
const DRAW_MAX = 240
const WEIGHT_MIN = 0.5
const WEIGHT_MAX = 3

function num(v, where) {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(where, '必须是数字')
  return v
}

function validateParam(p, i, all) {
  const where = `params[${i}]`
  if (!p || typeof p !== 'object') fail(where, '必须是对象')
  if (!PARAM_ID_RE.test(String(p.id || ''))) fail(`${where}.id`, '须为小写字母开头的标识符')
  if (!PARAM_GROUPS.includes(p.group)) fail(`${where}.group`, `取值须为 ${PARAM_GROUPS.join(' / ')}`)
  str(p.label, `${where}.label`, { max: 12 })
  str(p.hint, `${where}.hint`, { optional: true, max: 60 })
  if (p.type === 'select') {
    onlyKeys(p, ['id', 'type', 'group', 'label', 'hint', 'when', 'default', 'options'], where)
    if (!Array.isArray(p.options) || p.options.length < 1 || p.options.length > 16) fail(`${where}.options`, '须为 1~16 个选项')
    const seen = new Set()
    for (const [j, o] of p.options.entries()) {
      const ow = `${where}.options[${j}]`
      onlyKeys(o, ['value', 'label', 'hint', 'prompt'], ow)
      if (!OPTION_RE.test(String(o.value ?? ''))) fail(`${ow}.value`, '须为 1~32 位字母数字（可含 _ . : -）')
      if (seen.has(o.value)) fail(`${ow}.value`, `重复值 "${o.value}"`)
      seen.add(o.value)
      str(o.label, `${ow}.label`, { max: 16 })
      str(o.hint, `${ow}.hint`, { optional: true, max: 40 })
      if (o.prompt != null) {
        str(o.prompt, `${ow}.prompt`, { max: 300 })
        if (/\{\{|\}\}/.test(o.prompt)) fail(`${ow}.prompt`, '选项片段中不允许占位符')
      }
    }
    if (!seen.has(p.default)) fail(`${where}.default`, '必须是某个选项的 value')
  } else if (p.type === 'number') {
    onlyKeys(p, ['id', 'type', 'group', 'label', 'hint', 'when', 'default', 'min', 'max', 'step', 'unit'], where)
    num(p.min, `${where}.min`)
    num(p.max, `${where}.max`)
    num(p.step, `${where}.step`)
    num(p.default, `${where}.default`)
    if (p.min >= p.max) fail(`${where}.max`, '必须大于 min')
    if (p.step <= 0) fail(`${where}.step`, '必须大于 0')
    if (p.default < p.min || p.default > p.max) fail(`${where}.default`, '须在 min~max')
    str(p.unit, `${where}.unit`, { optional: true, max: 4 })
  } else if (p.type === 'text') {
    onlyKeys(p, ['id', 'type', 'group', 'label', 'hint', 'when', 'default', 'pattern', 'maxLength', 'placeholder'], where)
    if (!Number.isInteger(p.maxLength) || p.maxLength < 1 || p.maxLength > 200) fail(`${where}.maxLength`, '须为 1~200 的整数')
    try { new RegExp(str(p.pattern, `${where}.pattern`, { max: 200 })) } catch { fail(`${where}.pattern`, '不是合法正则') }
    if (typeof p.default !== 'string' || p.default.length > p.maxLength) fail(`${where}.default`, '须为不超过 maxLength 的字符串')
    str(p.placeholder, `${where}.placeholder`, { optional: true, max: 40 })
  } else {
    fail(`${where}.type`, '只支持 select / number / text')
  }
  if (p.when != null) {
    if (!p.when || typeof p.when !== 'object' || Array.isArray(p.when)) fail(`${where}.when`, '必须是对象')
    for (const [k, vals] of Object.entries(p.when)) {
      const dep = all.find((x) => x.id === k)
      if (!dep || dep.type !== 'select' || dep === p) fail(`${where}.when.${k}`, '只能依赖其它 select 参数')
      if (!Array.isArray(vals) || !vals.length || vals.some((v) => !dep.options.some((o) => o.value === v))) {
        fail(`${where}.when.${k}`, '须为该参数的合法取值数组')
      }
    }
  }
}

/** 严格校验 skill.json；packDir 用于检查预览图与运行时入口 */
export function validateSkillPack(raw, packDir) {
  onlyKeys(raw, [
    '$schema', 'spec', 'id', 'name', 'version', 'author', 'description', 'tags', 'previews',
    'pipeline', 'input', 'output', 'params', 'quick', 'planner', 'assets', 'runtime',
  ], 'skill.json')
  if (raw.spec !== SKILL_SPEC) fail('spec', `必须为 "${SKILL_SPEC}"`)
  const pipeline = raw.pipeline ?? 'elements'
  if (!PIPELINES.includes(pipeline)) fail('pipeline', `取值须为 ${PIPELINES.join(' / ')}`)
  if (!ID_RE.test(String(raw.id || ''))) fail('id', '须形如 author.skill-name（小写）')
  str(raw.name, 'name', { max: 24 })
  if (!SEMVER_RE.test(String(raw.version || ''))) fail('version', '须为 x.y.z')
  str(raw.author, 'author', { max: 60 })
  str(raw.description, 'description', { max: 200 })
  if (raw.tags != null) {
    strList(raw.tags, 'tags', { min: 0, max: 8 })
    raw.tags.forEach((t, i) => { if (t.length > 12) fail(`tags[${i}]`, '最多 12 字') })
  }
  if (raw.previews != null) {
    strList(raw.previews, 'previews', { min: 1, max: 8 })
    raw.previews.forEach((rel, i) => checkPackImage(packDir, rel, `previews[${i}]`, PREVIEW_EXT))
  }

  onlyKeys(raw.input, ['label', 'maxLength', 'placeholder'], 'input')
  str(raw.input.label, 'input.label', { max: 24 })
  if (!Number.isInteger(raw.input.maxLength) || raw.input.maxLength < 1 || raw.input.maxLength > INPUT_MAX[pipeline]) {
    fail('input.maxLength', `必须是 1~${INPUT_MAX[pipeline]} 的整数`)
  }
  str(raw.input.placeholder, 'input.placeholder', { optional: true, max: 120 })

  if (!Array.isArray(raw.params) || raw.params.length > 24) fail('params', '须为 0~24 项的数组')
  raw.params.forEach((p, i) => validateParam(p, i, raw.params))
  const ids = raw.params.map((p) => p.id)
  if (new Set(ids).size !== ids.length) fail('params', 'id 重复')
  if (raw.quick != null) strList(raw.quick, 'quick', { allowed: ids, min: 0, max: 6 })

  onlyKeys(raw.output, ['mime', 'codec', 'alphaWhen'], 'output')
  const [mime, codec] = pipeline === 'tts' ? ['audio/wav', 'pcm'] : ['video/webm', 'vp9']
  if (raw.output.mime !== mime) fail('output.mime', `${pipeline} 管线只支持 "${mime}"`)
  if (raw.output.codec !== codec) fail('output.codec', `${pipeline} 管线只支持 "${codec}"`)
  if (raw.output.alphaWhen != null) {
    for (const [k, vals] of Object.entries(raw.output.alphaWhen)) {
      const dep = raw.params.find((x) => x.id === k)
      if (!dep || dep.type !== 'select') fail(`output.alphaWhen.${k}`, '只能引用 select 参数')
      if (!Array.isArray(vals) || vals.some((v) => !dep.options.some((o) => o.value === v))) fail(`output.alphaWhen.${k}`, '取值不合法')
    }
  }

  if (pipeline === 'elements' || pipeline === 'narrated') {
    validateElementsPipeline(raw)
    if (pipeline === 'narrated' && raw.planner.countParam != null) fail('planner.countParam', 'narrated 管线按口播自动定元素数')
  } else {
    if (raw.planner != null) fail('planner', `${pipeline} 管线不使用规划器`)
    if (raw.assets != null) fail('assets', `${pipeline} 管线不生成素材`)
  }

  if (pipeline === 'tts') {
    if (raw.runtime != null) fail('runtime', 'tts 管线由宿主调 TTS_timeline，不带渲染端')
    return { ...raw, pipeline }
  }
  onlyKeys(raw.runtime, ['type', 'entry', 'timeoutSec'], 'runtime')
  if (raw.runtime.type !== 'python') fail('runtime.type', 'v1 只支持 "python"')
  const entry = String(raw.runtime.entry || '')
  if (path.isAbsolute(entry) || entry.split(/[/\\]/).includes('..') || !entry.endsWith('.py')) fail('runtime.entry', '必须是包内 .py 相对路径')
  if (!existsSync(path.join(packDir, entry))) fail('runtime.entry', '文件不存在')
  if (!Number.isInteger(raw.runtime.timeoutSec) || raw.runtime.timeoutSec < 30 || raw.runtime.timeoutSec > 7200) {
    fail('runtime.timeoutSec', '须为 30~7200 的整数')
  }
  return { ...raw, pipeline }
}

function validateElementsPipeline(raw) {
  onlyKeys(raw.planner, ['maxElements', 'countParam', 'system'], 'planner')
  if (!Number.isInteger(raw.planner.maxElements) || raw.planner.maxElements < 1 || raw.planner.maxElements > 8) {
    fail('planner.maxElements', '须为 1~8 的整数')
  }
  if (raw.planner.countParam != null) {
    const cp = raw.params.find((x) => x.id === raw.planner.countParam)
    if (!cp || cp.type !== 'number' || cp.min !== 0 || cp.max > raw.planner.maxElements || cp.step !== 1) {
      fail('planner.countParam', '须为 min=0、step=1、max≤maxElements 的 number 参数')
    }
  }
  str(raw.planner.system, 'planner.system', { min: 20, max: 2000 })

  const a = raw.assets
  onlyKeys(a, ['models', 'resolution', 'template', 'roles', 'avoid'], 'assets')
  strList(a.models, 'assets.models', { max: 8 })
  if (!RESOLUTIONS.includes(a.resolution)) fail('assets.resolution', `取值须为 ${RESOLUTIONS.join(' / ')}`)
  const template = str(a.template, 'assets.template', { min: 20, max: 2000 })
  const promptParams = raw.params.filter((p) => p.type === 'select' && p.options.every((o) => o.prompt)).map((p) => p.id)
  for (const m of template.matchAll(PLACEHOLDER_RE)) {
    if (!ASSET_VARS.includes(m[1]) && !promptParams.includes(m[1])) {
      fail('assets.template', `占位符 {{${m[1]}}} 只能是 ${ASSET_VARS.join(' / ')} 或每个选项都带 prompt 的 select 参数`)
    }
  }
  if (!/\{\{\s*draw\s*\}\}/.test(template)) fail('assets.template', '必须包含 {{draw}}')
  if (/\{\{|\}\}/.test(template.replace(PLACEHOLDER_RE, ''))) fail('assets.template', '存在不合法的花括号')
  onlyKeys(a.roles, ROLES, 'assets.roles')
  for (const r of ROLES) str(a.roles[r], `assets.roles.${r}`, { max: 300 })
  strList(a.avoid, 'assets.avoid', { min: 0, max: 40 })
}

function readPackDir(dir) {
  let raw
  try {
    raw = JSON.parse(readFileSync(path.join(dir, 'skill.json'), 'utf8'))
  } catch (e) {
    throw new PackError(`skill.json 解析失败: ${e instanceof Error ? e.message : e}`)
  }
  return { pack: validateSkillPack(raw, dir), dir }
}

export function scanSkillPacks() {
  const packs = new Map()
  const errors = []
  for (const base of [BUILTIN_SKILL_DIR, USER_SKILL_DIR]) {
    if (!existsSync(base)) continue
    for (const name of readdirSync(base)) {
      const dir = path.join(base, name)
      if (!statSync(dir).isDirectory() || !existsSync(path.join(dir, 'skill.json'))) continue
      try {
        const entry = readPackDir(dir)
        packs.set(entry.pack.id, entry)
      } catch (e) {
        errors.push({ dir, error: e instanceof Error ? e.message : String(e) })
      }
    }
  }
  return { packs, errors }
}

export function getSkillEntry(skillId) {
  const entry = scanSkillPacks().packs.get(String(skillId || ''))
  if (!entry) throw new Error(`未找到技能包 ${skillId}`)
  return entry
}

/** 给前端的公开描述（不含规划提示词、素材模板与路径） */
export function publicSkill({ pack }) {
  return {
    id: pack.id,
    name: pack.name,
    version: pack.version,
    author: pack.author,
    description: pack.description,
    tags: pack.tags || [],
    previews: (pack.previews || []).map((_, i) => `/api/ai-skills/${encodeURIComponent(pack.id)}/previews/${i}`),
    input: { ...pack.input },
    output: { ...pack.output },
    params: pack.params.map((p) => (p.type === 'select'
      ? { ...p, options: p.options.map(({ value, label, hint }) => ({ value, label, hint })) }
      : { ...p })),
    quick: pack.quick ?? null,
    pipeline: pack.pipeline,
    planner: pack.planner ? { maxElements: pack.planner.maxElements, countParam: pack.planner.countParam ?? null } : null,
    assets: pack.assets ? { models: pack.assets.models, resolution: pack.assets.resolution } : null,
  }
}

/** 口播文案：保留分段换行（TTS 按句切、字幕按文案认字），其余空白压成一个空格 */
export function cleanScript(v) {
  return String(v ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function listSkillPacks() {
  const { packs, errors } = scanSkillPacks()
  return { skills: [...packs.values()].map(publicSkill), errors }
}

export function skillPreviewPath(skillId, index) {
  const entry = scanSkillPacks().packs.get(String(skillId || ''))
  const rel = entry?.pack.previews?.[index]
  return rel ? path.join(entry.dir, rel) : null
}

/** 参数：缺省取默认；越界 / 未声明 / 非法选项一律拒绝 */
export function resolveSkillParams(pack, raw) {
  const given = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  for (const k of Object.keys(given)) {
    if (!pack.params.some((p) => p.id === k)) throw new Error(`技能「${pack.name}」没有参数 "${k}"`)
  }
  const out = {}
  for (const p of pack.params) {
    const v = given[p.id]
    if (p.type === 'select') {
      const s = v == null ? p.default : String(v)
      if (!p.options.some((o) => o.value === s)) throw new Error(`「${p.label}」不支持选项 "${s}"`)
      out[p.id] = s
    } else if (p.type === 'text') {
      if (v != null && typeof v !== 'string') throw new Error(`「${p.label}」须为文本`)
      out[p.id] = (v ?? p.default).trim().slice(0, p.maxLength)
    } else {
      const n = v == null || v === '' ? p.default : Number(v)
      if (!Number.isFinite(n) || n < p.min || n > p.max) throw new Error(`「${p.label}」须在 ${p.min}~${p.max}`)
      const steps = Math.round((n - p.min) / p.step)
      out[p.id] = Math.round((p.min + steps * p.step) * 1000) / 1000
    }
  }
  // 文本参数只在可见时校验格式（when 依赖的 select 已解析完）
  for (const p of pack.params) {
    if (p.type !== 'text') continue
    const visible = !p.when || Object.entries(p.when).every(([k, vals]) => vals.includes(out[k]))
    if (visible && !new RegExp(p.pattern).test(out[p.id])) throw new Error(`「${p.label}」格式不对`)
  }
  return out
}

export function skillAlpha(pack, params) {
  const w = pack.output.alphaWhen
  return !!w && Object.entries(w).every(([k, vals]) => vals.includes(params[k]))
}

/** 规划结果：LLM 或用户编辑的都走这一道 */
export function sanitizePlan(raw, pack, { strict = false, count = 0 } = {}) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
  if (!r) throw new Error('规划不是对象')
  const max = pack.planner.maxElements
  const list = Array.isArray(r.elements) ? r.elements : []
  if (strict && list.length > max) throw new Error(`最多 ${max} 个元素`)
  const elements = []
  for (const [i, e] of list.entries()) {
    if (elements.length >= (count || max)) break
    const draw = cleanText(e?.draw).slice(0, DRAW_MAX)
    if (!draw) {
      if (strict) throw new Error(`第 ${i + 1} 个元素缺少画面描述`)
      continue
    }
    const role = ROLES.includes(e?.role) ? e.role : elements.length === 0 ? 'hero' : 'support'
    const w = Number(e?.weight)
    const weight = Number.isFinite(w) ? Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, Math.round(w * 10) / 10)) : role === 'hero' ? 1.5 : 1
    elements.push({ label: cleanText(e?.label).slice(0, LABEL_MAX) || `元素 ${elements.length + 1}`, draw, role, weight })
  }
  if (!elements.length) throw new Error('规划里没有可用的元素')
  return { title: cleanText(r.title).slice(0, 12) || elements[0].label, notes: cleanText(r.notes).slice(0, 120), elements }
}

/**
 * 请求 → 可入队的任务描述。plan 可选：给了就按用户编辑版执行，不给则运行时由 AI 规划。
 * @returns {{ prompt: string, params: object, plan: object|null, alpha: boolean, meta: object }}
 */
export function compileSkillJob(entry, req) {
  const { pack } = entry
  const voice = pack.pipeline !== 'elements'
  const prompt = voice ? cleanScript(req.prompt) : cleanText(req.prompt)
  if (!prompt) throw new Error(`请填写「${pack.input.label}」`)
  if (prompt.length > pack.input.maxLength) throw new Error(`「${pack.input.label}」最多 ${pack.input.maxLength} 字`)
  if (voice && !/[\p{L}\p{N}]/u.test(prompt)) throw new Error(`「${pack.input.label}」里没有可朗读的文字`)
  const params = resolveSkillParams(pack, req.params)
  if (voice && req.plan != null) throw new Error(`技能「${pack.name}」不接受元素规划`)
  const count = pack.planner?.countParam ? params[pack.planner.countParam] : 0
  const plan = req.plan == null ? null : sanitizePlan(req.plan, pack, { strict: true })
  if (plan && count && plan.elements.length !== count) throw new Error(`规划有 ${plan.elements.length} 个元素，与「元素数」${count} 不符`)
  const alpha = skillAlpha(pack, params)
  return {
    prompt,
    params,
    plan,
    alpha,
    meta: { id: pack.id, version: pack.version, name: pack.name, pipeline: pack.pipeline, summary: prompt.slice(0, 60), alpha },
  }
}

export function compileSkillById(skillId, req) {
  return compileSkillJob(getSkillEntry(skillId), req)
}

export function buildPlannerMessages(pack, prompt, params) {
  const count = pack.planner.countParam ? params[pack.planner.countParam] : 0
  const max = pack.planner.maxElements
  const system = [
    pack.planner.system,
    '',
    '只输出一个 JSON 对象，不要解释：',
    '{',
    '  "title": "不超过 12 字的中文标题",',
    `  "elements": [ ${count ? `恰好 ${count} 个` : `1~${max} 个（通常 2~4 个）`}，按书写先后排列，每个：`,
    `    { "label": "不超过 ${LABEL_MAX} 字的中文名", "draw": "英文画面描述，具体到物件、人物动作和短标签文字，不超过 ${DRAW_MAX} 字符", "role": "hero | support | accent", "weight": ${WEIGHT_MIN}~${WEIGHT_MAX} 书写时长权重 }`,
    '  ],',
    '  "notes": "一句话说明怎么拆的"',
    '}',
    '要求：第一个元素 role=hero、weight 最大；元素之间要有叙事先后，合起来讲清用户这句话；不要发明用户没说的数字和概念。',
  ].join('\n')
  return [{ role: 'system', content: system }, { role: 'user', content: String(prompt).slice(0, pack.input.maxLength) }]
}

async function chatPlanner(config, messages) {
  if (!config?.apiKey) throw new Error('请先配置 API Key')
  const res = await fetch(`${normalizeBaseUrl(config.baseUrl)}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: SKILL_PLANNER_MODEL, messages, temperature: 0.6 }),
    // 长口播的分板 JSON 可能上万 token
    signal: AbortSignal.timeout(300_000),
  })
  const text = await res.text()
  let payload = {}
  try { payload = JSON.parse(text) } catch { payload = { error: text.slice(0, 300) } }
  if (!res.ok) throw new Error(String(payload?.error?.message || payload?.error || `AI 规划请求失败 (${res.status})`))
  return extractJson(payload?.choices?.[0]?.message?.content)
}

export async function planSkill(config, entry, prompt, params) {
  if (!entry.pack.planner) throw new Error(`技能「${entry.pack.name}」不需要规划`)
  if (entry.pack.pipeline === 'narrated') throw new Error(`技能「${entry.pack.name}」按配音时间自动拆分，不支持预先规划`)
  const raw = await chatPlanner(config, buildPlannerMessages(entry.pack, prompt, params))
  const count = entry.pack.planner.countParam ? params[entry.pack.planner.countParam] : 0
  return sanitizePlan(raw, entry.pack, { count })
}

// ── narrated：口播 → 配音短语 → 分板 + 元素 ─────────────────────────

/**
 * TTS_timeline 的 timing.json → 扁平短语表（句内按逗号切开的最小时间单元）。
 * @returns {{ i: number, sentence: number, text: string, start: number, end: number }[]} 秒
 */
export function timingPhrases(timing) {
  const out = []
  for (const [si, s] of (timing?.sentences ?? []).entries()) {
    const list = s.phrases?.length ? s.phrases : [s]
    for (const p of list) {
      const text = String(p.text ?? '').trim()
      if (!text || !Number.isFinite(p.start) || !Number.isFinite(p.end)) continue
      out.push({ i: out.length, sentence: si, text, start: p.start, end: Math.max(p.start, p.end) })
    }
  }
  return out
}

export function buildNarrationPlannerMessages(pack, phrases, params) {
  const perScene = pack.planner.maxElements
  const maxScenes = Number(params.scenes) || 0
  const total = phrases.at(-1)?.end ?? 0
  const system = [
    pack.planner.system,
    '',
    '输入是一条口播的短语表，每行「[编号] 开始秒数 | 短语」，空行分隔句子。短语编号就是时间锚点。',
    '只输出一个 JSON 对象，不要解释：',
    '{',
    '  "title": "不超过 12 字的中文标题",',
    '  "scenes": [ 按时间先后排列的黑板，每块：',
    '    { "start": 这块黑板从哪个短语编号开始（第一块必须是 0）,',
    `      "elements": [ 1~${perScene} 个，按出现先后排列，每个：`,
    `        { "at": 说到哪个短语时开始画（编号，须落在本块黑板的短语范围内）, "label": "不超过 ${LABEL_MAX} 字的中文名", "draw": "英文画面描述，具体到物件、人物动作和短标签文字，不超过 ${DRAW_MAX} 字符", "role": "hero | support | accent" } ] }`,
    '  ],',
    '  "notes": "一句话说明怎么拆的"',
    '}',
    '拆分规则：',
    '1. 按意思换板：一块黑板讲一件事，话题转折、进入下一个要点时才换板；换板点只能落在句子开头。',
    maxScenes
      ? `2. 恰好 ${maxScenes} 块黑板（短语不够时可以更少）。`
      : `2. 黑板数按内容定，大约每 8~15 秒一块（本条口播约 ${Math.round(total)} 秒），最多 ${NARRATED_MAX_SCENES} 块。`,
    `3. 元素要在讲到它的那一刻出现：at 选第一次提到这个东西的短语；同一块黑板里 at 递增，相邻元素最好隔开一两个短语，给书写留时间；全篇元素合计不超过 ${NARRATED_MAX_ELEMENTS} 个。`,
    '4. 每块黑板第一个元素 role=hero；关键数字、结论可以用 accent 写成 ≤6 字的粉笔大字。',
    '5. 只画口播里说到的东西，不要发明数字和概念。',
  ].join('\n')
  const lines = []
  for (const [k, p] of phrases.entries()) {
    if (k > 0 && p.sentence !== phrases[k - 1].sentence) lines.push('')
    lines.push(`[${p.i}] ${p.start.toFixed(1)}s | ${p.text}`)
  }
  return [{ role: 'system', content: system }, { role: 'user', content: lines.join('\n') }]
}

/**
 * LLM 输出 → 合法分板：换板点对齐句首、递增、首块从 0 开始；元素锚点夹进本块范围并递增；空板并入前一块。
 * @returns {{ title: string, notes: string, scenes: { start: number, elements: { at: number, label: string, draw: string, role: string, weight: number }[] }[] }}
 */
export function sanitizeNarrationPlan(raw, pack, phrases, { maxScenes = 0 } = {}) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
  if (!r) throw new Error('规划不是对象')
  const n = phrases.length
  if (!n) throw new Error('配音没有短语时间戳')
  const perScene = pack.planner.maxElements
  const sceneCap = Math.min(NARRATED_MAX_SCENES, maxScenes || NARRATED_MAX_SCENES)
  const sentenceHead = (i) => {
    let k = Math.min(n - 1, Math.max(0, Math.round(Number(i) || 0)))
    while (k > 0 && phrases[k - 1].sentence === phrases[k].sentence) k--
    return k
  }
  const list = (Array.isArray(r.scenes) ? r.scenes : [])
    .map((s) => ({ start: sentenceHead(s?.start), elements: (Array.isArray(s?.elements) ? s.elements : []).filter((e) => cleanText(e?.draw)) }))
    .filter((s) => s.elements.length)
    .sort((a, b) => a.start - b.start)
  const scenes = []
  for (const s of list) {
    const last = scenes.at(-1)
    if (last && last.start === s.start) last.elements.push(...s.elements)
    else scenes.push({ start: scenes.length ? s.start : 0, elements: [...s.elements] })
  }
  while (scenes.length > sceneCap) {
    const tail = scenes.pop()
    scenes.at(-1).elements.push(...tail.elements)
  }
  let total = 0
  const out = []
  for (const [k, s] of scenes.entries()) {
    const end = k + 1 < scenes.length ? scenes[k + 1].start : n
    const els = []
    for (const e of s.elements) {
      if (els.length >= perScene || total >= NARRATED_MAX_ELEMENTS) break
      const draw = cleanText(e?.draw).slice(0, DRAW_MAX)
      if (!draw) continue
      const at = Math.min(end - 1, Math.max(s.start, Math.round(Number(e?.at) || s.start)))
      const role = ROLES.includes(e?.role) ? e.role : els.length === 0 ? 'hero' : 'support'
      els.push({ at, label: cleanText(e?.label).slice(0, LABEL_MAX) || `元素 ${total + 1}`, draw, role, weight: role === 'hero' ? 1.5 : 1 })
      total++
    }
    els.sort((a, b) => a.at - b.at)
    // 只会因总元素数用完而为空：后面的内容留在上一块黑板上
    if (els.length) out.push({ start: out.length ? s.start : 0, elements: els })
  }
  if (!out.length) throw new Error('规划里没有可用的元素')
  return { title: cleanText(r.title).slice(0, 12) || out[0].elements[0].label, notes: cleanText(r.notes).slice(0, 120), scenes: out }
}

export async function planNarration(config, entry, phrases, params) {
  const raw = await chatPlanner(config, buildNarrationPlannerMessages(entry.pack, phrases, params))
  return sanitizeNarrationPlan(raw, entry.pack, phrases, { maxScenes: Number(params.scenes) || 0 })
}

/** 规划器不可用时：每句一块黑板（超出上限时相邻句合并），整句当主视觉 */
export function fallbackNarrationPlan(pack, phrases) {
  const heads = phrases.filter((p, k) => k === 0 || p.sentence !== phrases[k - 1].sentence)
  const step = Math.ceil(heads.length / NARRATED_MAX_SCENES) || 1
  const scenes = []
  for (let k = 0; k < heads.length; k += step) {
    const group = phrases.filter((p) => p.sentence >= heads[k].sentence && p.sentence < (heads[k + step]?.sentence ?? Infinity))
    const text = group.map((p) => p.text).join('')
    scenes.push({ start: heads[k].i, elements: [{ at: heads[k].i, label: text.slice(0, LABEL_MAX), draw: text, role: 'hero' }] })
  }
  return sanitizeNarrationPlan({ title: phrases.map((p) => p.text).join('').slice(0, 12), scenes }, pack, phrases)
}

/** 规划器不可用时的兜底：整句当成一个主视觉元素 */
export function fallbackPlan(pack, prompt) {
  return sanitizePlan({ title: prompt.slice(0, 12), elements: [{ label: prompt.slice(0, LABEL_MAX), draw: prompt, role: 'hero', weight: 1.5 }] }, pack)
}

/** 元素 → 生图提示词；画幅：单元素跟随输出画幅，多元素用 1:1 便于排版 */
export function assetPrompt(pack, element, params) {
  const a = pack.assets
  const vars = { draw: element.draw, label: element.label, role: a.roles[element.role] }
  for (const p of pack.params) {
    if (p.type === 'select' && p.options.every((o) => o.prompt)) vars[p.id] = p.options.find((o) => o.value === params[p.id]).prompt
  }
  let prompt = a.template.replace(PLACEHOLDER_RE, (_, id) => vars[id] ?? '')
  if (a.avoid.length) prompt += ` Avoid: ${a.avoid.join(', ')}.`
  return prompt
}

export function assetAspect(params, count) {
  if (count > 1) return '1:1'
  const [w, h] = String(params.size || '1280x720').split('x').map(Number)
  if (!w || !h) return '1:1'
  const r = w / h
  return r > 1.3 ? '16:9' : r < 0.77 ? '9:16' : '1:1'
}
