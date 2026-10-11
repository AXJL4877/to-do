/**
 * 工程文档规范（todo-project/2 形式化）+ 校验器 + 机器可读摘要。
 *
 * 设计目标（AI 原生）：
 *   1. 读工程不用读源码：所有单位、权威字段、引用关系都写在 shared/spec/project-v2.schema.json 里；
 *   2. 一次调用看懂一个工程：summarizeProject() 把几百 KB 的工程压成几 KB 的结构化概览；
 *   3. 出错可机器处理：错误带 code / path / hint，可直接喂回给智能体修；
 *   4. 零依赖：不引 ajv，纯函数，可在 Electron 主进程 / Node / 浏览器里跑。
 *
 * 用法（CLI）:
 *   node server/spec/projectSpec.mjs <工程.todo.json>            校验并打印报告
 *   node server/spec/projectSpec.mjs <工程.todo.json> --summary  只打印摘要
 *   node server/spec/projectSpec.mjs <工程.todo.json> --human    人类可读输出
 */

export const SPEC_PROJECT_V2 = 'todo-project/2'

/** 顶层键与它们的性质：document=文档（进版本比较）/ session=会话（不该进 diff）/ meta=元信息 */
export const TOP_LEVEL = {
  version: 'meta', savedAt: 'meta', projectName: 'document', settings: 'document',
  media: 'document', folders: 'document', sequences: 'document',
  activeSeqId: 'session', playhead: 'session', monitorCompose: 'session',
  script: 'document', scriptMemo: 'document', scriptWorkspace: 'session',
  prefs: 'session', presets: 'document', fonts: 'document',
}

const err = (code, at, message, hint) => ({ code, path: at, message, hint })
const warn = (code, at, message, hint) => ({ code, path: at, message, hint })
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

/** 识别一份文档属于哪个规范（不抛异常，识别不了返回 'unknown'）。 */
export function detectSpec(doc) {
  if (!isObj(doc)) return 'unknown'
  if (typeof doc.spec === 'string') return doc.spec
  if (doc.version === 2) return SPEC_PROJECT_V2
  if (isNum(doc.version)) return `todo-project/v${doc.version}`
  return 'unknown'
}

/**
 * 校验工程文档。返回机器可读报告；**不抛异常**（除传入完全非对象）。
 * @returns {{ok:boolean, spec:string, errors:Array, warnings:Array, stats:object}}
 */
export function validateProject(doc) {
  const errors = []
  const warnings = []
  if (!isObj(doc)) {
    return { ok: false, spec: 'unknown', errors: [err('not_object', '$', '工程根节点不是对象')], warnings: [], stats: {} }
  }
  const spec = detectSpec(doc)
  if (spec !== SPEC_PROJECT_V2) {
    warnings.push(warn('unknown_spec', '$.version', `未识别的工程版本：${JSON.stringify(doc.version ?? doc.spec)}`,
      `当前校验器只认 ${SPEC_PROJECT_V2}（version=2）。升级后用 spec 字符串标注版本。`))
  }

  // ---- 顶层 ----
  for (const key of Object.keys(doc)) {
    if (!(key in TOP_LEVEL)) warnings.push(warn('unknown_key', `$.${key}`, `未知顶层字段 ${key}`, '向前兼容：保留即可，但规范里没有它'))
  }

  // ---- settings / canvas ----
  const st = isObj(doc.settings) ? doc.settings : null
  if (!st) errors.push(err('missing_settings', '$.settings', '缺少 settings', '画布规格（width/height/fps）必须存在'))
  else {
    for (const [k, min] of [['width', 16], ['height', 16]]) {
      if (!isNum(st[k])) errors.push(err('bad_canvas', `$.settings.${k}`, `${k} 必须是数字（像素）`))
      else if (st[k] < min) errors.push(err('bad_canvas', `$.settings.${k}`, `${k}=${st[k]} 小于 ${min} 像素`))
    }
    if (!isNum(st.fps) || st.fps <= 0 || st.fps > 240) errors.push(err('bad_canvas', '$.settings.fps', 'fps 必须是 (0,240] 的数字（帧/秒）'))
  }

  // ---- media ----
  const media = Array.isArray(doc.media) ? doc.media : []
  if (!Array.isArray(doc.media)) errors.push(err('missing_media', '$.media', 'media 必须是数组'))
  const mediaById = new Map()
  media.forEach((m, i) => {
    const at = `$.media[${i}]`
    if (!isObj(m)) { errors.push(err('bad_media', at, '媒体项不是对象')); return }
    if (!m.id) errors.push(err('bad_media', `${at}.id`, '媒体缺少 id'))
    else if (mediaById.has(m.id)) errors.push(err('duplicate_id', `${at}.id`, `媒体 id 重复：${m.id}`))
    else mediaById.set(m.id, m)
    if (!['video', 'audio', 'image', 'font', 'sticker'].includes(m.kind)) {
      errors.push(err('bad_media_kind', `${at}.kind`, `未知媒体类型 ${JSON.stringify(m.kind)}`))
    }
    if (isNum(m.duration) && m.duration < 0) errors.push(err('bad_media', `${at}.duration`, '时长不能为负（单位：秒）'))
    // 长期引用：relPath 权威；两者都没有则这份工程搬走就找不到素材
    if (m.kind !== 'font' && !m.relPath && !m.path) {
      warnings.push(warn('media_no_ref', at, `媒体「${m.name ?? m.id}」既无 relPath 也无 path`, '补 relPath 才能整包搬走'))
    }
    if (m.path && !m.relPath) {
      warnings.push(warn('media_no_relpath', at, `媒体「${m.name ?? m.id}」只有绝对路径`, '保存时主进程会补 relPath'))
    }
  })

  // ---- sequences ----
  const seqs = Array.isArray(doc.sequences) ? doc.sequences : []
  if (!Array.isArray(doc.sequences) || !seqs.length) errors.push(err('missing_sequences', '$.sequences', 'sequences 必须是非空数组'))
  const seqIds = new Set()
  let clipTotal = 0
  let trackTotal = 0
  seqs.forEach((sq, si) => {
    const at = `$.sequences[${si}]`
    if (!isObj(sq)) { errors.push(err('bad_sequence', at, '序列不是对象')); return }
    if (!sq.id) errors.push(err('bad_sequence', `${at}.id`, '序列缺少 id'))
    else if (seqIds.has(sq.id)) errors.push(err('duplicate_id', `${at}.id`, `序列 id 重复：${sq.id}`))
    else seqIds.add(sq.id)

    const tracks = Array.isArray(sq.tracks) ? sq.tracks : []
    if (!Array.isArray(sq.tracks)) errors.push(err('missing_tracks', `${at}.tracks`, 'tracks 必须是数组'))
    const trackById = new Map()
    tracks.forEach((t, ti) => {
      const tat = `${at}.tracks[${ti}]`
      if (!isObj(t)) { errors.push(err('bad_track', tat, '轨道不是对象')); return }
      if (!t.id) errors.push(err('bad_track', `${tat}.id`, '轨道缺少 id'))
      else if (trackById.has(t.id)) errors.push(err('duplicate_id', `${tat}.id`, `轨道 id 重复：${t.id}`))
      else trackById.set(t.id, t)
      if (!['video', 'audio', 'subtitle', 'effect', 'adjustment'].includes(t.kind)) {
        errors.push(err('bad_track_kind', `${tat}.kind`, `未知轨道类型 ${JSON.stringify(t.kind)}`))
      }
    })
    trackTotal += tracks.length

    const clips = Array.isArray(sq.clips) ? sq.clips : []
    if (!Array.isArray(sq.clips)) errors.push(err('missing_clips', `${at}.clips`, 'clips 必须是数组'))
    const perTrack = new Map()
    clips.forEach((c, ci) => {
      const cat = `${at}.clips[${ci}]`
      if (!isObj(c)) { errors.push(err('bad_clip', cat, '片段不是对象')); return }
      const who = c.name ?? c.id ?? `#${ci}`
      if (!c.id) errors.push(err('bad_clip', `${cat}.id`, '片段缺少 id'))
      if (!c.trackId || !trackById.has(c.trackId)) {
        errors.push(err('orphan_track', `${cat}.trackId`, `片段「${who}」指向不存在的轨道 ${JSON.stringify(c.trackId)}`, '删除该片段或补回轨道'))
      }
      if (c.mediaId && !mediaById.has(c.mediaId)) {
        errors.push(err('orphan_media', `${cat}.mediaId`, `片段「${who}」指向不存在的媒体 ${c.mediaId}`, '用 relPath 重新关联，或删除该片段'))
      }
      if (!c.mediaId && !c.solid && !c.text) {
        warnings.push(warn('clip_no_source', cat, `片段「${who}」既无媒体也无纯色/文字`))
      }
      for (const k of ['start', 'duration', 'inPoint', 'outPoint']) {
        if (!isNum(c[k])) errors.push(err('bad_clip_time', `${cat}.${k}`, `${k} 必须是数字（秒）`))
      }
      if (isNum(c.start) && c.start < 0) errors.push(err('bad_clip_time', `${cat}.start`, '起点不能为负（秒）'))
      if (isNum(c.duration) && c.duration <= 0) errors.push(err('bad_clip_time', `${cat}.duration`, '时长必须大于 0（秒）'))
      const m = c.mediaId ? mediaById.get(c.mediaId) : null
      if (m && isNum(c.outPoint) && isNum(c.inPoint) && isNum(m.duration) && m.duration > 0) {
        if (c.outPoint > m.duration + 0.05) {
          warnings.push(warn('clip_past_media_end', `${cat}.outPoint`, `出点 ${c.outPoint}s 超出媒体时长 ${m.duration}s（片段「${who}」）`,
            '超出部分解码器会补最后一帧或黑帧'))
        }
        if (c.inPoint >= c.outPoint) {
          errors.push(err('bad_clip_time', `${cat}.outPoint`, `出点必须大于入点（${c.inPoint} → ${c.outPoint}）`))
        }
      }
      // 派生镜像一致性（meta 是派生，权威在片段自身）
      const meta = isObj(c.meta) ? c.meta : null
      if (meta) {
        const expect = { absIn: c.start, absOut: c.start + c.duration, start: c.start, duration: c.duration, end: c.start + c.duration, inPoint: c.inPoint, outPoint: c.outPoint }
        for (const [k, v] of Object.entries(expect)) {
          if (isNum(meta[k]) && isNum(v) && Math.abs(meta[k] - v) > 0.02) {
            warnings.push(warn('meta_mirror_drift', `${cat}.meta.${k}`, `派生字段与片段不一致：meta.${k}=${meta[k]} vs ${v.toFixed(3)}`,
              '权威在片段自身；重新入轨会刷新 meta'))
          }
        }
      }
      if (isNum(c.start) && isNum(c.duration)) {
        const list = perTrack.get(c.trackId) ?? []
        list.push({ who, a: c.start, b: c.start + c.duration })
        perTrack.set(c.trackId, list)
      }
      clipTotal += 1
    })
    // 同轨重叠：允许（叠化/覆盖），但值得提醒
    for (const [tid, list] of perTrack) {
      list.sort((x, y) => x.a - y.a)
      for (let i = 1; i < list.length; i += 1) {
        if (list[i].a < list[i - 1].b - 0.02) {
          warnings.push(warn('track_overlap', `${at}.clips`, `轨道 ${tid} 上「${list[i - 1].who}」与「${list[i].who}」时间重叠`,
            '同轨重叠 = 后者覆盖前者，确认是否本意'))
        }
      }
    }
  })

  // ---- activeSeqId 悬空（实测踩过，直接导致片段越堆越多）----
  if (doc.activeSeqId != null && !seqIds.has(doc.activeSeqId)) {
    errors.push(err('dangling_active_seq', '$.activeSeqId', `activeSeqId=${doc.activeSeqId} 不在 sequences 里`,
      '改成 sequences[0].id 或补回该序列；悬空会让新片段不断堆进旧序列'))
  }

  // ---- 成片登记 ----
  const aps = st && isObj(st.aiProductions) ? st.aiProductions : null
  if (aps) {
    for (const [id, p] of Object.entries(aps)) {
      if (!isObj(p)) { errors.push(err('bad_production_ref', `$.settings.aiProductions.${id}`, '成片登记不是对象')); continue }
      if (!isNum(p.t0)) errors.push(err('bad_production_ref', `$.settings.aiProductions.${id}.t0`, 't0 必须是数字（秒）'))
      if (typeof p.auto !== 'boolean') errors.push(err('bad_production_ref', `$.settings.aiProductions.${id}.auto`, 'auto 必须是布尔'))
      if (p.placed != null && !isObj(p.placed)) errors.push(err('bad_production_ref', `$.settings.aiProductions.${id}.placed`, 'placed 必须是对象'))
    }
  }

  const stats = {
    seqCount: seqs.length, trackCount: trackTotal, clipCount: clipTotal,
    mediaCount: media.length, productionCount: aps ? Object.keys(aps).length : 0,
  }
  return { ok: errors.length === 0, spec, errors, warnings, stats }
}

/**
 * 机器可读摘要：把一份工程压成 AI 一眼能看懂的结构（画布 / 序列 / 轨道 / 时间跨度 / 成片 / 素材清单）。
 * 目的：不需要读原始 JSON 就能规划编辑操作。
 */
export function summarizeProject(doc, { maxMedia = 40 } = {}) {
  if (!isObj(doc)) return { ok: false, error: 'not_object' }
  const st = isObj(doc.settings) ? doc.settings : {}
  const seqs = Array.isArray(doc.sequences) ? doc.sequences : []
  const media = Array.isArray(doc.media) ? doc.media : []
  return {
    ok: true,
    spec: detectSpec(doc),
    name: doc.projectName ?? null,
    canvas: { width: st.width ?? null, height: st.height ?? null, fps: st.fps ?? null, background: st.canvasBg ?? null },
    activeSeqId: doc.activeSeqId ?? null,
    sequences: seqs.map((sq) => {
      const clips = Array.isArray(sq.clips) ? sq.clips : []
      const end = clips.reduce((t, c) => Math.max(t, (c.start ?? 0) + (c.duration ?? 0)), 0)
      const byKind = {}
      const mediaById = new Map(media.map((m) => [m.id, m]))
      for (const c of clips) {
        const k = mediaById.get(c.mediaId)?.kind ?? (c.text ? 'text' : c.solid ? 'solid' : 'none')
        byKind[k] = (byKind[k] ?? 0) + 1
      }
      return {
        id: sq.id, name: sq.name ?? null, duration: +end.toFixed(3),
        workRange: [sq.workIn ?? 0, sq.workOut ?? 0],
        trackCount: (sq.tracks ?? []).length,
        tracks: (sq.tracks ?? []).map((t) => ({
          id: t.id, kind: t.kind, name: t.name ?? null, role: t.role ?? null,
          hidden: !!t.hidden, muted: !!t.muted, locked: !!t.locked,
          clips: clips.filter((c) => c.trackId === t.id).length,
        })),
        clips: clips.length, clipsByMediaKind: byKind,
        markers: (sq.markers ?? []).length,
      }
    }),
    productions: Object.entries(st.aiProductions ?? {}).map(([id, p]) => ({
      id, t0: p?.t0 ?? null, auto: !!p?.auto, placed: Object.keys(p?.placed ?? {}).length,
    })),
    media: {
      total: media.length,
      byKind: media.reduce((acc, m) => ({ ...acc, [m.kind]: (acc[m.kind] ?? 0) + 1 }), {}),
      sample: media.slice(0, maxMedia).map((m) => ({
        id: m.id, kind: m.kind, name: m.name ?? null, relPath: m.relPath ?? null,
        duration: m.duration ?? null, alpha: !!m.alpha, chromaKey: m.chromaKey ?? null,
      })),
      truncated: Math.max(0, media.length - maxMedia),
    },
  }
}
