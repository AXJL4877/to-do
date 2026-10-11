/**
 * 命令注册表（无 UI 核心层的第一块）。
 *
 * 为什么要有它：现在前端直接改 store，智能体拿不到三件事——**能做什么**、**为什么不能做**、**改了什么**。
 * 命令表把这三件事补齐，并让 CLI / MCP / HTTP / 未来的 UI 走**同一批 id**：
 *   { id, label, params, enabled(doc,args) => null | '人话原因', run(doc,args) => {doc,changed,created,summary} }
 *
 * 三条硬规则（对应设计文档的不变量）：
 *   I3 一次编辑 = 一条命令 = 一次撤销 → 命令是纯函数，会话层负责历史；
 *   I5 写入前必过校验 → applyCommand 在改动后跑规范校验，**新增错误即拒绝**；
 *   I6 已发布的命令 id 永不改名（工程里存的是 id）。
 *
 * 时间单位一律**秒**（v3 迁到整数 tick 前，这里如实标注）。
 */
import { validateProject } from '../spec/projectSpec.mjs'
import { compileParams, validateParams } from '../spec/params.mjs'

const num = (description, extra = {}) => ({ type: 'number', description, ...extra })
const clipIdParam = { type: 'string', required: true, description: '片段 id' }

/** 命令表。新增命令只能追加，不得改动已发布条目的 id 与语义。 */
export const COMMANDS = [
  {
    id: 'timeline.add_clip',
    label: '添加片段',
    category: 'timeline',
    params: {
      trackId: { type: 'string', required: true, description: '目标轨道 id' },
      start: num('时间轴起点（秒）', { required: true, minimum: 0 }),
      duration: num('时间轴时长（秒）', { required: true, minimum: 0.01 }),
      mediaId: { type: 'string', description: '素材 id；纯色/文字层可省' },
      inPoint: num('素材入点（秒）'),
      outPoint: num('素材出点（秒）'),
      name: { type: 'string', description: '片段显示名' },
      sequenceId: { type: 'string', description: '缺省=当前序列' },
    },
    enabled: (doc, p) => {
      const { seq, error } = resolveSequence(doc, p.sequenceId)
      if (error) return error
      const track = (seq.tracks ?? []).find((t) => t.id === p.trackId)
      if (!track) return `轨道 ${p.trackId} 不存在；可用：${(seq.tracks ?? []).map((t) => t.id).join(', ') || '（该序列没有轨道，先用 track.add）'}`
      if (p.mediaId && !(doc.media ?? []).some((m) => m.id === p.mediaId)) {
        return `素材 ${p.mediaId} 不在媒体库里；可用：${(doc.media ?? []).slice(0, 8).map((m) => m.id).join(', ')}…`
      }
      return null
    },
    run: (doc, p, ctx) => {
      const { seq } = resolveSequence(doc, p.sequenceId)
      const media = (doc.media ?? []).find((m) => m.id === p.mediaId)
      const inPoint = p.inPoint ?? 0
      const outPoint = p.outPoint ?? inPoint + p.duration
      const id = ctx.newId('clip')
      const clip = {
        id, trackId: p.trackId, ...(p.mediaId ? { mediaId: p.mediaId } : {}),
        name: p.name ?? media?.name ?? '新片段',
        start: round(p.start), duration: round(p.duration),
        inPoint: round(inPoint), outPoint: round(outPoint),
        speed: 1, reverse: false, enabled: true, blend: 'normal',
        effects: [], keyframes: {}, speedKeyframes: [],
      }
      clip.meta = mirrorMeta(clip, seq)
      seq.clips = [...(seq.clips ?? []), clip]
      return { doc, created: [id], changed: [], summary: `在 ${p.trackId} 上添加片段 ${clip.name}（${clip.start}s +${clip.duration}s）` }
    },
  },

  {
    id: 'timeline.move_clip',
    label: '移动片段',
    category: 'timeline',
    params: {
      clipId: clipIdParam,
      start: num('新的时间轴起点（秒）', { required: true, minimum: 0 }),
      trackId: { type: 'string', description: '换轨（缺省=不动）' },
    },
    enabled: (doc, p) => {
      const hit = findClip(doc, p.clipId)
      if (!hit) return `片段 ${p.clipId} 不存在`
      if (p.trackId) {
        const track = (hit.seq.tracks ?? []).find((t) => t.id === p.trackId)
        if (!track) return `轨道 ${p.trackId} 不存在；可用：${(hit.seq.tracks ?? []).map((t) => t.id).join(', ')}`
        if (track.kind !== hit.track.kind) return `片段在 ${hit.track.kind} 轨上，不能移到 ${track.kind} 轨`
      }
      return null
    },
    run: (doc, p) => {
      const hit = findClip(doc, p.clipId)
      const clip = hit.seq.clips.find((c) => c.id === p.clipId)
      const from = clip.start
      clip.start = round(p.start)
      if (p.trackId) clip.trackId = p.trackId
      clip.meta = mirrorMeta(clip, hit.seq)
      return { doc, changed: [clip.id], created: [], summary: `移动「${clip.name}」：${from}s → ${clip.start}s${p.trackId ? `（换到 ${p.trackId}）` : ''}` }
    },
  },

  {
    id: 'timeline.trim_clip',
    label: '修剪片段',
    category: 'timeline',
    params: {
      clipId: clipIdParam,
      edge: { type: 'string', required: true, enum: ['in', 'out'], description: 'in=改起点侧，out=改终点侧' },
      deltaSeconds: num('相对位移（秒）：正数=向右/变长', { required: true }),
    },
    enabled: (doc, p) => {
      const hit = findClip(doc, p.clipId)
      if (!hit) return `片段 ${p.clipId} 不存在`
      const c = hit.seq.clips.find((x) => x.id === p.clipId)
      const d = p.deltaSeconds
      if (p.edge === 'in' && c.duration - d < 0.02) return `向内修剪 ${d}s 会把片段修到 ${round(c.duration - d)}s，太短`
      if (p.edge === 'out' && c.duration + d < 0.02) return `向外修剪 ${d}s 会把片段修到 ${round(c.duration + d)}s，太短`
      if (p.edge === 'in' && c.inPoint + d < -0.001) return `素材入点会变成 ${round(c.inPoint + d)}s（不能为负）`
      return null
    },
    run: (doc, p) => {
      const hit = findClip(doc, p.clipId)
      const c = hit.seq.clips.find((x) => x.id === p.clipId)
      if (p.edge === 'in') {
        c.start = round(c.start + p.deltaSeconds)
        c.duration = round(c.duration - p.deltaSeconds)
        c.inPoint = round(c.inPoint + p.deltaSeconds)
      } else {
        c.duration = round(c.duration + p.deltaSeconds)
        c.outPoint = round(c.outPoint + p.deltaSeconds)
      }
      c.meta = mirrorMeta(c, hit.seq)
      return { doc, changed: [c.id], created: [], summary: `修剪「${c.name}」${p.edge} 边 ${p.deltaSeconds >= 0 ? '+' : ''}${p.deltaSeconds}s → ${c.start}s +${c.duration}s` }
    },
  },

  {
    id: 'timeline.split_clip',
    label: '切片',
    category: 'timeline',
    params: {
      clipId: clipIdParam,
      at: num('切线位置（时间轴秒）', { required: true, minimum: 0 }),
    },
    enabled: (doc, p) => {
      const hit = findClip(doc, p.clipId)
      if (!hit) return `片段 ${p.clipId} 不存在`
      const c = hit.seq.clips.find((x) => x.id === p.clipId)
      if (p.at <= c.start + 0.01 || p.at >= c.start + c.duration - 0.01) {
        return `切线 ${p.at}s 必须落在片段内部（${c.start}s ~ ${round(c.start + c.duration)}s）`
      }
      return null
    },
    run: (doc, p, ctx) => {
      const hit = findClip(doc, p.clipId)
      const seq = hit.seq
      const c = seq.clips.find((x) => x.id === p.clipId)
      const cut = round(p.at - c.start)
      const second = {
        ...structuredClone(c),
        id: ctx.newId('clip'),
        start: round(p.at),
        duration: round(c.duration - cut),
        inPoint: round(c.inPoint + cut),
        outPoint: c.outPoint,
        linkedId: undefined, groupId: undefined,
      }
      c.duration = round(cut)
      c.outPoint = round(c.inPoint + cut)
      c.meta = mirrorMeta(c, seq)
      second.meta = mirrorMeta(second, seq)
      seq.clips = [...seq.clips, second]
      return { doc, changed: [c.id], created: [second.id], summary: `在 ${p.at}s 切开「${c.name}」→ 两段 ${c.duration}s / ${second.duration}s` }
    },
  },

  {
    id: 'timeline.delete_clips',
    label: '删除片段',
    category: 'timeline',
    params: {
      clipIds: { type: 'array', required: true, description: '要删除的片段 id 列表', items: { type: 'string' } },
    },
    destructive: true,
    enabled: (doc, p) => {
      const missing = p.clipIds.filter((id) => !findClip(doc, id))
      if (missing.length) return `这些片段不存在：${missing.join(', ')}`
      return null
    },
    run: (doc, p) => {
      const ids = new Set(p.clipIds)
      const names = []
      for (const sq of doc.sequences ?? []) {
        const keep = []
        for (const c of sq.clips ?? []) {
          if (ids.has(c.id)) names.push(c.name ?? c.id)
          else keep.push(c)
        }
        sq.clips = keep
      }
      return { doc, changed: [...ids], created: [], summary: `删除 ${ids.size} 个片段：${names.slice(0, 5).join('、')}${names.length > 5 ? '…' : ''}` }
    },
  },

  {
    id: 'clip.set_transform',
    label: '设置变换',
    category: 'clip',
    params: {
      clipId: clipIdParam,
      x: num('水平位移（归一化，0=居中）'),
      y: num('垂直位移（归一化）'),
      scale: num('缩放倍率', { minimum: 0.01 }),
      rotation: num('旋转（度）'),
      opacity: num('不透明度 0~1', { minimum: 0, maximum: 1 }),
    },
    enabled: (doc, p) => {
      const hit = findClip(doc, p.clipId)
      if (!hit) return `片段 ${p.clipId} 不存在`
      const patchKeys = ['x', 'y', 'scale', 'rotation', 'opacity'].filter((k) => p[k] !== undefined)
      if (!patchKeys.length) return '没有给任何要改的字段（x/y/scale/rotation/opacity 至少一个）'
      return null
    },
    run: (doc, p) => {
      const hit = findClip(doc, p.clipId)
      const c = hit.seq.clips.find((x) => x.id === p.clipId)
      c.transform = { ...(c.transform ?? {}), ...Object.fromEntries(['x', 'y', 'scale', 'rotation', 'opacity'].filter((k) => p[k] !== undefined).map((k) => [k, p[k]])) }
      return { doc, changed: [c.id], created: [], summary: `「${c.name}」变换 → ${JSON.stringify(c.transform)}` }
    },
  },

  {
    id: 'track.add',
    label: '添加轨道',
    category: 'track',
    params: {
      kind: { type: 'string', required: true, enum: ['video', 'audio', 'subtitle', 'effect', 'adjustment'], description: '轨道类型' },
      name: { type: 'string' },
      sequenceId: { type: 'string' },
    },
    run: (doc, p, ctx) => {
      const { seq } = resolveSequence(doc, p.sequenceId)
      const id = ctx.newId('track')
      const sameKind = (seq.tracks ?? []).filter((t) => t.kind === p.kind).length
      seq.tracks = [...(seq.tracks ?? []), {
        id, kind: p.kind, name: p.name ?? `${p.kind === 'video' ? 'V' : p.kind === 'audio' ? 'A' : p.kind}${sameKind + 1}`,
        locked: false, muted: false, solo: false, hidden: false, height: 48,
      }]
      return { doc, created: [id], changed: [], summary: `添加 ${p.kind} 轨道 ${id}` }
    },
  },

  {
    id: 'track.remove',
    label: '删除轨道',
    category: 'track',
    params: { trackId: { type: 'string', required: true, description: '轨道 id' }, sequenceId: { type: 'string' } },
    destructive: true,
    enabled: (doc, p) => {
      const { seq, error } = resolveSequence(doc, p.sequenceId)
      if (error) return error
      const track = (seq.tracks ?? []).find((t) => t.id === p.trackId)
      if (!track) return `轨道 ${p.trackId} 不存在；可用：${(seq.tracks ?? []).map((t) => t.id).join(', ')}`
      const n = (seq.clips ?? []).filter((c) => c.trackId === p.trackId).length
      if (n) return `轨道 ${p.trackId} 上还有 ${n} 个片段；先 timeline.delete_clips 或 timeline.move_clip`
      if ((seq.tracks ?? []).length <= 1) return '序列至少要保留一条轨道'
      return null
    },
    run: (doc, p) => {
      const { seq } = resolveSequence(doc, p.sequenceId)
      seq.tracks = (seq.tracks ?? []).filter((t) => t.id !== p.trackId)
      return { doc, changed: [p.trackId], created: [], summary: `删除空轨道 ${p.trackId}` }
    },
  },

  {
    id: 'marker.add',
    label: '添加标记',
    category: 'sequence',
    params: {
      t: num('标记时刻（秒）', { required: true, minimum: 0 }),
      label: { type: 'string', required: true },
      color: { type: 'string' },
      sequenceId: { type: 'string' },
    },
    run: (doc, p, ctx) => {
      const { seq } = resolveSequence(doc, p.sequenceId)
      const id = ctx.newId('marker')
      seq.markers = [...(seq.markers ?? []), { id, t: round(p.t), label: p.label, color: p.color ?? '#ffcc00' }]
      return { doc, created: [id], changed: [], summary: `在 ${round(p.t)}s 加标记「${p.label}」` }
    },
  },

  {
    id: 'sequence.set_work_range',
    label: '设置工作区',
    category: 'sequence',
    params: {
      in: num('工作区入点（秒）', { required: true, minimum: 0 }),
      out: num('工作区出点（秒）', { required: true, minimum: 0 }),
      sequenceId: { type: 'string' },
    },
    enabled: (doc, p) => (p.out <= p.in ? `出点 ${p.out}s 必须大于入点 ${p.in}s` : null),
    run: (doc, p) => {
      const { seq } = resolveSequence(doc, p.sequenceId)
      seq.workIn = round(p.in)
      seq.workOut = round(p.out)
      return { doc, changed: [seq.id], created: [], summary: `工作区 ${seq.workIn}s ~ ${seq.workOut}s` }
    },
  },
]


const round = (v) => Math.round(Number(v) * 1000) / 1000

function resolveSequence(doc, sequenceId) {
  const seqs = doc.sequences ?? []
  if (!seqs.length) return { error: '工程里没有序列' }
  if (sequenceId) {
    const seq = seqs.find((s) => s.id === sequenceId)
    return seq ? { seq } : { error: `序列 ${sequenceId} 不存在；可用：${seqs.map((s) => s.id).join(', ')}` }
  }
  const active = seqs.find((s) => s.id === doc.activeSeqId) ?? seqs[0]
  return { seq: active }
}

function findClip(doc, clipId) {
  for (const seq of doc.sequences ?? []) {
    const clip = (seq.clips ?? []).find((c) => c.id === clipId)
    if (clip) return { seq, clip, track: (seq.tracks ?? []).find((t) => t.id === clip.trackId) ?? { kind: 'unknown' } }
  }
  return null
}

/** 把派生镜像写回 meta（权威在片段自身；meta 只是给 UI/查询用的镜像）。 */
function mirrorMeta(clip, seq) {
  const track = (seq.tracks ?? []).find((t) => t.id === clip.trackId)
  return {
    ...(clip.meta ?? {}),
    absIn: clip.start, absOut: round(clip.start + clip.duration),
    start: clip.start, duration: clip.duration, end: round(clip.start + clip.duration),
    inPoint: clip.inPoint, outPoint: clip.outPoint,
    trackId: clip.trackId, trackName: track?.name, trackKind: track?.kind,
    enabled: clip.enabled !== false,
    trackHidden: !!track?.hidden, trackMuted: !!track?.muted,
    visible: clip.enabled !== false && !track?.hidden,
  }
}

const err = (code, message, hint, details) => ({ ok: false, error: { code, message, ...(hint ? { hint } : {}), ...(details ? { details } : {}) } })

/** 命令的机器可读描述（含编译后的参数 schema）——CLI/MCP/HTTP/UI 共用。 */

/**
 * 重叠策略 "push"：同轨道上从左到右扫一遍，撞到前一个片段就往右推。
 *
 * 为什么这条规则属于**命令层**而不是 UI：同轨重叠在规范里其实是**警告**（允许——叠化/覆盖是常见做法），但命令层的默认策略是"拒绝"，
 * 所以"遇到重叠怎么办"必须是命令的参数；而"吸附到附近边缘"是**交互辅助**，留在 UI 更合适——
 * UI 先吸附出精确值，再把精确值交给命令。这样智能体拿到的是确定的规则，不需要模拟手感。
 */
function pushOverlaps(doc, clipIds) {
  const moved = new Set()
  for (const seq of doc.sequences ?? []) {
    const trackIds = new Set((seq.clips ?? []).filter((c) => clipIds.includes(c.id)).map((c) => c.trackId))
    for (const trackId of trackIds) {
      const clips = (seq.clips ?? [])
        .filter((c) => c.trackId === trackId)
        .sort((a, b) => a.start - b.start || String(a.id).localeCompare(String(b.id)))
      let end = -Infinity
      for (const c of clips) {
        if (c.start < end - 1e-6) {
          c.start = round(end)
          c.meta = mirrorMeta(c, seq)
          moved.add(c.id)
        }
        end = Math.max(end, c.start + c.duration)
      }
    }
  }
  return [...moved]
}

/**
 * 修剪策略 "clamp"：把边界夹到最近邻居的边界，不让修剪吃掉邻居。
 * 为什么修剪用 clamp 而移动用 push：拖边缘时把整条时间轴的其他片段shove开是反直觉的；
 * 移动才需要 push（用户拖着片段往前走，后面的自然要让位）。
 */
function clampTrim(seq, clip, edge, at) {
  const others = (seq.clips ?? []).filter((c) => c.trackId === clip.trackId && c.id !== clip.id)
  let value = at
  if (edge === 'out') {
    const end = clip.start + clip.duration
    const next = others.filter((c) => c.start >= end - 1e-6).sort((a, b) => a.start - b.start)[0]
    if (next) value = Math.min(value, next.start)
    value = Math.max(value, clip.start + 0.02)
  } else {
    const prev = others
      .filter((c) => c.start + c.duration <= clip.start + 1e-6)
      .sort((a, b) => (b.start + b.duration) - (a.start + a.duration))[0]
    if (prev) value = Math.max(value, prev.start + prev.duration)
    value = Math.min(value, clip.start + clip.duration - 0.02)
  }
  return round(value)
}

/**
 * 把"同一时刻起步的一组元素"找出来。
 * 一个元素 = 一个显现片段（名字含"显现"或有 video 素材）+ 紧随其后的 hold（同轨、紧接其结束）。
 */
function staggerGroups(seq, p) {
  const clips = seq.clips ?? []
  const within = (a, b, tol = 0.003) => Math.abs(a - b) <= tol
  const reveals = clips.filter((c) => typeof c.name === 'string' && c.name.includes('显现'))
  const byStart = new Map()
  for (const r of reveals) {
    const key = r.start.toFixed(3)
    if (!byStart.has(key)) byStart.set(key, [])
    byStart.get(key).push(r)
  }
  const groups = []
  for (const [key, list] of byStart) {
    const start = Number(key)
    if (p.from != null && start < p.from) continue
    if (p.to != null && start >= p.to) continue
    // 组内按轨道顺序（= 渲染叠放顺序）排，同轨按名字
    const trackOrder = new Map((seq.tracks ?? []).map((tr, i) => [tr.id, i]))
    list.sort((a, b) => (trackOrder.get(a.trackId) ?? 99) - (trackOrder.get(b.trackId) ?? 99) || String(a.name).localeCompare(String(b.name)))
    const items = list.map((r) => {
      const hold = clips.find((c) => c.trackId === r.trackId && !c.name.includes('显现')
        && within(c.start, r.start + r.duration, 0.02))
      return { revealId: r.id, holdId: hold?.id ?? null }
    })
    groups.push({ start, items })
  }
  return groups.sort((a, b) => a.start - b.start)
}

export function describeCommands({ withParams = true } = {}) {
  return COMMANDS.map((c) => ({
    id: c.id, label: c.label, category: c.category, destructive: !!c.destructive,
    params: withParams ? compileParams(c.params ?? {}) : undefined,
  }))
}

/**
 * 执行一条命令（纯函数：不改传入的 doc）。
 * @returns {{ok:true, doc, changed, created, summary} | {ok:false, error}}
 */
export function applyCommand(doc, id, args = {}, { newId = defaultNewId, validateAfter = true } = {}) {
  const cmd = byId.get(id)
  if (!cmd) {
    return err('not_found', `未知命令 ${id}`, `可用命令：${COMMAND_IDS.join(', ')}`)
  }
  let schema
  try {
    schema = compileParams(cmd.params ?? {})
  } catch (e) {
    return err('internal', `命令 ${id} 的参数 schema 非法：${e.message}`)
  }
  const v = validateParams(schema, args, { at: 'args' })
  if (!v.ok) {
    return err('bad_request', v.errors.map((e) => `${e.path}: ${e.message}`).join('；'), '按 params schema 修正参数', { errors: v.errors, accepted: Object.keys(schema.properties ?? {}) })
  }
  if (typeof cmd.enabled === 'function') {
    const why = cmd.enabled(doc, args)
    if (why) {
      const e = typeof why === 'string' ? { code: 'conflict', message: why } : why
      const code = e.code ?? 'conflict'
      return err(code, e.message ?? String(why), e.hint)
    }
  }

  const before = validateAfter ? validateProject(doc) : null
  const next = structuredClone(doc)
  let result
  try {
    result = cmd.run(next, args, { newId })
  } catch (e) {
    return err('internal', `命令 ${id} 执行失败：${e.message}`)
  }
  if (!result || typeof result !== 'object' || !result.doc) {
    return err('internal', `命令 ${id} 没有返回 {doc, changed, created, summary}`)
  }

  // I5：写入闸门——改动不得引入新的规范错误
  if (validateAfter) {
    const after = validateProject(result.doc)
    const beforeKeys = new Set(before.errors.map((e) => `${e.code}@${e.path}`))
    const introduced = after.errors.filter((e) => !beforeKeys.has(`${e.code}@${e.path}`))
    if (introduced.length) {
      return err('conflict', `命令 ${id} 会让工程变得不合规，已拒绝：${introduced.map((e) => e.message).join('；')}`,
        '这是写入闸门（不变量 I5）：命令不得引入新的规范错误', { introduced })
    }
  }

  return {
    ok: true, doc: result.doc,
    changed: result.changed ?? [], created: result.created ?? [],
    summary: result.summary ?? id,
    undoable: cmd.undoable !== false,
  }
}

let idSeq = 0
export function defaultNewId(prefix) {
  idSeq += 1
  return `${prefix}_${Date.now().toString(36)}${idSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

// ───────────────────────── 覆盖 UI 真实编辑动作的第二批命令 ─────────────────────────
// 目标：UI 的每个编辑动作都能映射到一条命令（P1 的目标是 20–30 条）。
// 追加时不得改动上面已发布条目的 id 与语义（I6）。

const patchClip = (doc, clipId, fn) => {
  const hit = findClip(doc, clipId)
  if (!hit) return null
  const clip = hit.seq.clips.find((c) => c.id === clipId)
  fn(clip, hit.seq)
  clip.meta = mirrorMeta(clip, hit.seq)
  return { clip, seq: hit.seq }
}

COMMANDS.push(
  {
    id: 'timeline.move_clips',
    label: '批量移动片段',
    category: 'timeline',
    params: {
      clipIds: { type: 'array', required: true, description: '要移动的片段 id', items: { type: 'string' } },
      deltaSeconds: num('整体位移（秒），可为负', { required: true }),
      trackId: { type: 'string', description: '整体换轨（可选，需与各片段轨道类型兼容）' },
    },
    enabled: (doc, p) => {
      const missing = p.clipIds.filter((id) => !findClip(doc, id))
      if (missing.length) return `这些片段不存在：${missing.join(', ')}`
      if (p.trackId) {
        const hits = p.clipIds.map((id) => findClip(doc, id))
        const kinds = new Set(hits.map((h) => h.track?.kind))
        if (kinds.size > 1) return `选中的片段跨多种轨道（${[...kinds].join('/')}），不能整体换到同一条轨道`
        const target = (hits[0].seq.tracks ?? []).find((t) => t.id === p.trackId)
        if (!target) return `轨道 ${p.trackId} 不存在；可用：${(hits[0].seq.tracks ?? []).map((t) => t.id).join(', ')}`
        if (target.kind !== [...kinds][0]) return `片段在 ${[...kinds][0]} 轨上，不能移到 ${target.kind} 轨`
      }
      const tooEarly = p.clipIds
        .map((id) => findClip(doc, id).clip)
        .filter((c) => c.start + p.deltaSeconds < -0.001)
      if (tooEarly.length) return `位移后会有 ${tooEarly.length} 个片段起点为负；最多往回 ${Math.min(...p.clipIds.map((id) => findClip(doc, id).clip.start)).toFixed(2)}s`
      return null
    },
    run: (doc, p) => {
      const changed = []
      for (const id of p.clipIds) {
        patchClip(doc, id, (clip) => {
          clip.start = round(clip.start + p.deltaSeconds)
          if (p.trackId) clip.trackId = p.trackId
        })
        changed.push(id)
      }
      return { doc, changed, created: [], summary: `移动 ${changed.length} 个片段 ${p.deltaSeconds >= 0 ? '+' : ''}${p.deltaSeconds}s${p.trackId ? `（换到 ${p.trackId}）` : ''}` }
    },
  },

  {
    id: 'timeline.ripple_delete',
    label: '波纹删除（删掉并合拢空隙）',
    category: 'timeline',
    params: {
      clipIds: { type: 'array', required: true, description: '要删除的片段 id', items: { type: 'string' } },
      sequenceId: { type: 'string' },
    },
    destructive: true,
    enabled: (doc, p) => {
      const missing = p.clipIds.filter((id) => !findClip(doc, id))
      if (missing.length) return `这些片段不存在：${missing.join(', ')}`
      return null
    },
    run: (doc, p) => {
      const ids = new Set(p.clipIds)
      const { seq } = resolveSequence(doc, p.sequenceId)
      const removed = (seq.clips ?? []).filter((c) => ids.has(c.id))
      let clips = (seq.clips ?? []).filter((c) => !ids.has(c.id))
      // 与前端 ripple 语义一致：同轨道上、位于被删片段之后的片段整体前移
      for (const r of removed) {
        clips = clips.map((c) => (c.trackId === r.trackId && c.start >= r.start + r.duration - 1e-6
          ? { ...c, start: round(c.start - r.duration), meta: mirrorMeta({ ...c, start: round(c.start - r.duration) }, seq) }
          : c))
      }
      seq.clips = clips
      return { doc, changed: [...ids], created: [], summary: `波纹删除 ${removed.length} 个片段并合拢空隙（${removed.reduce((t, c) => t + c.duration, 0).toFixed(2)}s）` }
    },
  },

  {
    id: 'clip.set_enabled',
    label: '启用/停用片段',
    category: 'clip',
    params: { clipId: clipIdParam, enabled: { type: 'boolean', required: true, description: 'false=停用（隐藏/静音）' } },
    enabled: (doc, p) => (findClip(doc, p.clipId) ? null : `片段 ${p.clipId} 不存在`),
    run: (doc, p) => {
      const hit = patchClip(doc, p.clipId, (c) => { c.enabled = p.enabled })
      return { doc, changed: [p.clipId], created: [], summary: `${p.enabled ? '启用' : '停用'}「${hit.clip.name}」` }
    },
  },

  {
    id: 'clip.set_speed',
    label: '变速/倒放/冻结',
    category: 'clip',
    params: {
      clipId: clipIdParam,
      speed: num('倍率，0.1~10', { minimum: 0.1, maximum: 10 }),
      reverse: { type: 'boolean' },
      freeze: num('冻结帧时刻（素材时间，秒）'),
    },
    enabled: (doc, p) => {
      if (!findClip(doc, p.clipId)) return `片段 ${p.clipId} 不存在`
      if (p.speed === undefined && p.reverse === undefined && p.freeze === undefined) return '至少要给 speed / reverse / freeze 之一'
      return null
    },
    run: (doc, p) => {
      const hit = patchClip(doc, p.clipId, (c) => {
        if (p.speed !== undefined) c.speed = p.speed
        if (p.reverse !== undefined) c.reverse = p.reverse
        if (p.freeze !== undefined) c.freeze = p.freeze
      })
      const bits = [p.speed !== undefined ? `${p.speed}x` : null, p.reverse ? '倒放' : null, p.freeze !== undefined ? `冻结@${p.freeze}s` : null].filter(Boolean)
      return { doc, changed: [p.clipId], created: [], summary: `「${hit.clip.name}」→ ${bits.join(' ')}` }
    },
  },

  {
    id: 'clip.set_audio',
    label: '设置音频参数',
    category: 'clip',
    params: {
      clipId: clipIdParam,
      volume: num('音量 0~4（1=原音量）', { minimum: 0, maximum: 4 }),
      gainDb: num('增益 dB（-60~18）', { minimum: -60, maximum: 18 }),
      mute: { type: 'boolean' },
      fadeIn: num('淡入（秒）', { minimum: 0 }),
      fadeOut: num('淡出（秒）', { minimum: 0 }),
    },
    enabled: (doc, p) => {
      const hit = findClip(doc, p.clipId)
      if (!hit) return `片段 ${p.clipId} 不存在`
      if (!['volume', 'gainDb', 'mute', 'fadeIn', 'fadeOut'].some((k) => p[k] !== undefined)) return '至少要给 volume / gainDb / mute / fadeIn / fadeOut 之一'
      if (p.fadeIn !== undefined && p.fadeIn > hit.clip.duration) return `淡入 ${p.fadeIn}s 超过片段时长 ${hit.clip.duration}s`
      return null
    },
    run: (doc, p) => {
      const hit = patchClip(doc, p.clipId, (c) => {
        c.audio = { ...(c.audio ?? {}) }
        for (const k of ['volume', 'gainDb', 'mute', 'fadeIn', 'fadeOut']) if (p[k] !== undefined) c.audio[k] = p[k]
      })
      return { doc, changed: [p.clipId], created: [], summary: `「${hit.clip.name}」音频 → ${JSON.stringify(hit.clip.audio)}` }
    },
  },

  {
    id: 'clip.set_color',
    label: '设置调色',
    category: 'clip',
    params: {
      clipId: clipIdParam,
      brightness: num('亮度 -1~1', { minimum: -1, maximum: 1 }),
      contrast: num('对比度 0~3', { minimum: 0, maximum: 3 }),
      saturation: num('饱和度 0~3', { minimum: 0, maximum: 3 }),
      temperature: num('色温 -1~1', { minimum: -1, maximum: 1 }),
      exposure: num('曝光 -3~3', { minimum: -3, maximum: 3 }),
    },
    enabled: (doc, p) => {
      if (!findClip(doc, p.clipId)) return `片段 ${p.clipId} 不存在`
      if (!['brightness', 'contrast', 'saturation', 'temperature', 'exposure'].some((k) => p[k] !== undefined)) return '至少要给一个调色字段'
      return null
    },
    run: (doc, p) => {
      const hit = patchClip(doc, p.clipId, (c) => {
        c.color = { ...(c.color ?? {}) }
        for (const k of ['brightness', 'contrast', 'saturation', 'temperature', 'exposure']) if (p[k] !== undefined) c.color[k] = p[k]
      })
      return { doc, changed: [p.clipId], created: [], summary: `「${hit.clip.name}」调色 → ${JSON.stringify(hit.clip.color)}` }
    },
  },

  {
    id: 'clip.set_text',
    label: '设置文字（字幕/花字）',
    category: 'clip',
    params: {
      clipId: clipIdParam,
      content: { type: 'string', description: '文字内容' },
      size: num('字号（像素）', { minimum: 6, maximum: 400 }),
      color: { type: 'string', description: '颜色 #RRGGBB' },
      align: { type: 'string', enum: ['left', 'center', 'right'] },
    },
    enabled: (doc, p) => {
      const hit = findClip(doc, p.clipId)
      if (!hit) return `片段 ${p.clipId} 不存在`
      // 视频轨上压字是正常做法（字幕条/花字常常就放在视频轨），所以不按轨道类型拦；
      // 只要求"确实给了要改的字段"，免得空命令进历史。
      if (!['content', 'size', 'color', 'align'].some((k) => p[k] !== undefined)) return '至少要给 content / size / color / align 之一'
      return null
    },
    run: (doc, p) => {
      const hit = patchClip(doc, p.clipId, (c) => {
        c.text = { ...(c.text ?? {}) }
        for (const k of ['content', 'size', 'color', 'align']) if (p[k] !== undefined) c.text[k] = p[k]
        if (p.content !== undefined) c.name = String(p.content).slice(0, 20) || c.name
      })
      return { doc, changed: [p.clipId], created: [], summary: `「${hit.clip.name}」文字 → ${JSON.stringify(hit.clip.text).slice(0, 80)}` }
    },
  },

  {
    id: 'clip.set_transition',
    label: '设置转场',
    category: 'clip',
    params: {
      clipId: clipIdParam,
      edge: { type: 'string', required: true, enum: ['in', 'out'] },
      type: { type: 'string', enum: ['dissolve', 'fadeBlack', 'fadeWhite', 'push', 'wipe'], description: '缺省=保留原类型' },
      duration: num('转场时长（秒），0=移除', { minimum: 0, maximum: 10 }),
      remove: { type: 'boolean', description: 'true=移除该侧转场' },
    },
    enabled: (doc, p) => {
      const hit = findClip(doc, p.clipId)
      if (!hit) return `片段 ${p.clipId} 不存在`
      if (p.duration !== undefined && p.duration > hit.clip.duration) return `转场 ${p.duration}s 比片段本身（${hit.clip.duration}s）还长`
      return null
    },
    run: (doc, p) => {
      const key = p.edge === 'in' ? 'transitionIn' : 'transitionOut'
      const hit = patchClip(doc, p.clipId, (c) => {
        if (p.remove || p.duration === 0) { delete c[key]; return }
        c[key] = { type: p.type ?? c[key]?.type ?? 'dissolve', duration: p.duration ?? c[key]?.duration ?? 0.4 }
      })
      return { doc, changed: [p.clipId], created: [], summary: p.remove || p.duration === 0 ? `移除「${hit.clip.name}」${p.edge} 转场` : `「${hit.clip.name}」${p.edge} 转场 → ${JSON.stringify(hit.clip[key])}` }
    },
  },

  {
    id: 'clip.add_effect',
    label: '添加特效',
    category: 'clip',
    params: {
      clipId: clipIdParam,
      type: { type: 'string', required: true, enum: ['blur', 'sharpen', 'vignette', 'glow', 'glitch', 'mosaic', 'noiseReduce', 'filter', 'chalkDust'] },
      strength: num('强度 0~1', { default: 0.5, minimum: 0, maximum: 1 }),
      start: num('片段内起点（秒）', { minimum: 0 }),
      end: num('片段内终点（秒）', { minimum: 0 }),
    },
    enabled: (doc, p) => {
      if (!findClip(doc, p.clipId)) return `片段 ${p.clipId} 不存在`
      return null
    },
    run: (doc, p, ctx) => {
      const id = ctx.newId('fx')
      const hit = patchClip(doc, p.clipId, (c) => {
        c.effects = [...(c.effects ?? []), { id, type: p.type, name: p.type, strength: p.strength ?? 0.5, enabled: true, start: p.start ?? 0, end: p.end ?? c.duration }]
      })
      return { doc, changed: [p.clipId], created: [id], summary: `给「${hit.clip.name}」加特效 ${p.type}` }
    },
  },

  {
    id: 'sequence.rename',
    label: '重命名序列',
    category: 'sequence',
    params: { name: { type: 'string', required: true, description: '新名字（≤40 字）' }, sequenceId: { type: 'string' } },
    enabled: (doc, p) => {
      const { error } = resolveSequence(doc, p.sequenceId)
      if (error) return error
      if (!String(p.name).trim()) return '序列名不能为空'
      if (String(p.name).length > 40) return `序列名太长（${String(p.name).length} 字，上限 40）`
      return null
    },
    run: (doc, p) => {
      const { seq } = resolveSequence(doc, p.sequenceId)
      const from = seq.name
      seq.name = String(p.name).trim()
      return { doc, changed: [seq.id], created: [], summary: `序列「${from}」→「${seq.name}」` }
    },
  },

  {
    id: 'media.remove',
    label: '从媒体库移除',
    category: 'media',
    params: {
      mediaIds: { type: 'array', required: true, description: '要移除的媒体 id', items: { type: 'string' } },
      removeClips: { type: 'boolean', description: 'true=同时删除引用它的片段' },
    },
    destructive: true,
    enabled: (doc, p) => {
      const missing = p.mediaIds.filter((id) => !(doc.media ?? []).some((m) => m.id === id))
      if (missing.length) return `这些媒体不存在：${missing.join(', ')}`
      if (!p.removeClips) {
        const refs = (doc.sequences ?? []).flatMap((s) => (s.clips ?? []).filter((c) => p.mediaIds.includes(c.mediaId)))
        if (refs.length) return `还有 ${refs.length} 个片段引用着这些素材；先删片段，或传 removeClips=true`
      }
      return null
    },
    run: (doc, p) => {
      const ids = new Set(p.mediaIds)
      const names = (doc.media ?? []).filter((m) => ids.has(m.id)).map((m) => m.name)
      doc.media = (doc.media ?? []).filter((m) => !ids.has(m.id))
      let droppedClips = 0
      if (p.removeClips) {
        for (const sq of doc.sequences ?? []) {
          const keep = (sq.clips ?? []).filter((c) => {
            const drop = c.mediaId && ids.has(c.mediaId)
            if (drop) droppedClips += 1
            return !drop
          })
          sq.clips = keep
        }
      }
      return { doc, changed: [...ids], created: [], summary: `从媒体库移除 ${ids.size} 个素材（${names.slice(0, 3).join('、')}${names.length > 3 ? '…' : ''}）${droppedClips ? `，同时删除 ${droppedClips} 个片段` : ''}` }
    },
  },

  {
    id: 'timeline.razor_at',
    label: '在指定时刻切开所有片段',
    category: 'timeline',
    params: {
      at: num('切线时刻（秒）', { required: true, minimum: 0 }),
      fps: num('帧率（帧网格对齐与端点判定用；缺省取工程设置）', { minimum: 1, maximum: 240 }),
      sequenceId: { type: 'string' },
    },
    enabled: (doc, p) => {
      const { seq, error } = resolveSequence(doc, p.sequenceId)
      if (error) return error
      const fps = p.fps ?? doc.settings?.fps ?? 30
      const half = 1 / fps / 2
      const hits = (seq.clips ?? []).filter((c) => p.at > c.start + half && p.at < c.start + c.duration - half)
      if (!hits.length) return `在 ${p.at}s 处没有可切开的片段（片段端点不会被子切开）`
      return null
    },
    run: (doc, p, ctx) => {
      const { seq } = resolveSequence(doc, p.sequenceId)
      const fps = p.fps ?? doc.settings?.fps ?? 30
      const half = 1 / fps / 2
      const at = round(p.at)
      const rightOf = new Map()
      const created = []
      const changed = []
      const next = []
      for (const c of seq.clips ?? []) {
        if (!(at > c.start + half && at < c.start + c.duration - half)) { next.push(c); continue }
        const offset = round(at - c.start)
        const left = { ...c, duration: offset, outPoint: round(c.inPoint + offset) }
        const right = {
          ...structuredClone(c),
          id: ctx.newId('clip'),
          start: at,
          duration: round(c.duration - offset),
          inPoint: round(c.inPoint + offset),
          linkedId: c.linkedId, // 右段的联动关系在下面统一重接
        }
        left.meta = mirrorMeta(left, seq)
        right.meta = mirrorMeta(right, seq)
        rightOf.set(c.id, right.id)
        created.push(right.id)
        changed.push(c.id)
        next.push(left, right)
      }
      // 联动的音视频同时被切开时，右段与右段互相关联（与前端 razor 语义一致）
      const rights = new Set(rightOf.values())
      seq.clips = next.map((c) => (rights.has(c.id) && c.linkedId && rightOf.has(c.linkedId)
        ? { ...c, linkedId: rightOf.get(c.linkedId) }
        : c))
      return { doc, changed, created, summary: `在 ${at}s 切开 ${changed.length} 个片段` }
    },
  },

  {
    id: 'timeline.set_clip_starts',
    label: '按精确位置摆放片段（可解重叠）',
    category: 'timeline',
    params: {
      moves: {
        type: 'array', required: true, description: '[{ clipId, start, trackId? }]：目标位置（秒），trackId 可选=顺带换轨',
        items: { type: 'object' },
      },
      overlap: {
        type: 'string', enum: ['reject', 'push'],
        description: 'reject=重叠即拒（默认，给智能体）；push=把同轨后面的片段往右推（给拖拽）',
      },
    },
    enabled: (doc, p) => {
      if (!p.moves.length) return 'moves 不能为空'
      const missing = p.moves.filter((m) => !findClip(doc, m.clipId)).map((m) => m.clipId)
      if (missing.length) return `这些片段不存在：${missing.join(', ')}`
      for (const m of p.moves) {
        const hit = findClip(doc, m.clipId)
        if (m.start < -0.001) return `片段 ${m.clipId} 的目标位置 ${m.start}s 为负`
        if (m.trackId) {
          const target = (hit.seq.tracks ?? []).find((t) => t.id === m.trackId)
          if (!target) return `轨道 ${m.trackId} 不存在；可用：${(hit.seq.tracks ?? []).map((t) => t.id).join(', ')}`
          if (target.kind !== hit.track?.kind) return `片段在 ${hit.track?.kind} 轨上，不能移到 ${target.kind} 轨`
        }
      }
      // reject 模式先说清"和谁撞了、怎么办"，而不是等写入闸门报一句泛泛的不合规
      if ((p.overlap ?? 'reject') === 'reject') {
        for (const m of p.moves) {
          const hit = findClip(doc, m.clipId)
          const c = hit.clip
          const targetTrack = m.trackId ?? c.trackId
          const clash = (hit.seq.clips ?? []).find((x) => x.id !== c.id && x.trackId === targetTrack
            && m.start < x.start + x.duration - 1e-6 && m.start + c.duration > x.start + 1e-6)
          if (clash) {
            return `片段 ${m.clipId} 放到 ${round(m.start)}s 会和「${clash.name ?? clash.id}」(${clash.start}s~${round(clash.start + clash.duration)}s) 重叠；要自动推开请传 overlap:"push"`
          }
        }
      }
      return null
    },
    run: (doc, p) => {
      const changed = []
      for (const m of p.moves) {
        const hit = patchClip(doc, m.clipId, (c) => {
          c.start = round(m.start)
          if (m.trackId) c.trackId = m.trackId
        })
        if (hit) changed.push(m.clipId)
      }
      const pushed = (p.overlap ?? 'reject') === 'push' ? pushOverlaps(doc, changed) : []
      return {
        doc,
        changed: [...new Set([...changed, ...pushed])],
        created: [],
        summary: `摆放 ${changed.length} 个片段${pushed.length ? `（顺带把 ${pushed.length} 个往后推）` : ''}`,
      }
    },
  },

  {
    id: 'timeline.trim_to',
    label: '把某一侧修到指定位置',
    category: 'timeline',
    params: {
      clipId: clipIdParam,
      edge: { type: 'string', required: true, enum: ['in', 'out'], description: 'in=起点侧，out=终点侧' },
      at: num('边界的绝对时间轴位置（秒）——吸附请由调用方先做好', { required: true, minimum: 0 }),
      linked: { type: 'boolean', description: 'true=联动的音视频一起修剪（默认 true）' },
      overlap: { type: 'string', enum: ['reject', 'clamp'], description: 'reject=撞邻居即拒（默认）；clamp=夹到邻居边界' },
    },
    enabled: (doc, p) => {
      const hit = findClip(doc, p.clipId)
      if (!hit) return `片段 ${p.clipId} 不存在`
      const c = hit.clip
      const end = c.start + c.duration
      if (p.edge === 'out' && p.at <= c.start + 0.02) return `终点侧修到 ${round(p.at)}s 会让片段长度 ≤ 0（片段 ${c.start}s~${round(end)}s）`
      if (p.edge === 'in' && p.at >= end - 0.02) return `起点侧修到 ${round(p.at)}s 会让片段长度 ≤ 0（片段 ${c.start}s~${round(end)}s）`
      // reject（默认）：提前说清"这一刀会压到谁"。注意规范把同轨重叠定为**警告**，
      // 所以这类拒绝是**命令策略**而不是规范强制——策略必须显式、可关（传 clamp 即可）。
      if ((p.overlap ?? 'reject') === 'reject') {
        const same = (hit.seq.clips ?? []).filter((x) => x.id !== c.id && x.trackId === c.trackId)
        const newStart = p.edge === 'in' ? p.at : c.start
        const newEnd = p.edge === 'in' ? end : p.at
        const clash = same.find((x) => newStart < x.start + x.duration - 1e-6 && newEnd > x.start + 1e-6)
        if (clash) return `修到 ${round(p.at)}s 会压到同轨的「${clash.name ?? clash.id}」(${clash.start}s~${round(clash.start + clash.duration)}s)；要自动夹住请传 overlap:"clamp"`
      }
      return null
    },
    run: (doc, p) => {
      const seq = resolveSequence(doc).seq
      const target = findClip(doc, p.clipId)
      const ids = new Set([p.clipId])
      if (p.linked !== false && target.clip.linkedId) {
        const partner = (seq.clips ?? []).find((c) => c.id === target.clip.linkedId)
        if (partner) ids.add(partner.id)
      }
      const mode = p.overlap ?? 'reject'
      const changed = []
      const clamped = []
      for (const cid of ids) {
        const hit = patchClip(doc, cid, (c) => {
          let at = round(p.at)
          const before = at
          if (mode === 'clamp') at = clampTrim(seq, c, p.edge, at)
          if (at !== before) clamped.push(cid)
          if (p.edge === 'out') {
            c.duration = round(at - c.start)
            c.outPoint = round(c.inPoint + c.duration)
          } else {
            const delta = round(at - c.start)
            c.start = at
            c.duration = round(c.duration - delta)
            c.inPoint = round(c.inPoint + delta)
          }
        })
        if (hit) changed.push(cid)
      }
      return {
        doc,
        changed: [...new Set(changed)],
        created: [],
        summary: `修剪 ${changed.length} 个片段的 ${p.edge} 边到 ${round(p.at)}s${clamped.length ? `（${clamped.length} 个被夹到邻居边界）` : ''}`,
      }
    },
  },

  {
    id: 'timeline.stagger_elements',
    label: '让同镜头的元素先后出现（错开）',
    category: 'timeline',
    params: {
      gapSeconds: num('相邻元素的错开量（秒）', { minimum: 0.05, maximum: 2 }),
      sequenceId: { type: 'string' },
      from: num('只处理起点 ≥ 该时刻的组（秒）'),
      to: num('只处理起点 < 该时刻的组（秒）'),
    },
    enabled: (doc, p) => {
      const { seq, error } = resolveSequence(doc, p.sequenceId)
      if (error) return error
      const groups = staggerGroups(seq, p)
      if (!groups.length) return '没有找到"同一时刻起步、带显现动画"的元素组（可能已经错开过了）'
      if (!groups.some((g) => g.items.length > 1)) return '所有组的元素数都是 1，无需错开'
      return null
    },
    run: (doc, p) => {
      const { seq } = resolveSequence(doc, p.sequenceId)
      const gap = p.gapSeconds ?? 0.3
      const groups = staggerGroups(seq, p).filter((g) => g.items.length > 1)
      const moved = []
      const clamped = []
      for (const g of groups) {
        g.items.forEach((item, i) => {
          const shift = round(i * gap)
          if (shift <= 0) return
          // 显现片段与其 hold 一起后移
          const reveal = seq.clips.find((c) => c.id === item.revealId)
          const hold = item.holdId ? seq.clips.find((c) => c.id === item.holdId) : null
          if (reveal) {
            reveal.start = round(reveal.start + shift)
            reveal.meta = mirrorMeta(reveal, seq)
            moved.push(reveal.id)
          }
          if (hold) {
            const end = round(hold.start + hold.duration) // 保持结束时刻不变
            hold.start = round(hold.start + shift)
            const next = round(end - hold.start)
            if (next < 0.2) {
              // 错开量太大，hold 会被压没：夹到 0.2s 并如实报告
              hold.duration = 0.2
              hold.start = round(end - 0.2)
              clamped.push(hold.id)
            } else {
              hold.duration = next
            }
            hold.meta = mirrorMeta(hold, seq)
            moved.push(hold.id)
          }
        })
      }
      return {
        doc,
        changed: [...new Set(moved)],
        created: [],
        summary: `错开 ${groups.length} 组元素（间距 ${gap}s，共移动 ${new Set(moved).size} 个片段）${clamped.length ? `；${clamped.length} 个 hold 被压到最短 0.2s` : ''}`,
      }
    },
  },
)

// ── 派生结构必须在**所有**命令注册完之后计算（第二批命令是 push 进来的）──
// 踩过一次真坑：写在 push 之前时 COMMAND_IDS 与 byId 都会漏掉新命令，
// 表现是"命令表里有、applyCommand 却说未知命令"。registry 一致性由 core.test.mjs 守着。
export const COMMAND_IDS = COMMANDS.map((c) => c.id)
const byId = new Map(COMMANDS.map((c) => [c.id, c]))