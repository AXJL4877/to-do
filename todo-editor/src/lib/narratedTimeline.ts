/**
 * 口播类技能（narrated 管线）的流式入轨：任务跑着的时候就按阶段产物往时间轴上放。
 *   配音一出来 → 放到播放头处（被占着就接在音频轨末尾），之后所有片段都链接它、按它的时间戳换算位置；
 *   元素优先复用这段时间空着的已有视频轨，不每个任务叠一组新轨
 *   每块黑板渲好 → 每个元素一份裁到自身框的透明素材：书写视频（起笔 → 写完）+ 定格图（写完 → 换板），
 *   放回默认排版位置，同一元素位同一条轨；技能参数要手时给书写片段开「粉笔手书写」入场动画（不占时间轴）
 * 同一产物只入轨一次：放过的记在片段上和工程里（放完立刻存盘），重启 / 刷新不会重复放，
 * 没来得及存就刷新的会重新补上，用户删掉的也不会被放回来。
 * 以后的扩展按同一个约定出阶段产物（params.partial）就能直接复用。
 */
import { appendGroupSlot, useApp, type GroupLanes } from '../store'
import type { MediaItem } from '../types'
import { aiFetch, aiUrl } from './aiFetch'
import { importAiJob, isSameAiMedia, shouldImport } from './aiJobImport'
import { elementTransform, setChalkHand } from './chalkHand'
import { isStoreAuthority } from './storeSync'

export type NarratedClipElement = {
  id: string
  label: string
  role: string
  box: number[]
  crop?: number[]
  startMs: number
  durationMs: number
  frames: number
  video: string
  hold: string
  tip?: number[][]
}

export type NarratedScene = {
  id: string
  index: number
  startMs: number
  endMs: number
  fps: number
  elements: NarratedClipElement[]
}

export type NarratedHand = { url: string; width: number; height: number; tipX: number; tipY: number }

export type NarratedStage = {
  voice?: { audio: string; timing: string; duration: number; text: string } | null
  tail?: number
  hand?: NarratedHand | null
  total?: { scenes: number; elements: number } | null
  /** 这次生成要占几条轨（整组接续用） */
  lanes?: GroupLanes | null
  scenes?: NarratedScene[]
}

export type NarratedJob = {
  id: string
  status: string
  params: {
    autoTimeline?: boolean
    size?: string
    skill?: { name?: string; pipeline?: string } | null
    request?: { params?: Record<string, unknown> } | null
    partial?: NarratedStage | null
    output?: (NarratedStage & { narration?: NarratedStage['voice']; plan?: { title?: string } }) | null
  }
}

const VOICE_LANE = 0

export const isNarratedJob = (j: { kind?: string; params?: { skill?: { pipeline?: string } | null } }) =>
  j.kind === 'skill' && j.params?.skill?.pipeline === 'narrated'

/** 运行中读 partial，完成后读清单；两者字段一致 */
export function narratedStage(j: NarratedJob): NarratedStage | null {
  const out = j.params.output
  if (out?.scenes) return { voice: out.narration ?? null, tail: out.tail, hand: out.hand ?? null, total: out.total ?? null, lanes: out.lanes ?? null, scenes: out.scenes }
  return j.params.partial ?? null
}

function loadPlaced(jobId: string) {
  return new Set<string>(useApp.getState().settings.aiPlaced?.[jobId] ?? [])
}

type JobState = { t0: number; placed: Set<string> }
const firstSeen = new Map<string, number>()

/** 每次现读：本机记录 + 工程里已有的片段（比如换机器打开工程） */
function stateOf(jobId: string, stage: NarratedStage & { voice: NonNullable<NarratedStage['voice']> }): JobState {
  if (!firstSeen.has(jobId)) {
    // 配音 + 各层元素按一整组接：它要占的轨在播放头处都空就从播放头开始，否则接在这些轨最晚的切口后面
    const st = useApp.getState()
    const lanes = stage.lanes ?? { audio: 1, video: Math.max(1, ...(stage.scenes ?? []).map((s) => s.elements.length)) }
    firstSeen.set(jobId, appendGroupSlot(st.seq(), lanes, st.playhead, stage.voice.duration + (stage.tail ?? 0)).start)
  }
  const placed = loadPlaced(jobId)
  for (const c of useApp.getState().seq().clips) {
    const src = c.meta?.source
    // 片段键形如 voice、s1/s1e1/draw，入轨按首段（配音 / 某块黑板）记
    if (src?.jobId === jobId && src.key) placed.add(src.key.split('/')[0])
  }
  return { t0: firstSeen.get(jobId)!, placed }
}

/** 记录和片段在同一份工程状态里：没来得及保存就刷新时两者一起丢，下一轮照常补放 */
function markPlaced(jobId: string, s: JobState, key: string) {
  s.placed.add(key)
  const settings = useApp.getState().settings
  useApp.setState({ settings: { ...settings, aiPlaced: { ...settings.aiPlaced, [jobId]: [...s.placed] } } })
}

function folderFor(j: NarratedJob) {
  const id = `f_ai_${j.id}`
  const st = useApp.getState()
  if (!st.folders.some((f) => f.id === id)) {
    const title = j.params.output?.plan?.title
    useApp.setState({ folders: [...st.folders, { id, name: `${j.params.skill?.name ?? 'AI'} ${title || j.id.slice(-4)}` }] })
  }
  return id
}

function ensureMedia(item: { name: string; url: string; kind: MediaItem['kind']; duration: number; width?: number; height?: number; alpha?: boolean }, folderId: string) {
  const hit = useApp.getState().media.find((m) => isSameAiMedia(m, item.url))
  if (hit) return hit.id
  return useApp.getState().importMedia([{ ...item, hasAudio: item.kind === 'audio', folderId }], { silent: true })[0] ?? null
}

/**
 * 把任务目前的阶段产物补到时间轴上（幂等）。不自动入轨的任务只把素材收进媒体库。
 */
export function syncNarratedJob(j: NarratedJob) {
  if (!isStoreAuthority() || !useApp.getState().started) return
  const stage = narratedStage(j)
  if (!stage?.voice) return
  const s = stateOf(j.id, { ...stage, voice: stage.voice })
  const placedBefore = s.placed.size
  try {
    placeStage(j, { ...stage, voice: stage.voice }, s)
  } finally {
    // 刚放上的片段马上存盘，别等 30 秒一次的自动保存
    if (s.placed.size !== placedBefore) void useApp.getState().flushProject()
  }
}

function placeStage(j: NarratedJob, stage: NarratedStage & { voice: NonNullable<NarratedStage['voice']> }, s: JobState) {
  const place = !!j.params.autoTimeline
  const [fw, fh] = String(j.params.size || '1280x720').split('x').map(Number)
  const frame = { width: fw || 1280, height: fh || 720 }
  const folderId = folderFor(j)
  const label = j.params.skill?.name ?? '黑板手绘'
  const opts = { jobId: j.id, kind: 'skill' }
  const wantHand = j.params.request?.params?.hand !== 'none'

  const voiceUrl = aiUrl(stage.voice.audio)
  const voiceMedia = ensureMedia({ name: `${label}_${j.id}_配音.wav`, url: voiceUrl, kind: 'audio', duration: stage.voice.duration }, folderId)
  const findVoice = () => useApp.getState().seq().clips.find((c) => c.meta?.source?.jobId === j.id
    && (c.meta.source.key === 'voice' || (c.mediaId === voiceMedia && c.meta.source.lane === VOICE_LANE)))
  if (!s.placed.has('voice')) {
    markPlaced(j.id, s, 'voice')
    if (voiceMedia && place && !findVoice()) {
      useApp.getState().addAiLayerClips([{ mediaId: voiceMedia, start: s.t0, duration: stage.voice.duration, lane: VOICE_LANE, source: { key: 'voice' } }], opts)
      useApp.getState().setToast(`${label}：配音已入轨，画面边生成边放上来`)
    }
  }

  // 配音被挪动 / 裁掉开头时，片段按它现在的位置换算；配音被删了就按当初放的位置
  const voice = findVoice()
  const at = (sec: number) => (voice ? voice.start + (sec - voice.inPoint) / (voice.speed || 1) : s.t0 + sec)
  const proj = { width: useApp.getState().settings.width, height: useApp.getState().settings.height }

  for (const scene of stage.scenes ?? []) {
    if (s.placed.has(scene.id)) continue
    markPlaced(j.id, s, scene.id)
    const fps = scene.fps || 30
    const projFps = Math.max(1, useApp.getState().settings.fps || fps)
    const snap = (t: number) => Math.round(t * projFps) / projFps
    const items: Parameters<ReturnType<typeof useApp.getState>['addAiLayerClips']>[0] = []
    scene.elements.forEach((e, k) => {
      // 书写片段不用最后一帧（渲染多留了 200ms 写完的画面），交界对齐到帧，定格图从同一时刻接上，不留缝
      const t0 = snap(at(e.startMs / 1000))
      const t2 = snap(at(scene.endMs / 1000))
      // 书写视频末尾多留的收尾帧不能越过本块结束：换板要硬切，最后一块要和配音同时结束
      const t1 = Math.max(t0 + 1 / projFps, Math.min(t2, snap(t0 + Math.max(1, e.frames - 1) / fps)))
      const drawSec = t1 - t0
      const holdSec = Math.max(0, t2 - t1)
      const size = e.crop ? { width: e.crop[2], height: e.crop[3] } : frame
      const name = e.label || e.id
      const video = ensureMedia({ name: `${scene.id}_${name}_书写.webm`, url: aiUrl(e.video), kind: 'video', duration: e.frames / fps, ...size, alpha: true }, folderId)
      const still = ensureMedia({ name: `${scene.id}_${name}.png`, url: aiUrl(e.hold), kind: 'image', duration: holdSec || 1, ...size }, folderId)
      if (!place) return
      const transform = e.crop ? elementTransform(e.crop, frame, proj) : undefined
      const key = `${scene.id}/${e.id}`
      const chalk = stage.hand && e.tip?.length
        ? { tip: e.tip, frame, hand: { ...stage.hand, url: aiUrl(stage.hand.url) } }
        : undefined
      if (video) items.push({ mediaId: video, start: t0, duration: drawSec, lane: k + 1, name: `${name} · 书写`, transform, source: { key: `${key}/draw`, chalk } })
      if (still && holdSec > 0.02) items.push({ mediaId: still, start: t1, duration: holdSec, lane: k + 1, name, transform, source: { key: `${key}/hold` } })
    })
    if (!items.length) continue
    const ids = useApp.getState().addAiLayerClips(items, opts)
    if (wantHand) {
      const draws = ids.filter((id, i): id is string => !!id && !!items[i].source?.chalk)
      if (draws.length) setChalkHand(draws, true, { history: false })
    }
  }
}

const TIMER_KEY = '__todoNarratedSync'
type TimerHost = { [TIMER_KEY]?: number }

/** 主窗常驻：面板关着也照样流式入轨。计时器挂在 window 上，热更新换模块时旧的会被停掉，不会两份同时放 */
export function startNarratedTimelineSync() {
  if (!isStoreAuthority()) return () => {}
  const host = window as unknown as TimerHost
  if (host[TIMER_KEY] != null) window.clearInterval(host[TIMER_KEY])
  const tick = async () => {
    if (!useApp.getState().started) return
    try {
      const r = await aiFetch('/api/ai-jobs?limit=40')
      const data = await r.json()
      if (!data.ok) return
      for (const j of data.items as (NarratedJob & { kind: string })[]) {
        if (!isNarratedJob(j)) continue
        if (j.status === 'running') syncNarratedJob(j)
        else if (shouldImport(j as never)) void importAiJob(j as never)
      }
    } catch { /* 下一轮再查 */ }
  }
  const timer = window.setInterval(() => void tick(), 2000)
  host[TIMER_KEY] = timer
  void tick()
  return () => {
    window.clearInterval(timer)
    if (host[TIMER_KEY] === timer) delete host[TIMER_KEY]
  }
}
