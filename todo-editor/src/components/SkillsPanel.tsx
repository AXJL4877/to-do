import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { Blocks, ChevronDown, ChevronLeft, ChevronRight, Loader2, Plus, RotateCcw, SlidersHorizontal, Sparkles, Trash2, Wand2 } from 'lucide-react'
import clsx from 'clsx'
import { useApp } from '../store'
import { aiFetch, aiUrl } from '../lib/aiFetch'
import { importAiJob, isSameAiMedia, shouldImport } from '../lib/aiJobImport'
import {
  CHALK_SKILL_ID, defaultSkillParams, enqueueSkill, fetchSkills, optionLabel, paramVisible, phasePercent, phaseText, speechSeconds,
  type SkillJob, type SkillPack, type SkillParams, type SkillPlan, type TimelinePlacement,
} from '../lib/aiSkills'
import { isNarratedJob, narratedStage, type NarratedJob } from '../lib/narratedTimeline'
import { createProduction, listProductions, type ProductionSummary } from '../lib/production'
import { forgetProduction, registerProduction } from '../lib/productionTimeline'
import { DynamicTextPanel } from './DynamicTextPanel'
import { DYNAMIC_TEXT_PACK } from '../lib/dynamicTextPack'
import { ProductionStudio } from './ProductionStudio'
import { PlacementControl, SkillParamControl, SkillStudio } from './SkillStudio'
import { CreativeProgress, progressThemeForJob } from './CreativeProgress'

const QUICK_FALLBACK = 4

/** 配音 / 字幕两类 skill 由配音面板和字幕烧录弹窗接管，这里只放出视频的 elements / narrated / production 管线 */
const isVideoSkill = (p: SkillPack) => p.pipeline === 'elements' || p.pipeline === 'narrated' || p.pipeline === 'production'
/** 成片的运行任务不单独列：成片卡片自己显示进度 */
const isVideoSkillJob = (j: SkillJob) =>
  j.kind === 'skill' && !['tts', 'subtitle', 'voice', 'production'].includes(j.params.skill?.pipeline ?? 'elements')
/** 早期任务没记 skill id，都是黑板手绘 */
const jobSkillId = (j: SkillJob) => j.params.skill?.id ?? CHALK_SKILL_ID

type Draft = { prompt: string; params: SkillParams; plan: SkillPlan | null }

const PLACEMENT_KEY = 'todo.skillPlacement'
const loadPlacement = (): TimelinePlacement => {
  try { return localStorage.getItem(PLACEMENT_KEY) === 'end' ? 'end' : 'playhead' } catch { return 'playhead' }
}

const SkillJobCard = memo(function SkillJobCard({ j, onRetry, onRemove }: { j: SkillJob; onRetry: (id: string) => void; onRemove: (id: string) => void }) {
  const media = useApp((s) => s.media)
  const addClipFromMedia = useApp((s) => s.addClipFromMedia)
  const out = j.params.output
  const pct = j.status === 'running' ? phasePercent(j.phase) : null
  const mediaId = j.resultUrl ? media.find((m) => isSameAiMedia(m, aiUrl(j.resultUrl!)))?.id : undefined
  const alpha = out?.alpha ?? j.params.skill?.alpha
  const finished = j.status === 'done' || j.status === 'imported'
  const stage = isNarratedJob(j) ? narratedStage(j as unknown as NarratedJob) : null
  const lastScene = stage?.scenes?.[stage.scenes.length - 1]
  const still = lastScene?.elements[lastScene.elements.length - 1]?.hold
  const failedEls = (j.params as { partial?: { failed?: unknown[] } }).partial?.failed?.length ?? 0
  const sceneCount = stage?.total ? `${stage.scenes?.length ?? 0}/${stage.total.scenes} 块黑板${j.params.autoTimeline ? '已入轨' : '已生成'}` : null

  return (
    <div className={clsx('skill-job', j.status === 'error' && 'is-error')} data-testid={`skill-job-${j.id}`}>
      <div className={clsx('skill-job-media', alpha && 'is-alpha')}>
        {stage ? (
          still ? <img src={aiUrl(still)} alt="" /> : (
            <div className="skill-job-placeholder">
              {j.status === 'error' ? '失败' : j.status === 'queued' ? '排队中' : <Loader2 size={16} className="animate-spin" />}
            </div>
          )
        ) : finished && out ? (
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
        {finished && mediaId && !stage && (
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
          <CreativeProgress
            theme={progressThemeForJob(j)}
            compact
            percent={pct}
            label={[phaseText(j.phase) || '进行中', sceneCount].filter(Boolean).join(' · ')}
          />
        ) : j.status === 'error' ? (
          <span className="text-[10px] line-clamp-2" style={{ color: 'var(--error)' }} title={j.error || ''}>{j.error}</span>
        ) : (
          <span className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>
            {j.status === 'queued' ? '排队中' : out ? `${out.duration.toFixed(1)}s${out.alpha ? ' · 透明' : ''}${sceneCount ? ` · ${sceneCount}` : ''}` : '完成'}
          </span>
        )}
      </div>
      <div className="flex flex-col shrink-0">
        {j.status === 'error' && (
          <button type="button" className="icon-btn" style={{ width: 22, height: 22 }} title={failedEls ? `只重试失败的 ${failedEls} 个元素（已成功的不重新生成）` : '重试（已完成的步骤直接复用）'} data-testid={`skill-job-retry-${j.id}`} onClick={() => onRetry(j.id)}>
            <RotateCcw size={11} />
          </button>
        )}
        {j.status !== 'running' && (
          <button type="button" className="icon-btn" style={{ width: 22, height: 22 }} title={j.status === 'queued' ? '取消' : '移除'} data-testid={`skill-job-del-${j.id}`} onClick={() => onRemove(j.id)}>
            <Trash2 size={11} />
          </button>
        )}
      </div>
    </div>
  )
})

/** 本工程里的一条成片：进度、规模，点开进工作台 */
const ProductionCard = memo(function ProductionCard({ p, onOpen, onRemove }: { p: ProductionSummary; onOpen: (id: string) => void; onRemove: (id: string) => void }) {
  const live = !!p.runningJobId || !!p.queuedJobId
  const failed = p.status?.failed?.length ?? 0
  const pct = p.status?.pct ?? 0
  return (
    <div className={clsx('skill-job', failed > 0 && !live && 'is-error')} data-testid={`production-card-${p.id}`}>
      <button type="button" className="skill-job-media" title="打开成片工作台" onClick={() => onOpen(p.id)}>
        <div className="skill-job-placeholder">{live ? <Loader2 size={16} className="animate-spin" /> : <Wand2 size={16} />}</div>
      </button>
      <button type="button" className="min-w-0 flex-1 flex flex-col gap-1 text-left" onClick={() => onOpen(p.id)}>
        <p className="m-0 text-[11px] leading-snug font-semibold truncate">{p.title || '成片'}</p>
        {live ? (
          <CreativeProgress
            theme="chalk"
            compact
            percent={pct}
            label={p.queuedJobId && !p.runningJobId ? '排队中' : phaseText(p.status?.phase) || '成片生成中'}
          />
        ) : (
          <span className="text-[10px] truncate" style={{ color: failed ? 'var(--error)' : 'var(--text-muted)' }} title={p.status?.error || p.status?.phase}>
            {[p.segments ? `${p.segments} 段 · ${p.boards} 块黑板 · ${p.duration.toFixed(1)}s` : '', phaseText(p.status?.phase)].filter(Boolean).join(' · ')}
          </span>
        )}
      </button>
      {!live && (
        <button type="button" className="icon-btn shrink-0" style={{ width: 22, height: 22 }} title="从本工程移除（时间轴上的片段保留）" onClick={() => onRemove(p.id)}>
          <Trash2 size={11} />
        </button>
      )}
    </div>
  )
})

/**
 * 媒体库「Skill」页，渐进展开：先只列技能（缩略图 + 说明）→ 点进某个技能才出描述框和生成
 * → 参数默认收成一行摘要 → 完整编辑在 SkillStudio 弹窗
 */
export function SkillsPanel() {
  const [packs, setPacks] = useState<SkillPack[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const selectedDynamicClip = useApp(s => s.sequences.find(q => q.id === s.activeSeqId)?.clips.find(c => c.id === s.selectedClipIds[0] && c.text?.fancy?.dynamic)?.id)
  const [selectedId, setSelectedId] = useState<string | null>(() => selectedDynamicClip ? DYNAMIC_TEXT_PACK.id : null)
  useEffect(() => { if (selectedDynamicClip) setSelectedId(DYNAMIC_TEXT_PACK.id) }, [selectedDynamicClip])
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [autoTimeline, setAutoTimeline] = useState(true)
  const [placement, setPlacementState] = useState<TimelinePlacement>(loadPlacement)
  const setPlacement = useCallback((v: TimelinePlacement) => {
    setPlacementState(v)
    try { localStorage.setItem(PLACEMENT_KEY, v) } catch { /* */ }
  }, [])
  const [paramsOpen, setParamsOpen] = useState(false)
  const [studioOpen, setStudioOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [jobs, setJobs] = useState<SkillJob[]>([])
  const [productions, setProductions] = useState<ProductionSummary[]>([])
  const [openProduction, setOpenProduction] = useState<string | null>(null)
  // 拼成字符串再比：每次返回新数组会让订阅一直判定为变化
  const productionIds = useApp((s) => Object.keys(s.settings.aiProductions ?? {}).join(','))

  const pack = packs?.find((p) => p.id === selectedId) ?? null
  const emptyDraft = useMemo<Draft>(() => ({ prompt: '', params: pack ? defaultSkillParams(pack) : {}, plan: null }), [pack])
  const draft = (pack && drafts[pack.id]) || emptyDraft
  const { prompt, params, plan } = draft

  const patchDraft = useCallback((patch: Partial<Draft>) => {
    if (!pack) return
    setDrafts((d) => ({ ...d, [pack.id]: { ...emptyDraft, ...d[pack.id], ...patch } }))
  }, [pack, emptyDraft])
  const setPrompt = useCallback((v: string) => patchDraft({ prompt: v }), [patchDraft])
  const setParams = useCallback((v: SkillParams) => patchDraft({ params: v }), [patchDraft])
  const setPlan = useCallback((v: SkillPlan | null) => patchDraft({ plan: v }), [patchDraft])

  function select(id: string | null) {
    setSelectedId(id)
    setParamsOpen(false)
    setError(null)
  }

  const refreshJobs = useCallback(async () => {
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
    try {
      const ids = Object.keys(useApp.getState().settings.aiProductions ?? {})
      setProductions(await listProductions(ids))
    } catch { /* */ }
  }, [])
  useEffect(() => { void refreshJobs() }, [productionIds, refreshJobs])

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
  const packProductions = pack ? productions.filter((p) => p.skillId === pack.id) : []
  const active = jobs.filter((j) => j.status === 'queued' || j.status === 'running').length
  const isProduction = pack?.pipeline === 'production'

  /** 成片：先建文档（登记入轨起点），再排一次运行；stopAfter=plan 只出分镜 */
  async function submitProduction(stopAfter?: 'plan'): Promise<boolean> {
    if (!pack || !prompt.trim()) return false
    setSubmitting(true)
    setError(null)
    try {
      const placeAt = useApp.getState().playhead
      const { production } = await createProduction({
        skillId: pack.id, script: prompt.trim(), params, autoTimeline, stopAfter,
        ...(autoTimeline ? { placement, ...(placement === 'playhead' ? { placeAt } : {}) } : {}),
      })
      registerProduction(production.id, { auto: autoTimeline, placement, placeAt, estimate: speechSeconds(prompt) })
      useApp.getState().setToast(stopAfter ? `${pack.name}：先配音、分段、拆分镜，好了在成片工作台里挑` : `${pack.name}已开始${autoTimeline ? '，配音和画面边生成边入轨' : ''}`)
      patchDraft({ prompt: '' })
      setOpenProduction(stopAfter ? production.id : null)
      void refreshJobs()
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      throw e
    } finally {
      setSubmitting(false)
    }
  }

  const removeProduction = useCallback((id: string) => {
    if (!window.confirm('从本工程移除这条成片？时间轴上已有的片段保留，之后不再自动更新')) return
    forgetProduction(id)
    void refreshJobs()
  }, [refreshJobs])

  async function submit(): Promise<boolean> {
    if (isProduction) return submitProduction()
    if (!pack || !prompt.trim()) return false
    setSubmitting(true)
    setError(null)
    try {
      const placeAt = useApp.getState().playhead
      await enqueueSkill({
        skillId: pack.id, prompt: prompt.trim(), params, plan, autoTimeline,
        ...(autoTimeline ? { placement, ...(placement === 'playhead' ? { placeAt } : {}) } : {}),
      })
      const where = !autoTimeline ? '' : placement === 'end' ? '，完成后接到时间线末尾' : `，从 ${placeAt.toFixed(1)}s 开始入轨`
      useApp.getState().setToast(`${pack.name}已入队${where}${active ? ` · 前面还有 ${active} 个` : ''}`)
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

  const retry = useCallback(async (id: string) => {
    const r = await aiFetch(`/api/ai-jobs/${id}/retry`, { method: 'POST' })
    const data = await r.json().catch(() => ({}))
    if (!data.ok) setError(data.error || '重试失败')
    void refreshJobs()
  }, [refreshJobs])

  const remove = useCallback(async (id: string) => {
    await aiFetch(`/api/ai-jobs/${id}`, { method: 'DELETE' })
    void refreshJobs()
  }, [refreshJobs])

  if (selectedId === DYNAMIC_TEXT_PACK.id) return <DynamicTextPanel onBack={() => select(null)} />

  if (!pack) {
    return (
      <div className="flex flex-col gap-1.5 p-1" data-testid="skill-picker">
        <button type="button" className="skill-card" data-testid="skill-pick-jizura-dynamic-text" onClick={() => select(DYNAMIC_TEXT_PACK.id)}>
          <span className="skill-card-thumb"><span style={{ fontSize: 22, fontWeight: 800, color: 'var(--accent)' }}>字</span></span>
          <span className="min-w-0 flex-1 flex flex-col gap-0.5"><span className="skill-card-name">{DYNAMIC_TEXT_PACK.name}</span><p className="skill-card-desc">{DYNAMIC_TEXT_PACK.description}</p></span>
          <ChevronRight size={14} />
        </button>
        {!packs && !loadError && <p className="editor-hint">正在加载其他拓展…</p>}
        {loadError && <p className="editor-hint">其他拓展暂不可用：{loadError}</p>}
        {(packs ?? []).map((p) => {
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
          rows={isProduction ? 8 : pack.pipeline === 'narrated' ? 6 : 3}
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
      {autoTimeline && <PlacementControl value={placement} onChange={setPlacement} />}

      <div className="flex gap-1.5">
        <button
          type="button"
          className="btn btn-primary flex-1"
          data-testid="skill-generate"
          disabled={!prompt.trim() || submitting}
          onClick={() => void submit().catch(() => {})}
        >
          {submitting ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
          {isProduction ? '一键成片' : '生成'}
        </button>
        {isProduction && (
          <button type="button" className="btn btn-ghost" title="先配音、分段、拆分镜，不生图不渲染：在工作台里挑好描述再出画面" data-testid="skill-plan-first"
            disabled={!prompt.trim() || submitting} onClick={() => void submitProduction('plan').catch(() => {})}>
            <Wand2 size={13} />先出分镜
          </button>
        )}
        <button type="button" className="btn btn-ghost" title="更多设置" aria-label="更多设置" data-testid="skill-more" onClick={() => setStudioOpen(true)}>
          <SlidersHorizontal size={13} />
        </button>
      </div>
      {error && <p className="text-[11px] m-0 px-1 ai-error-in" style={{ color: 'var(--error)' }} data-testid="skill-error">{error}</p>}

      {packProductions.length > 0 && (
        <div className="field" data-testid="skill-productions">
          <label>本工程的成片</label>
          <div className="flex flex-col gap-1.5">
            {packProductions.slice(0, 10).map((p) => (
              <ProductionCard key={p.id} p={p} onOpen={setOpenProduction} onRemove={removeProduction} />
            ))}
          </div>
        </div>
      )}
      {openProduction && (
        <ProductionStudio key={openProduction} id={openProduction} pack={(packs ?? []).find((x) => x.id === productions.find((p) => p.id === openProduction)?.skillId) ?? pack} onClose={() => setOpenProduction(null)} />
      )}

      {packJobs.length > 0 && (
        <div className="field" data-testid="skill-jobs">
          <label>任务</label>
          <div className="flex flex-col gap-1.5">
            {packJobs.slice(0, 10).map((j) => (
              <SkillJobCard key={j.id} j={j} onRetry={retry} onRemove={remove} />
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
          placement={placement}
          setPlacement={setPlacement}
          onSubmit={submit}
          onClose={() => setStudioOpen(false)}
        />
      )}
    </div>
  )
}
