import { useApp } from '../store'
import { aiFetch } from './aiFetch'
import { importAiJob, narrationJobIdOfUrl, shouldImport, type ImportableAiJob } from './aiJobImport'
import { SUBTITLE_SKILL_ID, defaultSkillParams, enqueueSkill, fetchSkills, type SkillPack, type SkillParams, type SubtitleSourceMedia } from './aiSkills'
import type { Clip, MediaItem } from '../types'
import { availableNarration } from '../../shared/ttsNarration.mjs'
import {
  clearSubtitleBurnPending,
  clearSubtitleBurnPendingByJob,
  markSubtitleBurnPending,
} from './subtitleBurnPending'
import type { ChapterBarRequest } from './chapterBar'

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
    const jobId = narrationJobIdOfUrl(m?.aiUrl) ?? narrationJobIdOfUrl(m?.url)
      ?? narrationJobIdOfUrl(m?.path) ?? c.meta?.source?.jobId ?? null
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

export function saveSubtitleStyle(params: SkillParams, chapter?: { on: boolean; titles: string }) {
  try {
    const prev = JSON.parse(localStorage.getItem(STYLE_STORE) || '{}') as Record<string, unknown>
    const next: Record<string, unknown> = { ...prev, ...Object.fromEntries(STYLE_KEYS.map((k) => [k, params[k]])) }
    if (chapter) {
      next.chapterBar = chapter.on ? 'on' : 'off'
      next.chapterTitles = chapter.titles
    }
    localStorage.setItem(STYLE_STORE, JSON.stringify(next))
  } catch { /* */ }
}

/** 上次是否打开进度条、写过的章名。没存过则关。 */
export function loadChapterDraft(): { on: boolean; titles: string } {
  try {
    const saved = JSON.parse(localStorage.getItem(STYLE_STORE) || '{}') as { chapterBar?: string; chapterTitles?: string }
    return { on: saved.chapterBar === 'on', titles: typeof saved.chapterTitles === 'string' ? saved.chapterTitles : '' }
  } catch {
    return { on: false, titles: '' }
  }
}

/** 完整任务或已完成的配音阶段；确实没有时间戳才返回 null，网络错误不降级成识别。 */
export async function narrationText(jobId: string): Promise<string | null> {
  const r = await aiFetch(`/api/ai-jobs/${jobId}`)
  // A temporary network/server failure is not evidence that TTS timing is absent.
  if (r.status === 404) return null
  if (!r.ok) throw new Error('读取 TTS 时间戳失败，请稍后重试')
  const data = await r.json()
  if (!data.ok) throw new Error(data.error || '读取 TTS 时间戳失败，请稍后重试')
  return availableNarration(data.job)?.text ?? null
}

const watching = new Set<string>()

/** 等字幕任务完成后入库并按 anchorClipId 对齐入轨；面板开着时它自己的轮询也可能先入库，由 importAiJob 去重 */
function watch(jobId: string, clipId: string) {
  markSubtitleBurnPending(clipId, jobId)
  if (watching.has(jobId)) return
  watching.add(jobId)
  const finish = () => {
    watching.delete(jobId)
    clearSubtitleBurnPending(clipId)
    clearSubtitleBurnPendingByJob(jobId)
  }
  const tick = async () => {
    try {
      const r = await aiFetch(`/api/ai-jobs/${jobId}`)
      const data = await r.json()
      const job = data.job as (ImportableAiJob & { status: string; error?: string | null }) | undefined
      if (!data.ok || !job) { finish(); return }
      if (job.status === 'error') {
        finish()
        useApp.getState().setToast(`字幕失败：${job.error || '未知错误'}`)
        return
      }
      if (job.status === 'done') {
        try {
          if (shouldImport(job)) await importAiJob(job)
        } catch (e) {
          useApp.getState().setToast(`字幕入轨失败：${e instanceof Error ? e.message : String(e)}`)
        } finally {
          finish()
        }
        return
      }
      if (job.status === 'imported') { finish(); return }
    } catch { /* 网络抖动，下一轮再查 */ }
    window.setTimeout(() => void tick(), 1200)
  }
  void tick()
}

/** 逐段烧录字幕（每段一个任务，完成后对齐并链接到该片段）；有 jobId 用配音文案，否则用 media 语音识别；入队失败时抛错。进度条只挂在第一段上，覆盖所选音频的整段时间。 */
export async function burnSubtitles(
  targets: { clipId: string; jobId?: string; media?: SubtitleSourceMedia }[],
  params: SkillParams,
  chapters?: ChapterBarRequest | null,
) {
  if (!targets.length) throw new Error('选中的音频都读不到文件，烧不了字幕')
  saveSubtitleStyle(params)
  // 先打上「烧录中」标记，关弹窗后时间轴立刻能看到动效
  for (const t of targets) markSubtitleBurnPending(t.clipId, `pending:${t.clipId}`)
  try {
    const jobs = await Promise.all(targets.map(({ clipId, jobId, media }, i) => enqueueSkill({
      skillId: SUBTITLE_SKILL_ID, prompt: '', params, autoTimeline: true, anchorClipId: clipId,
      ...(jobId ? { sourceJobId: jobId } : {}), ...(media ? { sourceMedia: media } : {}),
      ...(i === 0 && chapters ? { chapters } : {}),
    })))
    jobs.forEach((j, i) => {
      const clipId = targets[i]?.clipId
      if (clipId) watch(j.id, clipId)
    })
    useApp.getState().setToast(`正在烧录 ${jobs.length} 段字幕${chapters ? '和顶部进度条' : ''} · 看时间轴音频条扫光`)
  } catch (e) {
    for (const t of targets) clearSubtitleBurnPending(t.clipId)
    throw e
  }
}
