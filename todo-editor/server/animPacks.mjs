/**
 * 风格动画包（Anim Pack）加载 / 严格校验 / 编译成关键帧生成计划。
 * 规范：todo-anim-pack/1 —— 纯数据；关键帧提示词 = 包模板 + 受限输入 + 代码内置的分镜包装。
 *
 * 目录：server/anims/<name>/anim.json（内置）、$TODO_DATA_DIR/anims/<name>/anim.json（用户，同 id 覆盖内置）
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ASPECT_RATIOS, ID_RE, PLACEHOLDER_RE, PackError, RESOLUTIONS, SEMVER_RE,
  checkPackImage, cleanText, fail, onlyKeys, str, strList, validateCutoutCore, validateInput,
} from './stylePacks.mjs'

export const ANIM_SPEC = 'todo-anim-pack/1'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = process.env.TODO_DATA_DIR
  ? path.resolve(process.env.TODO_DATA_DIR)
  : path.join(ROOT, '.data')

export const BUILTIN_ANIM_DIR = path.join(ROOT, 'server', 'anims')
export const USER_ANIM_DIR = path.join(DATA_DIR, 'anims')

export const KEYFRAME_MODES = ['sheet', 'sequence']
export const LOOP_MODES = ['forward', 'pingpong']
const ALIGN_MODES = ['none', 'baseline']
/** 关键帧数 → 拼图网格 [列, 行] 与整张拼图画幅 */
export const SHEET_GRIDS = {
  4: { cols: 2, rows: 2, aspect: '1:1' },
  6: { cols: 3, rows: 2, aspect: '3:2' },
  8: { cols: 4, rows: 2, aspect: '16:9' },
  9: { cols: 3, rows: 3, aspect: '1:1' },
  12: { cols: 4, rows: 3, aspect: '4:3' },
}
const FRAME_COUNTS = Object.keys(SHEET_GRIDS).map(Number)
const PREVIEW_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif']
const BEAT_MAX = 80

function intList(v, where, { allowed, min, max }) {
  if (!Array.isArray(v) || v.length < 1 || v.length > 12) fail(where, '须为 1~12 项的数组')
  const seen = new Set()
  for (const [i, x] of v.entries()) {
    if (!Number.isInteger(x)) fail(`${where}[${i}]`, '必须是整数')
    if (allowed && !allowed.includes(x)) fail(`${where}[${i}]`, `取值须为 ${allowed.join(' / ')}`)
    if (min != null && (x < min || x > max)) fail(`${where}[${i}]`, `须在 ${min}~${max}`)
    if (seen.has(x)) fail(`${where}[${i}]`, `重复值 ${x}`)
    seen.add(x)
  }
  return v
}

/** 严格校验 anim.json；packDir 用于检查预览图 */
export function validateAnimPack(raw, packDir) {
  onlyKeys(raw, [
    '$schema', 'spec', 'id', 'name', 'version', 'author', 'description', 'tags',
    'outputs', 'inputs', 'prompt', 'keyframes', 'playback', 'image', 'previews', 'cutout',
  ], 'anim.json')
  if (raw.spec !== ANIM_SPEC) fail('spec', `必须为 "${ANIM_SPEC}"`)
  if (!ID_RE.test(String(raw.id || ''))) fail('id', '须形如 author.anim-name（小写）')
  str(raw.name, 'name', { max: 24 })
  if (!SEMVER_RE.test(String(raw.version || ''))) fail('version', '须为 x.y.z')
  str(raw.author, 'author', { max: 60 })
  str(raw.description, 'description', { max: 200 })
  if (raw.tags != null) {
    strList(raw.tags, 'tags', { min: 0, max: 8 })
    raw.tags.forEach((t, i) => { if (t.length > 12) fail(`tags[${i}]`, '最多 12 字') })
  }
  strList(raw.outputs, 'outputs', { allowed: ['animation'], max: 1 })

  if (!Array.isArray(raw.inputs) || raw.inputs.length < 1 || raw.inputs.length > 8) fail('inputs', '须为 1~8 项')
  raw.inputs.forEach(validateInput)
  const ids = raw.inputs.map((x) => x.id)
  if (new Set(ids).size !== ids.length) fail('inputs', 'id 重复')
  if (!raw.inputs.some((x) => x.type === 'text' && x.required)) fail('inputs', '至少需要一个必填的 text 输入')

  onlyKeys(raw.prompt, ['template', 'avoid'], 'prompt')
  const template = str(raw.prompt.template, 'prompt.template', { min: 20, max: 2000 })
  const used = new Set([...template.matchAll(PLACEHOLDER_RE)].map((m) => m[1]))
  for (const u of used) if (!ids.includes(u)) fail('prompt.template', `占位符 {{${u}}} 未在 inputs 中声明`)
  for (const id of ids) if (!used.has(id)) fail('prompt.template', `输入 "${id}" 未在模板中使用`)
  if (/\{\{|\}\}/.test(template.replace(PLACEHOLDER_RE, ''))) fail('prompt.template', '存在不合法的花括号')
  strList(raw.prompt.avoid, 'prompt.avoid', { min: 0, max: 40 })

  const k = raw.keyframes
  onlyKeys(k, ['modes', 'defaultMode', 'counts', 'defaultCount', 'align'], 'keyframes')
  strList(k.modes, 'keyframes.modes', { allowed: KEYFRAME_MODES })
  if (!k.modes.includes(k.defaultMode)) fail('keyframes.defaultMode', '须在 modes 中')
  intList(k.counts, 'keyframes.counts', { allowed: FRAME_COUNTS })
  if (!k.counts.includes(k.defaultCount)) fail('keyframes.defaultCount', '须在 counts 中')
  if (!ALIGN_MODES.includes(k.align)) fail('keyframes.align', `取值须为 ${ALIGN_MODES.join(' / ')}`)

  const p = raw.playback
  onlyKeys(p, ['fps', 'defaultFps', 'loops', 'defaultLoop', 'maxRepeat'], 'playback')
  intList(p.fps, 'playback.fps', { min: 1, max: 30 })
  if (!p.fps.includes(p.defaultFps)) fail('playback.defaultFps', '须在 fps 中')
  strList(p.loops, 'playback.loops', { allowed: LOOP_MODES })
  if (!p.loops.includes(p.defaultLoop)) fail('playback.defaultLoop', '须在 loops 中')
  if (!Number.isInteger(p.maxRepeat) || p.maxRepeat < 1 || p.maxRepeat > 20) fail('playback.maxRepeat', '须为 1~20 的整数')

  onlyKeys(raw.image, ['models', 'aspectRatios', 'defaultAspectRatio', 'resolutions', 'defaultResolution'], 'image')
  strList(raw.image.models, 'image.models', { max: 8 })
  strList(raw.image.aspectRatios, 'image.aspectRatios', { allowed: ASPECT_RATIOS })
  if (!raw.image.aspectRatios.includes(raw.image.defaultAspectRatio)) fail('image.defaultAspectRatio', '须在 aspectRatios 中')
  strList(raw.image.resolutions, 'image.resolutions', { allowed: RESOLUTIONS })
  if (!raw.image.resolutions.includes(raw.image.defaultResolution)) fail('image.defaultResolution', '须在 resolutions 中')

  if (raw.previews != null) {
    strList(raw.previews, 'previews', { min: 1, max: 8 })
    raw.previews.forEach((rel, i) => checkPackImage(packDir, rel, `previews[${i}]`, PREVIEW_EXT))
  }
  if (raw.cutout != null) {
    onlyKeys(raw.cutout, ['method', 'threshold', 'default', 'lockInputs'], 'cutout')
    validateCutoutCore(raw.cutout, raw.inputs)
  }
  return raw
}

function readPackDir(dir) {
  let raw
  try {
    raw = JSON.parse(readFileSync(path.join(dir, 'anim.json'), 'utf8'))
  } catch (e) {
    throw new PackError(`anim.json 解析失败: ${e instanceof Error ? e.message : e}`)
  }
  return { pack: validateAnimPack(raw, dir), dir }
}

export function scanAnimPacks() {
  const packs = new Map()
  const errors = []
  for (const base of [BUILTIN_ANIM_DIR, USER_ANIM_DIR]) {
    if (!existsSync(base)) continue
    for (const name of readdirSync(base)) {
      const dir = path.join(base, name)
      if (!statSync(dir).isDirectory() || !existsSync(path.join(dir, 'anim.json'))) continue
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
export function publicAnim({ pack }) {
  return {
    id: pack.id,
    name: pack.name,
    version: pack.version,
    author: pack.author,
    description: pack.description,
    tags: pack.tags || [],
    previews: (pack.previews || []).map((_, i) => `/api/ai-anims/${encodeURIComponent(pack.id)}/previews/${i}`),
    outputs: pack.outputs,
    inputs: pack.inputs.map((x) => (x.type === 'select'
      ? { id: x.id, type: x.type, label: x.label, default: x.default, options: x.options.map((o) => ({ value: o.value, label: o.label })) }
      : { id: x.id, type: x.type, label: x.label, required: !!x.required, maxLength: x.maxLength, placeholder: x.placeholder || '' })),
    keyframes: { ...pack.keyframes },
    playback: { ...pack.playback },
    image: { ...pack.image },
    cutout: pack.cutout ? { default: pack.cutout.default, lockInputs: pack.cutout.lockInputs || {} } : null,
  }
}

export function listAnimPacks() {
  const { packs, errors } = scanAnimPacks()
  return { anims: [...packs.values()].map(publicAnim), errors }
}

export function animPreviewPath(animId, index) {
  const entry = scanAnimPacks().packs.get(String(animId || ''))
  const rel = entry?.pack.previews?.[index]
  return rel ? path.join(entry.dir, rel) : null
}

function pick(value, allowed, fallback, what, packName) {
  const v = value ?? fallback
  if (!allowed.includes(v)) throw new Error(`风格动画「${packName}」不支持${what} ${v}`)
  return v
}

/**
 * 请求 → 关键帧生成计划。越界输入一律拒绝。
 * req: { inputs, mode, frames, fps, loop, repeat, aspectRatio, resolution, model, alpha, beats }
 */
export function compileAnimJob(entry, req) {
  const { pack } = entry
  const name = pack.name
  const inputs = req.inputs && typeof req.inputs === 'object' ? req.inputs : {}
  for (const k of Object.keys(inputs)) {
    if (!pack.inputs.some((x) => x.id === k)) throw new Error(`风格动画「${name}」没有输入项 "${k}"`)
  }

  if (req.alpha != null && typeof req.alpha !== 'boolean') throw new Error('alpha 必须是布尔值')
  const alpha = req.alpha ?? pack.cutout?.default ?? false
  if (alpha && !pack.cutout) throw new Error(`风格动画「${name}」不支持透明通道`)
  const locked = alpha ? pack.cutout.lockInputs || {} : {}

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

  const mode = pick(req.mode, pack.keyframes.modes, pack.keyframes.defaultMode, '关键帧模式', name)
  const frames = pick(req.frames == null ? undefined : Number(req.frames), pack.keyframes.counts, pack.keyframes.defaultCount, '关键帧数', name)
  const fps = pick(req.fps == null ? undefined : Number(req.fps), pack.playback.fps, pack.playback.defaultFps, '帧率', name)
  const loop = pick(req.loop, pack.playback.loops, pack.playback.defaultLoop, '循环方式', name)
  const repeat = req.repeat == null ? 1 : Number(req.repeat)
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > pack.playback.maxRepeat) {
    throw new Error(`重复次数须为 1~${pack.playback.maxRepeat}`)
  }
  const resolution = pick(req.resolution, pack.image.resolutions, pack.image.defaultResolution, '分辨率', name)
  const model = pick(req.model, pack.image.models, pack.image.models[0], '模型', name)
  // 拼图模式的画幅由网格决定；逐帧模式才用用户画幅
  const aspectRatio = mode === 'sheet'
    ? SHEET_GRIDS[frames].aspect
    : pick(req.aspectRatio, pack.image.aspectRatios, pack.image.defaultAspectRatio, '画幅', name)

  const rawBeats = req.beats == null ? [] : req.beats
  if (!Array.isArray(rawBeats) || rawBeats.length > frames) throw new Error(`分镜最多 ${frames} 条`)
  const beats = Array.from({ length: frames }, (_, i) => {
    const s = cleanText(rawBeats[i])
    if (s.length > BEAT_MAX) throw new Error(`第 ${i + 1} 帧分镜最多 ${BEAT_MAX} 字`)
    return s
  })

  let base = pack.prompt.template.replace(PLACEHOLDER_RE, (_, id) => values[id])
  if (pack.prompt.avoid.length) base += ` Avoid: ${pack.prompt.avoid.join(', ')}.`
  const summary = pack.inputs.filter((x) => x.type === 'text' && x.required).map((x) => resolved[x.id]).join(' · ')

  return {
    basePrompt: base,
    mode,
    frames,
    grid: mode === 'sheet' ? { cols: SHEET_GRIDS[frames].cols, rows: SHEET_GRIDS[frames].rows } : null,
    beats,
    fps,
    loop,
    repeat,
    align: pack.keyframes.align,
    aspectRatio,
    resolution,
    model,
    cutout: alpha ? { method: pack.cutout.method, threshold: pack.cutout.threshold } : null,
    meta: {
      id: pack.id,
      version: pack.version,
      name,
      inputs: resolved,
      summary,
      alpha,
      mode,
      frames,
      fps,
      loop,
      repeat,
    },
  }
}

export function compileAnimById(animId, req) {
  const entry = scanAnimPacks().packs.get(String(animId || ''))
  if (!entry) throw new Error(`未找到风格动画包 ${animId}`)
  return compileAnimJob(entry, req)
}

function beatText(beat, i, n) {
  if (beat) return beat
  const pct = n > 1 ? Math.round((i / (n - 1)) * 100) : 0
  if (i === 0) return 'the starting pose of the action'
  if (i === n - 1) return 'the ending pose of the action'
  return `an in-between key pose about ${pct}% through the action`
}

/** 拼图模式：一次生成整张关键帧网格 */
export function sheetPrompt(plan, { hasRef = false } = {}) {
  const { cols, rows } = plan.grid
  const n = plan.frames
  const poses = plan.beats.map((b, i) => `cell ${i + 1}: ${beatText(b, i, n)}`).join('; ')
  return [
    `Animation keyframe sheet: ${n} equal-size cells in a strict grid of ${cols} columns and ${rows} rows, read left to right, top to bottom,`,
    `showing ${n} successive key poses of one continuous motion from start to finish (${poses}).`,
    'Every cell shows the exact same character at the same scale, in the same position inside its cell, on the same ground line, from the same camera angle; only the pose changes between cells.',
    'The whole character stays fully inside its own cell with some empty margin. Cells are separated only by empty background: no borders, no grid lines, no frame numbers, no captions, no text.',
    hasRef ? 'The character must match the character in the reference image exactly.' : '',
    `Character and art style: ${plan.basePrompt}`,
  ].filter(Boolean).join(' ')
}

/** 逐帧模式：第 i 帧（0 起）的提示词；i>0 或有参考图时基于参考图重绘 */
export function framePrompt(plan, i, { fromRef }) {
  const pose = beatText(plan.beats[i], i, plan.frames)
  if (!fromRef) {
    return `${plan.basePrompt} Pose: ${pose}. Full body, centered in the frame, with generous empty margin around the character.`
  }
  return [
    'Redraw the exact same character from the reference image: identical design, proportions, clothes, colors, line style, scale, camera angle and position in the frame, on the same background.',
    `Change only the pose to: ${pose}.`,
    `Art style: ${plan.basePrompt}`,
  ].join(' ')
}
