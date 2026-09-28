/**
 * 风格包（Style Pack）加载 / 严格校验 / 编译成最终生图参数。
 * 规范：todo-style-pack/1 —— 纯数据，不含代码；最终提示词只能由模板 + 受限输入拼出。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const STYLE_SPEC = 'todo-style-pack/1'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = process.env.TODO_DATA_DIR
  ? path.resolve(process.env.TODO_DATA_DIR)
  : path.join(ROOT, '.data')

export const BUILTIN_STYLE_DIR = path.join(ROOT, 'server', 'styles')
export const USER_STYLE_DIR = path.join(DATA_DIR, 'styles')

const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '3:2', '2:3', '4:3', '3:4']
const RESOLUTIONS = ['1K', '2K', '4K']
const REF_EXT = ['.png', '.jpg', '.jpeg', '.webp']
const CUTOUT_METHODS = ['keyWhite']
const ID_RE = /^[a-z0-9]+(\.[a-z0-9][a-z0-9-]*)+$/
const INPUT_ID_RE = /^[a-z][a-zA-Z0-9_]{0,31}$/
const SEMVER_RE = /^\d+\.\d+\.\d+$/
const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g

class PackError extends Error {}

function fail(where, msg) {
  throw new PackError(`${where}: ${msg}`)
}

function onlyKeys(obj, allowed, where) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) fail(where, '必须是对象')
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) fail(where, `不允许的字段 "${k}"`)
  }
}

function str(v, where, { min = 1, max = 200, optional = false } = {}) {
  if (v == null && optional) return undefined
  if (typeof v !== 'string') fail(where, '必须是字符串')
  const s = v.trim()
  if (s.length < min || s.length > max) fail(where, `长度须在 ${min}~${max}`)
  return s
}

function strList(v, where, { allowed, min = 1, max = 20 } = {}) {
  if (!Array.isArray(v)) fail(where, '必须是数组')
  if (v.length < min || v.length > max) fail(where, `数量须在 ${min}~${max}`)
  const seen = new Set()
  for (const [i, x] of v.entries()) {
    str(x, `${where}[${i}]`, { max: 120 })
    if (allowed && !allowed.includes(x)) fail(`${where}[${i}]`, `取值须为 ${allowed.join(' / ')}`)
    if (seen.has(x)) fail(`${where}[${i}]`, `重复值 "${x}"`)
    seen.add(x)
  }
  return v
}

function validateInput(inp, i) {
  const where = `inputs[${i}]`
  if (!inp || typeof inp !== 'object') fail(where, '必须是对象')
  if (!INPUT_ID_RE.test(String(inp.id || ''))) fail(`${where}.id`, '须为小写字母开头的标识符')
  str(inp.label, `${where}.label`, { max: 24 })
  if (inp.type === 'text') {
    onlyKeys(inp, ['id', 'type', 'label', 'required', 'maxLength', 'placeholder'], where)
    if (inp.required != null && typeof inp.required !== 'boolean') fail(`${where}.required`, '必须是布尔值')
    if (!Number.isInteger(inp.maxLength) || inp.maxLength < 1 || inp.maxLength > 500) {
      fail(`${where}.maxLength`, '必须是 1~500 的整数')
    }
    str(inp.placeholder, `${where}.placeholder`, { optional: true, max: 80 })
  } else if (inp.type === 'select') {
    onlyKeys(inp, ['id', 'type', 'label', 'options', 'default'], where)
    if (!Array.isArray(inp.options) || inp.options.length < 1 || inp.options.length > 16) {
      fail(`${where}.options`, '须为 1~16 个选项')
    }
    const values = new Set()
    for (const [j, o] of inp.options.entries()) {
      const ow = `${where}.options[${j}]`
      onlyKeys(o, ['value', 'label', 'prompt'], ow)
      if (!INPUT_ID_RE.test(String(o.value || ''))) fail(`${ow}.value`, '须为标识符')
      if (values.has(o.value)) fail(`${ow}.value`, `重复值 "${o.value}"`)
      values.add(o.value)
      str(o.label, `${ow}.label`, { max: 24 })
      str(o.prompt, `${ow}.prompt`, { max: 400 })
      if (PLACEHOLDER_RE.test(o.prompt)) fail(`${ow}.prompt`, '选项片段中不允许占位符')
      PLACEHOLDER_RE.lastIndex = 0
    }
    if (!values.has(inp.default)) fail(`${where}.default`, '必须是某个选项的 value')
  } else {
    fail(`${where}.type`, '只支持 text / select')
  }
}

/** 严格校验 style.json；packDir 用于检查参考图 */
export function validateStylePack(raw, packDir) {
  onlyKeys(raw, [
    '$schema', 'spec', 'id', 'name', 'version', 'author', 'description', 'tags',
    'outputs', 'inputs', 'prompt', 'image', 'references', 'previews', 'cutout',
  ], 'style.json')
  if (raw.spec !== STYLE_SPEC) fail('spec', `必须为 "${STYLE_SPEC}"`)
  if (!ID_RE.test(String(raw.id || ''))) fail('id', '须形如 author.style-name（小写）')
  str(raw.name, 'name', { max: 24 })
  if (!SEMVER_RE.test(String(raw.version || ''))) fail('version', '须为 x.y.z')
  str(raw.author, 'author', { max: 60 })
  str(raw.description, 'description', { max: 200 })
  if (raw.tags != null) {
    strList(raw.tags, 'tags', { min: 0, max: 8 })
    raw.tags.forEach((t, i) => { if (t.length > 12) fail(`tags[${i}]`, '最多 12 字') })
  }
  strList(raw.outputs, 'outputs', { allowed: ['image'], max: 1 })

  if (!Array.isArray(raw.inputs) || raw.inputs.length < 1 || raw.inputs.length > 8) {
    fail('inputs', '须为 1~8 项')
  }
  raw.inputs.forEach(validateInput)
  const ids = raw.inputs.map((x) => x.id)
  if (new Set(ids).size !== ids.length) fail('inputs', 'id 重复')
  if (!raw.inputs.some((x) => x.type === 'text' && x.required)) {
    fail('inputs', '至少需要一个必填的 text 输入（自然语言描述）')
  }

  onlyKeys(raw.prompt, ['template', 'avoid'], 'prompt')
  const template = str(raw.prompt.template, 'prompt.template', { min: 20, max: 2000 })
  const used = new Set([...template.matchAll(PLACEHOLDER_RE)].map((m) => m[1]))
  for (const u of used) if (!ids.includes(u)) fail('prompt.template', `占位符 {{${u}}} 未在 inputs 中声明`)
  for (const id of ids) if (!used.has(id)) fail('prompt.template', `输入 "${id}" 未在模板中使用`)
  if (/\{\{|\}\}/.test(template.replace(PLACEHOLDER_RE, ''))) fail('prompt.template', '存在不合法的花括号')
  strList(raw.prompt.avoid, 'prompt.avoid', { min: 0, max: 40 })

  onlyKeys(raw.image, ['models', 'aspectRatios', 'defaultAspectRatio', 'resolutions', 'defaultResolution'], 'image')
  strList(raw.image.models, 'image.models', { max: 8 })
  strList(raw.image.aspectRatios, 'image.aspectRatios', { allowed: ASPECT_RATIOS })
  if (!raw.image.aspectRatios.includes(raw.image.defaultAspectRatio)) fail('image.defaultAspectRatio', '须在 aspectRatios 中')
  strList(raw.image.resolutions, 'image.resolutions', { allowed: RESOLUTIONS })
  if (!raw.image.resolutions.includes(raw.image.defaultResolution)) fail('image.defaultResolution', '须在 resolutions 中')

  if (raw.references != null) {
    onlyKeys(raw.references, ['images'], 'references')
    // v1 上游接口只接受一张参考图
    strList(raw.references.images, 'references.images', { min: 1, max: 1 })
    raw.references.images.forEach((rel, i) => checkPackImage(packDir, rel, `references.images[${i}]`))
  }
  if (raw.previews != null) {
    strList(raw.previews, 'previews', { min: 1, max: 8 })
    raw.previews.forEach((rel, i) => checkPackImage(packDir, rel, `previews[${i}]`))
  }
  if (raw.cutout != null) validateCutout(raw.cutout, raw.inputs)
  return raw
}

function validateCutout(c, inputs) {
  onlyKeys(c, ['method', 'threshold', 'trim', 'default', 'lockInputs'], 'cutout')
  if (!CUTOUT_METHODS.includes(c.method)) fail('cutout.method', `只支持 ${CUTOUT_METHODS.join(' / ')}`)
  if (typeof c.threshold !== 'number' || c.threshold < 0 || c.threshold > 0.5) fail('cutout.threshold', '须为 0~0.5')
  if (typeof c.trim !== 'boolean') fail('cutout.trim', '必须是布尔值')
  if (typeof c.default !== 'boolean') fail('cutout.default', '必须是布尔值')
  if (c.lockInputs != null) {
    if (!c.lockInputs || typeof c.lockInputs !== 'object' || Array.isArray(c.lockInputs)) fail('cutout.lockInputs', '必须是对象')
    for (const [k, v] of Object.entries(c.lockInputs)) {
      const inp = inputs.find((x) => x.id === k)
      if (!inp || inp.type !== 'select') fail(`cutout.lockInputs.${k}`, '只能锁定已声明的 select 输入')
      if (!inp.options.some((o) => o.value === v)) fail(`cutout.lockInputs.${k}`, `"${v}" 不是合法选项`)
    }
  }
}

function checkPackImage(packDir, rel, where) {
  if (path.isAbsolute(rel) || rel.split(/[/\\]/).includes('..')) fail(where, '必须是包内相对路径')
  if (!REF_EXT.includes(path.extname(rel).toLowerCase())) fail(where, `仅支持 ${REF_EXT.join(' ')}`)
  const abs = path.join(packDir, rel)
  if (!existsSync(abs) || !statSync(abs).isFile()) fail(where, '文件不存在')
}

function readPackDir(dir) {
  const file = path.join(dir, 'style.json')
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    throw new PackError(`style.json 解析失败: ${e instanceof Error ? e.message : e}`)
  }
  return { pack: validateStylePack(raw, dir), dir }
}

/** 扫描内置 + 用户目录；同 id 以用户目录为准 */
export function scanStylePacks() {
  const packs = new Map()
  const errors = []
  for (const base of [BUILTIN_STYLE_DIR, USER_STYLE_DIR]) {
    if (!existsSync(base)) continue
    for (const name of readdirSync(base)) {
      const dir = path.join(base, name)
      if (!statSync(dir).isDirectory() || !existsSync(path.join(dir, 'style.json'))) continue
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

/** 给前端的公开描述（不含模板与路径） */
export function publicStyle({ pack }) {
  return {
    id: pack.id,
    name: pack.name,
    version: pack.version,
    author: pack.author,
    description: pack.description,
    tags: pack.tags || [],
    previews: (pack.previews || []).map((_, i) => `/api/ai-styles/${encodeURIComponent(pack.id)}/previews/${i}`),
    outputs: pack.outputs,
    inputs: pack.inputs.map((x) => (x.type === 'select'
      ? { id: x.id, type: x.type, label: x.label, default: x.default, options: x.options.map((o) => ({ value: o.value, label: o.label })) }
      : { id: x.id, type: x.type, label: x.label, required: !!x.required, maxLength: x.maxLength, placeholder: x.placeholder || '' })),
    image: { ...pack.image },
    cutout: pack.cutout ? { default: pack.cutout.default, lockInputs: pack.cutout.lockInputs || {} } : null,
    hasReference: !!pack.references,
  }
}

export function listStylePacks() {
  const { packs, errors } = scanStylePacks()
  return { styles: [...packs.values()].map(publicStyle), errors }
}

function cleanText(v) {
  return String(v ?? '').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * 输入 → 最终生图参数。任何越界输入都直接拒绝，不做"尽量兼容"。
 * @returns {{ prompt: string, size: string, quality: string, model: string, refPath: string|null, meta: object }}
 */
export function compileStyleJob(entry, req) {
  const { pack, dir } = entry
  const inputs = req.inputs && typeof req.inputs === 'object' ? req.inputs : {}
  for (const k of Object.keys(inputs)) {
    if (!pack.inputs.some((x) => x.id === k)) throw new Error(`风格「${pack.name}」没有输入项 "${k}"`)
  }

  if (req.cutout != null && typeof req.cutout !== 'boolean') throw new Error('cutout 必须是布尔值')
  const wantCutout = req.cutout ?? pack.cutout?.default ?? false
  if (wantCutout && !pack.cutout) throw new Error(`风格「${pack.name}」不支持透明底输出`)
  const locked = wantCutout ? pack.cutout.lockInputs || {} : {}

  const values = {}
  const resolved = {}
  for (const inp of pack.inputs) {
    if (inp.type === 'select' && inp.id in locked) {
      const opt = inp.options.find((o) => o.value === locked[inp.id])
      values[inp.id] = opt.prompt
      resolved[inp.id] = opt.value
    } else if (inp.type === 'text') {
      const s = cleanText(inputs[inp.id])
      if (inp.required && !s) throw new Error(`请填写「${inp.label}」`)
      if (s.length > inp.maxLength) throw new Error(`「${inp.label}」最多 ${inp.maxLength} 字`)
      values[inp.id] = s
      resolved[inp.id] = s
    } else {
      const v = inputs[inp.id] ?? inp.default
      const opt = inp.options.find((o) => o.value === v)
      if (!opt) throw new Error(`「${inp.label}」不支持选项 "${v}"`)
      values[inp.id] = opt.prompt
      resolved[inp.id] = opt.value
    }
  }

  const size = req.aspectRatio || pack.image.defaultAspectRatio
  if (!pack.image.aspectRatios.includes(size)) throw new Error(`风格「${pack.name}」不支持画幅 ${size}`)
  const quality = req.resolution || pack.image.defaultResolution
  if (!pack.image.resolutions.includes(quality)) throw new Error(`风格「${pack.name}」不支持分辨率 ${quality}`)
  const model = req.model || pack.image.models[0]
  if (!pack.image.models.includes(model)) throw new Error(`风格「${pack.name}」不支持模型 ${model}`)

  let prompt = pack.prompt.template.replace(PLACEHOLDER_RE, (_, id) => values[id])
  if (pack.prompt.avoid.length) prompt += ` Avoid: ${pack.prompt.avoid.join(', ')}.`

  const refPath = pack.references ? path.join(dir, pack.references.images[0]) : null
  const summary = pack.inputs.find((x) => x.type === 'text' && x.required)
  return {
    prompt,
    size,
    quality,
    model,
    refPath,
    cutout: wantCutout
      ? { method: pack.cutout.method, threshold: pack.cutout.threshold, trim: pack.cutout.trim }
      : null,
    meta: {
      id: pack.id,
      version: pack.version,
      name: pack.name,
      inputs: resolved,
      summary: summary ? resolved[summary.id] : '',
      cutout: wantCutout,
    },
  }
}

/** 预览图绝对路径；只能按下标取清单里声明过的文件 */
export function stylePreviewPath(styleId, index) {
  const entry = scanStylePacks().packs.get(String(styleId || ''))
  const rel = entry?.pack.previews?.[index]
  return rel ? path.join(entry.dir, rel) : null
}

export function compileStyleById(styleId, req) {
  const { packs } = scanStylePacks()
  const entry = packs.get(String(styleId || ''))
  if (!entry) throw new Error(`未找到风格包 ${styleId}`)
  return compileStyleJob(entry, req)
}
