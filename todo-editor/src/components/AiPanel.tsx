import { useEffect, useRef, useState } from 'react'
import { Camera, ImagePlus, Loader2, Plus, Sparkles, Trash2, Video, Wand2, X } from 'lucide-react'
import { useApp } from '../store'
import { AiFloatLaunch } from './AiFloat'
import { isAiPopout } from '../lib/storeSync'
import { aiFetch, aiUrl } from '../lib/aiFetch'
import clsx from 'clsx'

const SIZES = ['3840x2160', '1024x1024'] as const
const MODELS = [
  { id: '', label: '默认 · gpt-image-2' },
  { id: 'gpt-image-2.5-flare', label: '2.5 快速 · flare' },
  { id: 'gpt-image-2.5-sunburst', label: '2.5 高端 · sunburst' },
] as const
const VID_DURATIONS = [5, 8, 10] as const

type ColdAsset = { id: string; name: string; url: string; kind: string }

type AiJob = {
  id: string
  kind: 'image' | 'video'
  status: 'queued' | 'running' | 'done' | 'error' | 'imported'
  prompt: string
  params: {
    size?: string
    model?: string
    duration?: number
    autoTimeline?: boolean
    width?: number | null
    height?: number | null
  }
  resultName?: string | null
  resultUrl?: string | null
  resultKind?: 'image' | 'video' | null
  duration?: number | null
  error?: string | null
  phase?: string | null
}

function friendlyAiError(raw: string): string {
  const s = raw.replace(/\s+/g, ' ').trim()
  if (/10061|积极拒绝|无法连接|Connection refused/i.test(s) || /127\.0\.0\.1:\d+/.test(s)) {
    return '无法连接虎妞/密匙上游（本机代理端口拒绝）。请关掉无效系统代理或启动代理后再试。'
  }
  if (/timeout|timed out/i.test(s)) return '生成超时，请稍后重试。'
  return s.slice(0, 240)
}

async function persistColdRef(dataUrl: string, kind: 'capture' | 'upload', name?: string) {
  try {
    await aiFetch('/api/ai-assets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl, kind, name }),
    })
  } catch { /* */ }
}

function statusLabel(j: AiJob) {
  if (j.status === 'queued') return '排队'
  if (j.status === 'running') return j.phase || '进行中'
  if (j.status === 'done') return '完成'
  if (j.status === 'imported') return '已入库'
  return '失败'
}

/** AI+：异步入队；截帧→SQLite；成果→媒体库 */
export function AiPanel({ hideTitle = false }: { hideTitle?: boolean } = {}) {
  const importMedia = useApp((s) => s.importMedia)
  const addClipFromMedia = useApp((s) => s.addClipFromMedia)
  const captureFrame = useApp((s) => s.captureFrame)
  const media = useApp((s) => s.media)
  const refDataUrl = useApp((s) => s.aiRefDataUrl)
  const setAiRef = useApp((s) => s.setAiRef)
  const mode = useApp((s) => s.aiGenMode)
  const setMode = useApp((s) => s.setAiGenMode)
  const inPopout = isAiPopout()

  const [prompt, setPrompt] = useState('')
  const [size, setSize] = useState<(typeof SIZES)[number]>('3840x2160')
  const [model, setModel] = useState('')
  const [duration, setDuration] = useState<(typeof VID_DURATIONS)[number]>(5)
  const [autoTimeline, setAutoTimeline] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [justAdded, setJustAdded] = useState<string | null>(null)
  const [cold, setCold] = useState<ColdAsset[]>([])
  const [jobs, setJobs] = useState<AiJob[]>([])
  const fileRef = useRef<HTMLInputElement>(null)
  const importing = useRef(new Set<string>())

  const aiMedia = media.filter((m) => m.folderId === 'f_ai')
  const activeJobs = jobs.filter((j) => j.status === 'queued' || j.status === 'running')

  async function refreshCold() {
    try {
      const r = await aiFetch('/api/ai-assets?limit=16')
      const data = await r.json()
      if (data.ok) {
        setCold((data.items as ColdAsset[]).map((a) => ({ ...a, url: aiUrl(a.url) })))
      }
    } catch { /* */ }
  }

  async function refreshJobs() {
    try {
      const r = await aiFetch('/api/ai-jobs?limit=30')
      const data = await r.json()
      if (!data.ok) return
      const items = data.items as AiJob[]
      setJobs(items)
      for (const j of items) {
        if (j.status === 'done' && j.resultUrl && !importing.current.has(j.id)) {
          importing.current.add(j.id)
          void importDoneJob(j)
        }
      }
    } catch { /* */ }
  }

  async function importDoneJob(j: AiJob) {
    try {
      const ack = await aiFetch(`/api/ai-jobs/${j.id}/ack`, { method: 'POST' })
      const ackData = await ack.json()
      if (!ackData.ok) return // 其它窗已入库

      const kind = (j.resultKind || j.kind) === 'video' ? 'video' : 'image'
      const [w, h] = String(j.params.size || '3840x2160').split('x').map(Number)
      importMedia([{
        name: j.resultName || `AI_${j.id}.${kind === 'video' ? 'mp4' : 'png'}`,
        url: aiUrl(j.resultUrl!),
        kind,
        duration: kind === 'video'
          ? (j.duration || j.params.duration || 5)
          : useApp.getState().settings.stillDuration,
        width: j.params.width || w || useApp.getState().settings.width,
        height: j.params.height || h || useApp.getState().settings.height,
      }])
      const st = useApp.getState()
      const added = st.media[st.media.length - 1]
      if (added) {
        useApp.setState({
          media: st.media.map((m) => (m.id === added.id ? { ...m, folderId: 'f_ai' } : m)),
        })
        setJustAdded(added.id)
        if (j.params.autoTimeline) addClipFromMedia(added.id)
        window.setTimeout(() => setJustAdded(null), 1800)
        useApp.getState().setToast(`AI ${kind === 'video' ? '视频' : '图片'}已入库`)
      }
      void refreshJobs()
    } catch (e) {
      importing.current.delete(j.id)
      setError(friendlyAiError(e instanceof Error ? e.message : String(e)))
    }
  }

  useEffect(() => {
    void refreshCold()
  }, [refDataUrl])

  useEffect(() => {
    void refreshJobs()
    const t = window.setInterval(() => {
      void refreshJobs()
    }, 2000)
    return () => window.clearInterval(t)
  }, [])

  function onPickRef(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    const rd = new FileReader()
    rd.onload = () => {
      const dataUrl = String(rd.result)
      setAiRef(dataUrl)
      void persistColdRef(dataUrl, 'upload', f.name).then(refreshCold)
    }
    rd.readAsDataURL(f)
    e.target.value = ''
  }

  async function pickCold(id: string) {
    try {
      const r = await aiFetch(`/api/ai-assets/${id}`)
      const data = await r.json()
      if (data.ok && data.dataUrl) setAiRef(data.dataUrl)
    } catch {
      setError('读取参考图失败')
    }
  }

  async function enqueue() {
    const p = prompt.trim()
    if (!p || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await aiFetch('/api/ai-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: mode,
          prompt: p,
          imageDataUrl: refDataUrl ?? undefined,
          size,
          model: model || undefined,
          duration,
          autoTimeline,
          width: mode === 'image' ? Number(size.split('x')[0]) : useApp.getState().settings.width,
          height: mode === 'image' ? Number(size.split('x')[1]) : useApp.getState().settings.height,
        }),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(friendlyAiError(data.error || '入队失败'))
      useApp.getState().setToast(`已加入队列 · ${activeJobs.length + 1}`)
      void refreshJobs()
    } catch (e) {
      setError(friendlyAiError(e instanceof Error ? e.message : String(e)))
    } finally {
      setSubmitting(false)
    }
  }

  async function removeJob(id: string) {
    await aiFetch(`/api/ai-jobs/${id}`, { method: 'DELETE' })
    void refreshJobs()
  }

  const canGen = !!prompt.trim() && !submitting

  return (
    <div className="ai-panel flex flex-col gap-2.5 p-1" data-testid="ai-panel">
      {!inPopout && !hideTitle && (
        <div className="flex items-center justify-between px-0.5">
          <span className="eyebrow">AI 生成</span>
          <AiFloatLaunch compact />
        </div>
      )}

      <div className="tab-row" data-testid="ai-mode-tabs">
        <button
          type="button"
          className={clsx('tab flex-1', mode === 'image' && 'active')}
          data-testid="ai-mode-image"
          onClick={() => setMode('image')}
        >
          <Sparkles size={12} className="inline mr-1" />生图
        </button>
        <button
          type="button"
          className={clsx('tab flex-1', mode === 'video' && 'active')}
          data-testid="ai-mode-video"
          onClick={() => setMode('video')}
        >
          <Video size={12} className="inline mr-1" />生视频
        </button>
      </div>

      <div className="field">
        <label>参考图（可选 · {mode === 'video' ? '有则图生视频' : '有则图生图'}）</label>
        {refDataUrl ? (
          <div className="ai-ref-preview relative rounded-lg overflow-hidden border" style={{ borderColor: 'var(--border)' }}>
            <img src={refDataUrl} alt="参考图" className="w-full h-20 object-cover" />
            <button
              type="button"
              className="absolute top-1 right-1 icon-btn bg-black/50 text-white"
              style={{ width: 22, height: 22 }}
              data-testid="ai-ref-clear"
              onClick={() => setAiRef(null)}
            >
              <X size={12} />
            </button>
          </div>
        ) : (
          <p className="text-[11px] m-0 px-0.5 mb-1.5" style={{ color: 'var(--text-muted)' }}>
            无参考图=文生{mode === 'video' ? '视频' : '图'} · 截帧可作参考
          </p>
        )}
        <div className="flex gap-1">
          <button type="button" className="btn btn-ghost flex-1" data-testid="ai-ref-capture" onClick={captureFrame}>
            <Camera size={13} /> 截帧
          </button>
          <button type="button" className="btn btn-ghost flex-1" data-testid="ai-ref-pick" onClick={() => fileRef.current?.click()}>
            <ImagePlus size={13} /> 上传
          </button>
        </div>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onPickRef} />
      </div>

      {cold.length > 0 && (
        <div className="field">
          <label>最近参考</label>
          <div className="flex gap-1 overflow-x-auto pb-0.5" data-testid="ai-cold-list">
            {cold.map((a) => (
              <button
                key={a.id}
                type="button"
                className="shrink-0 rounded border overflow-hidden"
                style={{ width: 48, height: 36, borderColor: 'var(--border)' }}
                title={a.name}
                data-testid={`ai-cold-${a.id}`}
                onClick={() => void pickCold(a.id)}
              >
                <img src={a.url} alt="" className="w-full h-full object-cover" />
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="field">
        <label>提示词</label>
        <textarea
          data-testid="ai-prompt"
          rows={3}
          placeholder={mode === 'image' ? '描述画面…' : '描述运动…'}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </div>

      {mode === 'image' ? (
        <>
          <div className="field">
            <label>尺寸</label>
            <select data-testid="ai-size" value={size} onChange={(e) => setSize(e.target.value as typeof size)}>
              <option value="3840x2160">16:9 4K</option>
              <option value="1024x1024">1:1</option>
            </select>
          </div>
          <div className="field">
            <label>模型</label>
            <select data-testid="ai-model" value={model} onChange={(e) => setModel(e.target.value)}>
              {MODELS.map((m) => (
                <option key={m.id || 'default'} value={m.id}>{m.label}</option>
              ))}
            </select>
          </div>
        </>
      ) : (
        <div className="field">
          <label>时长</label>
          <select data-testid="ai-duration" value={duration} onChange={(e) => setDuration(Number(e.target.value) as typeof duration)}>
            {VID_DURATIONS.map((d) => (
              <option key={d} value={d}>{d} 秒</option>
            ))}
          </select>
        </div>
      )}

      <label className="flex items-center gap-2 text-[11px] px-0.5 cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
        <input type="checkbox" checked={autoTimeline} data-testid="ai-auto-timeline" onChange={(e) => setAutoTimeline(e.target.checked)} />
        完成后自动入轨
      </label>

      <button
        type="button"
        className={clsx('btn btn-primary w-full', submitting && 'opacity-70')}
        data-testid="ai-generate"
        disabled={!canGen}
        onClick={() => void enqueue()}
      >
        {submitting ? <Loader2 size={13} className="animate-spin" /> : mode === 'video' ? <Video size={13} /> : <Sparkles size={13} />}
        {submitting ? '入队中…' : refDataUrl ? (mode === 'video' ? '图生视频 · 入队' : '图生图 · 入队') : (mode === 'video' ? '文生视频 · 入队' : '文生图 · 入队')}
      </button>

      {error && (
        <p className="text-[11px] m-0 px-1" style={{ color: 'var(--error)' }} data-testid="ai-error">{error}</p>
      )}

      {jobs.length > 0 && (
        <div className="field" data-testid="ai-queue">
          <label>队列 · {activeJobs.length} 进行中</label>
          <div className="flex flex-col gap-1">
            {jobs.slice(0, 12).map((j) => (
              <div
                key={j.id}
                className="flex items-start gap-1.5 rounded-md px-2 py-1.5 text-[11px]"
                style={{ background: 'var(--surface-2)' }}
                data-testid={`ai-job-${j.id}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1">
                    {j.status === 'running' && <Loader2 size={11} className="animate-spin shrink-0" />}
                    <span className="font-medium shrink-0">{j.kind === 'video' ? '视频' : '图片'}</span>
                    <span style={{ color: j.status === 'error' ? 'var(--error)' : 'var(--text-muted)' }}>
                      {statusLabel(j)}
                    </span>
                  </div>
                  <p className="m-0 truncate opacity-80">{j.prompt}</p>
                  {j.error && <p className="m-0 mt-0.5" style={{ color: 'var(--error)' }}>{friendlyAiError(j.error)}</p>}
                </div>
                {(j.status === 'queued' || j.status === 'error' || j.status === 'imported' || j.status === 'done') && (
                  <button
                    type="button"
                    className="icon-btn shrink-0"
                    style={{ width: 22, height: 22 }}
                    title={j.status === 'queued' ? '取消' : '移除'}
                    data-testid={`ai-job-del-${j.id}`}
                    onClick={() => void removeJob(j.id)}
                  >
                    <Trash2 size={11} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {aiMedia.length > 0 && (
        <>
          <div className="eyebrow mt-1 px-0.5">已入库 · {aiMedia.length}</div>
          <div className="grid grid-cols-2 gap-1.5" data-testid="ai-results">
            {aiMedia.map((m, i) => (
              <div
                key={m.id}
                className={clsx('ai-result-card group relative rounded-lg overflow-hidden border text-left', justAdded === m.id && 'is-new')}
                style={{ borderColor: 'var(--border)', animationDelay: `${i * 40}ms` }}
                data-testid={`ai-item-${m.id}`}
              >
                <button type="button" className="block w-full" title="双击入轨" onDoubleClick={() => addClipFromMedia(m.id)}>
                  {m.kind === 'video' ? (
                    <video src={m.url} className="w-full h-16 object-cover" muted playsInline preload="metadata" />
                  ) : (
                    <img src={m.url} alt={m.name} className="w-full h-16 object-cover" />
                  )}
                </button>
                <button
                  type="button"
                  className="absolute bottom-1 right-1 icon-btn bg-black/55 text-white opacity-0 group-hover:opacity-100"
                  style={{ width: 24, height: 24 }}
                  data-testid={`ai-add-${m.id}`}
                  title="加入时间线"
                  onClick={() => addClipFromMedia(m.id)}
                >
                  <Plus size={12} />
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      <p className="text-[10px] m-0 px-0.5" style={{ color: 'var(--text-muted)' }}>
        <Wand2 size={10} className="inline mr-1" />
        异步队列 · 可连加多条
      </p>
    </div>
  )
}
