import { useApp } from '../store'
import { aiFetch } from './aiFetch'
import { importAiJob, narrationJobIdOfUrl, shouldImport, type ImportableAiJob } from './aiJobImport'
import { SUBTITLE_SKILL_ID, defaultSkillParams, enqueueSkill, fetchSkills, type SkillPack, type SkillParams, type SubtitleSourceMedia } from './aiSkills'
import type { Clip, MediaItem } from '../types'

/** 服务端读得到文件的素材：AI 生成的（按 url 找）或带本机路径的；浏览器里拖进来的 blob 素材读不到 */
function asrMedia(m: MediaItem | undefined): SubtitleSourceMedia | null {
  if (!m) return null
  if (m.path) return { url: m.url, path: m.path, name: m.name }
  if (/\/ai-generated\/[^/?#]+/.test(m.url)) return { url: m.url, name: m.name }
  return null
}

export interface BurnTarget {
  clip: Clip
  /** 可能带配音文案的技能任务；没有文案时用 media 走语音识别 */
  jobId: string | null
  media: SubtitleSourceMedia | null
}

/** 选中片段里的音频片段，以及其中烧得了字幕的那部分（技能任务的配音，或服务端读得到文件、可以语音识别的素材） */
export function subtitleTargets(clipIds: string[]) {
  const st = useApp.getState()
  const seq = st.seq()
  const audio = seq.clips.filter((c) => clipIds.includes(c.id) && seq.tracks.find((t) => t.id === c.trackId)?.kind === 'audio')
  const burnable = audio.flatMap((c): BurnTarget[] => {
    const m = st.media.find((x) => x.id === c.mediaId)
    const jobId = narrationJobIdOfUrl(m?.url)
    const media = asrMedia(m)
    return jobId || media ? [{ clip: c, jobId, media }] : []
  })
  return { audio, burnable }
}

const STYLE_STORE = 'todo.subtitle.style'
const STYLE_KEYS = ['font', 'fontPx', 'bottomPct', 'keywords', 'maxChars']

let packCache: Promise<SkillPack> | null = null

export function subtitlePack(): Promise<SkillPack> {
  packCache ??= fetchSkills().then((list) => {
    const pack = list.find((s) => s.id === SUBTITLE_SKILL_ID)
    if (!pack) throw new Error('没有找到字幕技能包')
    return pack
  }).catch((e) => { packCache = null; throw e })
  return packCache
}

/** 字幕参数：包默认值 + 上次选的样式；画幅取当前工程，不在选项里时取同比例的一档 */
export function initialSubtitleParams(pack: SkillPack): SkillParams {
  const p = defaultSkillParams(pack)
  try {
    const saved = JSON.parse(localStorage.getItem(STYLE_STORE) || '{}') as SkillParams
    for (const def of pack.params) {
      const v = saved[def.id]
      if (!STYLE_KEYS.includes(def.id) || v == null) continue
      if (def.type === 'select' ? def.options.some((o) => o.value === v) : def.type === 'number' ? typeof v === 'number' && v >= def.min && v <= def.max : true) p[def.id] = v
    }
  } catch { /* */ }
  const { width, height } = useApp.getState().settings
  const size = pack.params.find((x) => x.id === 'size')
  if (size?.type === 'select') {
    const exact = size.options.find((o) => o.value === `${width}x${height}`)
    const ratio = size.options.find((o) => {
      const [w, h] = o.value.split('x').map(Number)
      return Math.abs(w / h - width / height) < 0.01
    })
    p.size = (exact ?? ratio)?.value ?? p.size
  }
  return p
}

export function saveSubtitleStyle(params: SkillParams) {
  try { localStorage.setItem(STYLE_STORE, JSON.stringify(Object.fromEntries(STYLE_KEYS.map((k) => [k, params[k]])))) } catch { /* */ }
}

/** 任务的配音文案；任务没有配音（文案 + 逐字时间戳）或取不到时返回 null */
export async function narrationText(jobId: string): Promise<string | null> {
  try {
    const r = await aiFetch(`/api/ai-jobs/${jobId}`)
    const data = await r.json()
    const n = data.job?.params?.output?.narration
    const ok = n?.text && n.timing && ['done', 'imported'].includes(data.job?.status)
    return ok ? String(n.text) : null
  } catch {
    return null
  }
}

const watching = new Set<string>()

/** 等字幕任务完成后入库并按 anchorClipId 对齐入轨；面板开着时它自己的轮询也可能先入库，由 importAiJob 去重 */
function watch(jobId: string) {
  if (watching.has(jobId)) return
  watching.add(jobId)
  const tick = async () => {
    try {
      const r = await aiFetch(`/api/ai-jobs/${jobId}`)
      const data = await r.json()
      const job = data.job as (ImportableAiJob & { status: string; error?: string | null }) | undefined
      if (!data.ok || !job) { watching.delete(jobId); return }
      if (job.status === 'error') {
        watching.delete(jobId)
        useApp.getState().setToast(`字幕失败：${job.error || '未知错误'}`)
        return
      }
      if (job.status === 'done') {
        watching.delete(jobId)
        if (shouldImport(job)) await importAiJob(job)
        return
      }
      if (job.status === 'imported') { watching.delete(jobId); return }
    } catch { /* 网络抖动，下一轮再查 */ }
    window.setTimeout(() => void tick(), 1500)
  }
  void tick()
}

/** 逐段烧录字幕（每段一个任务，完成后对齐并链接到该片段）；有 jobId 用配音文案，否则用 media 语音识别；入队失败时抛错 */
export async function burnSubtitles(targets: { clipId: string; jobId?: string; media?: SubtitleSourceMedia }[], params: SkillParams) {
  if (!targets.length) throw new Error('选中的音频都读不到文件，烧不了字幕')
  saveSubtitleStyle(params)
  const jobs = await Promise.all(targets.map(({ clipId, jobId, media }) => enqueueSkill({
    skillId: SUBTITLE_SKILL_ID, prompt: '', params, autoTimeline: true, anchorClipId: clipId,
    ...(jobId ? { sourceJobId: jobId } : { sourceMedia: media }),
  })))
  jobs.forEach((j) => watch(j.id))
  useApp.getState().setToast(`正在烧录 ${jobs.length} 段字幕`)
}
