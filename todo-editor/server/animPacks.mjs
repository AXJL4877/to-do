/**
 * 风格动画包（Anim Pack）加载 / 严格校验 / 编译成精灵图生成计划。
 * 规范：todo-anim-pack/2 —— 纯数据；一次生成 N×N 角色精灵图（默认 5×5 = 25 帧），切格后拼成序列帧动画。
 * 精灵图提示词 = 包模板 + 受限输入 + 代码内置的网格 / 分行分镜包装。
 *
 * 目录：server/anims/<name>/anim.json（内置）、$TODO_DATA_DIR/anims/<name>/anim.json（用户，同 id 覆盖内置）
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ID_RE, PLACEHOLDER_RE, PackError, RESOLUTIONS, SEMVER_RE,
  checkPackImage, cleanText, fail, onlyKeys, str, strList, validateCutoutCore, validateInput,
} from './stylePacks.mjs'

export const ANIM_SPEC = 'todo-anim-pack/2'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = process.env.TODO_DATA_DIR
  ? path.resolve(process.env.TODO_DATA_DIR)
  : path.join(ROOT, '.data')

export const BUILTIN_ANIM_DIR = path.join(ROOT, 'server', 'anims')
export const USER_ANIM_DIR = path.join(DATA_DIR, 'anims')

export const LOOP_MODES = ['forward', 'pingpong']
const ALIGN_MODES = ['none', 'baseline']
/** 精灵图边长（格）：N×N 方形网格，整张图 1:1 */
export const SPRITE_GRIDS = [4, 5, 6]
const PREVIEW_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif']
const BEAT_MAX = 80
/** 长镜头最多拆成几张精灵图（每张一段动作，首尾相接） */
export const MAX_SEGMENTS = 6

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
    'outputs', 'inputs', 'prompt', 'sprite', 'playback', 'image', 'previews', 'cutout',
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

  const s = raw.sprite
  onlyKeys(s, ['grid', 'align', 'segmentInput', 'maxSegments'], 'sprite')
  if (!SPRITE_GRIDS.includes(s.grid)) fail('sprite.grid', `取值须为 ${SPRITE_GRIDS.join(' / ')}（N×N 格）`)
  if (!ALIGN_MODES.includes(s.align)) fail('sprite.align', `取值须为 ${ALIGN_MODES.join(' / ')}`)
  if (s.maxSegments != null && (!Number.isInteger(s.maxSegments) || s.maxSegments < 1 || s.maxSegments > MAX_SEGMENTS)) {
    fail('sprite.maxSegments', `须为 1~${MAX_SEGMENTS} 的整数`)
  }
  if (s.segmentInput != null) {
    const inp = raw.inputs.find((x) => x.id === s.segmentInput)
    if (!inp || inp.type !== 'text') fail('sprite.segmentInput', '须为已声明的 text 输入 id')
  } else if ((s.maxSegments ?? 1) > 1) {
    fail('sprite.segmentInput', 'maxSegments > 1 时必须指定每段替换的 text 输入')
  }

  const p = raw.playback
  onlyKeys(p, ['fps', 'defaultFps', 'loops', 'defaultLoop', 'maxRepeat'], 'playback')
  intList(p.fps, 'playback.fps', { min: 1, max: 30 })
  if (!p.fps.includes(p.defaultFps)) fail('playback.defaultFps', '须在 fps 中')
  strList(p.loops, 'playback.loops', { allowed: LOOP_MODES })
  if (!p.loops.includes(p.defaultLoop)) fail('playback.defaultLoop', '须在 loops 中')
  if (!Number.isInteger(p.maxRepeat) || p.maxRepeat < 1 || p.maxRepeat > 20) fail('playback.maxRepeat', '须为 1~20 的整数')

  onlyKeys(raw.image, ['models', 'resolutions', 'defaultResolution'], 'image')
  strList(raw.image.models, 'image.models', { max: 8 })
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
    sprite: {
      grid: pack.sprite.grid,
      align: pack.sprite.align,
      frames: pack.sprite.grid * pack.sprite.grid,
      segmentInput: pack.sprite.segmentInput ?? null,
      maxSegments: pack.sprite.maxSegments ?? 1,
    },
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
 * 请求 → 精灵图生成计划。越界输入一律拒绝；网格由动画包固定。
 * req: { inputs, fps, loop, repeat, resolution, model, alpha, beats（每行一条） }
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

  const grid = pack.sprite.grid
  const frames = grid * grid
  const fps = pick(req.fps == null ? undefined : Number(req.fps), pack.playback.fps, pack.playback.defaultFps, '帧率', name)
  const loop = pick(req.loop, pack.playback.loops, pack.playback.defaultLoop, '循环方式', name)
  const repeat = req.repeat == null ? 1 : Number(req.repeat)
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > pack.playback.maxRepeat) {
    throw new Error(`重复次数须为 1~${pack.playback.maxRepeat}`)
  }
  const resolution = pick(req.resolution, pack.image.resolutions, pack.image.defaultResolution, '分辨率', name)
  const model = pick(req.model, pack.image.models, pack.image.models[0], '模型', name)

  // 分镜按行：每行 grid 帧为动作的一个阶段
  const rawBeats = req.beats == null ? [] : req.beats
  if (!Array.isArray(rawBeats) || rawBeats.length > grid) throw new Error(`分镜最多 ${grid} 条（每行一条）`)
  const beats = Array.from({ length: grid }, (_, i) => {
    const s = cleanText(rawBeats[i])
    if (s.length > BEAT_MAX) throw new Error(`第 ${i + 1} 行分镜最多 ${BEAT_MAX} 字`)
    return s
  })

  // 长镜头分段：第 1 段用 segmentInput 本身，后续每段替换它的内容，其余输入不变
  const segInput = pack.sprite.segmentInput ? pack.inputs.find((x) => x.id === pack.sprite.segmentInput) : null
  const maxSeg = pack.sprite.maxSegments ?? 1
  const rawExtra = req.segments == null ? [] : req.segments
  if (!Array.isArray(rawExtra)) throw new Error('segments 必须是数组')
  if (rawExtra.length > maxSeg - 1) throw new Error(`风格动画「${name}」最多 ${maxSeg} 段`)
  const segments = [segInput ? resolved[segInput.id] : '']
  for (const [i, x] of rawExtra.entries()) {
    const s = cleanText(x)
    if (!s) throw new Error(`请填写第 ${i + 2} 段的「${segInput.label}」`)
    if (s.length > segInput.maxLength) throw new Error(`第 ${i + 2} 段「${segInput.label}」最多 ${segInput.maxLength} 字`)
    segments.push(s)
  }
  const avoid = pack.prompt.avoid.length ? ` Avoid: ${pack.prompt.avoid.join(', ')}.` : ''
  const compose = (segText) => pack.prompt.template.replace(PLACEHOLDER_RE, (_, id) => (segInput && id === segInput.id ? segText : values[id])) + avoid
  const segmentPrompts = segments.map((s) => compose(s))
  const base = segmentPrompts[0]
  const totalFrames = frames + (segments.length - 1) * (frames - 1)
  const summary = [
    pack.inputs.filter((x) => x.type === 'text' && x.required).map((x) => resolved[x.id]).join(' · '),
    ...segments.slice(1),
  ].join(' → ')

  return {
    basePrompt: base,
    segmentPrompts,
    segments,
    totalFrames,
    frames,
    grid: { cols: grid, rows: grid },
    beats,
    fps,
    loop,
    repeat,
    align: pack.sprite.align,
    aspectRatio: '1:1',
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
      grid,
      frames: totalFrames,
      sheets: segments.length,
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

function rowBeat(beat, r, rows) {
  if (beat) return beat
  const a = Math.round((r / rows) * 100)
  const b = Math.round(((r + 1) / rows) * 100)
  if (r === 0) return 'the motion begins from the starting pose'
  if (r === rows - 1) return 'the motion completes into the ending pose'
  return `the motion continues (about ${a}%–${b}% of the action)`
}

/**
 * 精灵图：一次生成 N×N 连续序列帧。
 * segment：长镜头第几段（0 起）；hasRef：带角色参照；continuation：参考图为「左角色设定 | 右上一段末帧」拼图。
 */
export function spritePrompt(plan, { hasRef = false, segment = 0, continuation = false } = {}) {
  const { cols, rows } = plan.grid
  const n = plan.frames
  const total = plan.segments?.length ?? 1
  const beats = segment === 0 ? plan.beats : plan.beats.map(() => '')
  const phases = beats
    .map((b, r) => `row ${r + 1} (frames ${r * cols + 1}-${(r + 1) * cols}): ${rowBeat(b, r, rows)}`)
    .join('; ')
  const last = segment === total - 1
  const cycle = !last
    ? `This is part ${segment + 1} of ${total} of one continuous shot: frame ${n} must end mid-motion in a pose the next part can continue from, not a final resting pose.`
    : plan.loop === 'pingpong'
      ? `Frame ${n} is the extreme pose; the frames will also be played in reverse, so the motion must read well backwards.`
      : plan.repeat > 1 && total === 1
        ? `The motion is a seamless loop cycle: frame ${n} flows directly back into frame 1.`
        : ''
  const ref = continuation
    ? 'The reference image has two panels. LEFT panel: the character design sheet — the character must match it exactly (same proportions, face, clothes, colors, props). '
      + 'RIGHT panel: the last frame of the previous part of this same shot. Frame 1 of this sheet must be nearly identical to the RIGHT panel pose, with the same size, position and camera, and then the motion continues smoothly from there.'
    : hasRef
      ? 'The character must match the character in the reference image exactly (same proportions, face, clothes, colors, props).'
      : ''
  return [
    `Character animation sprite sheet: a strict ${cols}×${rows} grid of ${n} equal square cells, read left to right, top to bottom.`,
    `The ${n} cells are consecutive frames of one smooth continuous motion, like a frame-by-frame hand-drawn animation at ${plan.fps} fps: each frame changes only slightly from the previous one, with evenly spaced in-betweens and no jumps.`,
    total > 1 && segment > 0 ? `This is part ${segment + 1} of ${total} of one continuous shot.` : '',
    `Phases: ${phases}.`,
    cycle,
    'Every cell shows the exact same single character at the same size, standing on the same ground line at the same spot inside its cell, from the same fixed camera angle; only the pose changes.',
    'The whole character stays fully inside its own cell with clear empty margin on all sides and never crosses into neighboring cells. Cells are separated only by empty background: no borders, no grid lines, no frame numbers, no captions, no text.',
    ref,
    `Character and art style: ${plan.segmentPrompts?.[segment] ?? plan.basePrompt}`,
  ].filter(Boolean).join(' ')
}

/** 角色设定图：同风格、单人全身、中性站姿、白底，作为整段动画的角色参照 */
export function characterPrompt(plan) {
  return [
    'Character design reference sheet for a 2D animation: exactly one character, full body, standing in a neutral relaxed pose, front three-quarter view, centered, large in frame with clear empty margin on all sides.',
    'Plain pure white background, no scenery, no ground shadow, no text, no labels, no color swatches, no multiple views.',
    'Show the character design clearly (face, hairstyle, proportions, clothing, colors and any signature props) so it can be matched exactly in later animation frames. Ignore any action described below; the character just stands still.',
    `Character and art style: ${plan.basePrompt}`,
  ].join(' ')
}

