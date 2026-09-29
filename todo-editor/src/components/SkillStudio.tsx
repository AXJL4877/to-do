import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDown, ArrowUp, Blocks, Loader2, Plus, Sparkles, Trash2, Wand2, X } from 'lucide-react'
import clsx from 'clsx'
import {
  GROUP_LABELS, ROLE_LABELS, estimateTimings, optionLabel, paramVisible, planSkill, skillHasAlpha,
  type SkillElement, type SkillGroup, type SkillPack, type SkillParam, type SkillParams, type SkillPlan, type SkillRole,
} from '../lib/aiSkills'

export const ELEMENT_COLORS = ['#f4d35e', '#7cc6fe', '#f28482', '#84dcc6', '#c3a6ff', '#ffb870', '#a3d977', '#ff9ecb']

type Props = {
  pack: SkillPack
  prompt: string
  setPrompt: (v: string) => void
  params: SkillParams
  setParams: (v: SkillParams) => void
  plan: SkillPlan | null
  setPlan: (v: SkillPlan | null) => void
  autoTimeline: boolean
  setAutoTimeline: (v: boolean) => void
  onSubmit: () => Promise<boolean>
  onClose: () => void
}

/** 单个参数控件：≤4 个选项用分段按钮，更多用下拉；数值用滑杆 */
export function SkillParamControl({ p, values, onChange }: {
  p: SkillParam
  values: SkillParams
  onChange: (id: string, v: string | number) => void
}) {
  const v = values[p.id]
  if (p.type === 'number') {
    return (
      <div className="field" data-testid={`skill-param-${p.id}`}>
        <label className="flex items-center justify-between">
          <span>{p.label}</span>
          <span className="skill-param-value">
            {p.id === 'elements' && v === 0 ? 'AI 决定' : `${v}${p.unit ?? ''}`}
          </span>
        </label>
        <input type="range" min={p.min} max={p.max} step={p.step} value={Number(v)} title={p.hint} onChange={(e) => onChange(p.id, Number(e.target.value))} />
      </div>
    )
  }
  if (p.type === 'text') {
    const invalid = !!v && !new RegExp(p.pattern).test(String(v).trim())
    return (
      <div className="field" data-testid={`skill-param-${p.id}`}>
        <label>{p.label}</label>
        <input
          type="text"
          value={String(v ?? '')}
          maxLength={p.maxLength}
          placeholder={p.placeholder}
          title={p.hint}
          spellCheck={false}
          style={invalid ? { borderColor: 'var(--error)' } : undefined}
          onChange={(e) => onChange(p.id, e.target.value)}
        />
      </div>
    )
  }
  return (
    <div className="field" data-testid={`skill-param-${p.id}`}>
      <label>{p.label}</label>
      {p.options.length <= 4 ? (
        <div className="skill-seg">
          {p.options.map((o) => (
            <button
              key={o.value}
              type="button"
              className={clsx(v === o.value && 'active')}
              title={o.hint}
              data-testid={`skill-param-${p.id}-${o.value}`}
              onClick={() => onChange(p.id, o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
      ) : (
        <select value={String(v)} onChange={(e) => onChange(p.id, e.target.value)}>
          {p.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
    </div>
  )
}

/** 书写时间轴：每个元素一段，尾部停留单独一段 */
export function SkillTimingBar({ plan, duration, hold }: { plan: SkillPlan; duration: number; hold: number }) {
  const timings = estimateTimings(plan, duration, hold)
  const total = duration * 1000 || 1
  return (
    <div className="skill-timing" data-testid="skill-timing">
      {plan.elements.map((e, i) => (
        <div
          key={i}
          className="skill-timing-seg"
          style={{ width: `${(timings[i].durationMs / total) * 100}%`, background: ELEMENT_COLORS[i % ELEMENT_COLORS.length] }}
          title={`${e.label} · ${(timings[i].durationMs / 1000).toFixed(1)}s`}
        >
          <span>{i + 1}</span>
        </div>
      ))}
      {hold > 0 && (
        <div className="skill-timing-seg is-hold" style={{ width: `${((hold * 1000) / total) * 100}%` }} title={`停留 ${hold}s`}>
          <span>停</span>
        </div>
      )}
    </div>
  )
}

export function SkillStudio(props: Props) {
  const { pack, prompt, setPrompt, params, setParams, plan, setPlan, autoTimeline, setAutoTimeline, onSubmit, onClose } = props
  const [planning, setPlanning] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [plannedFor, setPlannedFor] = useState<string | null>(plan ? prompt : null)

  const max = pack.planner?.maxElements ?? 1
  const countParam = pack.planner?.countParam
  const countParamDef = pack.params.find((p) => p.id === countParam)
  const alpha = skillHasAlpha(pack, params)
  const duration = Number(params.duration ?? 8)
  const hold = Number(params.hold ?? 0)
  const groups = useMemo(() => {
    const out = new Map<SkillGroup, SkillParam[]>()
    for (const p of pack.params) {
      if (p.id === countParam) continue
      out.set(p.group, [...(out.get(p.group) ?? []), p])
    }
    return [...out.entries()]
  }, [pack, countParam])
  const preview = pack.previews[alpha ? 1 : 0] ?? pack.previews[0]
  const planValid = !plan || plan.elements.every((e) => e.draw.trim())
  const canSubmit = !!prompt.trim() && planValid && !submitting && !planning

  function setParam(id: string, v: string | number) {
    setParams({ ...params, [id]: v })
  }

  function writePlan(next: SkillPlan | null) {
    setPlan(next)
    if (countParam) setParams({ ...params, [countParam]: next ? next.elements.length : 0 })
  }

  function patchElement(i: number, patch: Partial<SkillElement>) {
    if (!plan) return
    writePlan({ ...plan, elements: plan.elements.map((e, j) => (j === i ? { ...e, ...patch } : e)) })
  }

  function moveElement(i: number, d: -1 | 1) {
    if (!plan) return
    const els = [...plan.elements]
    const j = i + d
    if (j < 0 || j >= els.length) return
    ;[els[i], els[j]] = [els[j], els[i]]
    writePlan({ ...plan, elements: els })
  }

  function removeElement(i: number) {
    if (!plan) return
    const els = plan.elements.filter((_, j) => j !== i)
    writePlan(els.length ? { ...plan, elements: els } : null)
  }

  function addElement() {
    const base = plan ?? { title: prompt.slice(0, 12), notes: '', elements: [] }
    if (base.elements.length >= max) return
    const role: SkillRole = base.elements.length ? 'support' : 'hero'
    writePlan({ ...base, elements: [...base.elements, { label: `元素 ${base.elements.length + 1}`, draw: '', role, weight: role === 'hero' ? 1.5 : 1 }] })
  }

  async function runPlan() {
    if (!prompt.trim() || planning) return
    setPlanning(true)
    setError(null)
    try {
      const next = await planSkill(pack.id, prompt.trim(), params)
      writePlan(next)
      setPlannedFor(prompt)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPlanning(false)
    }
  }

  async function submit() {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      if (await onSubmit()) onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  const elementCount = plan?.elements.length ?? (countParam && Number(params[countParam]) > 0 ? Number(params[countParam]) : null)
  const summary = [
    optionLabel(pack, 'size', params),
    `${duration}s`,
    alpha ? '透明通道' : optionLabel(pack, 'background', params),
    elementCount ? `${elementCount} 个元素` : '',
  ].filter(Boolean).join(' · ')

  return createPortal(
    <div className="modal-backdrop" data-testid="skill-studio" onClick={onClose}>
      <div
        className="modal"
        style={{ width: 'min(1040px, 100%)', height: 'min(720px, 92vh)', maxHeight: 'none' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
          <Blocks size={14} style={{ color: 'var(--accent)' }} />
          <span className="eyebrow">{pack.name}</span>
          <button className="icon-btn ml-auto" data-testid="skill-studio-close" onClick={onClose} aria-label="关闭">
            <X size={14} />
          </button>
        </div>

        <div className="flex flex-col md:flex-row flex-1 min-h-0 overflow-y-auto md:overflow-hidden">
          <div className="flex-1 md:min-h-0 md:overflow-y-auto p-4 flex flex-col gap-4">
            <section className="flex flex-col gap-2">
              <span className="eyebrow">{pack.input.label}</span>
              <textarea
                rows={3}
                className="skill-textarea"
                data-testid="skill-studio-prompt"
                maxLength={pack.input.maxLength}
                placeholder={pack.input.placeholder}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit() }}
              />
              <div>
                <button
                  type="button"
                  className={clsx('btn btn-ghost', plan && plannedFor !== null && plannedFor !== prompt && 'is-stale')}
                  data-testid="skill-plan"
                  disabled={!prompt.trim() || planning}
                  onClick={() => void runPlan()}
                >
                  {planning ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
                  {plan ? '重新拆解' : 'AI 拆解'}
                </button>
              </div>
            </section>

            <section className="flex flex-col gap-2" data-testid="skill-elements">
              <div className="flex items-center justify-between">
                <span className="eyebrow">元素 · {plan?.elements.length ?? 0}/{max}</span>
                {plan && (
                  <button type="button" className="link-btn" data-testid="skill-plan-clear" onClick={() => writePlan(null)}>
                    清空
                  </button>
                )}
              </div>
              {!plan && countParamDef && (
                <div className="max-w-[280px]">
                  <SkillParamControl p={countParamDef} values={params} onChange={setParam} />
                </div>
              )}
              {plan?.elements.map((el, i) => (
                <div key={i} className="skill-element" data-testid={`skill-element-${i}`}>
                  <span className="skill-element-index" style={{ background: ELEMENT_COLORS[i % ELEMENT_COLORS.length] }}>{i + 1}</span>
                  <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <input
                        className="skill-element-label"
                        value={el.label}
                        maxLength={12}
                        data-testid={`skill-element-label-${i}`}
                        onChange={(e) => patchElement(i, { label: e.target.value })}
                      />
                      <div className="skill-seg">
                        {(Object.keys(ROLE_LABELS) as SkillRole[]).map((r) => (
                          <button key={r} type="button" className={clsx(el.role === r && 'active')} onClick={() => patchElement(i, { role: r })}>
                            {ROLE_LABELS[r]}
                          </button>
                        ))}
                      </div>
                      <label className="skill-element-weight" title="书写时长权重">
                        时长
                        <input type="range" min={0.5} max={3} step={0.1} value={el.weight} onChange={(e) => patchElement(i, { weight: Number(e.target.value) })} />
                        <span>{el.weight.toFixed(1)}</span>
                      </label>
                      <span className="ml-auto flex items-center">
                        <button type="button" className="icon-btn" style={{ width: 24, height: 24 }} title="上移" disabled={i === 0} onClick={() => moveElement(i, -1)}><ArrowUp size={12} /></button>
                        <button type="button" className="icon-btn" style={{ width: 24, height: 24 }} title="下移" disabled={i === plan.elements.length - 1} onClick={() => moveElement(i, 1)}><ArrowDown size={12} /></button>
                        <button type="button" className="icon-btn" style={{ width: 24, height: 24 }} title="删除" data-testid={`skill-element-del-${i}`} onClick={() => removeElement(i)}><Trash2 size={12} /></button>
                      </span>
                    </div>
                    <textarea
                      rows={2}
                      className={clsx('skill-textarea', !el.draw.trim() && 'is-invalid')}
                      maxLength={240}
                      placeholder="画面描述"
                      data-testid={`skill-element-draw-${i}`}
                      value={el.draw}
                      onChange={(e) => patchElement(i, { draw: e.target.value })}
                    />
                  </div>
                </div>
              ))}
              {(plan?.elements.length ?? 0) < max && (
                <button type="button" className="skill-element-add" data-testid="skill-element-add" onClick={addElement}>
                  <Plus size={13} />添加元素
                </button>
              )}
              {plan && <SkillTimingBar plan={plan} duration={duration} hold={hold} />}
            </section>
          </div>

          <div className="md:w-[320px] shrink-0 md:min-h-0 md:overflow-y-auto p-4 flex flex-col gap-4 border-t md:border-t-0 md:border-l" style={{ borderColor: 'var(--border)', background: 'var(--surface-0)' }}>
            {preview && (
              <div className={clsx('skill-preview', alpha && 'is-alpha')}>
                <img src={preview} alt={pack.name} />
              </div>
            )}
            {groups.map(([g, list]) => {
              const shown = list.filter((p) => paramVisible(p, params))
              if (!shown.length) return null
              return (
                <section key={g} className="flex flex-col gap-2.5" data-testid={`skill-group-${g}`}>
                  <span className="eyebrow">{GROUP_LABELS[g]}</span>
                  {shown.map((p) => <SkillParamControl key={p.id} p={p} values={params} onChange={setParam} />)}
                </section>
              )
            })}
          </div>
        </div>

        <div className="flex items-center gap-3 px-4 py-3 border-t flex-wrap" style={{ borderColor: 'var(--border)' }}>
          <span className="text-[11px] min-w-0 flex-1 truncate" style={{ color: error ? 'var(--error)' : 'var(--text-secondary)' }} data-testid="skill-studio-summary">
            {error || summary}
          </span>
          <label className="flex items-center gap-1.5 text-[11px] cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
            <input type="checkbox" checked={autoTimeline} onChange={(e) => setAutoTimeline(e.target.checked)} />
            自动入轨
          </label>
          <button type="button" className="btn btn-ghost" onClick={onClose}>取消</button>
          <button type="button" className="btn btn-primary" data-testid="skill-studio-submit" disabled={!canSubmit} onClick={() => void submit()}>
            {submitting ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
            生成
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
