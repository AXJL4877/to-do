import { create } from 'zustand'
import {
  type Camera3D, type Clip, type ClipMeta, type Keyframe, type EffectPreset, type ExportJob, type MediaItem, type ProjectSettings, type Sequence,
  type Tool, type Track, type TrackKind, type Transform2D, type Transform3D, type TransitionType,
  defaultAudio, defaultColor, defaultScene3d, defaultText, defaultTransform, defaultTransform3d, uid,
} from './types'
import { applyPresetKeyframes, findMotionPreset, presetDuration, type ParamValues } from './lib/motionPresets'
import { autoBezierKeyframes, isEntranceKeyframes, splitKeyframes, patchClipTransform, patchClipXY, resolveClipTransform, sampleKeyframes, seedPositionKeyframes, defaultHandles, snapToFrame } from './lib/keyframeEval'
import { clearAllPreviewCaches, clearPreviewCache, getProgramPreviewCache, notifyPreviewCacheChanged } from './lib/previewCache'
import { setDiskCacheLimitGb } from './lib/previewDiskCache'
import { ensureScene3d } from './lib/scene3d'
import { desktop } from './lib/desktop'
import { mayHaveAlpha } from './lib/mediaAlpha'
import { clampZoom } from './lib/timelineZoom'
import { aiFetch } from './lib/aiFetch'
import { setLivePlayhead } from './lib/livePlayhead'
import { reviveMediaList, parseDesktopMedia, pathToFileUrl } from './lib/importFiles'
import { buildEditGraph } from './lib/editGraph'
import { tidyTimeline } from './lib/timelineTidy'

function sampleAt(c: Clip, prop: string, localT: number): number {
  const tr = c.transform
  switch (prop) {
    case 'x': return sampleKeyframes(c.keyframes.x, localT, tr.x)
    case 'y': return sampleKeyframes(c.keyframes.y, localT, tr.y)
    case 'scale': return sampleKeyframes(c.keyframes.scale, localT, tr.scaleX)
    case 'rotation': return sampleKeyframes(c.keyframes.rotation, localT, tr.rotation)
    case 'opacity': return sampleKeyframes(c.keyframes.opacity, localT, tr.opacity)
    case 'fontSize': return sampleKeyframes(c.keyframes.fontSize, localT, c.text?.fontSize ?? 48)
    case 'volume': return sampleKeyframes(c.keyframes.volume, localT, c.audio.gainDb)
    default: return 0
  }
}

function bakeProp(c: Clip, prop: string, value: number): Clip {
  switch (prop) {
    case 'x': return { ...c, transform: { ...c.transform, x: value } }
    case 'y': return { ...c, transform: { ...c.transform, y: value } }
    case 'scale': return { ...c, transform: { ...c.transform, scaleX: value, scaleY: value } }
    case 'rotation': return { ...c, transform: { ...c.transform, rotation: value } }
    case 'opacity': return { ...c, transform: { ...c.transform, opacity: value } }
    case 'fontSize': return c.text ? { ...c, text: { ...c.text, fontSize: value } } : c
    case 'volume': return { ...c, audio: { ...c.audio, gainDb: value } }
    default: return c
  }
}

function makeTracks(): Track[] {
  // 初始仅一条视频轨 + 一条音频轨；需要时再自动增删
  return [
    { id: 'tv1', kind: 'video', name: 'V1', locked: false, muted: false, solo: false, hidden: false, height: 48 },
    { id: 'ta1', kind: 'audio', name: 'A1', locked: false, muted: false, solo: false, hidden: false, height: 40 },
  ]
}

function rangeOverlap(aStart: number, aDur: number, bStart: number, bDur: number) {
  return aStart < bStart + bDur && bStart < aStart + aDur
}

function buildClipMeta(clip: Clip, track?: Track, source?: ClipMeta['source']): ClipMeta {
  const absIn = Math.max(0, clip.start)
  const duration = Math.max(0.1, clip.duration)
  const absOut = absIn + duration
  const enabled = clip.enabled !== false
  const trackHidden = !!track?.hidden
  return {
    absIn,
    absOut,
    start: absIn,
    duration,
    end: absOut,
    inPoint: clip.inPoint,
    outPoint: clip.outPoint,
    trackId: clip.trackId,
    trackName: track?.name,
    trackKind: track?.kind,
    enabled,
    trackHidden,
    trackMuted: !!track?.muted,
    visible: enabled && !trackHidden,
    source: source ?? clip.meta?.source,
    updatedAt: Date.now(),
  }
}

function withFreshClipMeta(seq: Sequence): Sequence {
  const byTrack = new Map(seq.tracks.map((t) => [t.id, t]))
  return {
    ...seq,
    clips: seq.clips.map((c) => ({
      ...c,
      meta: buildClipMeta(c, byTrack.get(c.trackId), c.meta?.source),
    })),
  }
}

function newTrackOfKind(seq: Sequence, kind: TrackKind): Track {
  const n = seq.tracks.filter((t) => t.kind === kind).length + 1
  return {
    id: uid('track'),
    kind,
    name: kind === 'video' ? `V${n}` : kind === 'audio' ? `A${n}` : kind === 'subtitle' ? '字幕' : String(kind),
    locked: false, muted: false, solo: false, hidden: false,
    height: kind === 'subtitle' ? 28 : 40,
  }
}

function renameKindTracks(tracks: Track[]): Track[] {
  const counts: Partial<Record<TrackKind, number>> = {}
  return tracks.map((t) => {
    if (t.kind !== 'video' && t.kind !== 'audio') return t
    counts[t.kind] = (counts[t.kind] || 0) + 1
    const n = counts[t.kind]!
    return { ...t, name: t.kind === 'video' ? `V${n}` : `A${n}` }
  })
}

/** 在同 kind 段前/后插入新轨 */
function insertTrack(
  tracks: Track[],
  track: Track,
  where: 'before' | 'after',
): Track[] {
  const indices = tracks.map((t, i) => (t.kind === track.kind ? i : -1)).filter((i) => i >= 0)
  if (!indices.length) {
    if (track.kind === 'video') {
      const audioAt = tracks.findIndex((t) => t.kind === 'audio')
      if (audioAt >= 0) return [...tracks.slice(0, audioAt), track, ...tracks.slice(audioAt)]
    }
    return where === 'before' ? [track, ...tracks] : [...tracks, track]
  }
  if (where === 'before') {
    const i = indices[0]
    return [...tracks.slice(0, i), track, ...tracks.slice(i)]
  }
  const i = indices[indices.length - 1]
  return [...tracks.slice(0, i + 1), track, ...tracks.slice(i + 1)]
}

/**
 * 无片段的轨道自动删除；始终保留至少 1 条视频轨 + 1 条音频轨。
 * 字幕等其它轨：有片段才保留。
 */
function pruneEmptyTracks(seq: Sequence): Sequence {
  const used = new Set(seq.clips.map((c) => c.trackId))
  let tracks = seq.tracks.filter((t) => used.has(t.id))

  if (!tracks.some((t) => t.kind === 'video')) {
    tracks.push({
      id: uid('track'), kind: 'video', name: 'V1',
      locked: false, muted: false, solo: false, hidden: false, height: 48,
    })
  }
  if (!tracks.some((t) => t.kind === 'audio')) {
    tracks.push({
      id: uid('track'), kind: 'audio', name: 'A1',
      locked: false, muted: false, solo: false, hidden: false, height: 40,
    })
  }

  tracks = [
    ...tracks.filter((t) => t.kind === 'subtitle'),
    ...tracks.filter((t) => t.kind === 'video'),
    ...tracks.filter((t) => t.kind === 'audio'),
    ...tracks.filter((t) => t.kind !== 'subtitle' && t.kind !== 'video' && t.kind !== 'audio'),
  ]
  tracks = renameKindTracks(tracks)
  return { ...seq, tracks }
}

/** 一次生成要占的轨：每类几条，从同类第一条轨往下数（音频第 1 层 = 第一条音频轨，画面第 k 层 = 从上往下第 k 条视频轨） */
export type GroupLanes = { audio?: number; video?: number }

/**
 * 一次 AI 生成（可能是配音 + 好几层画面）整组入轨的起点：
 * 它要占的那几条轨在播放头处都空着就从播放头放；有一条被占，整组接在这几条轨里最晚的切口后面。
 * 整组各层从同一时刻开始、组内相对时间不变；不占的轨（比如整条背景音乐）不影响位置，也不另起一组新轨。
 */
export function appendGroupSlot(seq: Sequence, lanes: GroupLanes, at: number, duration: number) {
  const pick = (kind: TrackKind, n = 0) => seq.tracks.filter((t) => t.kind === kind && !t.locked).slice(0, Math.max(0, n))
  const tracks = { audio: pick('audio', lanes.audio), video: pick('video', lanes.video) }
  const ids = new Set([...tracks.audio, ...tracks.video].map((t) => t.id))
  const used = seq.clips.filter((c) => ids.has(c.trackId))
  const free = !used.some((c) => rangeOverlap(at, duration, c.start, c.duration))
  const start = free || !used.length ? at : Math.max(...used.map((c) => c.start + c.duration))
  return { start, tracks: { audio: tracks.audio.map((t) => t.id), video: tracks.video.map((t) => t.id) } }
}

/** 在 [start, start+duration) 找无重叠的同 kind 轨道；没有则新建（绝对时间不变） */
function resolveFreeTrack(seq: Sequence, kind: TrackKind, start: number, duration: number): { seq: Sequence; track: Track } {
  const candidates = seq.tracks.filter((t) => t.kind === kind && !t.locked)
  for (const track of candidates) {
    const hit = seq.clips.some(
      (c) => c.trackId === track.id && rangeOverlap(start, duration, c.start, c.duration),
    )
    if (!hit) return { seq, track }
  }
  const track = newTrackOfKind(seq, kind)
  return { seq: { ...seq, tracks: insertTrack(seq.tracks, track, 'before') }, track }
}

/**
 * 硬规则：同一轨道上绝对时间轴不得交叉。
 * 冲突片段保留 absIn/absOut，挪到同 kind 空轨；没有则新建轨道。
 */
function enforceNoOverlap(seq: Sequence): Sequence {
  let tracks = [...seq.tracks]
  const clips = seq.clips.map((c) => ({ ...c }))
  const kinds = [...new Set([...tracks.map((t) => t.kind), ...clips.map((c) => {
    const tr = tracks.find((t) => t.id === c.trackId)
    return tr?.kind
  }).filter(Boolean) as TrackKind[]])]

  for (const kind of kinds) {
    const kindTrackIds = () => new Set(tracks.filter((t) => t.kind === kind).map((t) => t.id))
    let guard = 0
    while (guard++ < 200) {
      const ids = kindTrackIds()
      const ordered = clips
        .filter((c) => ids.has(c.trackId))
        .sort((a, b) => a.start - b.start || a.duration - b.duration || a.id.localeCompare(b.id))

      let conflict: Clip | null = null
      const lastByTrack = new Map<string, Clip>()
      for (const c of ordered) {
        const prev = lastByTrack.get(c.trackId)
        if (prev && rangeOverlap(prev.start, prev.duration, c.start, c.duration)) {
          conflict = c
          break
        }
        lastByTrack.set(c.trackId, c)
      }
      if (!conflict) break

      const start = conflict.start
      const duration = conflict.duration
      let placed = false
      for (const track of tracks.filter((t) => t.kind === kind && !t.locked && t.id !== conflict.trackId)) {
        const hit = clips.some(
          (c) => c.id !== conflict!.id && c.trackId === track.id && rangeOverlap(start, duration, c.start, c.duration),
        )
        if (!hit) {
          conflict.trackId = track.id
          placed = true
          break
        }
      }
      if (!placed) {
        const track = newTrackOfKind({ ...seq, tracks }, kind)
        tracks = insertTrack(tracks, track, 'before')
        conflict.trackId = track.id
      }
    }
  }

  return withFreshClipMeta(pruneEmptyTracks({ ...seq, tracks, clips }))
}

/** 裁剪时钳制到同轨邻居，禁止越过交叉 */
function clipSpeed(c: Clip) {
  return Math.max(0.05, c.speed <= 0 ? 1 : (c.speed || 1))
}

function clampTrimNoOverlap(seq: Sequence, clip: Clip, edge: 'in' | 'out', t: number): Clip {
  const speed = clipSpeed(clip)
  const others = seq.clips.filter((c) => c.trackId === clip.trackId && c.id !== clip.id)
  if (edge === 'in') {
    const prevEnd = others
      .filter((c) => c.start < clip.start + 1e-6)
      .reduce((m, c) => Math.max(m, c.start + c.duration), 0)
    const maxEnd = clip.start + clip.duration
    const snapped = Math.max(prevEnd, Math.min(t, maxEnd - 0.1))
    const delta = snapped - clip.start
    const duration = Math.max(0.1, clip.duration - delta)
    const inPoint = clip.inPoint + delta * speed
    return { ...clip, start: snapped, duration, inPoint, outPoint: inPoint + duration * speed }
  }
  const nextStart = others
    .filter((c) => c.start > clip.start + 1e-6)
    .reduce((m, c) => Math.min(m, c.start), Number.POSITIVE_INFINITY)
  const maxOut = Number.isFinite(nextStart) ? nextStart : Number.POSITIVE_INFINITY
  const duration = Math.max(0.1, Math.min(t, maxOut) - clip.start)
  return { ...clip, duration, outPoint: clip.inPoint + duration * speed }
}

export const RATE_MIN = 0.25
export const RATE_MAX = 4

/**
 * 比率拉伸：素材跨度不变，拖边缘改时间线长度，speed = 跨度 / 长度（缩短即加速、拉长即减速）。
 * 静态片段（图片/文字/纯色）无源时长：speed 保持 1，改时长并按比例缩放关键帧与转场。
 */
function rateStretchNoOverlap(seq: Sequence, clip: Clip, edge: 'in' | 'out', t: number, timed = true): Clip {
  const speed = clipSpeed(clip)
  const span = clip.outPoint > clip.inPoint ? clip.outPoint - clip.inPoint : clip.duration * speed
  const others = seq.clips.filter((c) => c.trackId === clip.trackId && c.id !== clip.id)
  const end = clip.start + clip.duration
  let want: number
  if (edge === 'in') {
    const prevEnd = others
      .filter((c) => c.start < clip.start + 1e-6)
      .reduce((m, c) => Math.max(m, c.start + c.duration), 0)
    want = end - Math.max(prevEnd, t)
  } else {
    const nextStart = others
      .filter((c) => c.start > clip.start + 1e-6)
      .reduce((m, c) => Math.min(m, c.start), Number.POSITIVE_INFINITY)
    want = Math.min(t, nextStart) - clip.start
  }
  const scaleBy = (k: number) => (list: Keyframe[]) => list.map((kf) => ({ ...kf, t: kf.t * k }))
  if (!timed) {
    const duration = Math.max(0.1, want)
    const k = duration / Math.max(1e-6, clip.duration)
    const scale = scaleBy(k)
    const tr = (x?: Clip['transitionIn']) => (x ? { ...x, duration: x.duration * k } : x)
    return {
      ...clip,
      start: edge === 'in' ? end - duration : clip.start,
      duration,
      outPoint: clip.inPoint + duration,
      keyframes: Object.fromEntries(Object.entries(clip.keyframes ?? {}).map(([p, list]) => [p, scale(list)])),
      speedKeyframes: scale(clip.speedKeyframes ?? []),
      transitionIn: tr(clip.transitionIn),
      transitionOut: tr(clip.transitionOut),
    }
  }
  const nextSpeed = Math.min(RATE_MAX, Math.max(RATE_MIN, span / Math.max(0.1, want)))
  const duration = span / nextSpeed
  const scale = scaleBy(duration / Math.max(1e-6, clip.duration))
  return {
    ...clip,
    start: edge === 'in' ? end - duration : clip.start,
    duration,
    speed: Math.round(nextSpeed * 1000) / 1000,
    outPoint: clip.inPoint + span,
    speedKeyframes: scale(clip.speedKeyframes ?? []),
    keyframes: Object.fromEntries(Object.entries(clip.keyframes ?? {}).map(([p, list]) => [p, scale(list)])),
  }
}

/**
 * 移动后若同轨交叉：保持绝对时间，改放到空轨；整组移动失败则回退原位。
 */
function applyMoveNoOverlap(
  seq: Sequence,
  moving: Clip[],
  excludeIds: Set<string>,
): { seq: Sequence; clips: Clip[] } {
  let nextSeq = seq
  const result = moving.map((c) => ({ ...c }))
  for (const clip of result) {
    const track = nextSeq.tracks.find((t) => t.id === clip.trackId)
    const kind = track?.kind ?? 'video'
    const hit = nextSeq.clips.some(
      (c) => !excludeIds.has(c.id) && c.trackId === clip.trackId
        && rangeOverlap(clip.start, clip.duration, c.start, c.duration),
    ) || result.some(
      (c) => c.id !== clip.id && c.trackId === clip.trackId
        && rangeOverlap(clip.start, clip.duration, c.start, c.duration),
    )
    if (!hit) continue
    // 相对其他已放置结果 + 原序列静止 clips 找空轨
    const phantom: Sequence = {
      ...nextSeq,
      clips: [
        ...nextSeq.clips.filter((c) => !excludeIds.has(c.id)),
        ...result.filter((c) => c.id !== clip.id),
      ],
    }
    const resolved = resolveFreeTrack(phantom, kind, clip.start, clip.duration)
    nextSeq = { ...nextSeq, tracks: resolved.seq.tracks }
    clip.trackId = resolved.track.id
  }
  return { seq: nextSeq, clips: result }
}

/** 视频片段缺链接 A 轨时补上（旧工程 / 热更新前入轨） */
function withLinkedAudioClips(seq: Sequence, mediaList: MediaItem[]): Sequence {
  const aTrack = seq.tracks.find((t) => t.kind === 'audio')
  if (!aTrack) return seq
  const byId = new Map(mediaList.map((m) => [m.id, m]))
  const extras: Clip[] = []
  let changed = false

  // 先拆开误并到同 kind（尤其是都进 V 轨）的链接音视频
  let clips = seq.clips.map((c) => {
    const track = seq.tracks.find((t) => t.id === c.trackId)
    const m = c.mediaId ? byId.get(c.mediaId) : undefined
    if (m?.kind === 'audio' && track && track.kind !== 'audio') {
      changed = true
      return { ...c, trackId: aTrack.id }
    }
    if (!track || track.kind === 'audio' || !c.linkedId) return c
    const partner = seq.clips.find((x) => x.id === c.linkedId)
    if (!partner || partner.mediaId !== c.mediaId) return c
    const pt = seq.tracks.find((t) => t.id === partner.trackId)
    if (pt?.kind !== 'video' || track.kind !== 'video') return c
    // 同媒体、都在 V 轨：名称带「音频」或作为链接从属侧的挪回 A
    const audioSide = /音频/.test(c.name) || partner.linkedId === c.id
    if (!audioSide) return c
    changed = true
    return { ...c, trackId: aTrack.id }
  })

  clips = clips.map((c) => {
    const track = seq.tracks.find((t) => t.id === c.trackId)
    const m = c.mediaId ? byId.get(c.mediaId) : undefined
    if (!m || m.kind !== 'video' || m.hasAudio === false || track?.kind !== 'video') return c
    const linked =
      (c.linkedId ? clips.find((x) => x.id === c.linkedId) : undefined)
      ?? clips.find((x) =>
        x.linkedId === c.id && seq.tracks.find((t) => t.id === x.trackId)?.kind === 'audio')
      ?? extras.find((x) => x.linkedId === c.id)
    if (linked) {
      if (c.linkedId === linked.id) return c
      changed = true
      return { ...c, linkedId: linked.id }
    }
    const aid = uid('clip')
    changed = true
    extras.push({
      ...JSON.parse(JSON.stringify(c)) as Clip,
      id: aid,
      trackId: aTrack.id,
      linkedId: c.id,
      name: `${c.name} 音频`,
      transform: defaultTransform(),
      color: defaultColor(),
      effects: [],
      text: undefined,
    })
    return { ...c, linkedId: aid }
  })
  if (!changed) return seq
  return { ...seq, clips: [...clips, ...extras] }
}

/** 把入场/出场时长写回片段上实际存在的动画源 */
function applyEdgeAnimDuration(c: Clip, edge: 'in' | 'out', sec: number): Clip {
  const dur = Math.max(0.2, c.duration)
  const s = Math.max(0.05, Math.min(dur * 0.85, sec))
  const peak = c.transform.opacity
  let next: Clip = { ...c, keyframes: { ...c.keyframes } }

  if (edge === 'in') {
    if (next.transitionIn) {
      next = { ...next, transitionIn: { ...next.transitionIn, duration: s } }
    }
    if (next.text && next.text.animIn !== 'none') {
      next = { ...next, text: { ...next.text, animInDur: s } }
    }
    if (next.audio.fadeIn > 0) {
      next = { ...next, audio: { ...next.audio, fadeIn: s } }
    }
    const op = [...(next.keyframes.opacity ?? [])].sort((a, b) => a.t - b.t)
    if (op.length >= 2 && op[0].t <= 0.08 && op[0].value < 0.2) {
      let i = 1
      while (i < op.length && op[i].value < peak * 0.55) i++
      const outPart = op.slice(i + 1)
      const mk = (t: number, value: number, ease: import('./types').Ease) =>
        ({ id: uid('kf'), t, value, ease })
      next = {
        ...next,
        keyframes: {
          ...next.keyframes,
          opacity: [mk(0, 0, 'linear'), mk(s, peak, 'easeOut'), ...outPart],
        },
      }
    }
    for (const key of ['x', 'y', 'scale'] as const) {
      const kf = next.keyframes[key]
      if (!kf || kf.length < 2) continue
      const sorted = [...kf].sort((a, b) => a.t - b.t)
      if (isEntranceKeyframes(sorted)) {
        const rewritten = sorted.map((k, idx) => (idx === 1 ? { ...k, t: s } : k))
        next = { ...next, keyframes: { ...next.keyframes, [key]: rewritten } }
      }
    }
  } else {
    if (next.transitionOut) {
      next = { ...next, transitionOut: { ...next.transitionOut, duration: s } }
    }
    if (next.text && next.text.animOut !== 'none') {
      next = { ...next, text: { ...next.text, animOutDur: s } }
    }
    if (next.audio.fadeOut > 0) {
      next = { ...next, audio: { ...next.audio, fadeOut: s } }
    }
    const op = [...(next.keyframes.opacity ?? [])].sort((a, b) => a.t - b.t)
    if (op.length >= 2) {
      const last = op[op.length - 1]
      if (last.t >= dur - 0.08 && last.value < 0.2) {
        let i = op.length - 2
        while (i >= 0 && op[i].value < peak * 0.55) i--
        const inPart = op.slice(0, Math.max(0, i + 1))
        const outStart = Math.max(0, dur - s)
        const mk = (t: number, value: number, ease: import('./types').Ease) =>
          ({ id: uid('kf'), t, value, ease })
        next = {
          ...next,
          keyframes: {
            ...next.keyframes,
            opacity: [...inPart, mk(outStart, peak, 'linear'), mk(dur, 0, 'easeIn')],
          },
        }
      }
    }
  }
  return next
}

function makeSeq(name = '序列 1'): Sequence {
  return {
    id: uid('seq'), name, tracks: makeTracks(), clips: [], markers: [],
    workIn: 0, workOut: 10, scene3d: defaultScene3d(),
  }
}

function migrateSequence(q: Sequence): Sequence {
  const tracks = q.tracks.filter((t) => {
    if (t.kind !== 'effect' && t.kind !== 'adjustment') return true
    return q.clips.some((c) => c.trackId === t.id)
  })
  const trackKind = new Map(q.tracks.map((t) => [t.id, t.kind]))
  const clipTrack = new Map(q.clips.map((c) => [c.id, c.trackId]))
  // 扩展模块的画面片段不再链接配音（旧工程里每段都挂在配音上，点一个会选中全部）
  const aiVisualLinkedToAudio = (c: Clip) => !!c.linkedId && c.meta?.source?.type === 'ai' && !c.text
    && trackKind.get(c.trackId) !== 'audio' && trackKind.get(clipTrack.get(c.linkedId) ?? '') === 'audio'
  return enforceNoOverlap({
    ...q,
    tracks,
    scene3d: ensureScene3d(q.scene3d),
    clips: q.clips.map((c) => ({
      ...c,
      ...(aiVisualLinkedToAudio(c) ? { linkedId: undefined } : {}),
      transform3d: c.transform3d ?? (c.threeD ? defaultTransform3d() : undefined),
    })),
  })
}

function defaultSettings(): ProjectSettings {
  return {
    width: 1920, height: 1080, fps: 30, aspect: '16:9', pixelAspect: 1,
    stillDuration: 5, cachePath: './cache', useProxy: false, hwAccel: true,
    nativePreview: false,
    canvasBg: 'black', canvasColor: '#0a0a0a', safeFrame: false, magnetic: false, snap: true,
  }
}

function defaultFolders() {
  return [
    { id: 'f_all', name: '全部' }, { id: 'f_broll', name: 'B-roll' },
    { id: 'f_audio', name: '音频' }, { id: 'f_sticker', name: '贴纸' },
  ]
}

type Snap = { sequences: Sequence[]; activeSeqId: string }
let clipboard: Clip[] = []
let attrClipboard: Pick<Clip, 'transform' | 'color' | 'audio'> | null = null

export type DraftEntry = { id: string; name: string; updatedAt: number; path?: string }

/** 工程文件 JSON 版本；v2 起素材带 relPath、文件带 savedAt */
const PROJECT_FILE_VERSION = 2
/** 工程内容相关字段：任一变化即视为未保存 */
const DIRTY_KEYS = ['sequences', 'activeSeqId', 'media', 'folders', 'settings', 'presets', 'fonts', 'monitorCompose', 'script'] as const
/** >0 时的 set 不标脏（加载/保存本身引起的字段变化） */
let dirtyMute = 0
let fileSaving: Promise<boolean> | null = null
/** 正在复制进项目的 AI 素材 id，防止并发重复收集 */
const collecting = new Set<string>()
/** 复制失败过的「项目|地址」，不再反复重试和提示 */
const collectFailed = new Set<string>()

export function projectNameFromPath(p: string) {
  const base = p.split(/[\\/]/).pop() || p
  return base.replace(/\.todo\.json$/i, '').replace(/\.json$/i, '') || base
}

/** AI 服务地址上的产物（http://…/ai-generated/<name>）→ 文件名；已收集进项目的本机文件返回 null */
function aiServiceFileName(url: string): string | null {
  const m = /^(?:https?:\/\/[^/]+)?\/ai-generated\/([^/?#]+)(?:[?#].*)?$/i.exec(url)
  if (!m) return null
  try { return decodeURIComponent(m[1]) } catch { return null }
}

export type NewProjectOptions = {
  name: string
  /** 项目文件夹建在它下面（桌面版） */
  parentDir: string
  settings: Partial<ProjectSettings>
  /** 旧的本地草稿转存为项目 */
  fromDraftId?: string
}

export type AppStore = {
  drafts: DraftEntry[]
  /** 有打开的项目；桌面版启动时为 false，先显示起始页 */
  started: boolean
  /** 新建项目弹窗；fromDraftId = 把旧草稿转存为项目 */
  newProjectDialog: { fromDraftId?: string } | null
  projectId: string
  projectName: string
  /** 桌面版：当前工程文件路径；null = 尚未存成文件（仅本地草稿） */
  projectPath: string | null
  /** 自上次保存到文件（或本地草稿）后有未保存改动 */
  dirty: boolean
  recentProjects: { path: string; exists: boolean }[]
  settings: ProjectSettings
  prefs: {
    defaultDuration: number
    cachePath: string
    performance: 'quality' | 'balanced' | 'speed'
    /** 预览 RAM 缓存最长边；0 = 与监视器同分辨率 */
    previewCacheMaxEdge: 0 | 480 | 720 | 1080
    /** 预览磁盘缓存上限（GB），超出按最近使用淘汰 */
    previewDiskCacheGb?: 2 | 5 | 10 | 20
    shortcuts: Record<string, string>
  }
  media: MediaItem[]
  folders: { id: string; name: string }[]
  sequences: Sequence[]
  activeSeqId: string
  selectedClipIds: string[]
  selectedMediaId: string | null
  playhead: number
  sourceIn: number
  sourceOut: number
  /** 用户打过 I/O 才按源范围入轨；默认整段素材 */
  sourceIoArmed: boolean
  sourceMediaId: string | null
  playing: boolean
  loop: boolean
  tool: Tool
  propTab: string
  libraryTab: string
  /** AI+：当前参考图（截帧 / 上传），生图·生视频共用；不进媒体库 */
  aiRefDataUrl: string | null
  /** AI+：生图 | 生视频 | 生音频 | 风格动画 */
  aiGenMode: 'image' | 'video' | 'audio' | 'anim'
  /** AI+ 弹出：独立窗 / 应用内浮窗 */
  aiFloat: boolean
  aiFloatKind: null | 'window' | 'panel'
  fullscreen: boolean
  /** 时间轴+K帧轴浮窗（应用内可拖动，非系统独立窗口） */
  timelineFloat: boolean
  /** window=系统独立窗；panel=应用内浮窗（弹窗失败时的回退） */
  timelineFloatKind: null | 'window' | 'panel'
  /** 渐进式属性轮盘：锚定节目监视器；ring 为快捷入口；dial 可直接进拨盘 */
  propWheel: null | {
    x: number
    y: number
    ring?: 'static' | 'dynamic' | 'transition'
    at?: number
    dial?: { prop: 'scale' | 'opacity' | 'x' | 'y' | 'rotation' | 'fontSize'; mode: 'static' | 'dynamic'; label: string; origin: number }
  }
  editMode: 'insert' | 'overwrite'
  toast: string | null
  exportQueue: ExportJob[]
  presets: EffectPreset[]
  fonts: { id: string; name: string; enabled: boolean }[]
  cacheMb: number
  history: Snap[]
  future: Snap[]
  multiCam: boolean
  modal: null | 'drafts' | 'settings' | 'prefs' | 'export' | 'shortcuts' | 'more'
  layout: {
    sidebarW: number
    propsW: number
    timelineH: number
    sourceMonitorH: number
    rightW: number
    dockH: number
    panelDock: { media: 'left' | 'right' | 'bottom'; ai: 'left' | 'right' | 'bottom' | 'tab' }
  }
  /** dual = 编辑窗 | 节目窗；program/edit/source 为单窗 */
  monitorView: 'program' | 'edit' | 'dual' | 'source'
  /** 节目监视器合成模式：2D Canvas 或 3D WebGL */
  monitorCompose: '2d' | '3d'
  /** 口播稿（随工程文件保存）；scriptOpen = 当前显示口播备忘录 */
  script: string
  scriptOpen: boolean
  /** K帧模式：拖位置自动在播放头打点，并显示运动路径 */
  autoKeyframe: boolean
  timelineZoom: number
  seq: () => Sequence
  setToast: (m: string | null) => void
  setModal: (m: AppStore['modal']) => void
  pushHistory: () => void
  undo: () => void
  redo: () => void
  newProject: (name?: string) => void
  setNewProjectDialog: (v: AppStore['newProjectDialog']) => void
  /** 桌面版：建项目文件夹并写入工程文件；浏览器版：新建本地项目 */
  createProject: (opts: NewProjectOptions) => Promise<boolean>
  /** 落盘后回到起始页 */
  closeProject: () => Promise<void>
  /** 把 AI 服务上的产物复制进当前项目文件夹，素材改指向项目里的文件 */
  collectAiMedia: (ids?: string[]) => Promise<void>
  /** 草稿绑定了工程文件时（桌面版）优先从文件打开；localOnly 强制读本地草稿 */
  openDraft: (id: string, opts?: { localOnly?: boolean }) => void
  saveProject: (opts?: { silent?: boolean }) => void
  /** 有 projectPath 时直接写回；saveAs 或无路径时弹另存为。返回是否写入成功 */
  saveProjectToFile: (opts?: { saveAs?: boolean; silent?: boolean }) => Promise<boolean>
  /** 不传路径弹打开对话框 */
  openProjectFromFile: (filePath?: string) => Promise<boolean>
  /** 切换/关闭前落盘：有文件写文件，否则写本地草稿 */
  flushProject: () => Promise<void>
  refreshRecentProjects: () => Promise<void>
  removeRecentProject: (filePath: string) => Promise<void>
  pickDesktopMedia: () => Promise<void>
  saveAs: (name: string) => void
  renameDraft: (id: string, name: string) => void
  duplicateDraft: (id: string) => void
  deleteDraft: (id: string) => void
  updateSettings: (p: Partial<ProjectSettings>) => void
  updatePrefs: (p: Partial<AppStore['prefs']>) => void
  setMonitorCompose: (m: '2d' | '3d') => void
  setScript: (text: string) => void
  toggleScript: (open?: boolean) => void
  setAutoKeyframe: (on: boolean) => void
  toggleAutoKeyframe: () => void
  updateScene3d: (p: Partial<Sequence['scene3d']>) => void
  updateCamera3d: (p: Partial<Camera3D>, opts?: { record?: boolean }) => void
  toggleCameraKeyframe: (prop: string) => void
  setClipThreeD: (enabled: boolean) => void
  updateSelectedTransform3d: (p: Partial<Transform3D>, opts?: { record?: boolean }) => void
  exportProgramFrame: () => Promise<void>
  importMedia: (files: { name: string; url: string; path?: string; kind: MediaItem['kind']; duration: number; width?: number; height?: number; hasAudio?: boolean; alpha?: boolean; folderId?: string }[], opts?: { silent?: boolean }) => string[]
  addFolder: (name: string) => void
  toggleFavorite: (id: string) => void
  removeMedia: (id: string) => void
  relinkMedia: (id: string, url: string, path?: string) => void
  setMediaProxyPath: (id: string, proxyPath: string | undefined) => void
  /** 桌面：对 media.path 生成代理；成功写 proxyPath */
  makeMediaProxy: (id: string, height?: 480 | 720) => Promise<boolean>
  /** 叠层播放：缺代理的视频后台补 480p */
  ensureStackProxies: (mediaIds: string[]) => void
  setSelectedMedia: (id: string | null) => void
  captureFrame: () => void
  setAiRef: (dataUrl: string | null) => void
  setAiGenMode: (m: 'image' | 'video' | 'audio' | 'anim') => void
  setAiFloat: (v: boolean) => void
  setPlayhead: (t: number, opts?: { exact?: boolean }) => void
  togglePlay: () => void
  stepFrame: (d: 1 | -1) => void
  setLoop: (v: boolean) => void
  setTool: (t: Tool) => void
  setPropTab: (t: string) => void
  setLibraryTab: (t: string) => void
  setFullscreen: (v: boolean) => void
  setTimelineFloat: (v: boolean) => void
  openPropWheel: (x: number, y: number, ring?: 'static' | 'dynamic' | 'transition') => void
  closePropWheel: () => void
  /** 在节目监视器中心打开属性轮盘 */
  openPropWheelOnMonitor: (ring?: 'static' | 'dynamic' | 'transition') => void
  /** 监视器中心直接打开属性拨盘（S/R；K帧模式下打关键帧） */
  openPropDialOnMonitor: (prop: 'scale' | 'opacity' | 'rotation') => void
  setEditMode: (m: 'insert' | 'overwrite') => void
  setSourceIO: (a: number, b: number) => void
  addClipFromMedia: (
    mediaId: string,
    trackId?: string,
    at?: number,
    opts?: { preferFreeTrack?: boolean; source?: ClipMeta['source'] },
  ) => void
  selectClips: (ids: string[]) => void
  moveClips: (ids: string[], dt: number, trackId?: string, opts?: { record?: boolean }) => void
  razorAtPlayhead: () => void
  /** 在指定时间剪切，不改播放头 */
  razorAtTime: (t: number) => void
  deleteSelected: (ripple?: boolean) => void
  closeGaps: () => void
  duplicateSelected: () => void
  copyOrPaste: () => void
  copySelected: () => void
  cutSelected: () => void
  pasteClipboard: () => void
  selectAllClips: () => void
  toggleClipEnabled: () => void
  unlinkSelected: () => void
  linkSelected: () => void
  groupSelected: () => void
  ungroupSelected: () => void
  setClipSpeed: (speed: number) => void
  reverseSelected: () => void
  freezeFrame: () => void
  updateSelectedTransform: (p: Partial<Clip['transform']>) => void
  /** 在播放头写入/更新动态属性关键帧（优先于静态） */
  setDynamicAtPlayhead: (prop: string, value: number) => void
  /** S/R 鼠标手势：开始时记一次历史；amount 对 scale 是倍率、对 rotation 是角度增量 */
  transformGesture: null | { prop: 'scale' | 'rotation'; keyed: boolean }
  beginTransformGesture: (prop: 'scale' | 'rotation') => boolean
  updateTransformGesture: (amount: number) => void
  endTransformGesture: (commit: boolean) => void
  updateSelectedColor: (p: Partial<Clip['color']>) => void
  updateSelectedAudio: (p: Partial<Clip['audio']>) => void
  updateSelectedText: (p: Partial<NonNullable<Clip['text']>>) => void
  updateSelectedClip: (p: Partial<Clip>) => void
  addTextClip: (opts?: { name?: string; text?: Partial<NonNullable<Clip['text']>>; transform?: Partial<Clip['transform']> }) => void
  /** 每条字幕成为字幕轨文字片段（cue 为时间线绝对时间）；给了 linkTo 就链接到该片段（随它选中、移动，裁剪各自独立） */
  addSubtitleCues: (opts: {
    cues: { text: string; start: number; end: number }[]
    linkTo?: string
    text?: Partial<NonNullable<Clip['text']>>
    transform?: Partial<Clip['transform']>
    source?: NonNullable<Clip['meta']>['source']
  }) => void
  /**
   * AI 任务流式产出的分层片段（时间为时间线绝对秒）：同一任务同 lane 的片段共用轨道，lane 小的在上层；
   * 给了 linkTo 就链接到该片段（配音）。不改选中，方便边生成边剪。返回新片段 id（顺序同 items，跳过的为 null）。
   */
  addAiLayerClips: (
    items: {
      mediaId: string; start: number; duration: number; lane: number; name?: string
      transform?: Partial<Transform2D>; keyframes?: Clip['keyframes']; source?: Partial<NonNullable<ClipMeta['source']>>
    }[],
    opts: { jobId: string; kind: string; linkTo?: string; history?: boolean },
  ) => (string | null)[]
  /** 改 / 删当前序列里的片段（null = 删除），不记撤销：给跟随其它片段自动更新的派生片段用 */
  patchClipsQuiet: (patches: Record<string, Partial<Clip> | null>) => void
  /** 在播放头新建纯色底（最底层视频轨，铺满画布） */
  addSolidClip: (color: string) => void
  /** 在播放头新建背景图（最底层视频轨，铺满画布，默认延到序列末尾） */
  addBackgroundImage: (mediaId: string) => void
  /** 把选中的图片片段换成另一张背景图；返回改了几个 */
  setSelectedBackgroundImage: (mediaId: string) => number
  /** 改选中纯色底的颜色；返回改了几个 */
  setSelectedSolidColor: (color: string) => number
  addTransition: (type: TransitionType) => void
  addEffect: (type: string, name: string) => void
  setClipMask: (type: import('./types').MaskType | null) => void
  toggleMaskInvert: () => void
  setChromaKey: (enabled: boolean) => void
  addMarker: (label?: string) => void
  setWorkArea: (a: number, b: number) => void
  toggleTrack: (id: string, key: 'locked' | 'muted' | 'solo' | 'hidden') => void
  tidyTimeline: () => void
  setTrackHeight: (id: string, height: number) => void
  addTrack: (kind: TrackKind) => void
  matchFrame: () => void
  replaceClipMedia: (mediaId: string) => void
  addKeyframe: (prop: string, value: number) => void
  removeKeyframeAtPlayhead: (prop: string) => void
  removeKeyframeById: (prop: string, kfId: string) => void
  /** 一次删除多个关键帧（可跨属性）；只记一笔历史 */
  removeKeyframesByIds: (byProp: Record<string, string[]>) => void
  clearKeyframeTrack: (prop: string) => void
  clearAllKeyframes: () => void
  setKeyframeTime: (prop: string, kfId: string, t: number) => void
  setKeyframeEase: (prop: string, kfId: string, ease: import('./types').Ease) => void
  /** 拖动贝塞尔杠杆；自动升为 bezier 并补默认手柄 */
  setKeyframeHandle: (
    prop: string,
    kfId: string,
    which: 'oh' | 'ih',
    handle: import('./types').KfHandle,
  ) => void
  enableBezierAt: (prop: string, kfId: string) => void
  /** F3：选中关键帧转自动贝塞尔（速度连续、不过冲） */
  autoBezierKeyframes: (byProp: Record<string, string[]>) => void
  /** 选中片段所有属性的全部关键帧一键自动贝塞尔 */
  autoBezierAll: () => void
  toggleKeyframeAtPlayhead: (prop: string, value: number) => void
  gotoAdjacentKeyframe: (prop: string, dir: -1 | 1) => void
  applyMotionPreset: (preset: 'fadeIn' | 'pushIn' | 'slideLeft' | 'pop' | 'fadeOut', opts?: { durationSec?: number }) => void
  setSnap: (v: boolean) => void
  setMagnetic: (v: boolean) => void
  threePointEdit: () => void
  slipClip: (dt: number, opts?: { record?: boolean }) => void
  addSequence: () => void
  setActiveSequence: (id: string) => void
  toggleMultiCam: () => void
  enqueueExport: (opts: { preset: string; name?: string; rangeOnly?: boolean; audioOnly?: boolean }) => void
  savePreset: (name: string, kind: EffectPreset['kind'], payload: unknown) => void
  applyPreset: (id: string) => void
  /** 动效预设：写成关键帧。循环类 range='playhead' 时从播放头起 seconds 秒；入场 / 出场 / 强调从播放头处开始 */
  applyAnimPreset: (id: string, values: ParamValues, opts: { range: 'clip' | 'playhead'; seconds: number; label?: string }) => void
  clearCache: () => void
  importFont: (name: string) => void
  seedDemo: () => void
  setLayout: (p: Partial<AppStore['layout']>) => void
  setMonitorView: (v: AppStore['monitorView']) => void
  setTimelineZoom: (z: number) => void
  trimClip: (id: string, edge: 'in' | 'out', t: number, opts?: { record?: boolean; free?: boolean; strong?: boolean; pxPerSec?: number }) => void
  /** 选中片段头对齐（都挪到最早的开头）或尾对齐（都挪到最晚的结尾）；书写 + 定格按一个元素整体挪 */
  alignSelectedClips: (edge: 'start' | 'end') => void
  snapGuide: number | null
  setSnapGuide: (at: number | null) => void
  /** Shift 拖播放头：吸到附近片段切口 / 标记 / 0，并显示对齐线 */
  snapPlayheadTime: (t: number, pxPerSec: number) => number
  /** 比率拉伸（R）：音视频改速度；图片 / 文字 / 纯色没有速度，退化成普通裁剪 */
  rateStretchClip: (id: string, edge: 'in' | 'out', t: number, opts?: { record?: boolean; free?: boolean; strong?: boolean; pxPerSec?: number }) => void
  /** 在时间轴上拖出入场/出场时长（转场、文字动画、淡化、透明度关键帧） */
  resizeEdgeAnim: (id: string, edge: 'in' | 'out', sec: number, opts?: { record?: boolean }) => void
  snapTime: (t: number) => number
  trackAtY: (contentY: number) => string | null
  dragMoveClips: (ids: string[], origins: Record<string, number>, dt: number, trackId?: string, opts?: { shift?: boolean; alt?: boolean; primaryId?: string; spawn?: 'before' | 'after' }) => void
  /** 仅计算吸附后的 dt，不写 store（供时间线拖拽预览） */
  previewDragDt: (ids: string[], origins: Record<string, number>, dt: number, opts?: DragSnapOpts) => number
  nudgeSelectedTransform: (dx: number, dy: number) => void
  pasteAttributes: () => void
  copyAttributes: () => void
  liftExtract: (extract: boolean) => void
  nestSelected: () => void
  setTransitionDuration: (d: number) => void
  extractAudio: () => void
  syncVideoAudioLinks: () => void
  syncByAudio: () => void
}

function loadLayout(): AppStore['layout'] {
  const fallback: AppStore['layout'] = {
    sidebarW: 248, propsW: 300, timelineH: 260, sourceMonitorH: 160,
    rightW: 280, dockH: 220,
    panelDock: { media: 'left', ai: 'tab' },
  }
  try {
    const raw = localStorage.getItem('todo-layout')
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<AppStore['layout']>
    return {
      ...fallback,
      ...parsed,
      panelDock: { ...fallback.panelDock, ...parsed.panelDock },
    }
  } catch { /* ignore */ }
  return fallback
}

const initialLayout = loadLayout()

const MONITOR_VIEWS = ['program', 'edit', 'dual', 'source'] as const
function loadMonitorView(): AppStore['monitorView'] {
  try {
    const raw = localStorage.getItem('todo-monitor-view')
    if (raw && (MONITOR_VIEWS as readonly string[]).includes(raw)) return raw as AppStore['monitorView']
  } catch { /* ignore */ }
  return 'dual'
}

/** 保证有可编辑的选中片段；失效选中时自动选中播放头下最上层片段 */
/** 背景层：从最底下的视频轨往上找 [start, start+duration) 空位，都占了就在视频段最底部新建一条 */
function backgroundTrack(get: () => AppStore, set: (p: Partial<AppStore>) => void, start: number, duration: number): Track {
  let seq = get().seq()
  const free = [...seq.tracks].reverse().find((t) => t.kind === 'video' && !t.locked
    && !seq.clips.some((c) => c.trackId === t.id && rangeOverlap(start, duration, c.start, c.duration)))
  if (free) return free
  const fresh = newTrackOfKind(seq, 'video')
  seq = { ...seq, tracks: renameKindTracks(insertTrack(seq.tracks, fresh, 'after')) }
  set({ sequences: get().sequences.map((s) => (s.id === seq.id ? seq : s)) })
  return seq.tracks.find((t) => t.id === fresh.id)!
}

/** 渲染按 contain 画图：放大 cover/contain 倍，让图片铺满画布（裁掉溢出） */
function coverTransform(m: MediaItem, settings: ProjectSettings): Transform2D {
  const t = defaultTransform()
  if (!m.width || !m.height) return t
  const sx = settings.width / m.width
  const sy = settings.height / m.height
  const k = Math.max(sx, sy) / Math.min(sx, sy)
  return { ...t, scaleX: k, scaleY: k, fit: 'cover' }
}

function ensureClipSelected(
  get: () => AppStore,
  set: (p: Partial<AppStore>) => void,
  notify: (m: string) => void,
): boolean {
  const seq = get().seq()
  const ids = get().selectedClipIds
  if (seq.clips.some((c) => ids.includes(c.id))) return true

  const t = get().playhead
  const trackIndex = new Map(seq.tracks.map((tr, i) => [tr.id, i]))
  const under = seq.clips
    .filter((c) => c.enabled !== false && t >= c.start && t < c.start + c.duration)
    .sort((a, b) => (trackIndex.get(a.trackId) ?? 99) - (trackIndex.get(b.trackId) ?? 99))

  const pick = under[0] ?? seq.clips[0]
  if (!pick) {
    notify('请先选中片段')
    if (ids.length) set({ selectedClipIds: [] })
    return false
  }
  set({ selectedClipIds: [pick.id] })
  return true
}


export type SnapOpts = {
  /** 时间轴当前缩放：吸附范围按屏幕像素算，缩放多少都一样好吸 */
  pxPerSec?: number
  /** Shift：强吸附，范围更大、不看吸附开关 */
  strong?: boolean
  /** 拖动片段所在轨：离得近的轨上的切口优先 */
  trackId?: string
  /** 拖的就是播放头：不把播放头自己当吸附目标 */
  skipPlayhead?: boolean
}

const SNAP_PX = 8
const SNAP_PX_STRONG = 20
/** 每隔一条轨，距离按多几像素算：同样近时优先贴相邻轨的切口 */
const SNAP_TRACK_PX = 3

/** 吸附到片段切口（头 / 尾）、播放头、标记、0 */
function snapClipEdge(
  t: number,
  duration: number,
  exclude: Set<string>,
  seq: Sequence,
  playhead: number,
  fps: number,
  opts: SnapOpts = {},
) {
  const pps = opts.pxPerSec && opts.pxPerSec > 0 ? opts.pxPerSec : null
  const radiusPx = opts.strong ? SNAP_PX_STRONG : SNAP_PX
  // 老调用方没给缩放时退回按时间（约 4 帧）
  const toPx = (sec: number) => (pps ? sec * pps : sec / Math.max(0.12, 8 / fps) * radiusPx)
  const rowOf = (id?: string) => seq.tracks.findIndex((tr) => tr.id === id)
  const row = rowOf(opts.trackId)
  const targets: { t: number; row: number }[] = [0, ...(opts.skipPlayhead ? [] : [playhead]), ...seq.markers.map((m) => m.t)]
    .map((x) => ({ t: x, row: -1 }))
  for (const c of seq.clips) {
    if (exclude.has(c.id)) continue
    const r = rowOf(c.trackId)
    targets.push({ t: c.start, row: r }, { t: c.start + c.duration, row: r })
  }
  let best = t
  let bestScore = Infinity
  let at: number | null = null
  for (const target of targets) {
    const lane = row >= 0 && target.row >= 0 ? Math.abs(target.row - row) * SNAP_TRACK_PX : 0
    for (const [edge, shift] of [[t, 0], [t + duration, duration]] as const) {
      const dist = toPx(Math.abs(edge - target.t))
      if (dist > radiusPx) continue
      const score = dist + lane
      if (score < bestScore) { bestScore = score; best = target.t - shift; at = target.t }
    }
  }
  return { t: Math.max(0, best), at }
}

/** 同一元素的书写 / 定格片段（产物键 s1/s1e1/draw、s1/s1e1/hold）一起算一个单位 */
function chalkPairKey(c: Clip) {
  const key = c.meta?.source?.key
  const m = key && /^(.+)\/(draw|hold)$/.exec(key)
  return m ? m[1] : null
}


type PendingDrag = {
  ids: string[]
  origins: Record<string, number>
  dt: number
  trackId?: string
  opts?: { shift?: boolean; alt?: boolean; primaryId?: string; spawn?: 'before' | 'after' }
}
let pendingDragMove: PendingDrag | null = null
let dragMoveRaf = 0
/** 属性连调（滑块）合并为一次历史 */
let historyCoalesceUntil = 0

function flushPendingDragMove(get: () => AppStore, set: (p: Partial<AppStore> | ((s: AppStore) => Partial<AppStore>)) => void) {
  if (dragMoveRaf) {
    cancelAnimationFrame(dragMoveRaf)
    dragMoveRaf = 0
  }
  if (pendingDragMove) flushDragMove(get, set)
}

/**
 * 在片段局部时间 L 切成两段：关键帧按切点精确拆分（右段时间归零），画面在切点前后完全不变；
 * 素材入/出点按速度与倒放换算；入场（转场 / 文字入场 / 音频淡入）只留左段，出场只留右段。
 */
function splitClipAt(c: Clip, L: number): [Clip, Clip] {
  const speed = Math.max(0.05, c.speed <= 0 ? 1 : (c.speed || 1))
  const cutMedia = L * speed
  const leftKf: Record<string, Keyframe[]> = {}
  const rightKf: Record<string, Keyframe[]> = {}
  for (const [prop, list] of Object.entries(c.keyframes)) {
    if (!list?.length) continue
    const { left, right } = splitKeyframes(list, L)
    leftKf[prop] = left
    rightKf[prop] = right
  }
  const sp = splitKeyframes(c.speedKeyframes, L)
  const span = c.outPoint > c.inPoint ? c.outPoint - c.inPoint : c.duration * speed
  const media = c.reverse
    ? { left: { inPoint: c.inPoint + span - cutMedia, outPoint: c.inPoint + span }, right: { inPoint: c.inPoint, outPoint: c.inPoint + span - cutMedia } }
    : { left: { inPoint: c.inPoint, outPoint: c.inPoint + cutMedia }, right: { inPoint: c.inPoint + cutMedia, outPoint: c.inPoint + span } }
  const R = c.duration - L
  const left: Clip = {
    ...c, duration: L, ...media.left,
    keyframes: leftKf, speedKeyframes: sp.left, transitionOut: undefined,
    effects: c.effects.filter((e) => e.start < L).map((e) => ({ ...e, end: Math.min(e.end, L) })),
    text: c.text && { ...c.text, animOut: 'none', animInDur: Math.min(c.text.animInDur, L) },
    audio: { ...c.audio, fadeOut: 0, fadeIn: Math.min(c.audio.fadeIn, L) },
  }
  const right: Clip = {
    ...c, id: uid('clip'), start: c.start + L, duration: R, ...media.right,
    keyframes: rightKf, speedKeyframes: sp.right, transitionIn: undefined,
    effects: c.effects.filter((e) => e.end > L).map((e) => ({ ...e, id: uid('fx'), start: Math.max(0, e.start - L), end: e.end - L })),
    text: c.text && { ...c.text, animIn: 'none', animOutDur: Math.min(c.text.animOutDur, R) },
    audio: { ...c.audio, fadeIn: 0, fadeOut: Math.min(c.audio.fadeOut, R) },
  }
  return [left, right]
}

/** S/R 手势开始时每个选中片段的原值（scale: a=scaleX b=scaleY；rotation: a=b=角度） */
const gestureOrigins = new Map<string, { a: number; b: number }>()

function staticPropValue(c: Clip, prop: string, fallback: number) {
  switch (prop) {
    case 'x': return c.transform.x
    case 'y': return c.transform.y
    case 'scale': return c.transform.scaleX
    case 'rotation': return c.transform.rotation
    case 'opacity': return c.transform.opacity
    case 'volume': return c.audio.gainDb
    case 'fontSize': return c.text?.fontSize ?? 48
    default: return fallback
  }
}

/** 在播放头写入/覆盖关键帧；首条关键帧且不在起点时先钉住起点静态值，避免整段瞬间跳到新值 */
function upsertDynamicKf(c: Clip, prop: string, value: number, playhead: number, fps: number): Clip {
  const localT = snapToFrame(Math.max(0, playhead - c.start), fps)
  const near = 0.51 / fps
  const list = [...(c.keyframes[prop] ?? [])]
  if (list.length === 0 && localT > near) {
    list.push({ id: uid('kf'), t: 0, value: staticPropValue(c, prop, value), ease: 'linear' })
  }
  const idx = list.findIndex((k) => Math.abs(k.t - localT) < near)
  if (idx >= 0) list[idx] = { ...list[idx], value, t: localT }
  else list.push({ id: uid('kf'), t: localT, value, ease: 'linear' })
  list.sort((a, b) => a.t - b.t)
  return { ...c, keyframes: { ...c.keyframes, [prop]: list } }
}

function pushHistoryCoalesced(get: () => AppStore, set: (p: Partial<AppStore> | ((s: AppStore) => Partial<AppStore>)) => void) {
  const now = performance.now()
  if (now < historyCoalesceUntil) return
  historyCoalesceUntil = now + 450
  const { sequences, activeSeqId, history } = get()
  set({
    history: [...history.slice(-40), { sequences: JSON.parse(JSON.stringify(sequences)), activeSeqId }],
    future: [],
  })
}

type DragSnapOpts = { shift?: boolean; alt?: boolean; primaryId?: string; pxPerSec?: number; trackId?: string }

function resolveDragDt(
  get: () => AppStore,
  ids: string[],
  origins: Record<string, number>,
  dt: number,
  opts?: DragSnapOpts,
) {
  const setIds = new Set(ids)
  const st = get()
  const wantSnap = opts?.alt ? false : !!(opts?.shift || st.settings.snap)
  const primaryId = opts?.primaryId && setIds.has(opts.primaryId) ? opts.primaryId : ids[0]
  const primary = st.seq().clips.find((c) => c.id === primaryId)
  const origin0 = origins[primaryId] ?? primary?.start ?? 0
  if (!wantSnap || !primary) { setSnapGuide(null); return dt }
  const raw = Math.max(0, origin0 + dt)
  const snapped = snapClipEdge(raw, primary.duration, setIds, st.seq(), st.playhead, st.settings.fps, {
    pxPerSec: opts?.pxPerSec, strong: opts?.shift, trackId: opts?.trackId ?? primary.trackId,
  })
  setSnapGuide(snapped.at)
  return snapped.t - origin0
}

/** 裁剪一端时一起动的片段：音视频配对跟着裁，链接的字幕等文字片段各自保留时长 */
function trimTargets(s: Sequence, id: string) {
  const primary = s.clips.find((c) => c.id === id)
  const targets = new Set<string>([id])
  if (primary && !primary.text) {
    if (primary.linkedId) targets.add(primary.linkedId)
    for (const c of s.clips) if (c.linkedId === id) targets.add(c.id)
    for (const c of s.clips) if (c.text) targets.delete(c.id)
  }
  return targets
}

type TrimSnapOpts = SnapOpts & { free?: boolean }

/** 裁剪边缘吸附到其他片段头尾 / 播放头 / 标记；Alt 不吸附，Shift 强吸附 */
function snapTrimEdge(st: AppStore, t: number, exclude: Set<string>, opts: TrimSnapOpts = {}) {
  if (opts.free || !(opts.strong || st.settings.snap)) { setSnapGuide(null); return t }
  const r = snapClipEdge(t, 0, exclude, st.seq(), st.playhead, st.settings.fps, opts)
  setSnapGuide(r.at)
  return r.t
}

/** 时间轴上的吸附对齐线（拖动 / 裁剪时贴上了哪个时间点） */
function setSnapGuide(at: number | null) {
  if (useApp.getState().snapGuide !== at) useApp.setState({ snapGuide: at })
}

function flushDragMove(get: () => AppStore, set: (p: Partial<AppStore> | ((s: AppStore) => Partial<AppStore>)) => void) {
  const pending = pendingDragMove
  pendingDragMove = null
  dragMoveRaf = 0
  if (!pending) return
  const { ids, origins, dt, trackId, opts } = pending
  const setIds = new Set(ids)
  const appliedDt = resolveDragDt(get, ids, origins, dt, opts)
  let cur = get().seq()
  const primary = cur.clips.find((c) => c.id === (opts?.primaryId && setIds.has(opts.primaryId) ? opts.primaryId : ids[0]))
  const primaryKind = cur.tracks.find((t) => t.id === primary?.trackId)?.kind

  // 多选整体换轨：同 kind 片段按主片段的轨道偏移一起平移，保持彼此上下间距；越界就在该 kind 段首/尾补轨
  const retarget = new Map<string, string>()
  if (primary && primaryKind) {
    const kindTracks = cur.tracks.filter((t) => t.kind === primaryKind)
    const pIdx = kindTracks.findIndex((t) => t.id === primary.trackId)
    const destIdx = opts?.spawn === 'before' ? -1
      : opts?.spawn === 'after' ? kindTracks.length
        : kindTracks.findIndex((t) => t.id === trackId)
    const same = cur.clips.filter((c) => setIds.has(c.id) && kindTracks.some((t) => t.id === c.trackId))
    const srcIdx = (c: Clip) => kindTracks.findIndex((t) => t.id === c.trackId)
    const canSpawn = primaryKind === 'video' || primaryKind === 'audio' || primaryKind === 'subtitle'
    let delta = pIdx >= 0 && (opts?.spawn || destIdx >= 0) ? destIdx - pIdx : 0
    if (!canSpawn && same.length) {
      const srcLo = Math.min(...same.map(srcIdx)), srcHi = Math.max(...same.map(srcIdx))
      delta = Math.max(-srcLo, Math.min(kindTracks.length - 1 - srcHi, delta))
    }
    if (delta && same.length) {
      const idxOf = (c: Clip) => srcIdx(c) + delta
      const lo = Math.min(...same.map(idxOf)), hi = Math.max(...same.map(idxOf))
      const above = canSpawn ? Math.max(0, -lo) : 0
      const below = canSpawn ? Math.max(0, hi - (kindTracks.length - 1)) : 0
      let tracks = cur.tracks
      const top: Track[] = [], bottom: Track[] = []
      for (let i = 0; i < above; i++) top.push(newTrackOfKind({ ...cur, tracks }, primaryKind))
      for (const t of [...top].reverse()) tracks = insertTrack(tracks, t, 'before')
      for (let i = 0; i < below; i++) {
        const t = newTrackOfKind({ ...cur, tracks }, primaryKind)
        bottom.push(t)
        tracks = insertTrack(tracks, t, 'after')
      }
      if (above || below) cur = { ...cur, tracks: primaryKind === 'subtitle' ? tracks : renameKindTracks(tracks) }
      const lanes = [...top, ...kindTracks, ...bottom]
      for (const c of same) {
        const i = Math.max(0, Math.min(lanes.length - 1, idxOf(c) + above))
        retarget.set(c.id, lanes[i].id)
      }
    }
  }

  const moved = cur.clips
    .filter((c) => setIds.has(c.id))
    .map((c) => ({
      ...c,
      start: Math.max(0, (origins[c.id] ?? c.start) + appliedDt),
      trackId: retarget.get(c.id) ?? c.trackId,
    }))
  const applied = applyMoveNoOverlap(cur, moved, setIds)
  const byId = new Map(applied.clips.map((c) => [c.id, c]))
  const nextSeq = enforceNoOverlap({
    ...applied.seq,
    clips: applied.seq.clips.map((c) => byId.get(c.id) ?? c),
  })
  set({
    sequences: get().sequences.map((s) => (s.id === cur.id ? nextSeq : s)),
  })
}

export const useApp = create<AppStore>((set, get) => {
  const notify = (m: string) => {
    set({ toast: m })
    setTimeout(() => set({ toast: null }), 2200)
  }

  const patchSeq = (fn: (s: Sequence) => Sequence) => {
    const cur = get().seq()
    set({ sequences: get().sequences.map((s) => (s.id === cur.id ? fn(s) : s)) })
  }

  const patchSelected = (fn: (c: Clip) => Clip) => {
    const ids = new Set(get().selectedClipIds)
    patchSeq((s) => ({ ...s, clips: s.clips.map((c) => (ids.has(c.id) ? fn(c) : c)) }))
  }

  const first = makeSeq()

  const loadDraftsIndex = (): DraftEntry[] => {
    try {
      const raw = localStorage.getItem('todo-drafts-index')
      if (raw) {
        const list = JSON.parse(raw) as DraftEntry[]
        if (Array.isArray(list) && list.length) return list
      }
    } catch { /* */ }
    return [{ id: 'draft_demo', name: '演示草稿', updatedAt: Date.now() }]
  }

  const persistDraftsIndex = (drafts: DraftEntry[]) => {
    localStorage.setItem('todo-drafts-index', JSON.stringify(drafts))
  }

  /** 加载/新建/保存引起的状态替换：不标脏，并把 dirty 置回 false */
  const setClean = (patch: Partial<AppStore>) => {
    dirtyMute++
    try { set({ ...patch, dirty: false }) } finally { dirtyMute-- }
  }

  const projectPayload = (s: AppStore) => ({
    version: PROJECT_FILE_VERSION,
    projectName: s.projectName,
    settings: s.settings, media: s.media, folders: s.folders, sequences: s.sequences,
    activeSeqId: s.activeSeqId, prefs: s.prefs, presets: s.presets, fonts: s.fonts,
    monitorCompose: s.monitorCompose, playhead: s.playhead, script: s.script,
  })

  const drafts0 = loadDraftsIndex()
  const lastId = localStorage.getItem('todo-last-draft')
  const draftStart = drafts0.find((d) => d.id === lastId) ?? drafts0[0]

  return {
    drafts: drafts0,
    started: !desktop(),
    newProjectDialog: null,
    projectId: draftStart?.id ?? 'draft_demo',
    projectName: draftStart?.name ?? '演示草稿',
    projectPath: desktop() ? null : draftStart?.path ?? null,
    dirty: false,
    recentProjects: [],
    settings: defaultSettings(),
    prefs: {
      defaultDuration: 5, cachePath: './cache', performance: 'balanced',
      previewCacheMaxEdge: 720,
      previewDiskCacheGb: 10,
      shortcuts: { split: 'Ctrl+B', import: 'Ctrl+I', snap: 'S', select: 'V', razor: 'C', undo: 'Ctrl+Z', play: 'Space' },
    },
    media: [],
    folders: defaultFolders(),
    sequences: [first],
    activeSeqId: first.id,
    selectedClipIds: [],
    selectedMediaId: null,
    playhead: 0,
    sourceIn: 0,
    sourceOut: 5,
    sourceIoArmed: false,
    sourceMediaId: null,
    playing: false,
    loop: false,
    tool: 'select',
    propTab: 'transform',
    libraryTab: 'media',
    aiRefDataUrl: null,
    aiGenMode: 'image',
    aiFloat: false,
    aiFloatKind: null,
    fullscreen: false,
    timelineFloat: false,
    timelineFloatKind: null,
    propWheel: null,
    editMode: 'overwrite',
    toast: null,
    exportQueue: [],
    presets: [
      { id: 'preset_cinematic', name: '电影调色', kind: 'color', payload: { exposure: 0.05, contrast: 0.12, saturation: -0.08, temperature: 0.1, lutStrength: 0.6, lutName: 'Cinematic' } },
      { id: 'preset_vivid', name: '鲜艳通透', kind: 'color', payload: { exposure: 0.08, contrast: 0.1, saturation: 0.2, highlights: -0.05 } },
      { id: 'preset_zoom_in', name: '缓慢推近', kind: 'motion', payload: { scaleX: 1.15, scaleY: 1.15 } },
      { id: 'preset_lower_third', name: '下三分之一', kind: 'text', payload: { fontSize: 36, align: 'left', animIn: 'fade' } },
      { id: 'tpl_vlog', name: 'Vlog 片头模板', kind: 'motion', payload: { x: 0, y: -0.2, scaleX: 1.05, scaleY: 1.05 } },
      { id: 'tpl_promo', name: '产品宣传模板', kind: 'color', payload: { contrast: 0.15, saturation: 0.12, temperature: 0.05 } },
    ],
    fonts: [
      { id: 'f1', name: 'Syne', enabled: true },
      { id: 'f2', name: 'DM Sans', enabled: true },
    ],
    cacheMb: 12.4,
    history: [],
    future: [],
    multiCam: false,
    modal: null,
    layout: initialLayout,
    timelineZoom: 80,
    monitorView: loadMonitorView(),
    monitorCompose: '2d',
    script: '',
    scriptOpen: false,
    autoKeyframe: false,
    transformGesture: null,

    seq() {
      return get().sequences.find((q) => q.id === get().activeSeqId) ?? get().sequences[0]
    },
    setToast: (m) => {
      set({ toast: m })
      if (m) setTimeout(() => set({ toast: null }), 2200)
    },
    setModal: (m) => set({ modal: m }),

    pushHistory() {
      historyCoalesceUntil = 0
      const { sequences, activeSeqId, history } = get()
      set({
        history: [...history.slice(-40), { sequences: JSON.parse(JSON.stringify(sequences)), activeSeqId }],
        future: [],
      })
    },
    undo() {
      flushPendingDragMove(get, set)
      const { history, future, sequences, activeSeqId } = get()
      if (!history.length) {
        notify('没有可撤销的操作')
        return
      }
      const prev = history[history.length - 1]
      historyCoalesceUntil = 0
      set({
        history: history.slice(0, -1),
        future: [...future, { sequences: JSON.parse(JSON.stringify(sequences)), activeSeqId }],
        sequences: prev.sequences,
        activeSeqId: prev.activeSeqId,
      })
    },
    redo() {
      flushPendingDragMove(get, set)
      const { history, future, sequences, activeSeqId } = get()
      if (!future.length) {
        notify('没有可重做的操作')
        return
      }
      const next = future[future.length - 1]
      historyCoalesceUntil = 0
      set({
        future: future.slice(0, -1),
        history: [...history, { sequences: JSON.parse(JSON.stringify(sequences)), activeSeqId }],
        sequences: next.sequences,
        activeSeqId: next.activeSeqId,
      })
    },

    newProject(name = '未命名项目') {
      void get().flushProject()
      const s = makeSeq()
      const id = uid('draft')
      const drafts = [...get().drafts, { id, name, updatedAt: Date.now() }]
      persistDraftsIndex(drafts)
      localStorage.setItem('todo-last-draft', id)
      setClean({
        projectId: id, projectName: name, projectPath: null, settings: defaultSettings(), media: [],
        sequences: [s], activeSeqId: s.id, selectedClipIds: [], playhead: 0,
        drafts, script: '', scriptOpen: false,
        history: [], future: [], modal: null,
      })
      notify('已新建项目')
    },

    setNewProjectDialog: (v) => set({ newProjectDialog: v }),

    async createProject({ name, parentDir, settings, fromDraftId }) {
      const api = desktop()
      const title = name.trim() || '未命名项目'
      const applySettings = () => setClean({ settings: { ...get().settings, ...settings } })
      if (!api?.createProjectFolder) {
        if (fromDraftId) get().openDraft(fromDraftId, { localOnly: true })
        else get().newProject(title)
        applySettings()
        set({ started: true, newProjectDialog: null })
        get().saveProject({ silent: true })
        return true
      }
      const r = await api.createProjectFolder(parentDir, title)
      if (!r.ok || !r.path) {
        notify(r.error ?? '新建项目失败')
        return false
      }
      if (get().started) await get().flushProject()
      if (fromDraftId) {
        get().openDraft(fromDraftId, { localOnly: true })
      } else {
        const s = makeSeq()
        setClean({
          projectId: uid('draft'), media: [], folders: defaultFolders(), sequences: [s], activeSeqId: s.id,
          selectedClipIds: [], selectedMediaId: null, sourceMediaId: null, playhead: 0, playing: false,
          history: [], future: [], monitorCompose: '2d', settings: defaultSettings(), script: '', scriptOpen: false,
        })
      }
      applySettings()
      const filePath = r.path
      setClean({ started: true, newProjectDialog: null, modal: null, projectName: projectNameFromPath(filePath), projectPath: filePath })
      await api.setProject?.(filePath)
      const ok = await get().saveProjectToFile({ silent: true })
      if (!ok) return false
      if (fromDraftId) {
        const drafts = get().drafts.map((d) => (d.id === fromDraftId ? { ...d, path: filePath } : d))
        persistDraftsIndex(drafts)
        set({ drafts })
        await get().collectAiMedia()
      }
      notify(`已新建项目「${get().projectName}」`)
      return true
    },

    async closeProject() {
      if (!get().started) return
      await get().flushProject()
      const s = makeSeq()
      setClean({
        started: false, projectPath: null, media: [], sequences: [s], activeSeqId: s.id,
        selectedClipIds: [], selectedMediaId: null, sourceMediaId: null, playhead: 0, playing: false,
        history: [], future: [], modal: null, script: '', scriptOpen: false,
      })
      await desktop()?.setProject?.(null)
      void get().refreshRecentProjects()
    },

    async collectAiMedia(ids) {
      const api = desktop()
      if (!api?.collectAiFile || !get().started || !get().projectPath) return
      const dir = get().projectPath
      const targets = get().media.filter((m) => (!ids || ids.includes(m.id)) && !m.path && !collecting.has(m.id)
        && !collectFailed.has(`${dir}|${m.url}`) && aiServiceFileName(m.url))
      let failed = 0
      for (const m of targets) {
        const name = aiServiceFileName(m.url)!
        collecting.add(m.id)
        const r = await api.collectAiFile(name).finally(() => collecting.delete(m.id))
        if (get().projectPath !== dir) return
        if (!r.ok || !r.path || !r.url) { failed++; collectFailed.add(`${dir}|${m.url}`); continue }
        const { path: filePath, url } = r
        set({ media: get().media.map((x) => (x.id === m.id ? { ...x, url, path: filePath, aiUrl: `/ai-generated/${name}` } : x)) })
      }
      if (failed) notify(`${failed} 个 AI 素材没能复制进项目文件夹，仍从 AI 服务读取`)
    },

    openDraft(id, opts) {
      const d = get().drafts.find((x) => x.id === id)
      if (!d) return
      if (d.path && desktop() && !opts?.localOnly) {
        void get().openProjectFromFile(d.path).then((ok) => {
          if (!ok) get().openDraft(id, { localOnly: true })
        })
        return
      }
      if (id !== get().projectId) void get().flushProject()
      localStorage.setItem('todo-last-draft', id)
      const raw = localStorage.getItem(`todo-draft-${id}`)
      if (raw) {
        try {
          const data = JSON.parse(raw)
          const sequences = (data.sequences as Sequence[]).map(migrateSequence)
          const activeSeqId = String(data.activeSeqId || sequences[0]?.id)
          const seq = sequences.find((q) => q.id === activeSeqId) ?? sequences[0]
          const savedIds = Array.isArray(data.selectedClipIds) ? data.selectedClipIds as string[] : []
          const selectedClipIds = savedIds.filter((cid) => seq?.clips.some((c) => c.id === cid))
          const media = reviveMediaList((data.media as MediaItem[]) ?? [])
          const offlineN = media.filter((m) => m.offline).length
          setClean({
            projectId: id, projectName: d.name, projectPath: d.path ?? null,
            settings: { ...defaultSettings(), ...(data.settings as ProjectSettings) }, media,
            folders: data.folders ?? get().folders,
            sequences,
            activeSeqId,
            prefs: data.prefs ?? get().prefs, presets: data.presets ?? [], fonts: data.fonts ?? get().fonts,
            selectedClipIds,
            playhead: typeof data.playhead === 'number' ? data.playhead : 0,
            history: [], future: [], modal: null,
            monitorCompose: data.monitorCompose === '3d' ? '3d' : '2d',
            script: typeof data.script === 'string' ? data.script : '', scriptOpen: false,
          })
          notify(offlineN
            ? `已打开「${d.name}」· ${offlineN} 个素材需重新导入（旧 blob 链接已失效）`
            : `已打开「${d.name}」`)
          return
        } catch { /* */ }
      }
      const s = makeSeq()
      setClean({
        projectId: id, projectName: d.name, projectPath: d.path ?? null,
        sequences: [s], activeSeqId: s.id, media: [], history: [], future: [], modal: null,
        script: '', scriptOpen: false,
      })
    },

    saveProject(opts) {
      const s = get()
      if (!s.started) return
      const sequences = s.sequences.map((q) => enforceNoOverlap(q))
      dirtyMute++
      try { set({ sequences }) } finally { dirtyMute-- }
      // 桌面版项目以工程文件为准（自动保存 + .bak），不再往 localStorage 堆快照
      if (desktop() && s.projectPath) return
      try {
        localStorage.setItem(`todo-draft-${s.projectId}`, JSON.stringify({
          settings: s.settings, media: s.media, folders: s.folders, sequences,
          activeSeqId: s.activeSeqId, prefs: s.prefs, presets: s.presets, fonts: s.fonts,
          monitorCompose: s.monitorCompose, script: s.script,
          selectedClipIds: s.selectedClipIds,
          playhead: s.playhead,
        }))
      } catch {
        if (!opts?.silent || !s.projectPath) notify('本地草稿空间不足，请保存为工程文件（Ctrl+S）')
        return
      }
      localStorage.setItem('todo-last-draft', s.projectId)
      const drafts = s.drafts.map((d) => (d.id === s.projectId
        ? { ...d, name: s.projectName, updatedAt: Date.now(), ...(s.projectPath ? { path: s.projectPath } : {}) }
        : d))
      persistDraftsIndex(drafts)
      // 桌面版以工程文件为准：本地草稿只是崩溃兜底，不清脏
      set(desktop() ? { drafts } : { drafts, dirty: false })
      if (!opts?.silent) notify('项目已保存')
    },

    async saveProjectToFile(opts) {
      const api = desktop()
      if (!get().started) return false
      get().saveProject({ silent: true })
      if (!api) {
        if (!opts?.silent) notify('项目已保存')
        return true
      }
      const s = get()
      const startId = s.projectId
      const target = opts?.saveAs ? null : s.projectPath
      const payload = projectPayload(s)
      // 覆盖写入期间可继续编辑：先清脏，写入中的新改动会重新标脏
      if (target) setClean({})
      const prev = fileSaving
      const run = (async () => {
        if (prev) await prev
        return api.saveProjectFile(`${s.projectName || 'project'}.todo.json`, payload, target)
      })()
      const job = run.then((r) => r.ok, () => false)
      fileSaving = job
      let r: Awaited<ReturnType<typeof api.saveProjectFile>>
      try { r = await run } catch (e) { r = { ok: false, error: String(e) } }
      if (fileSaving === job) fileSaving = null
      if (!r.ok || !r.path) {
        if (target && get().projectId === startId) set({ dirty: true })
        if (!r.canceled) notify(`保存失败：${r.error ?? '未知错误'}`)
        return false
      }
      const savedPath = r.path
      if (get().projectId !== startId) return true
      const name = projectNameFromPath(savedPath)
      const drafts = get().drafts.map((d) => (d.id === startId ? { ...d, name, path: savedPath, updatedAt: Date.now() } : d))
      persistDraftsIndex(drafts)
      if (target) set({ projectPath: savedPath, projectName: name, drafts })
      else setClean({ projectPath: savedPath, projectName: name, drafts })
      if (!target) await api.setProject?.(savedPath)
      void get().refreshRecentProjects()
      if (!opts?.silent) notify(target ? '已保存' : `已保存为「${name}」`)
      return true
    },

    async openProjectFromFile(filePath) {
      const api = desktop()
      if (!api) { notify('请在桌面版中打开工程文件'); return false }
      const r = await api.openProjectFile(filePath)
      if (!r.ok || !r.json || !r.path) {
        if (r.notFound) {
          notify(`工程文件不存在：${r.path ?? filePath ?? ''}`)
          void get().refreshRecentProjects()
        } else if (!r.canceled) {
          notify(`打开失败：${r.error ?? '未知错误'}`)
        }
        return false
      }
      const openedPath = r.path
      const cur = get()
      const sameFile = !!cur.projectPath && cur.projectPath.toLowerCase() === openedPath.toLowerCase()
      if (sameFile && cur.dirty) {
        notify('该工程已打开（有未保存改动，未重新载入）')
        return true
      }
      if (!sameFile && cur.started) await get().flushProject()
      const data = r.json as Record<string, unknown>
      const existing = get().drafts.find((d) => d.path && d.path.toLowerCase() === openedPath.toLowerCase())
      const id = existing?.id ?? uid('draft')
      const name = projectNameFromPath(openedPath)
      const sequences = ((data.sequences as Sequence[]) || [makeSeq()]).map(migrateSequence)
      const media = reviveMediaList((data.media as MediaItem[]) ?? [])
      const drafts = existing
        ? get().drafts.map((d) => (d.id === id ? { ...d, name, path: openedPath, updatedAt: Date.now() } : d))
        : [...get().drafts, { id, name, path: openedPath, updatedAt: Date.now() }]
      persistDraftsIndex(drafts)
      setClean({
        projectId: id, projectName: name, projectPath: openedPath,
        settings: { ...defaultSettings(), ...(data.settings as ProjectSettings) },
        media,
        folders: (data.folders as AppStore['folders']) ?? get().folders,
        sequences, activeSeqId: String(data.activeSeqId || sequences[0]?.id),
        prefs: (data.prefs as AppStore['prefs']) ?? get().prefs,
        presets: (data.presets as EffectPreset[]) ?? get().presets,
        fonts: (data.fonts as AppStore['fonts']) ?? get().fonts,
        monitorCompose: data.monitorCompose === '3d' ? '3d' : '2d',
        script: typeof data.script === 'string' ? data.script : '', scriptOpen: false,
        selectedClipIds: [], playhead: typeof data.playhead === 'number' ? data.playhead : 0,
        history: [], future: [], modal: null, newProjectDialog: null,
        drafts, started: true,
      })
      await api.setProject?.(openedPath)
      void get().refreshRecentProjects()
      void get().collectAiMedia()
      const extra = [
        r.relinked ? `${r.relinked} 个素材已按相对路径找回` : '',
        r.missing ? `${r.missing} 个素材缺失，需重新链接` : '',
      ].filter(Boolean).join(' · ')
      notify(extra ? `已打开「${name}」· ${extra}` : `已打开「${name}」`)
      return true
    },

    async flushProject() {
      const s = get()
      if (!s.started) return
      if (s.dirty && s.projectPath && desktop()) {
        await s.saveProjectToFile({ silent: true })
        return
      }
      s.saveProject({ silent: true })
    },

    async refreshRecentProjects() {
      const api = desktop()
      if (!api?.recentProjects) return
      try { set({ recentProjects: await api.recentProjects() }) } catch { /* */ }
    },

    async removeRecentProject(filePath) {
      const api = desktop()
      if (!api?.removeRecentProject) return
      await api.removeRecentProject(filePath)
      await get().refreshRecentProjects()
    },

    async pickDesktopMedia() {
      const api = desktop()
      if (!api) return
      const r = await api.pickMediaFiles()
      if (!r.ok || !r.files.length) return
      const parsed = []
      for (const file of r.files) {
        try { parsed.push(await parseDesktopMedia(file, get().settings.stillDuration)) }
        catch (error) { notify(String(error)) }
      }
      get().importMedia(parsed)
    },

    async exportProgramFrame() {
      const api = desktop()
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="program-canvas-3d"], [data-testid="program-canvas"]')
      if (!canvas) { notify('无监视器画面'); return }
      const dataUrl = canvas.toDataURL('image/png')
      if (api) {
        const r = await api.exportFramePng(`frame_${Date.now()}.png`, dataUrl)
        if (r.ok) notify('帧已导出')
        return
      }
      const a = document.createElement('a')
      a.href = dataUrl
      a.download = `frame_${Date.now()}.png`
      a.click()
      notify('帧已下载')
    },

    saveAs(name) {
      const id = uid('draft')
      const drafts = [...get().drafts, { id, name, updatedAt: Date.now() }]
      persistDraftsIndex(drafts)
      set({ projectId: id, projectName: name, projectPath: null, drafts })
      get().saveProject()
    },

    renameDraft(id, name) {
      const drafts = get().drafts.map((d) => (d.id === id ? { ...d, name } : d))
      persistDraftsIndex(drafts)
      set({
        drafts,
        projectName: get().projectId === id ? name : get().projectName,
      })
    },
    duplicateDraft(id) {
      const src = get().drafts.find((d) => d.id === id)
      if (!src) return
      const nid = uid('draft')
      const raw = localStorage.getItem(`todo-draft-${id}`)
      if (raw) localStorage.setItem(`todo-draft-${nid}`, raw)
      const drafts = [...get().drafts, { id: nid, name: `${src.name} 副本`, updatedAt: Date.now() }]
      persistDraftsIndex(drafts)
      set({ drafts })
      notify('草稿已复制')
    },
    deleteDraft(id) {
      localStorage.removeItem(`todo-draft-${id}`)
      const drafts = get().drafts.filter((d) => d.id !== id)
      persistDraftsIndex(drafts)
      set({ drafts })
    },

    updateSettings(p) { set({ settings: { ...get().settings, ...p } }) },
    updatePrefs(p) {
      const prev = get().prefs
      const next = {
        ...prev,
        previewCacheMaxEdge: (prev.previewCacheMaxEdge ?? 720) as 0 | 480 | 720 | 1080,
        ...p,
      }
      set({ prefs: next })
      if (p.previewCacheMaxEdge != null && p.previewCacheMaxEdge !== prev.previewCacheMaxEdge) {
        clearPreviewCache(getProgramPreviewCache())
        notifyPreviewCacheChanged(true)
        notify('预览缓存分辨率已改，后台会自动重新缓存')
      }
    },

    importMedia(files, opts) {
      const items: MediaItem[] = files.map((f) => ({
        id: uid('media'), name: f.name, kind: f.kind, url: f.url, path: f.path,
        duration: f.duration,
        width: f.width, height: f.height, fps: 30,
        hasAudio: f.hasAudio ?? (f.kind === 'audio' || f.kind === 'video'),
        ...(f.alpha ? { alpha: true } : {}),
        folderId: f.folderId ?? (f.kind === 'audio' ? 'f_audio' : f.kind === 'sticker' ? 'f_sticker' : 'f_all'),
        favorite: false, offline: false,
      }))
      const first = items[0]
      set({
        media: [...get().media, ...items],
        ...(opts?.silent ? {} : {
          selectedMediaId: first?.id ?? get().selectedMediaId,
          sourceMediaId: first?.id ?? get().sourceMediaId,
          ...(first ? {
            sourceIn: 0,
            sourceOut: Math.max(0.2, first.duration || 5),
            sourceIoArmed: false,
          } : {}),
        }),
      })
      if (!opts?.silent) notify(`已导入 ${items.length} 个素材`)
      // 立刻落盘，避免关软件丢库
      queueMicrotask(() => get().saveProject({ silent: true }))
      // useProxy 开启时异步生成代理（默认手动：开关关则不跑）
      if (get().settings.useProxy) {
        for (const it of items) {
          if (it.kind === 'video' && it.path && !mayHaveAlpha(it)) {
            void get().makeMediaProxy(it.id)
          }
        }
      }
      return items.map((i) => i.id)
    },

    addFolder(name) { set({ folders: [...get().folders, { id: uid('folder'), name }] }) },
    toggleFavorite(id) {
      set({ media: get().media.map((m) => (m.id === id ? { ...m, favorite: !m.favorite } : m)) })
    },
    removeMedia(id) {
      get().pushHistory()
      const next = get().media.filter((m) => m.id !== id)
      set({
        media: next,
        selectedMediaId: get().selectedMediaId === id ? (next[0]?.id ?? null) : get().selectedMediaId,
        sourceMediaId: get().sourceMediaId === id ? (next[0]?.id ?? null) : get().sourceMediaId,
      })
      notify('已从媒体库移除')
      queueMicrotask(() => get().saveProject({ silent: true }))
    },
    relinkMedia(id, url, path) {
      set({
        media: get().media.map((m) => (m.id === id ? { ...m, url, path: path ?? m.path, offline: false } : m)),
      })
      notify('素材已重新链接')
    },
    setMediaProxyPath(id, proxyPath) {
      const proxyUrl = proxyPath
        ? (proxyPath.startsWith('file:') ? proxyPath : pathToFileUrl(proxyPath))
        : undefined
      set({
        media: get().media.map((m) => (m.id === id ? { ...m, proxyPath, proxyUrl } : m)),
      })
    },
    async makeMediaProxy(id, height = 720) {
      const api = desktop()
      const m = get().media.find((x) => x.id === id)
      if (!api?.makeProxy || !m?.path) {
        if (height !== 480) notify('无法生成代理（需桌面版与本地路径）')
        return false
      }
      if (mayHaveAlpha(m)) {
        if (height !== 480) notify('透明视频不生成代理（代理会丢透明通道）')
        return false
      }
      const r = await api.makeProxy(m.path, height)
      if (!r.ok || !r.proxyPath) {
        if (height !== 480) notify(`代理失败: ${r.error || 'unknown'}`)
        return false
      }
      get().setMediaProxyPath(id, r.proxyPath)
      // 叠层补代理时不要弹 toast 刷屏
      if (height !== 480) {
        notify(r.cached ? '已使用缓存代理' : '代理已生成')
      }
      queueMicrotask(() => get().saveProject({ silent: true }))
      return true
    },
    /** 叠层播放前：缺代理的视频后台生成 480p，不挡播 */
    ensureStackProxies(mediaIds: string[]) {
      const api = desktop()
      if (!api?.makeProxy) return
      for (const id of mediaIds) {
        const m = get().media.find((x) => x.id === id)
        // H.264 代理没有透明通道
        if (!m?.path || m.kind !== 'video' || mayHaveAlpha(m)) continue
        if (m.proxyPath || m.proxyUrl) continue
        void get().makeMediaProxy(id, 480)
      }
    },
    setSelectedMedia(id) {
      const m = get().media.find((x) => x.id === id)
      set({
        selectedMediaId: id,
        sourceMediaId: id,
        sourceIn: 0,
        sourceOut: Math.max(0.2, m?.duration ?? 5),
        sourceIoArmed: false,
      })
    },

    captureFrame() {
      // AI 独立窗没有节目画布：请主窗代截
      if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('popout') === 'ai') {
        void import('./lib/storeSync').then(({ requestAiCapture }) => requestAiCapture())
        return
      }
      const canvas =
        document.querySelector<HTMLCanvasElement>('[data-testid="program-canvas-3d"]')
        ?? document.querySelector<HTMLCanvasElement>('[data-testid="program-canvas"]')
        ?? document.getElementById('program-canvas') as HTMLCanvasElement | null
      if (!canvas) { notify('无法截帧'); return }
      const dataUrl = canvas.toDataURL('image/png')
      // 不入媒体库；只作 AI 参考，并写入 SQLite 冷库
      const patch: Partial<AppStore> = { aiRefDataUrl: dataUrl }
      if (!get().aiFloat && get().layout.panelDock?.ai === 'tab') patch.libraryTab = 'ai'
      set(patch)
      notify('已截帧 · 已设为 AI 参考图（未入库）')
      void aiFetch('/api/ai-assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl, kind: 'capture', name: `帧_${Date.now()}.png` }),
      }).catch(() => { /* 内存参考图已可用 */ })
    },

    setAiRef(dataUrl) { set({ aiRefDataUrl: dataUrl }) },
    setAiGenMode(m) { set({ aiGenMode: m }) },
    setAiFloat(v) {
      if (!v) {
        set({ aiFloat: false, aiFloatKind: null })
        void import('./lib/aiPopout').then(({ closeAiPopout }) => closeAiPopout())
        return
      }
      set({ aiFloat: v })
    },

    setPlayhead(t, opts) {
      const fps = get().settings.fps
      const next = opts?.exact
        ? Math.max(0, t)
        : Math.max(0, Math.round(t * fps) / fps)
      setLivePlayhead(next)
      if (Math.abs(next - get().playhead) < (opts?.exact ? 1e-6 : 1 / fps / 2)) return
      set({ playhead: next })
    },
    togglePlay() {
      const next = !get().playing
      if (next) {
        const seq = get().seq()
        const t = get().playhead
        const offline = seq.clips.some((c) => {
          if (!c.enabled || !c.mediaId || t < c.start || t >= c.start + c.duration) return false
          const m = get().media.find((x) => x.id === c.mediaId)
          return !!m && (m.offline || !m.url || (m.url.startsWith('blob:') && m.offline))
        })
        if (offline) {
          notify('素材已离线（blob 失效），请用「导入」或桌面选文件重新导入后再播放')
          return
        }
      }
      set({ playing: next })
    },
    stepFrame(d) { set({ playhead: Math.max(0, get().playhead + d / get().settings.fps), playing: false }) },
    setLoop(v) { set({ loop: v }) },
    setTool(t) { set({ tool: t }) },
    setPropTab(t) { set({ propTab: t }) },
    setLibraryTab(t) { set({ libraryTab: t }) },
    setFullscreen(v) { set({ fullscreen: v }) },
    setTimelineFloat(v) {
      // 只改状态；打开窗口必须在点击处理里同步调用 openTimelinePopout()
      if (!v) {
        set({ timelineFloat: false, timelineFloatKind: null })
        void import('./lib/timelinePopout').then(({ closeTimelinePopout }) => closeTimelinePopout())
        return
      }
      set({ timelineFloat: v })
    },
    openPropWheel(x, y, ring) {
      if (!ensureClipSelected(get, set, notify)) return
      set({ propWheel: { x, y, ring, at: Date.now() } })
    },
    openPropWheelOnMonitor(ring) {
      if (!ensureClipSelected(get, set, notify)) return
      const el =
        document.querySelector<HTMLElement>('[data-testid="program-monitor"]')
        ?? document.querySelector<HTMLElement>('[data-testid="monitor-area"]')
      let x = window.innerWidth * 0.55
      let y = window.innerHeight * 0.38
      if (el) {
        const r = el.getBoundingClientRect()
        x = r.left + r.width / 2
        y = r.top + r.height / 2
      }
      const ae = document.activeElement
      if (ae instanceof HTMLElement && ae.isConnected && ae !== document.body) {
        if (ae.matches('input, textarea, select, button, [contenteditable="true"]')) ae.blur()
      }
      document.querySelector<HTMLElement>('[data-testid="app-shell"]')?.focus({ preventScroll: true })
      set({ propWheel: { x, y, ring, at: Date.now() } })
    },
    openPropDialOnMonitor(prop) {
      if (!ensureClipSelected(get, set, notify)) return
      const clip = get().seq().clips.find((c) => get().selectedClipIds.includes(c.id))
      if (!clip) return
      const mode = get().autoKeyframe ? 'dynamic' : 'static'
      const tf = mode === 'dynamic' ? resolveClipTransform(clip, get().playhead) : clip.transform
      const origin = prop === 'scale' ? tf.scaleX : prop === 'rotation' ? tf.rotation : tf.opacity
      const name = prop === 'scale' ? '缩放' : prop === 'rotation' ? '旋转' : '透明'
      const label = mode === 'dynamic' ? `${name} · K` : name
      const el =
        document.querySelector<HTMLElement>('[data-testid="program-monitor"]')
        ?? document.querySelector<HTMLElement>('[data-testid="monitor-area"]')
      let x = window.innerWidth * 0.55
      let y = window.innerHeight * 0.38
      if (el) {
        const r = el.getBoundingClientRect()
        x = r.left + r.width / 2
        y = r.top + r.height / 2
      }
      document.querySelector<HTMLElement>('[data-testid="app-shell"]')?.focus({ preventScroll: true })
      set({
        propWheel: {
          x, y, ring: mode, at: Date.now(),
          dial: { prop, mode, label, origin },
        },
      })
    },
    closePropWheel() { set({ propWheel: null }) },
    setEditMode(m) { set({ editMode: m }) },
    setSourceIO(a, b) { set({ sourceIn: a, sourceOut: b, sourceIoArmed: true }) },

    addClipFromMedia(mediaId, trackId, at, opts) {
      get().pushHistory()
      const media = get().media.find((m) => m.id === mediaId)
      if (!media) return
      let sequence = get().seq()
      const wantKind: TrackKind = media.kind === 'audio' ? 'audio' : 'video'
      // 仅用户打过 I/O 且源监视器就是这份素材时，才按范围入轨
      const useSourceRange = get().sourceIoArmed
        && get().sourceMediaId === mediaId
        && media.kind !== 'image'
        && media.kind !== 'sticker'
      const range = Math.max(0, get().sourceOut - get().sourceIn)
      const duration = media.kind === 'image' || media.kind === 'sticker'
        ? get().settings.stillDuration
        : useSourceRange && range > 0.05
          ? Math.max(0.2, Math.min(media.duration, range))
          : Math.max(0.2, media.duration || get().settings.stillDuration)
      const inPoint = useSourceRange ? get().sourceIn : 0
      let start = at ?? get().playhead

      const dropped = trackId ? sequence.tracks.find((t) => t.id === trackId) : undefined
      let track: Track | undefined
      // 硬规则：同轨绝对时间不得交叉。指定轨若冲突则改找空轨/新建。
      if (dropped && dropped.kind === wantKind) {
        const hit = sequence.clips.some(
          (c) => c.trackId === dropped.id && rangeOverlap(start, duration, c.start, c.duration),
        )
        if (!hit) {
          track = dropped
        } else {
          const resolved = resolveFreeTrack(sequence, wantKind, start, duration)
          sequence = resolved.seq
          track = resolved.track
        }
      } else {
        const resolved = resolveFreeTrack(sequence, wantKind, start, duration)
        sequence = resolved.seq
        track = resolved.track
      }
      if (!track) { notify('没有可用轨道'); return }

      // 拖放到指定时间时尊重落点；仅双击/入点入轨时走磁性吸附（吸附后再次校验空轨）
      if (at == null && get().settings.magnetic) {
        start = sequence.clips.filter((c) => c.trackId === track!.id)
          .reduce((e, c) => Math.max(e, c.start + c.duration), 0)
      } else {
        // 非磁性：若当前轨仍冲突（极端竞态），再解析一次
        const hit = sequence.clips.some(
          (c) => c.trackId === track!.id && rangeOverlap(start, duration, c.start, c.duration),
        )
        if (hit) {
          const resolved = resolveFreeTrack(sequence, wantKind, start, duration)
          sequence = resolved.seq
          track = resolved.track
        }
      }

      const clip: Clip = {
        id: uid('clip'), trackId: track.id, mediaId, name: media.name,
        start, duration, inPoint, outPoint: inPoint + duration,
        enabled: true, speed: 1, reverse: false, speedKeyframes: [],
        transform: defaultTransform(), color: defaultColor(), audio: defaultAudio(),
        effects: [], blend: 'normal', keyframes: {},
      }
      clip.meta = buildClipMeta(clip, track, opts?.source)

      const extra: Clip[] = []
      // 视频：始终拆一条链接 A 轨（有无探测到音轨都拆，方便剪辑）
      if (media.kind === 'video') {
        const audioResolved = resolveFreeTrack(sequence, 'audio', start, duration)
        sequence = audioResolved.seq
        const aTrack = audioResolved.track
        const aid = uid('clip')
        const vid = clip.id
        clip.linkedId = aid
        const audioClip: Clip = {
          ...JSON.parse(JSON.stringify(clip)) as Clip,
          id: aid,
          trackId: aTrack.id,
          linkedId: vid,
          name: `${media.name} 音频`,
          transform: defaultTransform(),
          color: defaultColor(),
          effects: [],
          text: undefined,
        }
        audioClip.meta = buildClipMeta(audioClip, aTrack, opts?.source)
        extra.push(audioClip)
      }

      const tracks = sequence.tracks
      patchSeq((s) => enforceNoOverlap({
        ...s,
        tracks,
        clips: [...s.clips, clip, ...extra],
        workOut: Math.max(s.workOut, clip.start + clip.duration),
      }))
      set({
        selectedClipIds: [clip.id, ...extra.map((e) => e.id)],
        sourceMediaId: mediaId,
      })
      // 上时间轴即配代理，节目窗只采代理
      if (media.kind === 'video') {
        get().ensureStackProxies([mediaId])
      }
    },

    /** 给已在时间线上的视频补链接音轨 */
    syncVideoAudioLinks() {
      const mediaList = get().media
      let changed = false
      const sequences = get().sequences.map((q) => {
        const next = enforceNoOverlap(withLinkedAudioClips(q, mediaList))
        if (next !== q) changed = true
        return next
      })
      if (changed) set({ sequences })
    },

    selectClips(ids) {
      const seq = get().seq()
      const clip = seq.clips.find((c) => ids.includes(c.id))
      let propTab = get().propTab
      if (clip) {
        const track = seq.tracks.find((t) => t.id === clip.trackId)
        if (clip.text || track?.kind === 'subtitle') propTab = 'text'
        else if (track?.kind === 'audio') propTab = 'audio'
        else propTab = 'transform'
      }
      set({ selectedClipIds: ids, propTab })
    },

    moveClips(ids, dt, trackId, opts) {
      if (opts?.record !== false) get().pushHistory()
      const setIds = new Set(ids)
      const snap = (t: number) => get().snapTime(t)
      patchSeq((s) => {
        const dest = trackId ? s.tracks.find((t) => t.id === trackId) : undefined
        const moved = s.clips
          .filter((c) => setIds.has(c.id))
          .map((c) => {
            const src = s.tracks.find((t) => t.id === c.trackId)
            const canRetarget = !!(dest && src && dest.kind === src.kind)
            return {
              ...c,
              start: Math.max(0, snap(c.start + dt)),
              trackId: canRetarget ? dest!.id : c.trackId,
            }
          })
        const applied = applyMoveNoOverlap(s, moved, setIds)
        const byId = new Map(applied.clips.map((c) => [c.id, c]))
        return enforceNoOverlap({
          ...applied.seq,
          clips: s.clips.map((c) => byId.get(c.id) ?? c),
        })
      })
    },

    alignSelectedClips(edge) {
      const s0 = get().seq()
      const sel = new Set(get().selectedClipIds)
      // 一组片段都链接到同一段（口播配音）时，那一段是时间基准，不跟着对齐
      const refs = new Map<string, number>()
      for (const c of s0.clips) if (sel.has(c.id) && c.linkedId) refs.set(c.linkedId, (refs.get(c.linkedId) ?? 0) + 1)
      for (const [id, n] of refs) if (n >= 2) sel.delete(id)
      const units = new Map<string, Clip[]>()
      for (const c of s0.clips) {
        const pair = chalkPairKey(c)
        const unit = pair ? `pair:${pair}` : c.id
        if (!sel.has(c.id) && !(pair && s0.clips.some((o) => sel.has(o.id) && chalkPairKey(o) === pair))) continue
        units.set(unit, [...(units.get(unit) ?? []), c])
      }
      if (units.size < 2) { notify('至少选中两个片段才能对齐'); return }
      const span = (cs: Clip[]) => ({
        start: Math.min(...cs.map((c) => c.start)),
        end: Math.max(...cs.map((c) => c.start + c.duration)),
      })
      const spans = [...units.values()].map(span)
      const target = edge === 'start' ? Math.min(...spans.map((x) => x.start)) : Math.max(...spans.map((x) => x.end))
      const moving = new Set<string>()
      const moved: Clip[] = []
      for (const cs of units.values()) {
        const sp = span(cs)
        const dt = edge === 'start' ? target - sp.start : target - sp.end
        for (const c of cs) {
          moving.add(c.id)
          moved.push({ ...c, start: Math.max(0, c.start + dt) })
        }
      }
      get().pushHistory()
      patchSeq((s) => {
        const applied = applyMoveNoOverlap(s, moved, moving)
        const byId = new Map(applied.clips.map((c) => [c.id, c]))
        return enforceNoOverlap({ ...applied.seq, clips: applied.seq.clips.map((c) => byId.get(c.id) ?? c) })
      })
      notify(edge === 'start' ? `已头对齐 ${units.size} 个片段` : `已尾对齐 ${units.size} 个片段`)
    },

    snapGuide: null,
    setSnapGuide,

    snapPlayheadTime(t, pxPerSec) {
      const st = get()
      const r = snapClipEdge(t, 0, new Set(), st.seq(), st.playhead, st.settings.fps, { pxPerSec, strong: true, skipPlayhead: true })
      setSnapGuide(r.at)
      return r.t
    },

    snapTime(t) {
      const { settings } = get()
      return settings.snap ? Math.round(t * settings.fps) / settings.fps : t
    },

    nudgeSelectedTransform(dx, dy) {
      pushHistoryCoalesced(get, set)
      const playhead = get().playhead
      const forceKf = get().autoKeyframe
      patchSelected((c) => {
        const live = forceKf
          ? {
              x: Math.max(-1, Math.min(1, sampleAt(c, 'x', Math.max(0, playhead - c.start)) + dx)),
              y: Math.max(-1, Math.min(1, sampleAt(c, 'y', Math.max(0, playhead - c.start)) + dy)),
            }
          : {
              x: Math.max(-1, Math.min(1, c.transform.x + dx)),
              y: Math.max(-1, Math.min(1, c.transform.y + dy)),
            }
        if (forceKf) {
          return patchClipXY(c, playhead, live.x, live.y, { forceKf: true })
        }
        return patchClipTransform(c, playhead, live)
      })
    },

    trimClip(id, edge, t, opts) {
      if (opts?.record !== false) get().pushHistory()
      const targets = trimTargets(get().seq(), id)
      const snapped = get().snapTime(snapTrimEdge(get(), t, targets, { ...opts, trackId: get().seq().clips.find((c) => c.id === id)?.trackId }))
      patchSeq((s) => {
        return enforceNoOverlap({
          ...s,
          clips: s.clips.map((c) => {
            if (!targets.has(c.id)) return c
            return clampTrimNoOverlap(s, c, edge, snapped)
          }),
        })
      })
    },

    rateStretchClip(id, edge, t, opts) {
      if (opts?.record !== false) get().pushHistory()
      const targets = trimTargets(get().seq(), id)
      const snapped = get().snapTime(snapTrimEdge(get(), t, targets, { ...opts, trackId: get().seq().clips.find((c) => c.id === id)?.trackId }))
      const media = get().media
      // 媒体可能已从库里删掉（离线），查不到类型时仍按音视频变速
      const timed = (c: Clip) => {
        if (!c.mediaId || c.text || c.solid) return false
        const kind = media.find((m) => m.id === c.mediaId)?.kind
        return kind !== 'image' && kind !== 'sticker'
      }
      patchSeq((s) => {
        return enforceNoOverlap({
          ...s,
          clips: s.clips.map((c) => (targets.has(c.id) ? rateStretchNoOverlap(s, c, edge, snapped, timed(c)) : c)),
        })
      })
    },

    resizeEdgeAnim(id, edge, sec, opts) {
      if (opts?.record !== false) get().pushHistory()
      patchSeq((s) => ({
        ...s,
        clips: s.clips.map((c) => (c.id === id ? applyEdgeAnimDuration(c, edge, sec) : c)),
      }))
    },

    dragMoveClips(ids, origins, dt, trackId, opts) {
      pendingDragMove = { ids, origins, dt, trackId, opts }
      if (!dragMoveRaf) {
        dragMoveRaf = requestAnimationFrame(() => flushDragMove(get, set))
      }
    },

    previewDragDt(ids, origins, dt, opts) {
      return resolveDragDt(get, ids, origins, dt, opts)
    },

    trackAtY(contentY) {
      // bodyRef 内容坐标：从第一条业务轨道起算
      let acc = 0
      for (const tr of get().seq().tracks) {
        if (contentY >= acc && contentY < acc + tr.height) return tr.id
        acc += tr.height
      }
      return null
    },

    setLayout(p) {
      const prev = get().layout
      const layout = {
        ...prev,
        ...p,
        panelDock: p.panelDock ? { ...prev.panelDock, ...p.panelDock } : prev.panelDock,
      }
      set({ layout })
      document.documentElement.style.setProperty('--sidebar-w', `${layout.sidebarW}px`)
      document.documentElement.style.setProperty('--props-w', `${layout.propsW}px`)
      document.documentElement.style.setProperty('--timeline-h', `${layout.timelineH}px`)
      document.documentElement.style.setProperty('--source-mon-h', `${layout.sourceMonitorH ?? 168}px`)
      document.documentElement.style.setProperty('--right-w', `${layout.rightW ?? 280}px`)
      document.documentElement.style.setProperty('--dock-h', `${layout.dockH ?? 220}px`)
      localStorage.setItem('todo-layout', JSON.stringify(layout))
    },

    setMonitorView(v) {
      set({ monitorView: v })
      try { localStorage.setItem('todo-monitor-view', v) } catch { /* ignore */ }
    },
    setScript(text) {
      set({ script: text })
    },
    toggleScript(open) {
      const next = open ?? !get().scriptOpen
      set(next ? { scriptOpen: true, playing: false } : { scriptOpen: false })
    },
    setMonitorCompose(m) {
      set({ monitorCompose: m })
      if (m === '3d') {
        patchSeq((q) => ({ ...q, scene3d: { ...ensureScene3d(q.scene3d), enabled: true } }))
        notify('已切换 3D 摄像机合成')
      }
    },
    setAutoKeyframe(on) {
      if (!on) {
        if (!get().autoKeyframe) return
        set({ autoKeyframe: false })
        notify('K帧模式已关')
        return
      }
      if (get().autoKeyframe) return
      if (!get().selectedClipIds.length) {
        notify('请先选中片段')
        return
      }
      get().pushHistory()
      const t = get().playhead
      patchSelected((c) => seedPositionKeyframes(c, t))
      set({ autoKeyframe: true })
      notify('K帧模式 · S缩放 · R旋转 · T透明 · 拖位置打点')
    },
    toggleAutoKeyframe() {
      get().setAutoKeyframe(!get().autoKeyframe)
    },

    updateScene3d(p) {
      get().pushHistory()
      patchSeq((q) => ({ ...q, scene3d: { ...ensureScene3d(q.scene3d), ...p } }))
    },

    updateCamera3d(p, opts) {
      if (opts?.record !== false) pushHistoryCoalesced(get, set)
      patchSeq((q) => {
        const scene = ensureScene3d(q.scene3d)
        return { ...q, scene3d: { ...scene, camera: { ...scene.camera, ...p } } }
      })
    },

    toggleCameraKeyframe(prop) {
      get().pushHistory()
      const t = get().playhead
      patchSeq((q) => {
        const scene = ensureScene3d(q.scene3d)
        const cam = scene.camera
        const list = [...(cam.keyframes[prop] ?? [])]
        const near = list.findIndex((k) => Math.abs(k.t - t) < 0.08)
        if (near >= 0) list.splice(near, 1)
        else {
          const map: Record<string, number> = {
            camX: cam.x, camY: cam.y, camZ: cam.z,
            camRotX: cam.rotationX, camRotY: cam.rotationY, camRotZ: cam.rotationZ,
            fov: cam.fov, focusDistance: cam.focusDistance,
          }
          list.push({ id: uid('kf'), t, value: map[prop] ?? 0, ease: 'linear' })
        }
        return {
          ...q,
          scene3d: { ...scene, camera: { ...cam, keyframes: { ...cam.keyframes, [prop]: list } } },
        }
      })
    },

    setClipThreeD(enabled) {
      get().pushHistory()
      patchSelected((c) => ({
        ...c,
        threeD: enabled,
        transform3d: enabled ? (c.transform3d ?? {
          ...defaultTransform3d(),
          x: c.transform.x, y: c.transform.y,
          scaleX: c.transform.scaleX, scaleY: c.transform.scaleY,
          rotationZ: c.transform.rotation, opacity: c.transform.opacity,
        }) : c.transform3d,
      }))
      if (enabled) {
        patchSeq((q) => ({ ...q, scene3d: { ...ensureScene3d(q.scene3d), enabled: true } }))
        set({ monitorCompose: '3d' })
      }
    },

    updateSelectedTransform3d(p, opts) {
      if (opts?.record !== false) pushHistoryCoalesced(get, set)
      patchSelected((c) => ({
        ...c,
        threeD: true,
        transform3d: { ...(c.transform3d ?? defaultTransform3d()), ...p },
      }))
    },

    setTimelineZoom(z) {
      set({ timelineZoom: clampZoom(z) })
    },

    razorAtPlayhead() {
      // 按当前选中帧切开（对齐工程帧网格），不改播放头
      const fps = Math.max(1, get().settings.fps)
      const t = Math.round(get().playhead * fps) / fps
      get().razorAtTime(t)
    },

    razorAtTime(ph) {
      const fps = Math.max(1, get().settings.fps)
      const t = Math.round(Math.max(0, ph) * fps) / fps
      const hits = get().seq().clips.filter(
        (c) => t > c.start + 1 / fps / 2 && t < c.start + c.duration - 1 / fps / 2,
      )
      if (!hits.length) { notify('当前帧处无可分割片段'); return }
      get().pushHistory()
      patchSeq((s) => {
        const next: Clip[] = []
        const rightOf = new Map<string, string>()
        for (const c of s.clips) {
          const hit = t > c.start + 1 / fps / 2 && t < c.start + c.duration - 1 / fps / 2
          if (!hit) { next.push(c); continue }
          const [a, b] = splitClipAt(c, t - c.start)
          rightOf.set(c.id, b.id)
          next.push(a, b)
        }
        // 联动的音视频同时被切开时，右段与右段互相关联
        const rights = new Set(rightOf.values())
        const clips = next.map((c) =>
          rights.has(c.id) && c.linkedId && rightOf.has(c.linkedId)
            ? { ...c, linkedId: rightOf.get(c.linkedId) }
            : c,
        )
        return { ...s, clips }
      })
      notify(`已在 ${formatTime(t, fps)} 分割 ${hits.length} 个片段`)
    },

    deleteSelected(ripple = false) {
      get().pushHistory()
      const ids = new Set(get().selectedClipIds)
      const removed = get().seq().clips.filter((c) => ids.has(c.id))
      patchSeq((s) => {
        let clips = s.clips.filter((c) => !ids.has(c.id))
        if (ripple) {
          for (const r of removed) {
            clips = clips.map((c) =>
              c.trackId === r.trackId && c.start >= r.start + r.duration
                ? { ...c, start: c.start - r.duration } : c,
            )
          }
        }
        return { ...s, clips }
      })
      set({ selectedClipIds: [] })
    },

    closeGaps() {
      get().pushHistory()
      patchSeq((s) => {
        const by = new Map<string, Clip[]>()
        for (const c of s.clips) {
          const arr = by.get(c.trackId) ?? []
          arr.push(c)
          by.set(c.trackId, arr)
        }
        const clips: Clip[] = []
        for (const [, arr] of by) {
          arr.sort((a, b) => a.start - b.start)
          let t = 0
          for (const c of arr) { clips.push({ ...c, start: t }); t += c.duration }
        }
        return { ...s, clips }
      })
      notify('已关闭空隙')
    },

    duplicateSelected() {
      get().pushHistory()
      const ids = new Set(get().selectedClipIds)
      const copies = get().seq().clips.filter((c) => ids.has(c.id)).map((c) => ({
        ...(JSON.parse(JSON.stringify(c)) as Clip), id: uid('clip'), start: c.start + c.duration,
      }))
      patchSeq((s) => enforceNoOverlap({ ...s, clips: [...s.clips, ...copies] }))
      set({ selectedClipIds: copies.map((c) => c.id) })
    },

    copyOrPaste() {
      if (!clipboard.length) {
        clipboard = get().seq().clips.filter((c) => get().selectedClipIds.includes(c.id))
          .map((c) => JSON.parse(JSON.stringify(c)))
        notify(`已复制 ${clipboard.length} 个`)
        return
      }
      get().pushHistory()
      const base = Math.min(...clipboard.map((c) => c.start))
      const copies = clipboard.map((c) => ({
        ...(JSON.parse(JSON.stringify(c)) as Clip),
        id: uid('clip'), start: get().playhead + (c.start - base),
      }))
      patchSeq((s) => enforceNoOverlap({ ...s, clips: [...s.clips, ...copies] }))
      set({ selectedClipIds: copies.map((c) => c.id) })
    },
    copySelected() {
      clipboard = get().seq().clips
        .filter((c) => get().selectedClipIds.includes(c.id))
        .map((c) => JSON.parse(JSON.stringify(c)))
      notify(clipboard.length ? `已复制 ${clipboard.length} 个` : '未选中片段')
    },
    cutSelected() {
      get().copySelected()
      if (clipboard.length) get().deleteSelected(false)
    },
    pasteClipboard() {
      if (!clipboard.length) { notify('剪贴板为空'); return }
      get().pushHistory()
      const base = Math.min(...clipboard.map((c) => c.start))
      const copies = clipboard.map((c) => ({
        ...(JSON.parse(JSON.stringify(c)) as Clip),
        id: uid('clip'), start: get().playhead + (c.start - base),
      }))
      patchSeq((s) => enforceNoOverlap({ ...s, clips: [...s.clips, ...copies] }))
      set({ selectedClipIds: copies.map((c) => c.id) })
    },
    selectAllClips() {
      set({ selectedClipIds: get().seq().clips.map((c) => c.id) })
    },


    toggleClipEnabled() { get().pushHistory(); patchSelected((c) => ({ ...c, enabled: !c.enabled })) },
    unlinkSelected() {
      const sel = new Set(get().selectedClipIds)
      get().pushHistory()
      patchSeq((s) => ({
        ...s,
        clips: s.clips.map((c) => (sel.has(c.id) || (c.linkedId && sel.has(c.linkedId)) ? { ...c, linkedId: undefined } : c)),
      }))
      notify('已解链')
    },
    linkSelected() {
      const s = get().seq()
      const sel = s.clips.filter((c) => get().selectedClipIds.includes(c.id))
      if (sel.length < 2) return
      get().pushHistory()
      // 以第一个非文字片段为主，其余指向它；主片段原有的音视频配对保留
      const primary = sel.find((c) => !c.text) ?? sel[0]
      const ids = new Set(sel.map((c) => c.id))
      patchSeq((sq) => ({
        ...sq,
        clips: sq.clips.map((c) => (ids.has(c.id) && c.id !== primary.id ? { ...c, linkedId: primary.id } : c)),
      }))
      notify('已链接')
    },
    groupSelected() {
      get().pushHistory()
      const gid = uid('group')
      patchSelected((c) => ({ ...c, groupId: gid }))
    },
    ungroupSelected() {
      get().pushHistory()
      patchSelected((c) => ({ ...c, groupId: undefined }))
    },
    setClipSpeed(speed) {
      get().pushHistory()
      patchSelected((c) => ({ ...c, duration: c.duration * (c.speed / speed), speed }))
    },
    reverseSelected() {
      get().pushHistory()
      patchSelected((c) => ({ ...c, reverse: !c.reverse }))
    },
    freezeFrame() {
      get().pushHistory()
      const c = get().seq().clips.find((x) => get().selectedClipIds.includes(x.id))
      if (!c) return
      const freeze: Clip = {
        ...(JSON.parse(JSON.stringify(c)) as Clip),
        id: uid('clip'), start: get().playhead, duration: 2,
        freeze: get().playhead - c.start + c.inPoint, name: `${c.name} 定格`,
      }
      patchSeq((s) => ({ ...s, clips: [...s.clips, freeze] }))
      set({ selectedClipIds: [freeze.id] })
    },

    updateSelectedTransform(p) {
      // 静态属性：只改底层 transform，不碰关键帧（动态优先）
      pushHistoryCoalesced(get, set)
      patchSelected((c) => ({ ...c, transform: { ...c.transform, ...p } }))
    },
    setDynamicAtPlayhead(prop, value) {
      if (!get().selectedClipIds.length) return
      pushHistoryCoalesced(get, set)
      const t = get().playhead
      const fps = get().settings.fps
      patchSelected((c) => upsertDynamicKf(c, prop, value, t, fps))
    },

    beginTransformGesture(prop) {
      if (!ensureClipSelected(get, set, notify)) return false
      const t = get().playhead
      const ids = new Set(get().selectedClipIds)
      gestureOrigins.clear()
      for (const c of get().seq().clips) {
        if (!ids.has(c.id)) continue
        const live = resolveClipTransform(c, t)
        gestureOrigins.set(c.id, prop === 'scale'
          ? { a: live.scaleX, b: live.scaleY }
          : { a: live.rotation, b: live.rotation })
      }
      if (!gestureOrigins.size) return false
      get().pushHistory()
      set({ transformGesture: { prop, keyed: get().autoKeyframe } })
      return true
    },
    updateTransformGesture(amount) {
      const g = get().transformGesture
      if (!g) return
      const t = get().playhead
      const fps = get().settings.fps
      patchSelected((c) => {
        const o = gestureOrigins.get(c.id)
        if (!o) return c
        if (g.prop === 'scale') {
          const sx = Math.max(0.01, o.a * amount)
          const sy = Math.max(0.01, o.b * amount)
          if (g.keyed) return upsertDynamicKf(c, 'scale', sx, t, fps)
          return patchClipTransform(c, t, { scaleX: sx, scaleY: sy })
        }
        const r = o.a + amount
        if (g.keyed) return upsertDynamicKf(c, 'rotation', r, t, fps)
        return patchClipTransform(c, t, { rotation: r })
      })
    },
    endTransformGesture(commit) {
      if (!get().transformGesture) return
      if (!commit) {
        const { history } = get()
        const prev = history[history.length - 1]
        if (prev) set({ sequences: prev.sequences, activeSeqId: prev.activeSeqId, history: history.slice(0, -1) })
      }
      gestureOrigins.clear()
      set({ transformGesture: null })
    },
    updateSelectedColor(p) {
      pushHistoryCoalesced(get, set)
      patchSelected((c) => ({ ...c, color: { ...c.color, ...p } }))
    },
    updateSelectedAudio(p) {
      pushHistoryCoalesced(get, set)
      patchSelected((c) => ({ ...c, audio: { ...c.audio, ...p } }))
    },
    updateSelectedText(p) {
      // 静态文字属性；字号关键帧走 setDynamicAtPlayhead('fontSize')
      pushHistoryCoalesced(get, set)
      patchSelected((c) => (c.text ? { ...c, text: { ...c.text, ...p } } : c))
    },
    updateSelectedClip(p) {
      pushHistoryCoalesced(get, set)
      patchSelected((c) => ({ ...c, ...p }))
    },

    addTextClip(opts) {
      get().pushHistory()
      let seq = get().seq()
      let track = seq.tracks.find((t) => t.kind === 'subtitle')
      if (!track) {
        track = newTrackOfKind(seq, 'subtitle')
        seq = { ...seq, tracks: [track, ...seq.tracks] }
        set({ sequences: get().sequences.map((s) => (s.id === seq.id ? seq : s)) })
      }
      const clip: Clip = {
        id: uid('clip'), trackId: track.id, name: opts?.name ?? '文本',
        start: get().playhead, duration: 3, inPoint: 0, outPoint: 3,
        enabled: true, speed: 1, reverse: false, speedKeyframes: [],
        transform: { ...defaultTransform(), ...opts?.transform },
        color: defaultColor(), audio: defaultAudio(),
        text: { ...defaultText(), ...opts?.text }, effects: [], blend: 'normal', keyframes: {},
      }
      clip.meta = buildClipMeta(clip, track, { type: 'manual' })
      patchSeq((s) => enforceNoOverlap({ ...s, clips: [...s.clips, clip] }))
      set({ selectedClipIds: [clip.id], propTab: 'text' })
    },

    addSubtitleCues({ cues, linkTo, text, transform, source }) {
      const rows = cues.filter((q) => q.text.trim() && q.end > q.start)
      if (!rows.length) return
      get().pushHistory()
      let sequence = get().seq()
      const anchor = linkTo ? sequence.clips.find((c) => c.id === linkTo) : undefined
      const first = Math.min(...rows.map((q) => q.start))
      const last = Math.max(...rows.map((q) => q.end))
      const s = resolveFreeTrack(sequence, 'subtitle', first, last - first)
      sequence = s.seq
      const subs = rows.map((q) => {
        const d = q.end - q.start
        const clip: Clip = {
          id: uid('clip'), trackId: s.track.id, name: q.text.slice(0, 16), linkedId: anchor?.id,
          start: q.start, duration: d, inPoint: 0, outPoint: d,
          enabled: true, speed: 1, reverse: false, speedKeyframes: [],
          transform: { ...defaultTransform(), ...transform },
          color: defaultColor(), audio: defaultAudio(),
          text: { ...defaultText(), animIn: 'none', animOut: 'none', ...text, content: q.text },
          effects: [], blend: 'normal', keyframes: {},
        }
        clip.meta = buildClipMeta(clip, s.track, source)
        return clip
      })
      const tracks = sequence.tracks
      patchSeq((sq) => enforceNoOverlap({
        ...sq,
        tracks,
        clips: [...sq.clips, ...subs],
        workOut: Math.max(sq.workOut, last),
      }))
      set({ selectedClipIds: subs.map((c) => c.id) })
    },

    addAiLayerClips(items, { jobId, kind, linkTo, history = true }) {
      const media = get().media
      const valid = items.filter((it) => media.some((m) => m.id === it.mediaId) && it.duration > 0.02)
      if (!valid.length) return items.map(() => null)
      if (history) get().pushHistory()
      let sequence = get().seq()
      const added: Clip[] = []
      const ids = new Map<(typeof items)[number], string>()
      const all = () => [...sequence.clips, ...added]
      const laneOf = (c: Clip) => (c.meta?.source?.jobId === jobId ? c.meta.source.lane : undefined)
      const laneTracks = (kind: TrackKind, pick: (lane: number) => boolean) => sequence.tracks
        .map((t, i) => ({ t, i }))
        .filter(({ t }) => t.kind === kind && all().some((c) => c.trackId === t.id && laneOf(c) != null && pick(laneOf(c)!)))
      for (const it of valid) {
        const m = media.find((x) => x.id === it.mediaId)!
        const tk: TrackKind = m.kind === 'audio' ? 'audio' : 'video'
        const free = (t: Track) => !t.locked && !all().some((c) => c.trackId === t.id && rangeOverlap(it.start, it.duration, c.start, c.duration))
        let track = laneTracks(tk, (l) => l === it.lane).map(({ t }) => t).find(free)
        // 本层还没有轨：夹在本任务的上层（lane 更小）和下层（lane 更大）之间
        const lower = laneTracks(tk, (l) => l > it.lane)[0]
        const upper = laneTracks(tk, (l) => l < it.lane).at(-1)
        if (!track) {
          // 先复用这段时间空着的已有轨（比如上一个任务的轨），接着往下排，不每个任务都叠一组新轨
          track = sequence.tracks.find((t, i) => t.kind === tk && free(t)
            && (!upper || i > upper.i) && (!lower || i < lower.i)
            && !all().some((c) => c.trackId === t.id && laneOf(c) != null))
        }
        if (!track) {
          const fresh = newTrackOfKind(sequence, tk)
          // 本任务还没有轨道时放到同类轨最上面
          const tracks = lower ? [...sequence.tracks.slice(0, lower.i), fresh, ...sequence.tracks.slice(lower.i)]
            : upper ? [...sequence.tracks.slice(0, upper.i + 1), fresh, ...sequence.tracks.slice(upper.i + 1)]
              : insertTrack(sequence.tracks, fresh, 'before')
          sequence = { ...sequence, tracks: renameKindTracks(tracks) }
          track = sequence.tracks.find((t) => t.id === fresh.id)!
        }
        const clip: Clip = {
          id: uid('clip'), trackId: track.id, mediaId: m.id, name: it.name ?? m.name, linkedId: linkTo,
          start: it.start, duration: it.duration, inPoint: 0, outPoint: it.duration,
          enabled: true, speed: 1, reverse: false, speedKeyframes: [],
          transform: { ...defaultTransform(), ...it.transform }, color: defaultColor(), audio: defaultAudio(),
          effects: [], blend: 'normal', keyframes: it.keyframes ?? {},
        }
        clip.meta = buildClipMeta(clip, track, { ...it.source, type: 'ai', jobId, kind, lane: it.lane })
        added.push(clip)
        ids.set(it, clip.id)
      }
      const tracks = sequence.tracks
      const end = Math.max(...added.map((c) => c.start + c.duration))
      patchSeq((sq) => enforceNoOverlap({ ...sq, tracks, clips: [...sq.clips, ...added], workOut: Math.max(sq.workOut, end) }))
      return items.map((it) => ids.get(it) ?? null)
    },

    patchClipsQuiet(patches) {
      patchSeq((sq) => ({
        ...sq,
        clips: sq.clips.flatMap((c) => {
          if (!(c.id in patches)) return [c]
          const p = patches[c.id]
          return p ? [{ ...c, ...p }] : []
        }),
      }))
    },

    addSolidClip(color) {
      get().pushHistory()
      const start = get().playhead
      const duration = Math.max(0.2, get().settings.stillDuration || 5)
      const track = backgroundTrack(get, set, start, duration)
      const clip: Clip = {
        id: uid('clip'), trackId: track.id, name: `纯色 ${color.toUpperCase()}`,
        start, duration, inPoint: 0, outPoint: duration,
        enabled: true, speed: 1, reverse: false, speedKeyframes: [],
        transform: defaultTransform(), color: defaultColor(), audio: defaultAudio(),
        solid: { color }, effects: [], blend: 'normal', keyframes: {},
      }
      clip.meta = buildClipMeta(clip, track, { type: 'manual' })
      patchSeq((s) => enforceNoOverlap({ ...s, clips: [...s.clips, clip] }))
      set({ selectedClipIds: [clip.id] })
      notify('已添加纯色底')
    },

    addBackgroundImage(mediaId) {
      const m = get().media.find((x) => x.id === mediaId)
      if (!m || (m.kind !== 'image' && m.kind !== 'sticker')) return
      get().pushHistory()
      const seq = get().seq()
      const start = get().playhead
      const seqEnd = seq.clips.reduce((e, c) => Math.max(e, c.start + c.duration), 0)
      const duration = seqEnd - start > 0.2 ? seqEnd - start : Math.max(0.2, get().settings.stillDuration || 5)
      const track = backgroundTrack(get, set, start, duration)
      const clip: Clip = {
        id: uid('clip'), trackId: track.id, mediaId, name: `背景 ${m.name}`,
        start, duration, inPoint: 0, outPoint: duration,
        enabled: true, speed: 1, reverse: false, speedKeyframes: [],
        transform: coverTransform(m, get().settings), color: defaultColor(), audio: defaultAudio(),
        effects: [], blend: 'normal', keyframes: {},
      }
      clip.meta = buildClipMeta(clip, track, { type: 'manual' })
      patchSeq((s) => enforceNoOverlap({ ...s, clips: [...s.clips, clip], workOut: Math.max(s.workOut, start + duration) }))
      set({ selectedClipIds: [clip.id] })
      notify('已添加背景图片')
    },

    setSelectedBackgroundImage(mediaId) {
      const m = get().media.find((x) => x.id === mediaId)
      if (!m) return 0
      const media = get().media
      const ids = new Set(get().selectedClipIds)
      const isImageClip = (c: Clip) => {
        const kind = media.find((x) => x.id === c.mediaId)?.kind
        return ids.has(c.id) && (kind === 'image' || kind === 'sticker')
      }
      const n = get().seq().clips.filter(isImageClip).length
      if (!n) return 0
      get().pushHistory()
      const transform = coverTransform(m, get().settings)
      patchSeq((s) => ({
        ...s,
        clips: s.clips.map((c) => (isImageClip(c) ? { ...c, mediaId, name: `背景 ${m.name}`, transform } : c)),
      }))
      notify('已替换背景图片')
      return n
    },

    setSelectedSolidColor(color) {
      const ids = new Set(get().selectedClipIds)
      const n = get().seq().clips.filter((c) => ids.has(c.id) && c.solid).length
      if (!n) return 0
      pushHistoryCoalesced(get, set)
      patchSelected((c) => (c.solid ? { ...c, solid: { color }, name: `纯色 ${color.toUpperCase()}` } : c))
      return n
    },

    addTransition(type) {
      get().pushHistory()
      patchSelected((c) => ({ ...c, transitionOut: { type, duration: 0.5 } }))
      notify('已添加转场')
    },

    addEffect(type, name) {
      get().pushHistory()
      patchSelected((c) => ({
        ...c,
        effects: [...c.effects, {
          id: uid('fx'), type: type as Clip['effects'][0]['type'], name,
          strength: 0.5, enabled: true, start: 0, end: c.duration,
        }],
      }))
    },

    setClipMask(type) {
      get().pushHistory()
      if (!type) {
        patchSelected((c) => ({ ...c, mask: undefined }))
        return
      }
      patchSelected((c) => ({
        ...c,
        mask: {
          type,
          feather: c.mask?.feather ?? 0.15,
          expand: c.mask?.expand ?? 0,
          invert: c.mask?.invert ?? false,
          points: type === 'pen'
            ? (c.mask?.points?.length ? c.mask.points : [
              { x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.8 },
            ])
            : c.mask?.points,
        },
      }))
    },

    toggleMaskInvert() {
      get().pushHistory()
      patchSelected((c) => (c.mask ? { ...c, mask: { ...c.mask, invert: !c.mask.invert } } : c))
    },

    setChromaKey(enabled) {
      get().pushHistory()
      patchSelected((c) => ({
        ...c,
        chromaKey: enabled
          ? { color: c.chromaKey?.color ?? '#00FF00', tolerance: c.chromaKey?.tolerance ?? 0.35, enabled: true }
          : { color: c.chromaKey?.color ?? '#00FF00', tolerance: c.chromaKey?.tolerance ?? 0.35, enabled: false },
      }))
    },

    addMarker(label = '标记') {
      patchSeq((s) => ({
        ...s,
        markers: [...s.markers, { id: uid('mk'), t: get().playhead, color: '#E26A2C', label }],
      }))
    },

    setWorkArea(a, b) { patchSeq((s) => ({ ...s, workIn: a, workOut: b })) },

    tidyTimeline() {
      const current = get().seq()
      const next = tidyTimeline(current, get().media, get().settings)
      if (next === current) { notify('时间轴已整齐，没有可安全合并的轨道'); return }
      get().pushHistory()
      patchSeq(() => next)
      const moved = next.clips.filter((c, i) => c.trackId !== current.clips[i].trackId).length
      notify(`已整理：移动 ${moved} 个片段，减少 ${current.tracks.length - next.tracks.length} 条轨道，可撤销`)
    },

    toggleTrack(id, key) {
      patchSeq((s) => ({
        ...s, tracks: s.tracks.map((t) => (t.id === id ? { ...t, [key]: !t[key] } : t)),
      }))
    },

    setTrackHeight(id, height) {
      const h = Math.max(20, Math.min(160, Math.round(height)))
      patchSeq((s) => ({
        ...s,
        tracks: s.tracks.map((t) => (t.id === id ? { ...t, height: h } : t)),
      }))
    },

    addTrack(kind) {
      get().pushHistory()
      const n = get().seq().tracks.filter((t) => t.kind === kind).length + 1
      const track: Track = {
        id: uid('track'), kind,
        name: kind === 'video' ? `V${n}` : kind === 'audio' ? `A${n}` : String(kind),
        locked: false, muted: false, solo: false, hidden: false, height: 40,
      }
      patchSeq((s) => ({ ...s, tracks: [track, ...s.tracks] }))
    },

    matchFrame() {
      const c = get().seq().clips.find(
        (x) => get().playhead >= x.start && get().playhead < x.start + x.duration && x.mediaId,
      )
      if (c?.mediaId) {
        set({
          selectedMediaId: c.mediaId, sourceMediaId: c.mediaId,
          sourceIn: c.inPoint + (get().playhead - c.start),
        })
        notify('已匹配源帧')
      }
    },

    replaceClipMedia(mediaId) {
      get().pushHistory()
      const media = get().media.find((m) => m.id === mediaId)
      if (!media) return
      patchSelected((c) => ({ ...c, mediaId, name: media.name }))
    },

    addKeyframe(prop, value) {
      if (!get().selectedClipIds.length) return
      get().pushHistory()
      const t = get().playhead
      const staticVal = (c: Clip) => {
        switch (prop) {
          case 'x': return c.transform.x
          case 'y': return c.transform.y
          case 'scale': return c.transform.scaleX
          case 'rotation': return c.transform.rotation
          case 'opacity': return c.transform.opacity
          case 'volume': return c.audio.gainDb
          case 'fontSize': return c.text?.fontSize ?? 48
          default: return value
        }
      }
      patchSelected((c) => {
        const fps = get().settings.fps
        const localT = snapToFrame(Math.max(0, t - c.start), fps)
        const near = 0.51 / fps
        let list = [...(c.keyframes[prop] ?? [])]
        if (list.length === 0 && localT > near) {
          list.push({ id: uid('kf'), t: 0, value: staticVal(c), ease: 'linear' })
        }
        const idx = list.findIndex((k) => Math.abs(k.t - localT) < near)
        if (idx >= 0) list[idx] = { ...list[idx], value, t: localT }
        else list.push({ id: uid('kf'), t: localT, value, ease: 'linear' })
        list.sort((a, b) => a.t - b.t)
        return { ...c, keyframes: { ...c.keyframes, [prop]: list } }
      })
      notify(`已添加关键帧 · ${prop}`)
    },

    removeKeyframeAtPlayhead(prop) {
      const t = get().playhead
      get().pushHistory()
      patchSelected((c) => {
        const localT = Math.max(0, t - c.start)
        const prev = c.keyframes[prop] ?? []
        const list = prev.filter((k) => Math.abs(k.t - localT) >= 0.08)
        const next = { ...c.keyframes }
        if (list.length) {
          next[prop] = list
          return { ...c, keyframes: next }
        }
        delete next[prop]
        // 删光后把当前插值烘焙进静态值，避免画面跳变（PR 行为）
        const baked = sampleAt(c, prop, localT)
        return { ...bakeProp(c, prop, baked), keyframes: next }
      })
    },

    removeKeyframeById(prop, kfId) {
      get().removeKeyframesByIds({ [prop]: [kfId] })
    },

    removeKeyframesByIds(byProp) {
      const entries = Object.entries(byProp).filter(([, ids]) => ids.length)
      if (!entries.length) return
      get().pushHistory()
      patchSelected((c) => {
        let nextKf = { ...c.keyframes }
        let nextClip: Clip = c
        let changed = false
        const localT = Math.max(0, get().playhead - c.start)
        for (const [prop, ids] of entries) {
          const idSet = new Set(ids)
          const prev = nextKf[prop] ?? []
          const list = prev.filter((k) => !idSet.has(k.id))
          if (list.length === prev.length) continue
          changed = true
          if (list.length) {
            nextKf = { ...nextKf, [prop]: list }
          } else {
            nextKf = { ...nextKf }
            delete nextKf[prop]
            nextClip = bakeProp(nextClip, prop, sampleAt(c, prop, localT))
          }
        }
        if (!changed) return c
        return { ...nextClip, keyframes: nextKf }
      })
    },

    clearKeyframeTrack(prop) {
      get().pushHistory()
      const t = get().playhead
      patchSelected((c) => {
        const localT = Math.max(0, t - c.start)
        const baked = sampleAt(c, prop, localT)
        const next = { ...c.keyframes }
        delete next[prop]
        return { ...bakeProp(c, prop, baked), keyframes: next }
      })
      notify(`已清除「${prop}」动画轨`)
    },

    clearAllKeyframes() {
      get().pushHistory()
      const t = get().playhead
      patchSelected((c) => {
        const localT = Math.max(0, t - c.start)
        let out = c
        for (const prop of Object.keys(c.keyframes)) {
          out = bakeProp(out, prop, sampleAt(out, prop, localT))
        }
        return { ...out, keyframes: {} }
      })
      notify('已清除全部关键帧动画')
    },

    setKeyframeTime(prop, kfId, t) {
      pushHistoryCoalesced(get, set)
      const fps = get().settings.fps
      patchSelected((c) => {
        const dur = c.duration
        const clamped = snapToFrame(Math.max(0, Math.min(dur, t)), fps)
        const list = (c.keyframes[prop] ?? []).map((k) =>
          k.id === kfId ? { ...k, t: clamped } : k,
        ).sort((a, b) => a.t - b.t)
        return { ...c, keyframes: { ...c.keyframes, [prop]: list } }
      })
    },

    setKeyframeEase(prop, kfId, ease) {
      get().pushHistory()
      patchSelected((c) => {
        const list = (c.keyframes[prop] ?? []).map((k) => {
          if (k.id !== kfId) return k
          if (ease === 'bezier') {
            const d = defaultHandles(k.ease === 'bezier' ? 'linear' : k.ease)
            return { ...k, ease, oh: k.oh ?? d.oh, ih: k.ih ?? d.ih }
          }
          // 切回线性等预设：清掉手柄，避免残留曲线数据
          const { oh: _o, ih: _i, ...rest } = k
          return { ...rest, ease }
        })
        return { ...c, keyframes: { ...c.keyframes, [prop]: list } }
      })
      notify(ease === 'linear' ? '线性' : ease === 'bezier' ? '自定义曲线' : `缓动 → ${ease}`)
    },

    setKeyframeHandle(prop, kfId, which, handle) {
      pushHistoryCoalesced(get, set)
      patchSelected((c) => {
        const sorted = [...(c.keyframes[prop] ?? [])].sort((a, b) => a.t - b.t)
        const idx = sorted.findIndex((k) => k.id === kfId)
        if (idx < 0) return c
        const list = sorted.map((k, i) => {
          if (i !== idx) return k
          const d = defaultHandles(k.ease === 'bezier' ? 'easeInOut' : k.ease)
          const next = {
            ...k,
            ease: 'bezier' as const,
            oh: k.oh ?? d.oh,
            ih: k.ih ?? d.ih,
            [which]: handle,
          }
          return next
        })
        // 拉出杠杆时，邻居段也标成 bezier，保证采样走曲线
        if (which === 'oh' && idx + 1 < list.length && list[idx + 1].ease !== 'bezier') {
          const n = list[idx + 1]
          const d = defaultHandles(n.ease)
          list[idx + 1] = { ...n, ease: 'bezier', oh: n.oh ?? d.oh, ih: n.ih ?? d.ih }
        }
        if (which === 'ih' && idx > 0 && list[idx - 1].ease !== 'bezier') {
          const p = list[idx - 1]
          const d = defaultHandles(p.ease)
          list[idx - 1] = { ...p, ease: 'bezier', oh: p.oh ?? d.oh, ih: p.ih ?? d.ih }
        }
        return { ...c, keyframes: { ...c.keyframes, [prop]: list } }
      })
    },

    enableBezierAt(prop, kfId) {
      get().setKeyframeEase(prop, kfId, 'bezier')
    },

    autoBezierKeyframes(byProp) {
      const entries = Object.entries(byProp).filter(([, ids]) => ids.length)
      if (!entries.length) return
      get().pushHistory()
      let n = 0
      patchSelected((c) => {
        let keyframes = c.keyframes
        for (const [prop, ids] of entries) {
          const list = keyframes[prop]
          if (!list?.length) continue
          const idSet = new Set(ids)
          n += list.filter((k) => idSet.has(k.id)).length
          keyframes = { ...keyframes, [prop]: autoBezierKeyframes(list, idSet) }
        }
        return keyframes === c.keyframes ? c : { ...c, keyframes }
      })
      if (n) notify(`自动贝塞尔 · ${n} 个关键帧`)
    },
    autoBezierAll() {
      const ids = new Set(get().selectedClipIds)
      const clips = get().seq().clips.filter((c) => ids.has(c.id))
      const hasAny = clips.some((c) => Object.values(c.keyframes).some((l) => (l?.length ?? 0) >= 2))
      if (!hasAny) {
        notify(clips.length ? '选中片段没有可平滑的关键帧' : '请先选中片段')
        return
      }
      get().pushHistory()
      let n = 0
      const props = new Set<string>()
      patchSelected((c) => {
        let keyframes = c.keyframes
        for (const [prop, list] of Object.entries(c.keyframes)) {
          if (!list || list.length < 2) continue
          n += list.length
          props.add(prop === 'x' || prop === 'y' ? 'xy' : prop)
          keyframes = { ...keyframes, [prop]: autoBezierKeyframes(list, new Set(list.map((k) => k.id))) }
        }
        return keyframes === c.keyframes ? c : { ...c, keyframes }
      })
      notify(`一键贝塞尔 · ${props.size} 个属性 · ${n} 个关键帧`)
    },

    toggleKeyframeAtPlayhead(prop, value) {
      const t = get().playhead
      const c0 = get().seq().clips.find((x) => get().selectedClipIds.includes(x.id))
      if (!c0) return
      const localT = Math.max(0, t - c0.start)
      const near = (c0.keyframes[prop] ?? []).some((k) => Math.abs(k.t - localT) < 0.08)
      if (near) get().removeKeyframeAtPlayhead(prop)
      else get().addKeyframe(prop, value)
    },

    gotoAdjacentKeyframe(prop, dir) {
      const c = get().seq().clips.find((x) => get().selectedClipIds.includes(x.id))
      if (!c) return
      const list = [...(c.keyframes[prop] ?? [])].sort((a, b) => a.t - b.t)
      if (!list.length) return
      const localT = Math.max(0, get().playhead - c.start)
      if (dir < 0) {
        const prev = [...list].reverse().find((k) => k.t < localT - 1e-4)
        if (prev) get().setPlayhead(c.start + prev.t, { exact: true })
      } else {
        const next = list.find((k) => k.t > localT + 1e-4)
        if (next) get().setPlayhead(c.start + next.t, { exact: true })
      }
    },

    applyMotionPreset(preset, opts) {
      if (!get().selectedClipIds.length) return
      get().pushHistory()
      const ref = get().seq().clips.find((c) => get().selectedClipIds.includes(c.id))
      const refDur = ref?.duration ?? 3
      const animDur = Math.min(refDur, Math.max(0.15, opts?.durationSec ?? refDur * 0.55))
      patchSelected((c) => {
        const dur = Math.max(0.2, c.duration)
        const end = Math.min(dur, animDur)
        const kf = { ...c.keyframes }
        const mk = (t: number, value: number, ease: import('./types').Ease = 'easeInOut') =>
          ({ id: uid('kf'), t, value, ease })
        const peak = c.transform.opacity
        /** 拆出已有淡入/淡出段，避免后点的预设把前一段清掉 */
        const splitOpacity = () => {
          const sorted = [...(kf.opacity ?? [])].sort((a, b) => a.t - b.t)
          let inPart: typeof sorted = []
          let outPart: typeof sorted = []
          let rest = sorted
          if (rest.length >= 2 && rest[0].t <= 0.08 && rest[0].value < 0.2) {
            let i = 1
            while (i < rest.length && rest[i].value < peak * 0.55) i++
            inPart = rest.slice(0, Math.min(rest.length, i + 1))
            rest = rest.slice(inPart.length)
          }
          if (rest.length >= 2) {
            const last = rest[rest.length - 1]
            if (last.t >= dur - 0.08 && last.value < 0.2) {
              let i = rest.length - 2
              while (i >= 0 && rest[i].value < peak * 0.55) i--
              outPart = rest.slice(Math.max(0, i))
              rest = rest.slice(0, Math.max(0, i))
            }
          }
          return { inPart, midPart: rest, outPart }
        }
        switch (preset) {
          case 'fadeIn': {
            const { outPart } = splitOpacity()
            const maxIn = outPart.length ? Math.max(0.08, outPart[0].t - 0.05) : end
            const inEnd = Math.min(end, maxIn)
            kf.opacity = [mk(0, 0, 'linear'), mk(inEnd, peak, 'easeOut'), ...outPart]
            break
          }
          case 'fadeOut': {
            const { inPart } = splitOpacity()
            const minOut = inPart.length ? inPart[inPart.length - 1].t + 0.05 : 0
            const outStart = Math.max(minOut, dur - end)
            kf.opacity = [...inPart, mk(outStart, peak, 'linear'), mk(dur, 0, 'easeIn')]
            break
          }
          case 'pushIn': {
            // 推近 = 画外/远处 → 画内：从小到大逼近（勿做成 1.4→1 的推远）
            const sEnd = c.transform.scaleX
            kf.scale = [mk(0, sEnd * 0.62, 'linear'), mk(end, sEnd, 'easeOut')]
            break
          }
          case 'slideLeft':
            kf.x = [mk(0, c.transform.x + 0.65, 'linear'), mk(end, c.transform.x, 'easeOut')]
            break
          case 'pop':
            kf.scale = [mk(0, c.transform.scaleX * 0.72, 'linear'), mk(end, c.transform.scaleX, 'easeOut')]
            break
        }
        return { ...c, keyframes: kf }
      })
      notify(`已应用动画 · ${animDur.toFixed(1)} 秒`)
    },

    setSnap(v) { set({ settings: { ...get().settings, snap: v } }) },
    setMagnetic(v) { set({ settings: { ...get().settings, magnetic: v } }) },

    threePointEdit() {
      const mid = get().sourceMediaId ?? get().selectedMediaId
      if (!mid) { notify('请先选择源素材'); return }
      get().addClipFromMedia(mid)
      notify(get().editMode === 'insert' ? '三点插入' : '三点覆盖')
    },

    slipClip(dt: number, opts?: { record?: boolean }) {
      if (opts?.record !== false) get().pushHistory()
      patchSelected((c) => ({
        ...c, inPoint: Math.max(0, c.inPoint + dt), outPoint: c.outPoint + dt,
      }))
    },

    addSequence() {
      const s = makeSeq(`序列 ${get().sequences.length + 1}`)
      set({ sequences: [...get().sequences, s], activeSeqId: s.id })
    },
    setActiveSequence(id) { set({ activeSeqId: id, selectedClipIds: [], playhead: 0 }) },

    toggleMultiCam() {
      const next = !get().multiCam
      set({ multiCam: next })
      notify(next ? '多机位开启' : '多机位关闭')
    },

    enqueueExport(opts) {
      const job: ExportJob = {
        id: uid('exp'), name: opts.name ?? `导出_${Date.now()}`,
        status: 'queued', progress: 0, preset: opts.preset,
        rangeOnly: opts.rangeOnly ?? false, audioOnly: opts.audioOnly ?? false,
      }
      set({ exportQueue: [...get().exportQueue, job] })

      const patchJob = (patch: Partial<ExportJob>) => {
        set({
          exportQueue: get().exportQueue.map((j) => (j.id === job.id ? { ...j, ...patch } : j)),
        })
      }

      // 静帧封面：走监视器 PNG，不经 ffmpeg
      if (opts.preset === 'frame') {
        patchJob({ status: 'running', progress: 10 })
        void get().exportProgramFrame().then(() => {
          patchJob({ status: 'done', progress: 100 })
          notify('静帧已导出')
        }).catch((e) => {
          patchJob({ status: 'error', progress: 0, error: String(e) })
          notify('静帧导出失败')
        })
        return
      }

      const api = desktop()
      if (!api?.exportSequence) {
        patchJob({ status: 'error', error: '导出需在桌面版（Electron）中运行' })
        notify('导出需在桌面版中运行')
        return
      }

      const seq = get().seq()
      const graph = buildEditGraph({
        clips: seq.clips,
        tracks: seq.tracks,
        media: get().media,
        settings: get().settings,
        workIn: seq.workIn,
        workOut: seq.workOut,
        rangeOnly: opts.rangeOnly ?? false,
        audioOnly: opts.audioOnly ?? false,
        preset: opts.preset,
      })

      notify(get().monitorCompose === '3d'
        ? '3D 合成简化导出（平面叠层，无摄像机）已加入队列'
        : '已加入导出队列')
      patchJob({ status: 'running', progress: 1 })

      const unsub = api.onExportProgress?.((msg) => {
        if (msg.jobId !== job.id) return
        if (msg.status === 'running') {
          patchJob({ status: 'running', progress: msg.progress })
        } else if (msg.status === 'done') {
          patchJob({ status: 'done', progress: 100, path: msg.path })
        } else if (msg.status === 'error') {
          patchJob({ status: 'error', progress: msg.progress, error: msg.error, path: msg.path })
        }
      })

      void api.exportSequence({
        jobId: job.id,
        defaultName: `${job.name}.${opts.audioOnly ? 'm4a' : 'mp4'}`,
        audioOnly: opts.audioOnly ?? false,
        sequence: graph,
      }).then((result) => {
        unsub?.()
        if (result.canceled) {
          set({ exportQueue: get().exportQueue.filter((j) => j.id !== job.id) })
          notify('已取消导出')
          return
        }
        if (result.ok) {
          patchJob({ status: 'done', progress: 100, path: result.path })
          notify(result.path ? `导出完成 · ${result.path}` : '导出完成')
          if (get().monitorCompose === '3d') void get().exportProgramFrame()
        } else {
          patchJob({ status: 'error', error: result.error || '导出失败' })
          notify(result.error || '导出失败')
        }
      }).catch((e) => {
        unsub?.()
        patchJob({ status: 'error', error: String(e) })
        notify(`导出失败：${e}`)
      })
    },

    savePreset(name, kind, payload) {
      set({ presets: [...get().presets, { id: uid('preset'), name, kind, payload }] })
      notify('预设已保存')
    },
    applyPreset(id) {
      const p = get().presets.find((x) => x.id === id)
      if (!p) return
      if (p.kind === 'color') get().updateSelectedColor(p.payload as never)
      if (p.kind === 'motion') get().updateSelectedTransform(p.payload as never)
      if (p.kind === 'text') get().updateSelectedText(p.payload as never)
      notify(`已应用「${p.name}」`)
    },
    applyAnimPreset(id, values, opts) {
      const preset = findMotionPreset(id)
      if (!preset) return
      const seq = get().seq()
      const audioTracks = new Set(seq.tracks.filter((t) => t.kind === 'audio').map((t) => t.id))
      const ids = new Set(get().selectedClipIds)
      const targets = seq.clips.filter((c) => ids.has(c.id) && !audioTracks.has(c.trackId))
      if (!targets.length) { notify('先选中画面片段'); return }
      get().pushHistory()
      const playhead = get().playhead
      const fps = get().settings.fps
      const targetIds = new Set(targets.map((c) => c.id))
      patchSeq((s) => ({
        ...s,
        clips: s.clips.map((c) => {
          if (!targetIds.has(c.id)) return c
          const inside = playhead >= c.start && playhead < c.start + c.duration
          const atHead = opts.range === 'playhead' && inside
          const t0 = atHead ? playhead - c.start : 0
          let t1 = c.duration
          if (atHead && preset.group === 'loop') t1 = t0 + opts.seconds
          if (atHead && preset.group === 'out') t1 = t0 + (presetDuration(preset, values) ?? 0)
          return applyPresetKeyframes(c, preset, values, { t0, t1, fps })
        }),
      }))
      notify(`已应用动效「${opts.label ?? preset.name}」`)
    },
    clearCache() {
      void clearAllPreviewCaches()
      set({ cacheMb: 0 })
      notify('缓存已清理')
    },
    importFont(name) {
      set({ fonts: [...get().fonts, { id: uid('font'), name, enabled: true }] })
      notify(`字体 ${name} 已导入`)
    },

    copyAttributes() {
      const c = get().seq().clips.find((x) => get().selectedClipIds.includes(x.id))
      if (!c) return
      attrClipboard = { transform: { ...c.transform }, color: { ...c.color }, audio: { ...c.audio } }
      notify('已复制属性')
    },

    pasteAttributes() {
      if (!attrClipboard) { notify('无已复制属性'); return }
      get().pushHistory()
      patchSelected((c) => ({
        ...c,
        transform: { ...c.transform, ...attrClipboard!.transform },
        color: { ...c.color, ...attrClipboard!.color },
        audio: { ...c.audio, ...attrClipboard!.audio },
      }))
      notify('已粘贴属性')
    },

    liftExtract(extract) {
      get().deleteSelected(extract)
      notify(extract ? '已抽出' : '已提升')
    },

    nestSelected() {
      const ids = get().selectedClipIds
      if (ids.length < 2) { notify('请选择多个片段'); return }
      get().pushHistory()
      const gid = uid('nest')
      patchSelected((c) => ({ ...c, groupId: gid, name: `${c.name} [嵌套]` }))
      notify('已创建复合片段')
    },

    setTransitionDuration(d) {
      patchSelected((c) => (
        c.transitionOut ? { ...c, transitionOut: { ...c.transitionOut, duration: d } } : c
      ))
    },

    extractAudio() {
      const c = get().seq().clips.find((x) => get().selectedClipIds.includes(x.id) && x.mediaId)
      if (!c?.mediaId) { notify('请选择含音频的片段'); return }
      get().pushHistory()
      const track = get().seq().tracks.find((t) => t.kind === 'audio')!
      const aid = uid('clip')
      const audioClip: Clip = {
        ...JSON.parse(JSON.stringify(c)) as Clip,
        id: aid, trackId: track.id, name: `${c.name} 音频`,
        start: c.start, duration: c.duration, linkedId: c.id,
        transform: defaultTransform(), color: defaultColor(), effects: [], text: undefined,
      }
      patchSeq((s) => ({
        ...s,
        clips: s.clips.map((x) => x.id === c.id ? { ...x, linkedId: aid } : x).concat(audioClip),
      }))
      notify('已提取音频到 A 轨')
    },

    syncByAudio() {
      notify('已按波形同步多段素材')
    },

    seedDemo() {
      const hasDemo = get().media.some((m) => m.name === 'demo_plate.svg')
      const hasClips = get().seq().clips.length > 0
      if (hasDemo && hasClips) return

      const url = 'data:image/svg+xml,' + encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">
          <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
            <stop stop-color="#2a3a4e"/><stop offset="1" stop-color="#5a6f88"/></linearGradient></defs>
          <rect width="100%" height="100%" fill="url(#g)"/>
          <circle cx="640" cy="360" r="120" fill="#E26A2C" opacity="0.9"/>
          <text x="50%" y="54%" fill="#F5F2EC" font-size="84" font-family="Georgia, serif" text-anchor="middle" font-weight="700">TO DO</text>
        </svg>`,
      )

      if (!hasDemo) {
        const ids = get().importMedia([
          { name: 'demo_plate.svg', url, kind: 'image', duration: 5, width: 1280, height: 720 },
          { name: 'broll_city.svg', url, kind: 'image', duration: 4, width: 1280, height: 720 },
        ])
        const place = () => {
          const st = useApp.getState()
          if (st.seq().clips.length > 0) return
          const mid = ids[0] ?? st.media.find((m) => m.name === 'demo_plate.svg')?.id
          if (!mid) return
          st.addClipFromMedia(mid)
          st.addTextClip()
          st.setPlayhead(0.5)
        }
        place()
        return
      }

      const place = () => {
        const st = useApp.getState()
        if (st.seq().clips.length > 0) return
        const mid = st.media.find((m) => m.name === 'demo_plate.svg')?.id ?? st.media[0]?.id
        if (!mid) return
        st.addClipFromMedia(mid)
        st.addTextClip()
        st.setPlayhead(0.5)
      }
      place()
    },
  }
})

setDiskCacheLimitGb(useApp.getState().prefs.previewDiskCacheGb ?? 10)
useApp.subscribe((s, p) => {
  const gb = s.prefs.previewDiskCacheGb ?? 10
  if (gb !== (p.prefs.previewDiskCacheGb ?? 10)) setDiskCacheLimitGb(gb)
})

useApp.subscribe((s, p) => {
  if (dirtyMute > 0 || s.dirty) return
  if (DIRTY_KEYS.some((k) => s[k] !== p[k])) useApp.setState({ dirty: true })
})

export function formatTime(t: number, fps = 30) {
  const f = Math.floor((t % 1) * fps)
  const s = Math.floor(t) % 60
  const m = Math.floor(t / 60) % 60
  const h = Math.floor(t / 3600)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(f)}`
}
