/**
 * OpenTimelineIO 互操作（对外交付格式）。
 *
 * OTIO 是影视工业的交换格式（Pixar 起头，已被多家 NLE/流程工具支持）。做它的价值不是"多一种导出"，
 * 而是**让这份工程能被别的软件读**，也让"我们的时间模型是否站得住"有一个外部标尺。
 *
 * 两个模型的根本差异（也是本文件大部分代码存在的原因）：
 *   TO DO：每条片段带**绝对起点**（start/duration），同轨可以有重叠（叠化/覆盖），时间用浮点秒。
 *   OTIO ：轨道是**顺序**的——位置由"前面所有片段与 Gap 的长度和"隐含，重叠无法表达。
 * 所以 toOtio 要按起点排序 + 用 Gap 填洞 + 把重叠如实记进 lossy；fromOtio 要把顺序累加回绝对起点。
 *
 * 时间用 `RationalTime{rate, value}`（value 是**帧数**）。本项目帧率由 settings.fps 给出，
 * 经 server/spec/ticks.mjs 归一成有理数（29.97 → 30000/1001），避免把 29.97 当成 2997/100。
 */
import { toFrameRate, rateToNumber } from '../spec/ticks.mjs'

export const OTIO_SCHEMA = {
  timeline: 'Timeline.1',
  stack: 'Stack.1',
  track: 'Track.1',
  clip: 'Clip.1',
  gap: 'Gap.1',
  timeRange: 'TimeRange.1',
  rationalTime: 'RationalTime.1',
  externalRef: 'ExternalReference.1',
  missingRef: 'MissingReference.1',
}

const rt = (frames, rate) => ({ OTIO_SCHEMA: OTIO_SCHEMA.rationalTime, rate, value: Math.round(frames) })
const timeRange = (startFrames, durationFrames, rate) => ({
  OTIO_SCHEMA: OTIO_SCHEMA.timeRange, start_time: rt(startFrames, rate), duration: rt(durationFrames, rate),
})

/** 只保留整数帧：TO DO 是浮点秒，转 OTIO 必然落到帧网格上——落到网格外的部分要如实报告。 */
const secToFrames = (seconds, rate) => Math.round(Number(seconds) * rate)
const framesToSec = (frames, rate) => Number(frames) / rate

/**
 * 工程 → OTIO。
 * @returns {{otio:object, lossy:Array<{code:string, path:string, message:string}>}}
 */
export function toOtio(doc, { sequenceId = null, name = null } = {}) {
  const lossy = []
  const seqs = doc.sequences ?? []
  const seq = sequenceId ? seqs.find((s) => s.id === sequenceId) : (seqs.find((s) => s.id === doc.activeSeqId) ?? seqs[0])
  if (!seq) {
    return { otio: null, lossy: [{ code: 'no_sequence', path: '$', message: '工程里没有可导出的序列' }] }
  }
  const rate = rateToNumber(toFrameRate(doc.settings?.fps ?? 30))
  const tracks = []

  for (const track of seq.tracks ?? []) {
    const clips = (seq.clips ?? []).filter((c) => c.trackId === track.id).sort((a, b) => a.start - b.start)
    const children = []
    let cursor = 0 // 已铺到的帧位置
    for (const c of clips) {
      const startF = secToFrames(c.start, rate)
      const durF = secToFrames(c.duration, rate)
      if (startF < cursor) {
        // 同轨重叠：OTIO 的顺序模型表达不了，如实记录并把起点夹到游标处
        lossy.push({
          code: 'track_overlap', path: `sequences.${seq.id}.tracks.${track.id}.${c.id}`,
          message: `同轨重叠：起点 ${c.start}s 落在前一段结束（${framesToSec(cursor, rate)}s）之内；OTIO 用 Gap 顺序表达位置，重叠会被压平`,
        })
      }
      const gapFrames = Math.max(0, startF - cursor)
      if (gapFrames > 0) children.push({ OTIO_SCHEMA: OTIO_SCHEMA.gap, name: 'Gap', source_range: timeRange(0, gapFrames, rate) })
      const media = (doc.media ?? []).find((m) => m.id === c.mediaId)
      const inF = secToFrames(c.inPoint ?? 0, rate)
      const srcDurF = secToFrames(Math.max(0.001, (c.outPoint ?? 0) - (c.inPoint ?? 0)), rate)
      const target = media?.relPath || media?.path || null
      const clip = {
        OTIO_SCHEMA: OTIO_SCHEMA.clip,
        name: c.name ?? c.id,
        source_range: timeRange(inF, srcDurF, rate),
        media_reference: target
          ? { OTIO_SCHEMA: OTIO_SCHEMA.externalRef, target_url: String(target).replace(/\\/g, '/'), available_range: timeRange(0, secToFrames(media.duration ?? 0, rate), rate) }
          : { OTIO_SCHEMA: OTIO_SCHEMA.missingRef },
        metadata: {
          todo: {
            clipId: c.id, mediaId: c.mediaId ?? null, start: c.start, duration: c.duration,
            inPoint: c.inPoint ?? 0, outPoint: c.outPoint ?? 0, enabled: c.enabled !== false,
            speed: c.speed ?? 1, reverse: !!c.reverse, linkedId: c.linkedId ?? null,
            transform: c.transform ?? null, color: c.color ?? null, audio: c.audio ?? null,
            text: c.text ?? null, effects: c.effects ?? [], keyframes: c.keyframes ?? null,
            transitions: { in: c.transitionIn ?? null, out: c.transitionOut ?? null },
          },
        },
      }
      children.push(clip)
      cursor = Math.max(cursor, startF + durF)
    }
    // 轨道类型：OTIO 只有 Video/Audio 两类
    let kind = track.kind === 'audio' ? 'Audio' : 'Video'
    if (track.kind !== 'audio' && track.kind !== 'video') {
      lossy.push({ code: 'track_kind_folded', path: `tracks.${track.id}`, message: `轨道类型 "${track.kind}" 在 OTIO 里没有对应项，已按 Video 导出（原名保留在 metadata.todo.trackKind）` })
    }
    tracks.push({
      OTIO_SCHEMA: OTIO_SCHEMA.track,
      name: track.name ?? track.id,
      kind,
      metadata: { todo: { trackId: track.id, trackKind: track.kind, muted: !!track.muted, hidden: !!track.hidden, locked: !!track.locked } },
      children,
    })
  }

  if ((seq.markers ?? []).length) {
    lossy.push({ code: 'markers_dropped', path: `sequences.${seq.id}.markers`, message: `${seq.markers.length} 个标记未导出（OTIO 的 marker 挂在 item 上，本项目挂在序列上）` })
  }
  if ((seq.clips ?? []).some((c) => c.keyframes && Object.keys(c.keyframes).length)) {
    lossy.push({ code: 'keyframes_metadata_only', path: `sequences.${seq.id}`, message: '关键帧保留在 metadata.todo 里（未映射成 OTIO 的 effect/animation）' })
  }

  const otio = {
    OTIO_SCHEMA: OTIO_SCHEMA.timeline,
    name: name ?? seq.name ?? doc.projectName ?? 'TO DO Timeline',
    global_start_time: null,
    metadata: {
      todo: {
        spec: 'todo-project/' + (doc.version ?? 2), projectName: doc.projectName ?? null,
        sequenceId: seq.id, fps: doc.settings?.fps ?? 30, rate,
        canvas: { width: doc.settings?.width ?? null, height: doc.settings?.height ?? null },
      },
    },
    tracks: { OTIO_SCHEMA: OTIO_SCHEMA.stack, name: 'tracks', children: tracks },
  }
  return { otio, lossy }
}

/**
 * OTIO → 一条 TO DO 序列。
 * @param {object} otio
 * @param {{media?:Array, sequenceId?:string, trackIds?:Function}} [opts] media 用于按 relPath 找回 mediaId
 * @returns {{sequence:object, lossy:Array}}
 */
export function fromOtio(otio, opts = {}) {
  const lossy = []
  const media = opts.media ?? []
  const stack = otio?.tracks
  if (!stack?.children) return { sequence: null, lossy: [{ code: 'bad_otio', path: '$', message: 'otio.tracks.children 不存在，不是有效的 OTIO 时间轴' }] }
  const tracks = []
  const clips = []
  let n = 0
  const newId = opts.trackIds ?? ((p) => `${p}_otio_${++n}`)

  stack.children.filter((c) => c.OTIO_SCHEMA === OTIO_SCHEMA.track).forEach((t, ti) => {
    const todo = t.metadata?.todo ?? {}
    const kind = todo.trackKind ?? (String(t.kind).toLowerCase() === 'audio' ? 'audio' : 'video')
    const trackId = todo.trackId ?? newId('track')
    tracks.push({
      id: trackId, kind, name: t.name ?? `T${ti + 1}`,
      locked: !!todo.locked, muted: !!todo.muted, solo: false, hidden: !!todo.hidden, height: 48,
    })
    let cursorFrames = 0
    for (const child of t.children ?? []) {
      const rate = child.source_range?.duration?.rate ?? otio.tracks?.metadata?.todo?.rate ?? 30
      if (child.OTIO_SCHEMA === OTIO_SCHEMA.gap) {
        cursorFrames += Number(child.source_range?.duration?.value ?? 0)
        continue
      }
      if (child.OTIO_SCHEMA !== OTIO_SCHEMA.clip) {
        lossy.push({ code: 'item_dropped', path: `tracks.${ti}.children`, message: `未支持的元素 ${child.OTIO_SCHEMA}，已跳过` })
        continue
      }
      const durF = Number(child.source_range?.duration?.value ?? 0)
      const inF = Number(child.source_range?.start_time?.value ?? 0)
      const url = child.media_reference?.target_url ?? null
      const norm = (s) => String(s ?? '').replace(/\\/g, '/')
      const m = url ? media.find((x) => norm(x.relPath) === norm(url) || norm(x.path) === norm(url)) : null
      if (url && !m) lossy.push({ code: 'media_unmatched', path: `media_reference`, message: `找不到素材：${url}（片段仍会导入，但素材引用为空）` })
      const clip = {
        id: child.metadata?.todo?.clipId ?? newId('clip'),
        trackId,
        ...(m ? { mediaId: m.id } : {}),
        name: child.name ?? 'OTIO 片段',
        start: framesToSec(cursorFrames, rate),
        duration: framesToSec(durF, rate),
        inPoint: framesToSec(inF, rate),
        outPoint: framesToSec(inF + durF, rate),
        speed: child.metadata?.todo?.speed ?? 1,
        reverse: !!child.metadata?.todo?.reverse,
        enabled: child.metadata?.todo?.enabled !== false,
        effects: child.metadata?.todo?.effects ?? [],
        ...(child.metadata?.todo?.transform ? { transform: child.metadata.todo.transform } : {}),
        ...(child.metadata?.todo?.text ? { text: child.metadata.todo.text } : {}),
      }
      clips.push(clip)
      cursorFrames += durF
    }
  })

  const seq = { id: opts.sequenceId ?? 'seq_otio', name: otio.name ?? 'OTIO 导入', tracks, clips, markers: [] }
  const dropped = ['transitionIn', 'transitionOut', 'color', 'audio', 'keyframes', 'linkedId']
  lossy.push({ code: 'fields_not_restored', path: '$', message: `这些字段只存在于 metadata.todo（未映射回工程字段，需要时读 metadata）：${dropped.join(', ')}` })
  return { sequence: seq, lossy }
}
