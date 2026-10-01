/**
 * 抖音发布：内置 AI 写文案 + 生竖封面（标题画进画面）。
 */
import { aiFetch, aiUrl } from './aiFetch'
import { desktop } from './desktop'

export type DouyinMeta = {
  title: string
  caption: string
  tags: string[]
}

async function readJson(res: Response) {
  const j = await res.json().catch(() => ({})) as { ok?: boolean; error?: string; [k: string]: unknown }
  if (!res.ok || j.ok === false) throw new Error(String(j.error || res.statusText || '请求失败'))
  return j
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
    await new Promise((r) => setTimeout(r, 1200))
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

/** AI 生成 cover-3x4（标题画进画面），返回本机 path */
export async function generateDouyinCover(input: {
  title: string
  styleHint?: string
  imageDataUrl?: string
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
      quality: '2K',
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
