/**
 * 抖音发布：内置 AI 写文案 + 生竖封面（标题画进画面）。
 * 文案/封面以「本工程口播备忘录 + 项目名」为主题来源；
 * 不跟最新一次成片任务走（那次可能只是短修改）。
 */
import { aiFetch, aiUrl } from './aiFetch'
import { desktop } from './desktop'
import { getProduction } from './production'
import { readSpokenBody } from './scriptMemoDocument'
import { useApp } from '../store'

export type DouyinMeta = {
  title: string
  caption: string
  tags: string[]
}

export type PublishBrief = {
  title: string
  script: string
  /** script=工程口播；production=工程无口播时才用成片长稿兜底；project=仅项目名 */
  source: 'production' | 'script' | 'project'
  productionId?: string
  styleHint: string
}

async function readJson(res: Response) {
  const j = await res.json().catch(() => ({})) as { ok?: boolean; error?: string; [k: string]: unknown }
  if (!res.ok || j.ok === false) throw new Error(String(j.error || res.statusText || '请求失败'))
  return j
}

export const STYLE_HINT = '财经黑板粉笔风，深色黑板，粉笔白字与橙色强调，竖版封面构图'

function firstText(...vals: Array<string | null | undefined>) {
  for (const v of vals) {
    const t = String(v || '').trim()
    if (t) return t
  }
  return ''
}

/** 封面大标题：用用户正在看的表单/种子，不要被工程名盖掉 */
export function pickCoverHeadline(parts: {
  formTitle?: string
  seedTitle?: string
  briefTitle?: string
  projectName?: string
}) {
  return firstText(parts.formTitle, parts.seedTitle, parts.briefTitle, parts.projectName).slice(0, 22) || '成片'
}

export function pickCoverStyleHint(parts: {
  formHint?: string
  seedHint?: string
  briefHint?: string
}) {
  return firstText(parts.formHint, parts.seedHint, parts.briefHint) || STYLE_HINT
}

function substantial(text: string) {
  const t = text.replace(/\s+/g, '').length
  return t >= 40
}

/** 工程无口播时：在本工程成片里挑「稿子最长」的一条做兜底（不是最近更新） */
async function longestProjectProduction(ids: string[]) {
  if (!ids.length) return null
  const q = `?ids=${ids.map(encodeURIComponent).join(',')}`
  const data = await aiFetch(`/api/ai-productions${q}`).then((r) => r.json()).catch(() => null) as
    | { ok?: boolean; items?: { id: string; title: string; updatedAt: number }[] }
    | null
  const items = Array.isArray(data?.items) ? data!.items! : []
  if (!items.length) return null
  let best: { id: string; title: string; script: string; len: number } | null = null
  // 最多看 8 条，避免一次拉太多
  for (const it of items.slice(0, 8)) {
    try {
      const p = await getProduction(it.id)
      const script = String(p.script || p.segments?.map((s) => s.text).join('\n\n') || '').trim()
      const len = script.replace(/\s+/g, '').length
      if (!best || len > best.len) {
        best = { id: p.id, title: String(p.title || '').trim(), script, len }
      }
    } catch { /* skip */ }
  }
  return best && best.len > 0 ? best : null
}

/**
 * 发布用标题与文稿：
 * 1) 优先工程口播备忘录 + 项目名（主题）
 * 2) 口播太短/为空时，才用本工程「稿子最长」的成片兜底
 * 绝不默认用「最近一次」成片任务（可能只是短修改）
 */
export async function resolvePublishBrief(opts?: {
  projectName?: string
  script?: string
}): Promise<PublishBrief> {
  const st = useApp.getState()
  const projectName = (opts?.projectName ?? st.projectName ?? '').trim()
  const body = readSpokenBody(opts?.script ?? st.script ?? '', st.scriptMemo).trim()
  const pkg = st.publishSeed || null
  const titled = st.scriptWorkspace?.package?.titles?.[0] || st.scriptMemo?.publish?.titles?.[0] || ''

  if (substantial(body) || titled) {
    return {
      title: (titled || projectName || body.split(/\n+/).map((l) => l.trim()).find(Boolean) || '成片').slice(0, 22),
      script: body,
      source: 'script',
      styleHint: pkg ? [pkg.title, pkg.description].filter(Boolean).join('。') || STYLE_HINT : STYLE_HINT,
    }
  }

  try {
    const ids = Object.keys(st.settings.aiProductions ?? {})
    const best = await longestProjectProduction(ids)
    if (best && substantial(best.script)) {
      // 有工程口播碎片就拼在前面，主题仍用项目名
      const script = body && body !== best.script ? `${body}\n\n${best.script}` : best.script
      return {
        title: (projectName || best.title || '成片').slice(0, 22),
        script,
        source: body ? 'script' : 'production',
        productionId: best.id,
        styleHint: STYLE_HINT,
      }
    }
  } catch {
    /* 成片服务不可用时退回备忘录 / 项目名 */
  }

  if (body) {
    return {
      title: (titled || projectName || body.split(/\n+/).map((l) => l.trim()).find(Boolean) || '成片').slice(0, 22),
      script: body,
      source: 'script',
      styleHint: STYLE_HINT,
    }
  }

  return {
    title: projectName || '成片',
    script: '',
    source: 'project',
    styleHint: STYLE_HINT,
  }
}

/** AI 写标题 / 简介 / 标签 */
export async function fetchDouyinMeta(input: {
  projectName?: string
  script?: string
  hint?: string
}): Promise<DouyinMeta> {
  const res = await aiFetch('/api/ai-douyin-meta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const j = await readJson(res)
  const meta = j.meta as DouyinMeta
  if (!meta?.title) throw new Error('AI 未返回标题')
  return {
    title: String(meta.title),
    caption: String(meta.caption || ''),
    tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [],
  }
}

type AiJob = {
  id: string
  status: string
  resultUrl?: string | null
  error?: string | null
}

async function pollJob(id: string, onProgress?: (job: AiJob) => void, timeoutMs = 180000): Promise<AiJob> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const res = await aiFetch(`/api/ai-jobs/${encodeURIComponent(id)}`)
    const j = await readJson(res)
    const job = j.job as AiJob
    onProgress?.(job)
    if (job.status === 'done') return job
    if (job.status === 'error') throw new Error(job.error || '封面生成失败')
    await new Promise((r) => setTimeout(r, 800))
  }
  throw new Error('封面生成超时')
}

/** 把 /ai-generated/xxx.png 存成本机文件，返回 path */
export async function downloadAiImageToDisk(resultUrl: string, fileName: string): Promise<string> {
  const res = await aiFetch(resultUrl)
  if (!res.ok) throw new Error(`下载封面失败 (${res.status})`)
  const buf = new Uint8Array(await res.arrayBuffer())
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < buf.length; i += chunk) {
    binary += String.fromCharCode(...buf.subarray(i, i + chunk))
  }
  const dataUrl = `data:image/png;base64,${btoa(binary)}`
  const api = desktop()
  if (!api?.saveMediaAsset) throw new Error('需在桌面版保存封面')
  const saved = await api.saveMediaAsset(fileName, dataUrl)
  if (!saved.ok || !saved.path) throw new Error(saved.error || '保存封面失败')
  return saved.path
}

/** AI 生成 cover-3x4（标题画进画面），默认 1K 更快；需要更清可传 quality:'2K' */
export async function generateDouyinCover(input: {
  title: string
  styleHint?: string
  imageDataUrl?: string
  quality?: '1K' | '2K'
  onProgress?: (msg: string) => void
}): Promise<{ path: string; jobId: string; previewUrl: string }> {
  input.onProgress?.('正在提交封面生图…')
  const res = await aiFetch('/api/ai-douyin-cover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: input.title,
      styleHint: input.styleHint,
      imageDataUrl: input.imageDataUrl,
      quality: input.quality === '2K' ? '2K' : '1K',
    }),
  })
  const j = await readJson(res)
  const job = j.job as AiJob
  if (!job?.id) throw new Error('封面任务创建失败')
  input.onProgress?.('封面生成中…')
  const done = await pollJob(job.id, (cur) => {
    if (cur.status === 'running') input.onProgress?.('封面生成中…')
  })
  const resultUrl = done.resultUrl || `/ai-generated/${done.id}.png`
  input.onProgress?.('正在保存封面…')
  const path = await downloadAiImageToDisk(resultUrl, `cover-3x4_${done.id}.png`)
  return { path, jobId: done.id, previewUrl: aiUrl(resultUrl) }
}

/** 一键：文案与封面并行；封面标题优先用项目主题，文稿用工程口播 */
export async function generateMetaAndCover(input: {
  projectName?: string
  script?: string
  coverTitle?: string
  styleHint?: string
  onProgress?: (msg: string) => void
}): Promise<{ meta: DouyinMeta; cover: { path: string; jobId: string; previewUrl: string } }> {
  const coverTitle = pickCoverHeadline({
    formTitle: input.coverTitle,
    projectName: input.projectName,
  })
  input.onProgress?.('文案与封面并行生成中…')
  const [meta, cover] = await Promise.all([
    fetchDouyinMeta({
      projectName: input.projectName || coverTitle,
      script: input.script,
      hint: coverTitle !== input.projectName ? coverTitle : undefined,
    }),
    generateDouyinCover({
      title: coverTitle,
      styleHint: input.styleHint,
      quality: '1K',
      onProgress: (m) => input.onProgress?.(m),
    }),
  ])
  return { meta, cover }
}
