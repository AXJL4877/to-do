import { useEffect, useMemo, useState } from 'react'
import { Blocks, ChevronDown, ChevronLeft, ChevronRight, Loader2, Plus, RotateCcw, SlidersHorizontal, Sparkles, Trash2, Wand2 } from 'lucide-react'
import clsx from 'clsx'
import { useApp } from '../store'
import { aiFetch, aiUrl } from '../lib/aiFetch'
import { importAiJob, shouldImport } from '../lib/aiJobImport'
import {
  CHALK_SKILL_ID, defaultSkillParams, enqueueSkill, fetchSkills, optionLabel, paramVisible, phasePercent, phaseText,
  type SkillJob, type SkillPack, type SkillParams, type SkillPlan,
} from '../lib/aiSkills'
import { SkillParamControl, SkillStudio } from './SkillStudio'

const QUICK_FALLBACK = 4

/** 配音 / 字幕两类 skill 由配音面板和字幕烧录弹窗接管，这里只放「描述 → 出视频」的 elements 管线 */
const isVideoSkill = (p: SkillPack) => p.pipeline === 'elements'
const isVideoSkillJob = (j: SkillJob) =>
  j.kind === 'skill' && !['tts', 'subtitle', 'voice'].includes(j.params.skill?.pipeline ?? 'elements')
/** 早期任务没记 skill id，都是黑板手绘 */
const jobSkillId = (j: SkillJob) => j.params.skill?.id ?? CHALK_SKILL_ID

type Draft = { prompt: string; params: SkillParams; plan: SkillPlan | null }

function SkillJobCard({ j, onRetry, onRemove }: { j: SkillJob; onRetry: () => void; onRemove: () => void }) {
  const media = useApp((s) => s.media)
  const addClipFromMedia = useApp((s) => s.addClipFromMedia)
  const out = j.params.output
  const pct = j.status === 'running' ? phasePercent(j.phase) : null
  const mediaId = j.resultUrl ? media.find((m) => m.url === aiUrl(j.resultUrl!))?.id : undefined
  const alpha = out?.alpha ?? j.params.skill?.alpha
  const finished = j.status === 'done' || j.status === 'imported'

  return (
    <div className={clsx('skill-job', j.status === 'error' && 'is-error')} data-testid={`skill-job-${j.id}`}>
      <div className={clsx('skill-job-media', alpha && 'is-alpha')}>
        {finished && out ? (
          <video
            src={aiUrl(out.video)}
            poster={aiUrl(out.still)}
            muted
            playsInline
            loop
            preload="none"
            onMouseEnter={(e) => void e.currentTarget.play().catch(() => {})}
            onMouseLeave={(e) => { e.currentTarget.pause(); e.currentTarget.currentTime = 0 }}
          />
        ) : (
          <div className="skill-job-placeholder">
            {j.status === 'error' ? '失败' : j.status === 'queued' ? '排队中' : <Loader2 size={16} className="animate-spin" />}
          </div>
        )}
        {finished && mediaId && (
          <button
            type="button"
            className="skill-job-add icon-btn"
            title="加入时间线"
            data-testid={`skill-job-add-${j.id}`}
            onClick={() => addClipFromMedia(mediaId, undefined, undefined, { preferFreeTrack: true, source: { type: 'ai', jobId: j.id, kind: 'skill' } })}
          >
            <Plus size={12} />
          </button>
        )}
      </div>
      <div className="min-w-0 flex-1 flex flex-col gap-1">
        <p className="m-0 text-[11px] leading-snug line-clamp-2" title={j.prompt}>{out?.plan?.title ? `〔${out.plan.title}〕` : ''}{j.prompt}</p>
        {j.status === 'running' ? (
          <>
            <div className="ai-progress"><div className={pct == null ? 'ai-progress-bar' : 'ai-progress-fill'} style={pct == null ? undefined : { width: `${pct}%` }} /></div>
            <span className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>{pct != null ? `${pct}%` : phaseText(j.phase) || '进行中'}</span>
          </>
        ) : j.status === 'error' ? (
          <span className="text-[10px] line-clamp-2" style={{ color: 'var(--error)' }} title={j.error || ''}>{j.error}</span>
        ) : (
          <span className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>
            {j.status === 'queued' ? '排队中' : out ? `${out.duration.toFixed(1)}s${out.alpha ? ' · 透明' : ''}` : '完成'}
          </span>
        )}
      </div>
      <div className="flex flex-col shrink-0">
        {j.status === 'error' && (
          <button type="button" className="icon-btn" style={{ width: 22, height: 22 }} title="重试" data-testid={`skill-job-retry-${j.id}`} onClick={onRetry}>
            <RotateCcw size={11} />
          </button>
        )}
        {j.status !== 'running' && (
          <button type="button" className="icon-btn" style={{ width: 22, height: 22 }} title={j.status === 'queued' ? '取消' : '移除'} data-testid={`skill-job-del-${j.id}`} onClick={onRemove}>
            <Trash2 size={11} />
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * 媒体库「Skill」页，渐进展开：先只列技能（缩略图 + 说明）→ 点进某个技能才出描述框和生成
 * → 参数默认收成一行摘要 → 完整编辑在 SkillStudio 弹窗
 */
export function SkillsPanel() {
  const [packs, setPacks] = useState<SkillPack[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [autoTimeline, setAutoTimeline] = useState(true)
  const [paramsOpen, setParamsOpen] = useState(false)
  const [studioOpen, setStudioOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [jobs, setJobs] = useState<SkillJob[]>([])

  const pack = packs?.find((p) => p.id === selectedId) ?? null
  const draft: Draft = (pack && drafts[pack.id]) || { prompt: '', params: pack ? defaultSkillParams(pack) : {}, plan: null }
  const { prompt, params, plan } = draft

  function patchDraft(patch: Partial<Draft>) {
    if (!pack) return
    setDrafts((d) => ({ ...d, [pack.id]: { ...draft, ...d[pack.id], ...patch } }))
  }
  const setPrompt = (v: string) => patchDraft({ prompt: v })
  const setParams = (v: SkillParams) => patchDraft({ params: v })
  const setPlan = (v: SkillPlan | null) => patchDraft({ plan: v })

  function select(id: string | null) {
    setSelectedId(id)
    setParamsOpen(false)
    setError(null)
  }

  async function refreshJobs() {
    try {
      const r = await aiFetch('/api/ai-jobs?limit=40')
      const data = await r.json()
      if (!data.ok) return
      const items = (data.items as SkillJob[]).filter(isVideoSkillJob)
      setJobs(items)
      for (const j of items) {
        if (shouldImport(j)) void importAiJob(j).catch((e) => setError(e instanceof Error ? e.message : String(e)))
      }
    } catch { /* */ }
  }

  useEffect(() => {
    fetchSkills()
      .then((list) => {
        const video = list.filter(isVideoSkill)
        setPacks(video)
        if (!video.length) setLoadError('还没有可用的技能包')
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
    void refreshJobs()
    const t = window.setInterval(() => void refreshJobs(), 2000)
    return () => window.clearInterval(t)
  }, [])

  const quick = useMemo(() => {
    if (!pack) return []
    const countParam = pack.planner?.countParam
    const ids = pack.quick ?? pack.params.filter((p) => p.id !== countParam).slice(0, QUICK_FALLBACK).map((p) => p.id)
    return ids.flatMap((id) => pack.params.filter((p) => p.id === id && paramVisible(p, params)))
  }, [pack, params])
  const packJobs = pack ? jobs.filter((j) => jobSkillId(j) === pack.id) : []
  const active = jobs.filter((j) => j.status === 'queued' || j.status === 'running').length

  async function submit(): Promise<boolean> {
    if (!pack || !prompt.trim()) return false
    setSubmitting(true)
    setError(null)
    try {
      await enqueueSkill({ skillId: pack.id, prompt: prompt.trim(), params, plan, autoTimeline })
      useApp.getState().setToast(`${pack.name}已入队${active ? ` · 前面还有 ${active} 个` : ''}`)
      const countParam = pack.planner?.countParam
      patchDraft({ plan: null, ...(countParam ? { params: { ...params, [countParam]: 0 } } : {}) })
      void refreshJobs()
      return true
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      throw e
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

  if (!packs || !packs.length) {
    return (
      <div className="py-8 text-center text-[12px]" style={{ color: loadError ? 'var(--error)' : 'var(--text-muted)' }} data-testid="skill-panel-loading">
        {loadError || <Loader2 size={16} className="animate-spin inline" />}
      </div>
    )
  }

  if (!pack) {
    return (
      <div className="flex flex-col gap-1.5 p-1" data-testid="skill-picker">
        {packs.map((p) => {
          const running = jobs.filter((j) => jobSkillId(j) === p.id && (j.status === 'queued' || j.status === 'running')).length
          return (
            <button key={p.id} type="button" className="skill-card" title={p.description} data-testid={`skill-pick-${p.id}`} onClick={() => select(p.id)}>
              <span className="skill-card-thumb">
                {p.previews[0] ? <img src={p.previews[0]} alt="" /> : <Blocks size={16} />}
              </span>
              <span className="min-w-0 flex-1 flex flex-col gap-0.5">
                <span className="flex items-center gap-1.5 min-w-0">
                  <span className="skill-card-name">{p.name}</span>
                  {running > 0 && <Loader2 size={11} className="animate-spin shrink-0" style={{ color: 'var(--accent)' }} />}
                </span>
                <p className="skill-card-desc">{p.description}</p>
              </span>
              <ChevronRight size={14} className="shrink-0" style={{ color: 'var(--text-muted)' }} />
            </button>
          )
        })}
      </div>
    )
  }

  const paramSummary = quick.map((p) => optionLabel(pack, p.id, params)).filter(Boolean).join(' · ')

  return (
    <div className="flex flex-col gap-2.5 p-1" data-testid="skill-panel">
      <div className="skill-head">
        <button type="button" className="icon-btn" style={{ width: 24, height: 24 }} title="返回技能列表" aria-label="返回技能列表" data-testid="skill-back" onClick={() => select(null)}>
          <ChevronLeft size={14} />
        </button>
        <span className="text-[12px] font-semibold truncate" title={pack.description}>{pack.name}</span>
      </div>

      <div className="field">
        <label>{pack.input.label}</label>
        <textarea
          rows={3}
          data-testid="skill-prompt"
          maxLength={pack.input.maxLength}
          placeholder={pack.input.placeholder ?? `${pack.input.label}…`}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit().catch(() => {}) }}
        />
        {plan && (
          <button type="button" className="skill-plan-chip" data-testid="skill-plan-chip" onClick={() => setStudioOpen(true)}>
            <Wand2 size={11} />{plan.elements.map((e) => e.label).join(' → ')}
          </button>
        )}
      </div>

      {quick.length > 0 && (
        <button type="button" className="skill-param-summary" data-testid="skill-param-summary" onClick={() => setParamsOpen((v) => !v)}>
          <span className="min-w-0 flex-1 truncate">{paramSummary}</span>
          <ChevronDown size={12} className="shrink-0" style={{ transform: paramsOpen ? 'rotate(180deg)' : undefined, transition: 'transform 160ms' }} />
        </button>
      )}
      {paramsOpen && quick.map((p) => (
        <SkillParamControl key={p.id} p={p} values={params} onChange={(id, v) => setParams({ ...params, [id]: v })} />
      ))}

      <label className="flex items-center gap-2 text-[11px] px-0.5 cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
        <input type="checkbox" checked={autoTimeline} data-testid="skill-auto-timeline" onChange={(e) => setAutoTimeline(e.target.checked)} />
        自动入轨
      </label>

      <div className="flex gap-1.5">
        <button
          type="button"
          className="btn btn-primary flex-1"
          data-testid="skill-generate"
          disabled={!prompt.trim() || submitting}
          onClick={() => void submit().catch(() => {})}
        >
          {submitting ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
          生成
        </button>
        <button type="button" className="btn btn-ghost" title="更多设置" aria-label="更多设置" data-testid="skill-more" onClick={() => setStudioOpen(true)}>
          <SlidersHorizontal size={13} />
        </button>
      </div>
      {error && <p className="text-[11px] m-0 px-1 ai-error-in" style={{ color: 'var(--error)' }} data-testid="skill-error">{error}</p>}

      {packJobs.length > 0 && (
        <div className="field" data-testid="skill-jobs">
          <label>任务</label>
          <div className="flex flex-col gap-1.5">
            {packJobs.slice(0, 10).map((j) => (
              <SkillJobCard key={j.id} j={j} onRetry={() => void retry(j.id)} onRemove={() => void remove(j.id)} />
            ))}
          </div>
        </div>
      )}
      {studioOpen && (
        <SkillStudio
          key={pack.id}
          pack={pack}
          prompt={prompt}
          setPrompt={setPrompt}
          params={params}
          setParams={setParams}
          plan={plan}
          setPlan={setPlan}
          autoTimeline={autoTimeline}
          setAutoTimeline={setAutoTimeline}
          onSubmit={submit}
          onClose={() => setStudioOpen(false)}
        />
      )}
    </div>
  )
}
