import { appendGroupSlot, useApp } from '../store'
import type { ClipMeta } from '../types'

type ClipSource = NonNullable<ClipMeta['source']>
import { aiFetch, aiUrl } from './aiFetch'
import { subtitleClipStyle, type SkillOutput, type SkillParams, type TtsOutput } from './aiSkills'
import { isNarratedJob, syncNarratedJob, type NarratedJob } from './narratedTimeline'
import { isStoreAuthority } from './storeSync'
import { narrationJobId } from '../../shared/ttsNarration.mjs'

export type ImportableAiJob = {
  id: string
  kind: string
  params: {
    size?: string
    duration?: number
    autoTimeline?: boolean
    anchorClipId?: string | null
    width?: number | null
    height?: number | null
    purpose?: 'texture'
    skill?: { name: string; pipeline?: string } | null
    request?: { params: SkillParams } | null
    output?: object | null
  }
  resultName?: string | null
  resultUrl?: string | null
  resultKind?: 'image' | 'video' | 'audio' | null
  duration?: number | null
}

const KIND_LABEL: Record<string, string> = { anim: '动画', skill: '黑板手绘', video: '视频', image: '图片' }

/** 进程内去重；跨窗口去重靠服务端 ack（只有第一个 ack 的窗口入库） */
const claimed = new Set<string>()

export function shouldImport(j: ImportableAiJob & { status: string }) {
  return j.status === 'done' && !!j.resultUrl && j.params.purpose !== 'texture' && !claimed.has(j.id)
}

type ImportItem = Parameters<ReturnType<typeof useApp.getState>['importMedia']>[0][number]

/** 同一个 AI 产物：地址相同，或它已被复制进项目（aiUrl 记着原路径） */
export function isSameAiMedia(m: { url: string; aiUrl?: string }, url: string) {
  return m.url === url || (!!m.aiUrl && url.endsWith(m.aiUrl))
}

function addToAiFolder(item: ImportItem) {
  const hit = useApp.getState().media.find((m) => isSameAiMedia(m, item.url))
  if (hit) return hit.id
  useApp.getState().importMedia([item])
  const st = useApp.getState()
  const added = st.media[st.media.length - 1]
  if (!added) return null
  useApp.setState({ media: st.media.map((m) => (m.id === added.id ? { ...m, folderId: 'f_ai' } : m)) })
  return added.id
}

function ttsOutput(j: ImportableAiJob): TtsOutput | null {
  const out = j.params.output as Partial<TtsOutput> | null | undefined
  return out?.narration && out.audio ? (out as TtsOutput) : null
}

function subtitleOutput(j: ImportableAiJob): SkillOutput | null {
  const out = j.params.output as SkillOutput | null | undefined
  return out?.source && out.subtitles?.cues.length ? out : null
}

function ensureVoiceMedia(j: ImportableAiJob, out: TtsOutput) {
  return addToAiFolder({ name: `${j.params.skill?.name ?? '配音'}_${j.id}.wav`, url: aiUrl(out.audio), kind: 'audio', duration: out.duration })
}

/** 配音放到播放头处；那里被占着就接在音频轨最后一段后面 */
export function placeTtsVoice(j: ImportableAiJob): boolean {
  const out = ttsOutput(j)
  const mediaId = out && ensureVoiceMedia(j, out)
  if (!mediaId) return false
  placeAppended(mediaId, 'audio', out.duration, { type: 'ai', jobId: j.id, kind: j.kind })
  return true
}

/** 单个产物也按整组接：视频连同拆出来的链接音频一起算，画面和声音从同一时刻开始 */
function placeAppended(mediaId: string, kind: 'audio' | 'video' | 'image', duration: number, source: ClipSource) {
  const st = useApp.getState()
  const lanes = kind === 'audio' ? { audio: 1 } : kind === 'video' ? { video: 1, audio: 1 } : { video: 1 }
  const slot = appendGroupSlot(st.seq(), lanes, st.playhead, duration)
  const trackId = (kind === 'audio' ? slot.tracks.audio : slot.tracks.video)[0]
  st.addClipFromMedia(mediaId, trackId, slot.start, { preferFreeTrack: true, source })
}

/**
 * 技能任务产物的 URL → 任务 id：配音 `<jobId>_voice.wav`、成片 `<jobId>.webm/.mp4`（黑板手绘带旁白时配音从成片 0 秒开始）。
 * 只说明「可能带配音」，有没有文案和时间戳要看任务的 output.narration。
 */
export function narrationJobIdOfUrl(url: string | undefined) {
  return narrationJobId(url)
}

/**
 * 字幕进字幕轨：对齐时间轴上那段配音（按它的起点、入点、速度换算），并链接到它。
 * 优先对齐发起烧录的那个片段（anchorClipId），其次选中的、再次第一段同源配音；都没有时从播放头开始。
 * @returns 'aligned' 已对齐配音；'playhead' 从播放头放；null 没有可放的字幕
 */
export function placeSubtitles(j: ImportableAiJob): 'aligned' | 'playhead' | null {
  const out = subtitleOutput(j)
  if (!out?.source || !out.subtitles) return null
  const st = useApp.getState()
  const audioUrl = aiUrl(out.source.audio)
  const sourceJob = out.source.jobId
  const mediaIds = new Set(st.media.filter((m) => isSameAiMedia(m, audioUrl) || narrationJobIdOfUrl(m.url) === sourceJob).map((m) => m.id))
  const seq = st.seq()
  // 只对齐音频轨上的片段（成片的视频片段和它的音频片段同源，取音频那段）
  const voiceClips = seq.clips.filter((c) => c.mediaId && mediaIds.has(c.mediaId)
    && seq.tracks.find((t) => t.id === c.trackId)?.kind === 'audio')
  // 烧录时点名的片段直接认（本机导入素材的 url 和服务端记下的对不上）
  const anchor = seq.clips.find((c) => c.id === j.params.anchorClipId
    && seq.tracks.find((t) => t.id === c.trackId)?.kind === 'audio')
  const clip = anchor
    ?? voiceClips.find((c) => st.selectedClipIds.includes(c.id))
    ?? voiceClips[0]

  let cues = out.subtitles.cues
  if (clip) {
    const speed = clip.speed || 1
    const toTimeline = (t: number) => clip.start + (t - clip.inPoint) / speed
    cues = cues
      .filter((q) => q.end > clip.inPoint && q.start < clip.outPoint)
      .map((q) => ({
        text: q.text,
        start: toTimeline(Math.max(q.start, clip.inPoint)),
        end: toTimeline(Math.min(q.end, clip.outPoint)),
      }))
  } else {
    cues = cues.map((q) => ({ text: q.text, start: st.playhead + q.start, end: st.playhead + q.end }))
  }
  if (!cues.length) return null
  const style = subtitleClipStyle({ ...out.params, ...j.params.request?.params }, out.width, out.height)
  st.addSubtitleCues({
    cues,
    linkTo: clip?.id,
    text: style.text,
    transform: style.transform,
    source: { type: 'ai', jobId: j.id, kind: j.kind },
  })
  return clip ? 'aligned' : 'playhead'
}

/**
 * 完成的 AI 任务 → 媒体库（AI 文件夹），按需自动入轨。
 * 配音：wav 入库，自动入轨时放到播放头；字幕：透明 WebM 入库备用，自动入轨时字幕条目对齐配音。
 * @returns 新媒体 id；已被其它窗口入库时返回 null
 */
export async function importAiJob(j: ImportableAiJob): Promise<string | null> {
  // 口播类的片段早已边生成边入轨，只由主窗收尾
  const narrated = isNarratedJob(j)
  if (narrated && !isStoreAuthority()) return null
  claimed.add(j.id)
  try {
    const id = await importClaimed(j, narrated)
    // 服务端已记成「已入库」，本地这份必须立刻落盘，否则这时刷新就再也拿不回来
    if (isStoreAuthority()) await useApp.getState().flushProject()
    return id
  } catch (e) {
    claimed.delete(j.id)
    throw e
  }
}

async function importClaimed(j: ImportableAiJob, narrated: boolean): Promise<string | null> {
  const ack = await aiFetch(`/api/ai-jobs/${j.id}/ack`, { method: 'POST' })
  const ackData = await ack.json()
  if (!ackData.ok) return null
  const label = j.params.skill?.name ?? KIND_LABEL[j.kind]

  if (narrated) {
    syncNarratedJob(j as unknown as NarratedJob)
    useApp.getState().setToast(`${label ?? '黑板手绘'}已全部生成${j.params.autoTimeline ? '并入轨' : '，素材在媒体库'}`)
    return useApp.getState().media.find((m) => isSameAiMedia(m, aiUrl(j.resultUrl!)))?.id ?? null
  }

  const tts = ttsOutput(j)
  if (tts) {
    const id = ensureVoiceMedia(j, tts)
    if (id && j.params.autoTimeline) placeTtsVoice(j)
    useApp.getState().setToast(`${label ?? '配音'}已入库`)
    return id
  }

  const kind = (j.resultKind || j.kind) === 'image' ? 'image' : 'video'
  const [w, h] = String(j.params.size || '3840x2160').split('x').map(Number)
  const st0 = useApp.getState()
  const addedId = addToAiFolder({
    name: j.resultName || `AI_${j.id}.${kind === 'video' ? 'mp4' : 'png'}`,
    url: aiUrl(j.resultUrl!),
    kind,
    duration: kind === 'video' ? (j.duration || j.params.duration || 5) : st0.settings.stillDuration,
    width: j.params.width || w || st0.settings.width,
    height: j.params.height || h || st0.settings.height,
    ...(kind === 'video' ? { alpha: !!(j.params.output as { alpha?: boolean } | null | undefined)?.alpha } : {}),
  })
  if (!addedId) return null
  if (subtitleOutput(j)) {
    const placed = j.params.autoTimeline ? placeSubtitles(j) : null
    useApp.getState().setToast(placed === 'aligned' ? '字幕已对齐配音入轨' : `${label ?? '字幕'}已入库`)
    return addedId
  }
  if (j.params.autoTimeline) {
    const m = useApp.getState().media.find((x) => x.id === addedId)
    const dur = kind === 'image' ? st0.settings.stillDuration : (m?.duration || j.duration || j.params.duration || 5)
    placeAppended(addedId, kind, dur, { type: 'ai', jobId: j.id, kind: j.kind })
  }
  useApp.getState().setToast(`AI ${label ?? (kind === 'video' ? '视频' : '图片')}已入库`)
  return addedId
}
