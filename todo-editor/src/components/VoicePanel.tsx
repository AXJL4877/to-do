import { useEffect, useRef, useState } from 'react'
import { Loader2, Mic, Pause, Play, Plus, RotateCcw, Trash2 } from 'lucide-react'
import clsx from 'clsx'
import { useApp } from '../store'
import { aiFetch, aiUrl } from '../lib/aiFetch'
import { importAiJob, placeTtsVoice, shouldImport } from '../lib/aiJobImport'
import {
  TTS_SKILL_ID, defaultSkillParams, enqueueSkill, fetchSkills, paramVisible, phasePercent, phaseText, speechSeconds,
  type SkillJob, type SkillPack, type SkillParams, type TtsOutput,
} from '../lib/aiSkills'
import { SkillParamControl } from './SkillStudio'

type TtsJob = SkillJob<TtsOutput>

const VOICE_STORE = 'todo.tts.voice'

function scriptStats(text: string) {
  const chars = text.replace(/[\p{P}\s]/gu, '').length
  return { chars, seconds: Math.round(speechSeconds(text)) }
}

function loadVoiceParams(pack: SkillPack): SkillParams {
  const p = defaultSkillParams(pack)
  try {
    const saved = JSON.parse(localStorage.getItem(VOICE_STORE) || '{}') as SkillParams
    for (const def of pack.params) if (def.id in saved) p[def.id] = saved[def.id]
  } catch { /* */ }
  return p
}

const isFinished = (j: { status: string }) => j.status === 'done' || j.status === 'imported'

function voiceName(pack: SkillPack, j: TtsJob) {
  const p = pack.params.find((x) => x.id === 'voice')
  const v = j.params.request?.params?.voice
  if (p?.type !== 'select' || v == null) return ''
  return p.options.find((o) => o.value === v)?.label ?? ''
}

function TtsJobCard({ pack, j, onRetry, onRemove }: { pack: SkillPack; j: TtsJob; onRetry: () => void; onRemove: () => void }) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const out = j.params.output
  const ready = isFinished(j) && !!out
  const pct = j.status === 'running' ? phasePercent(j.phase) : null
  const meta = [voiceName(pack, j), out ? `${out.duration.toFixed(1)}s` : ''].filter(Boolean).join(' · ') || '完成'

  function toggle() {
    const a = audioRef.current
    if (!a) return
    if (a.paused) void a.play().catch(() => {})
    else a.pause()
  }

  return (
    <div className={clsx('skill-job', j.status === 'error' && 'is-error')} data-testid={`tts-job-${j.id}`}>
      <div className="flex flex-col gap-1 shrink-0">
        <button type="button" className="icon-btn" disabled={!ready} title={playing ? '暂停' : '试听'} onClick={toggle}>
          {j.status === 'running' || j.status === 'queued' ? <Loader2 size={12} className="animate-spin" /> : playing ? <Pause size={12} /> : <Play size={12} />}
        </button>
        {ready && <audio ref={audioRef} src={aiUrl(out.audio)} preload="none" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />}
      </div>
      <div className="min-w-0 flex-1 flex flex-col gap-1">
        <p className="m-0 text-[11px] leading-snug line-clamp-2" title={j.prompt}>{j.prompt}</p>
        {j.status === 'running' ? (
          <>
            <div className="ai-progress"><div className={pct == null ? 'ai-progress-bar' : 'ai-progress-fill'} style={pct == null ? undefined : { width: `${pct}%` }} /></div>
            <span className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>{phaseText(j.phase) || '进行中'}{pct != null ? ` · ${pct}%` : ''}</span>
          </>
        ) : j.status === 'error' ? (
          <span className="text-[10px] line-clamp-2" style={{ color: 'var(--error)' }} title={j.error || ''}>{j.error}</span>
        ) : (
          <span className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>{j.status === 'queued' ? '排队中' : meta}</span>
        )}
      </div>
      <div className="flex flex-col shrink-0">
        {ready && (
          <button type="button" className="icon-btn" style={{ width: 22, height: 22 }} title="放到播放头" data-testid={`tts-job-add-${j.id}`} onClick={() => placeTtsVoice(j)}>
            <Plus size={11} />
          </button>
        )}
        {j.status === 'error' && (
          <button type="button" className="icon-btn" style={{ width: 22, height: 22 }} title="重试" data-testid={`tts-job-retry-${j.id}`} onClick={onRetry}>
            <RotateCcw size={11} />
          </button>
        )}
        {j.status !== 'running' && (
          <button type="button" className="icon-btn" style={{ width: 22, height: 22 }} title={j.status === 'queued' ? '取消' : '移除'} data-testid={`tts-job-del-${j.id}`} onClick={onRemove}>
            <Trash2 size={11} />
          </button>
        )}
      </div>
    </div>
  )
}

/** 媒体库「配音」页：选音色 → 文案转 TTS 入轨。字幕在时间轴选中配音后右键「烧录字幕」 */
export function VoicePanel() {
  const [pack, setPack] = useState<SkillPack | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [script, setScript] = useState('')
  const [params, setParams] = useState<SkillParams>({})
  const [autoTimeline, setAutoTimeline] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [jobs, setJobs] = useState<TtsJob[]>([])

  async function refreshJobs() {
    try {
      const r = await aiFetch('/api/ai-jobs?limit=60')
      const data = await r.json()
      if (!data.ok) return
      const items = (data.items as TtsJob[]).filter((j) => j.kind === 'skill' && j.params.skill?.id === TTS_SKILL_ID)
      setJobs(items)
      for (const j of items) {
        if (shouldImport(j)) void importAiJob(j).catch((e) => setError(e instanceof Error ? e.message : String(e)))
      }
    } catch { /* */ }
  }

  useEffect(() => {
    fetchSkills()
      .then((list) => {
        const t = list.find((s) => s.id === TTS_SKILL_ID) ?? null
        setPack(t)
        if (t) setParams(loadVoiceParams(t))
        else setLoadError('没有找到配音技能包')
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
    void refreshJobs()
    const t = window.setInterval(() => void refreshJobs(), 2000)
    return () => window.clearInterval(t)
  }, [])

  function setParam(id: string, v: SkillParams[string]) {
    const next = { ...params, [id]: v }
    setParams(next)
    try { localStorage.setItem(VOICE_STORE, JSON.stringify(next)) } catch { /* */ }
  }

  const stats = scriptStats(script)

  async function submit() {
    if (!pack || !stats.chars || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const ahead = jobs.filter((j) => j.status === 'queued' || j.status === 'running').length
      await enqueueSkill({ skillId: pack.id, prompt: script.trim(), params, autoTimeline })
      useApp.getState().setToast(`配音已入队${ahead ? ` · 前面还有 ${ahead} 个` : ''}`)
      void refreshJobs()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  async function retry(id: string) {
    const r = await aiFetch(`/api/ai-jobs/${id}/retry`, { method: 'POST' })
    const data = await r.json().catch(() => ({}))
    if (!data.ok) setError(data.error || '重试失败')
    void refreshJobs()
  }

  async function remove(id: string) {
    await aiFetch(`/api/ai-jobs/${id}`, { method: 'DELETE' })
    void refreshJobs()
  }

  if (!pack) {
    return (
      <div className="py-8 text-center text-[12px]" style={{ color: loadError ? 'var(--error)' : 'var(--text-muted)' }} data-testid="voice-panel-loading">
        {loadError || <Loader2 size={16} className="animate-spin inline" />}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2.5 p-1" data-testid="voice-panel">
      {pack.params.filter((p) => paramVisible(p, params)).map((p) => (
        <SkillParamControl key={p.id} p={p} values={params} onChange={setParam} />
      ))}
      <div className="field">
        <label className="flex items-center justify-between">
          <span>{pack.input.label}</span>
          {stats.chars > 0 && <span className="skill-param-value" data-testid="voice-stats">{stats.chars} 字 · 约 {stats.seconds}s</span>}
        </label>
        <textarea
          rows={6}
          data-testid="voice-script"
          maxLength={pack.input.maxLength}
          placeholder="粘贴口播文案…"
          value={script}
          onChange={(e) => setScript(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit() }}
        />
      </div>
      <label className="flex items-center gap-2 text-[11px] px-0.5 cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
        <input type="checkbox" checked={autoTimeline} data-testid="voice-auto-timeline" onChange={(e) => setAutoTimeline(e.target.checked)} />
        自动入轨
      </label>
      <button type="button" className="btn btn-primary" data-testid="tts-generate" disabled={!stats.chars || submitting} onClick={() => void submit()}>
        {submitting ? <Loader2 size={13} className="animate-spin" /> : <Mic size={13} />}
        生成配音
      </button>
      <p className="text-[10px] m-0 px-0.5" style={{ color: 'var(--text-muted)' }}>字幕：在时间轴选中配音片段（可多选），右键「烧录字幕」。</p>
      {error && <p className="text-[11px] m-0 px-1 ai-error-in" style={{ color: 'var(--error)' }} data-testid="voice-error">{error}</p>}

      {jobs.length > 0 && (
        <div className="field" data-testid="tts-jobs">
          <label>配音</label>
          <div className="flex flex-col gap-1.5">
            {jobs.slice(0, 12).map((j) => (
              <TtsJobCard key={j.id} pack={pack} j={j} onRetry={() => void retry(j.id)} onRemove={() => void remove(j.id)} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
