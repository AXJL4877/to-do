import { useEffect, useMemo, useRef, useState } from 'react'
import { AudioLines, Camera, ImagePlus, LayoutGrid, Loader2, Music, Plus, Settings, Sparkles, Trash2, Video, Wand2, X } from 'lucide-react'
import { useApp } from '../store'
import { AiFloatLaunch } from './AiFloat'
import { isAiPopout } from '../lib/storeSync'
import { aiFetch, aiUrl } from '../lib/aiFetch'
import { AiStyleForm, defaultStyleValues, styleValuesReady, type StylePack, type StyleValues } from './AiStyleForm'
import { AiStylePicker } from './AiStylePicker'
import clsx from 'clsx'

const FALLBACK_SIZE_OPTIONS = [
  { value: '1024x1024', label: '1:1 1024' },
] as const
const FALLBACK_QUALITY_OPTIONS = [
  { value: 'standard', label: '标准' },
] as const
const FALLBACK_MODELS = [{
  id: 'gpt-image-2',
  label: 'gpt-image-2',
  sizeOptions: FALLBACK_SIZE_OPTIONS,
  defaultSize: '1024x1024',
  qualityOptions: [
    { value: 'low', label: '草稿' },
    { value: 'medium', label: '标准' },
    { value: 'high', label: '高质量' },
  ],
  defaultQuality: 'low',
}] as const
const VID_DURATIONS = [5, 8, 10] as const

type ColdAsset = { id: string; name: string; url: string; kind: string }
type SizeOption = { value: string; label: string }
type QualityOption = { value: string; label: string }
type AiModel = {
  id: string
  label: string
  ownedBy?: string
  sizeOptions?: readonly SizeOption[]
  defaultSize?: string
  qualityOptions?: readonly QualityOption[]
  defaultQuality?: string
}
type AiConfig = { baseUrl: string; hasApiKey: boolean; apiKeyMasked: string }
type AiMode = 'image' | 'video' | 'audio'

type AiJob = {
  id: string
  kind: 'image' | 'video' | 'audio'
  status: 'queued' | 'running' | 'done' | 'error' | 'imported'
  prompt: string
  params: {
    size?: string
    model?: string
    quality?: string
    duration?: number
    autoTimeline?: boolean
    width?: number | null
    height?: number | null
    style?: { id: string; name: string; version: string; summary: string; cutout?: boolean } | null
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

function audioModelProfile(modelId: string) {
  const id = modelId.toLowerCase()
  if (id.includes('voice-clone') || id.includes('speech-2.8')) {
    return {
      kind: 'voice-clone' as const,
      title: id.includes('speech-2.8') ? '海螺语音克隆' : '克隆音色',
      detail: '上传参考音频并填写对应文本，用于复刻专属音色。',
    }
  }
  if (id.includes('voice-design')) {
    return {
      kind: 'voice-design' as const,
      title: '音色设计',
      detail: '根据音色描述创建声音，可用于后续文本转语音。',
    }
  }
  if (id.includes('music') || id.includes('suno')) {
    return {
      kind: 'music' as const,
      title: '音乐生成',
      detail: '根据主题、风格或歌词生成完整音乐。',
    }
  }
  return {
    kind: 'tts' as const,
    title: modelId.includes('GT') || id.includes('tts') ? '文本转语音' : '语音合成',
    detail: '输入文本、音色和语速，生成朗读音频。',
  }
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
  const [size, setSize] = useState('1024x1024')
  const [quality, setQuality] = useState('low')
  const [model, setModel] = useState('gpt-image-2')
  const [duration, setDuration] = useState<(typeof VID_DURATIONS)[number]>(5)
  const [audioText, setAudioText] = useState('')
  const [audioTitle, setAudioTitle] = useState('')
  const [audioVoice, setAudioVoice] = useState('alloy')
  const [audioSpeed, setAudioSpeed] = useState(1)
  const [audioFormat, setAudioFormat] = useState('mp3')
  const [audioStyle, setAudioStyle] = useState('')
  const [audioVoiceName, setAudioVoiceName] = useState('')
  const [audioRefText, setAudioRefText] = useState('')
  const [audioRefName, setAudioRefName] = useState('')
  const [audioLoop, setAudioLoop] = useState(false)
  const [autoTimeline, setAutoTimeline] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [configOpen, setConfigOpen] = useState(false)
  const [config, setConfig] = useState<AiConfig | null>(null)
  const [configBaseUrl, setConfigBaseUrl] = useState('https://huniuai.com')
  const [configKey, setConfigKey] = useState('')
  const [configSaving, setConfigSaving] = useState(false)
  const [models, setModels] = useState<AiModel[]>([...FALLBACK_MODELS])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [justAdded, setJustAdded] = useState<string | null>(null)
  const [cold, setCold] = useState<ColdAsset[]>([])
  const [jobs, setJobs] = useState<AiJob[]>([])
  const [styles, setStyles] = useState<StylePack[]>([])
  const [styleId, setStyleId] = useState('')
  const [styleValues, setStyleValues] = useState<StyleValues | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const audioFileRef = useRef<HTMLInputElement>(null)
  const importing = useRef(new Set<string>())

  const aiMedia = media.filter((m) => m.folderId === 'f_ai')
  const activeJobs = jobs.filter((j) => j.status === 'queued' || j.status === 'running')
  const selectedModel = useMemo(() => models.find((m) => m.id === model), [model, models])
  const sizeOptions = selectedModel?.sizeOptions?.length ? selectedModel.sizeOptions : [...FALLBACK_SIZE_OPTIONS]
  const qualityOptions = selectedModel?.qualityOptions?.length ? selectedModel.qualityOptions : [...FALLBACK_QUALITY_OPTIONS]
  const audioProfile = audioModelProfile(model)
  const activeStyle = mode === 'image' ? styles.find((s) => s.id === styleId) ?? null : null

  async function refreshStyles() {
    try {
      const r = await aiFetch('/api/ai-styles')
      const data = await r.json()
      if (data.ok) {
        setStyles((data.styles as StylePack[])
          .filter((s) => s.outputs.includes('image'))
          .map((s) => ({ ...s, previews: s.previews.map((p) => aiUrl(p)) })))
      }
    } catch { /* */ }
  }

  function pickStyle(id: string) {
    if (id === styleId) return
    setStyleId(id)
    const pack = styles.find((s) => s.id === id)
    setStyleValues(pack ? defaultStyleValues(pack) : null)
  }

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

  async function refreshConfig() {
    try {
      const r = await aiFetch('/api/ai-config')
      const data = await r.json()
      if (!data.ok) return
      const next = data.config as AiConfig
      setConfig(next)
      setConfigBaseUrl(next.baseUrl || 'https://huniuai.com')
    } catch { /* */ }
  }

  async function refreshModels() {
    setModelsLoading(true)
    setModelsError(null)
    try {
      const r = await aiFetch(`/api/ai-models?mode=${encodeURIComponent(mode)}`)
      const data = await r.json()
      if (!data.ok) throw new Error(data.error || '模型列表读取失败')
      const next = (data.models || []) as AiModel[]
      const usable = next.length ? next : (mode === 'image' ? [...FALLBACK_MODELS] : [])
      setModels(usable)
      const nextModel = usable.some((m) => m.id === model) ? model : usable[0]?.id || ''
      setModel(nextModel)
      const profile = usable.find((m) => m.id === nextModel)
      const optionValues = (profile?.sizeOptions || FALLBACK_SIZE_OPTIONS).map((s) => s.value)
      if (!optionValues.includes(size)) setSize(profile?.defaultSize || optionValues[0] || '1024x1024')
      const qualityValues = (profile?.qualityOptions || FALLBACK_QUALITY_OPTIONS).map((q) => q.value)
      if (!qualityValues.includes(quality)) setQuality(profile?.defaultQuality || qualityValues[0] || 'standard')
    } catch (e) {
      setModels(mode === 'image' ? [...FALLBACK_MODELS] : [])
      setModelsError(friendlyAiError(e instanceof Error ? e.message : String(e)))
    } finally {
      setModelsLoading(false)
    }
  }

  async function saveConfig() {
    setConfigSaving(true)
    setError(null)
    try {
      const body: { baseUrl: string; apiKey?: string } = { baseUrl: configBaseUrl }
      if (configKey.trim()) body.apiKey = configKey.trim()
      const r = await aiFetch('/api/ai-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await r.json()
      if (!data.ok) throw new Error(data.error || '配置保存失败')
      const next = data.config as AiConfig
      setConfig(next)
      setConfigBaseUrl(next.baseUrl)
      setConfigKey('')
      setConfigOpen(false)
      useApp.getState().setToast('AI 配置已保存')
      void refreshModels()
    } catch (e) {
      setError(friendlyAiError(e instanceof Error ? e.message : String(e)))
    } finally {
      setConfigSaving(false)
    }
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
        if (j.params.autoTimeline) {
          addClipFromMedia(added.id, undefined, undefined, {
            preferFreeTrack: true,
            source: { type: 'ai', jobId: j.id, kind: j.kind },
          })
        }
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
    void refreshStyles()
    void refreshConfig().then(refreshModels)
    const t = window.setInterval(() => {
      void refreshJobs()
    }, 2000)
    return () => window.clearInterval(t)
  }, [])

  useEffect(() => {
    void refreshModels()
  }, [mode])

  useEffect(() => {
    if (!sizeOptions.some((s) => s.value === size)) {
      setSize(selectedModel?.defaultSize || sizeOptions[0]?.value || '1024x1024')
    }
    if (!qualityOptions.some((q) => q.value === quality)) {
      setQuality(selectedModel?.defaultQuality || qualityOptions[0]?.value || 'standard')
    }
  }, [model, quality, qualityOptions, selectedModel, size, sizeOptions])

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
    if (submitting) return
    if (activeStyle ? !styleValues || !styleValuesReady(activeStyle, styleValues) : !p) return
    if (!config?.hasApiKey) {
      setConfigOpen(true)
      setError('请先配置虎妞 API Key')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const res = await aiFetch('/api/ai-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(activeStyle && styleValues ? {
          kind: 'image',
          styleId: activeStyle.id,
          styleInputs: styleValues.inputs,
          size: styleValues.aspectRatio,
          quality: styleValues.resolution,
          model: styleValues.model,
          cutout: styleValues.cutout,
          imageDataUrl: refDataUrl ?? undefined,
          autoTimeline,
        } : {
          kind: mode,
          prompt: p,
          imageDataUrl: refDataUrl ?? undefined,
          size,
          model,
          quality,
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

  const canGen = !submitting && (activeStyle
    ? !!styleValues && styleValuesReady(activeStyle, styleValues)
    : !!prompt.trim())
  const isAudioMode = mode === 'audio'

  return (
    <div className="ai-panel flex flex-col gap-2.5 p-1" data-testid="ai-panel">
      {!inPopout && !hideTitle && (
        <div className="flex items-center justify-between px-0.5">
          <span className="eyebrow">AI 生成</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className={clsx('icon-btn', config?.hasApiKey && 'active')}
              style={{ width: 26, height: 26 }}
              data-testid="ai-config-open"
              title="配置 API Key 与 Base URL"
              aria-label="配置"
              onClick={() => setConfigOpen(true)}
            >
              <Settings size={12} />
            </button>
            <AiFloatLaunch compact />
          </div>
        </div>
      )}
      {(inPopout || hideTitle) && (
        <div className="flex justify-end px-0.5">
          <button
            type="button"
            className={clsx('icon-btn', config?.hasApiKey && 'active')}
            style={{ width: 26, height: 26 }}
            data-testid="ai-config-open"
            title="配置 API Key 与 Base URL"
            aria-label="配置"
            onClick={() => setConfigOpen(true)}
          >
            <Settings size={12} />
          </button>
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
        <button
          type="button"
          className={clsx('tab flex-1', mode === 'audio' && 'active')}
          data-testid="ai-mode-audio"
          onClick={() => setMode('audio')}
        >
          <AudioLines size={12} className="inline mr-1" />生音频
        </button>
      </div>

      {mode === 'image' && styles.length > 0 && (
        <div className="field">
          <label>风格</label>
          <button type="button" className="ai-style-trigger" data-testid="ai-style" onClick={() => setPickerOpen(true)}>
            <span className="shrink-0 w-10 h-10 rounded-md overflow-hidden grid place-items-center bg-white border" style={{ borderColor: 'var(--border)' }}>
              {activeStyle?.previews[0]
                ? <img src={activeStyle.previews[0]} alt="" className="w-full h-full object-cover" />
                : <Sparkles size={16} style={{ color: 'var(--accent)' }} />}
            </span>
            <span className="min-w-0 flex-1 flex flex-col">
              <span className="text-[12px] font-semibold truncate">{activeStyle ? activeStyle.name : '自由生成'}</span>
              <span className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>
                {activeStyle ? activeStyle.tags.join(' · ') || activeStyle.author : `不限风格 · ${styles.length} 个风格可选`}
              </span>
            </span>
            <LayoutGrid size={14} className="shrink-0 mr-1" style={{ color: 'var(--text-muted)' }} />
          </button>
        </div>
      )}
      {pickerOpen && (
        <AiStylePicker styles={styles} currentId={styleId} onPick={pickStyle} onClose={() => setPickerOpen(false)} />
      )}

      {mode !== 'audio' && (
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
      )}

      {mode !== 'audio' && cold.length > 0 && (
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

      {activeStyle && styleValues && (
        <AiStyleForm pack={activeStyle} value={styleValues} onChange={setStyleValues} />
      )}

      {mode !== 'audio' && !activeStyle && (
      <div className="field">
        <label>提示词</label>
        <textarea
          data-testid="ai-prompt"
          rows={3}
          placeholder={mode === 'image' ? '描述画面…' : mode === 'video' ? '描述运动…' : '输入要生成的声音、音乐或朗读文本…'}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </div>
      )}

      {!activeStyle && (
      <div className="field">
        <label>模型</label>
        <select data-testid="ai-model" value={model} onChange={(e) => setModel(e.target.value)}>
          {models.map((m) => (
            <option key={m.id} value={m.id}>{m.label || m.id}</option>
          ))}
        </select>
        <div className="flex items-center justify-between gap-1 px-0.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
          <span className="truncate">
            {modelsLoading ? '模型读取中...' : modelsError ? modelsError : models.length ? `${models.length} 个可用模型` : config?.hasApiKey ? '当前能力暂无可用模型' : '请先配置 Key 后刷新模型'}
          </span>
          <button type="button" className="underline shrink-0" data-testid="ai-model-refresh" onClick={() => void refreshModels()}>
            刷新
          </button>
        </div>
      </div>
      )}

      {activeStyle ? null : mode === 'image' ? (
        <>
          <div className="field">
            <label>尺寸</label>
            <select data-testid="ai-size" value={size} onChange={(e) => setSize(e.target.value)}>
              {sizeOptions.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>质量</label>
            <select data-testid="ai-quality" value={quality} onChange={(e) => setQuality(e.target.value)}>
              {qualityOptions.map((q) => (
                <option key={q.value} value={q.value}>{q.label}</option>
              ))}
            </select>
          </div>
        </>
      ) : mode === 'video' ? (
        <div className="field">
          <label>时长</label>
          <select data-testid="ai-duration" value={duration} onChange={(e) => setDuration(Number(e.target.value) as typeof duration)}>
            {VID_DURATIONS.map((d) => (
              <option key={d} value={d}>{d} 秒</option>
            ))}
          </select>
        </div>
      ) : (
        <>
          <div className="field">
            <label>{audioProfile.title}</label>
            <div className="rounded-md px-2 py-1.5 text-[11px] flex items-center gap-1.5" style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}>
              {audioProfile.kind === 'music' ? <Music size={12} /> : <AudioLines size={12} />}
              <span>{audioProfile.detail}</span>
            </div>
          </div>

          {audioProfile.kind === 'music' && (
            <>
              <div className="field">
                <label>音乐主题</label>
                <textarea data-testid="ai-audio-music-prompt" rows={3} value={audioText} onChange={(e) => setAudioText(e.target.value)} placeholder="描述旋律、情绪、歌词或想要的音乐画面..." />
              </div>
              <div className="field">
                <label>标题</label>
                <input data-testid="ai-audio-title" value={audioTitle} onChange={(e) => setAudioTitle(e.target.value)} placeholder="可选" />
              </div>
              <div className="field">
                <label>风格</label>
                <input data-testid="ai-audio-style" value={audioStyle} onChange={(e) => setAudioStyle(e.target.value)} placeholder="流行、电子、民谣、纯音乐..." />
              </div>
              <label className="flex items-center gap-2 text-[11px] px-0.5 cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
                <input type="checkbox" checked={audioLoop} onChange={(e) => setAudioLoop(e.target.checked)} />
                循环/氛围素材
              </label>
            </>
          )}

          {audioProfile.kind === 'tts' && (
            <>
              <div className="field">
                <label>朗读文本</label>
                <textarea data-testid="ai-audio-tts-text" rows={4} value={audioText} onChange={(e) => setAudioText(e.target.value)} placeholder="输入要合成语音的文本..." />
              </div>
              <div className="field">
                <label>音色</label>
                <select data-testid="ai-audio-voice" value={audioVoice} onChange={(e) => setAudioVoice(e.target.value)}>
                  {['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="field">
                  <label>语速</label>
                  <input data-testid="ai-audio-speed" type="number" min="0.5" max="2" step="0.1" value={audioSpeed} onChange={(e) => setAudioSpeed(Number(e.target.value) || 1)} />
                </div>
                <div className="field">
                  <label>格式</label>
                  <select data-testid="ai-audio-format" value={audioFormat} onChange={(e) => setAudioFormat(e.target.value)}>
                    {['mp3', 'wav', 'opus', 'aac', 'flac'].map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                </div>
              </div>
            </>
          )}

          {audioProfile.kind === 'voice-clone' && (
            <>
              <div className="field">
                <label>参考音频</label>
                <button type="button" className="btn btn-ghost w-full justify-start" data-testid="ai-audio-ref-pick" onClick={() => audioFileRef.current?.click()}>
                  <AudioLines size={13} /> {audioRefName || '上传参考音频'}
                </button>
                <input
                  ref={audioFileRef}
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  onChange={(e) => {
                    setAudioRefName(e.target.files?.[0]?.name || '')
                    e.target.value = ''
                  }}
                />
              </div>
              <div className="field">
                <label>参考文本</label>
                <textarea data-testid="ai-audio-ref-text" rows={3} value={audioRefText} onChange={(e) => setAudioRefText(e.target.value)} placeholder="填写参考音频中说/唱的内容..." />
              </div>
              <div className="field">
                <label>音色名称</label>
                <input data-testid="ai-audio-voice-name" value={audioVoiceName} onChange={(e) => setAudioVoiceName(e.target.value)} placeholder="例如：我的旁白音色" />
              </div>
              <div className="field">
                <label>生成文本</label>
                <textarea data-testid="ai-audio-clone-text" rows={3} value={audioText} onChange={(e) => setAudioText(e.target.value)} placeholder="使用克隆音色朗读的文本..." />
              </div>
            </>
          )}

          {audioProfile.kind === 'voice-design' && (
            <>
              <div className="field">
                <label>音色描述</label>
                <textarea data-testid="ai-audio-design-style" rows={3} value={audioStyle} onChange={(e) => setAudioStyle(e.target.value)} placeholder="温暖、年轻、纪录片旁白、低沉、有亲和力..." />
              </div>
              <div className="field">
                <label>试听文本</label>
                <textarea data-testid="ai-audio-design-text" rows={3} value={audioText} onChange={(e) => setAudioText(e.target.value)} placeholder="输入用于试听新音色的文本..." />
              </div>
              <div className="field">
                <label>音色名称</label>
                <input data-testid="ai-audio-design-name" value={audioVoiceName} onChange={(e) => setAudioVoiceName(e.target.value)} placeholder="可选" />
              </div>
            </>
          )}
        </>
      )}

      {mode !== 'audio' && (
      <label className="flex items-center gap-2 text-[11px] px-0.5 cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
        <input type="checkbox" checked={autoTimeline} data-testid="ai-auto-timeline" onChange={(e) => setAutoTimeline(e.target.checked)} />
        完成后自动入轨
      </label>
      )}

      <button
        type="button"
        className={clsx('btn btn-primary w-full', submitting && 'opacity-70')}
        data-testid="ai-generate"
        disabled={!canGen || isAudioMode || !model}
        onClick={() => void enqueue()}
      >
        {submitting ? <Loader2 size={13} className="animate-spin" /> : mode === 'video' ? <Video size={13} /> : mode === 'audio' ? <AudioLines size={13} /> : <Sparkles size={13} />}
        {submitting ? '入队中…' : activeStyle ? `${activeStyle.name} · 入队` : mode === 'audio' ? '生音频 · 待接入' : refDataUrl ? (mode === 'video' ? '图生视频 · 入队' : '图生图 · 入队') : (mode === 'video' ? '文生视频 · 入队' : '文生图 · 入队')}
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
                  <p className="m-0 truncate opacity-80">
                    {j.params.style
                      ? `〔${j.params.style.name}${j.params.style.cutout ? ' · 透明底' : ''}〕${j.params.style.summary}`
                      : j.prompt}
                  </p>
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
                    <img src={m.url} alt={m.name} className="w-full h-16 object-contain" />
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

      {configOpen && (
        <div className="modal-backdrop" data-testid="ai-config-modal" onClick={() => setConfigOpen(false)}>
          <div className="modal" style={{ width: 'min(420px, 100%)' }} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
              <span className="eyebrow">AI 接口配置</span>
              <button className="icon-btn" data-testid="ai-config-close" onClick={() => setConfigOpen(false)} aria-label="关闭">
                <X size={14} />
              </button>
            </div>
            <div className="p-4 grid gap-3">
              <div className="field">
                <label>Base URL</label>
                <input
                  data-testid="ai-config-base-url"
                  value={configBaseUrl}
                  placeholder="https://huniuai.com"
                  onChange={(e) => setConfigBaseUrl(e.target.value)}
                />
              </div>
              <div className="field">
                <label>API Key</label>
                <input
                  data-testid="ai-config-key"
                  value={configKey}
                  type="password"
                  placeholder={config?.hasApiKey ? `已保存 ${config.apiKeyMasked}` : 'sk-...'}
                  onChange={(e) => setConfigKey(e.target.value)}
                />
              </div>
              <p className="text-[11px] m-0" style={{ color: 'var(--text-muted)' }}>
                留空 API Key 会保留当前已保存密钥，只更新中转站地址。
              </p>
              <div className="flex justify-end gap-2">
                <button type="button" className="btn btn-ghost" onClick={() => setConfigOpen(false)}>取消</button>
                <button
                  type="button"
                  className="btn btn-primary"
                  data-testid="ai-config-save"
                  disabled={configSaving}
                  onClick={() => void saveConfig()}
                >
                  {configSaving && <Loader2 size={13} className="animate-spin" />}
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
