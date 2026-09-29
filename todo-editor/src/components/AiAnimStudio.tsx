import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronRight, Clapperboard, Film, ImageOff, Loader2, Plus, Scissors, Sparkles, Square, X } from 'lucide-react'
import clsx from 'clsx'
import { aiFetch } from '../lib/aiFetch'
import type { StyleInput } from './AiStyleForm'

export type AnimPack = {
  id: string
  name: string
  version: string
  author: string
  description: string
  tags: string[]
  previews: string[]
  outputs: string[]
  inputs: StyleInput[]
  sprite: { grid: number; frames: number; align: string; segmentInput?: string | null; maxSegments?: number }
  playback: { fps: number[]; defaultFps: number; loops: ('forward' | 'pingpong')[]; defaultLoop: 'forward' | 'pingpong'; maxRepeat: number }
  image: { models: string[]; resolutions: string[]; defaultResolution: string }
  cutout: { default: boolean; lockInputs: Record<string, string> } | null
}

export type AnimValues = {
  inputs: Record<string, string>
  beats: string[]
  fps: number
  loop: 'forward' | 'pingpong'
  repeat: number
  resolution: string
  model: string
  alpha: boolean
  /** 第 2 段起每段的动作；第 1 段用 sprite.segmentInput 对应的输入 */
  segments: string[]
  /** 角色参照：auto 先生成角色设定图；ref 用 AI 面板参考图；reuse 沿用 characterFrom 任务的角色 */
  character: 'auto' | 'ref' | 'reuse'
  characterFrom: string | null
}

/** 已完成动画任务留下的角色参照图，可被新任务沿用 */
export type AnimCharacter = { jobId: string; url: string; name: string }

export function defaultAnimValues(pack: AnimPack, hasRef = false): AnimValues {
  const inputs: Record<string, string> = {}
  for (const inp of pack.inputs) inputs[inp.id] = inp.type === 'select' ? inp.default : ''
  return {
    inputs,
    beats: Array(pack.sprite.grid).fill(''),
    fps: pack.playback.defaultFps,
    loop: pack.playback.defaultLoop,
    repeat: 1,
    resolution: pack.image.defaultResolution,
    model: pack.image.models[0],
    alpha: pack.cutout?.default ?? false,
    segments: [],
    character: hasRef ? 'ref' : 'auto',
    characterFrom: null,
  }
}

function playFrames(v: AnimValues, frames: number) {
  const one = v.loop === 'pingpong' && frames > 2 ? frames * 2 - 2 : frames
  return one * v.repeat
}

/** 风格动画弹窗：左侧动画包，右侧精灵图分镜 + 输出设置，直接入队 */
export function AiAnimStudio({ anims, hasRef, characters, onSubmit, onClose }: {
  anims: AnimPack[]
  hasRef: boolean
  characters: AnimCharacter[]
  onSubmit: (pack: AnimPack, v: AnimValues) => Promise<boolean>
  onClose: () => void
}) {
  const [packId, setPackId] = useState(anims[0]?.id ?? '')
  const pack = anims.find((a) => a.id === packId) ?? null
  const [value, setValue] = useState<AnimValues | null>(pack ? defaultAnimValues(pack, hasRef) : null)
  const [submitting, setSubmitting] = useState(false)
  const [idea, setIdea] = useState('')
  /** AI 导演对当前 idea 的拆分结果；idea 改动后作废 */
  const [direction, setDirection] = useState<{ title: string; notes: string } | null>(null)
  const [directing, setDirecting] = useState(false)
  const [directErr, setDirectErr] = useState<string | null>(null)
  const [showDetail, setShowDetail] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function choose(id: string) {
    if (id === packId) return
    setPackId(id)
    const p = anims.find((a) => a.id === id)
    setValue(p ? defaultAnimValues(p, hasRef) : null)
    setDirection(null)
  }

  async function direct(): Promise<AnimValues | null> {
    if (!pack || !value || !idea.trim() || directing) return null
    setDirecting(true)
    setDirectErr(null)
    try {
      const r = await aiFetch('/api/ai-anim-direct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ animId: pack.id, idea: idea.trim() }),
      })
      const data = await r.json()
      if (!data.ok) throw new Error(data.error || 'AI 拆分失败')
      const d = data.direction as { title: string; notes: string; values: Pick<AnimValues, 'inputs' | 'segments' | 'beats' | 'fps' | 'loop' | 'repeat' | 'alpha'> }
      const next = { ...value, ...d.values }
      setValue(next)
      setDirection({ title: d.title, notes: d.notes })
      return next
    } catch (e) {
      setDirectErr(e instanceof Error ? e.message : String(e))
      return null
    } finally {
      setDirecting(false)
    }
  }

  const isReady = (v: AnimValues | null) => !!pack && !!v
    && pack.inputs.every((inp) => inp.type !== 'text' || !inp.required || !!v.inputs[inp.id]?.trim())
    && v.segments.every((s) => !!s.trim())
    && (v.character !== 'ref' || hasRef)
    && (v.character !== 'reuse' || !!v.characterFrom)
  const ready = useMemo(() => isReady(value), [pack, value, hasRef]) // eslint-disable-line react-hooks/exhaustive-deps
  /** 写了一句话但还没拆分：提交时先让 AI 拆分再入队 */
  const needsDirect = !!idea.trim() && !direction

  async function submit() {
    if (!pack || !value || submitting || directing) return
    if (!needsDirect && !ready) return
    setSubmitting(true)
    try {
      const v = needsDirect ? await direct() : value
      if (v && isReady(v) && await onSubmit(pack, v)) onClose()
    } finally {
      setSubmitting(false)
    }
  }

  const set = (patch: Partial<AnimValues>) => value && setValue({ ...value, ...patch })
  const locked = value?.alpha && pack?.cutout ? pack.cutout.lockInputs : {}
  const grid = pack?.sprite.grid ?? 5
  const frames = grid * grid
  const segInput = pack?.sprite.segmentInput ? pack.inputs.find((i) => i.id === pack.sprite.segmentInput) : undefined
  const maxSegs = segInput ? pack?.sprite.maxSegments ?? 1 : 1
  const sheets = 1 + (value?.segments.length ?? 0)
  const totalFrames = frames + (sheets - 1) * (frames - 1)
  const imageCalls = sheets + (value?.character === 'auto' ? 1 : 0)

  return createPortal(
    <div className="modal-backdrop" data-testid="ai-anim-studio" onClick={onClose}>
      <div
        className="modal"
        style={{ width: 'min(1000px, 100%)', height: 'min(700px, 92vh)', maxHeight: 'none' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
          <Clapperboard size={14} style={{ color: 'var(--accent)' }} />
          <span className="eyebrow">风格动画 · {anims.length}</span>
          <button className="icon-btn ml-auto" data-testid="ai-anim-close" onClick={onClose} aria-label="关闭">
            <X size={14} />
          </button>
        </div>

        <div className="flex flex-col md:flex-row flex-1 min-h-0 overflow-y-auto md:overflow-hidden">
          <div className="md:w-[300px] shrink-0 md:min-h-0 md:overflow-y-auto p-3 border-b md:border-b-0 md:border-r" style={{ borderColor: 'var(--border)' }}>
            <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))' }}>
              {anims.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  data-testid={`ai-anim-card-${a.id}`}
                  className={clsx('style-card group', packId === a.id && 'is-focused')}
                  onClick={() => choose(a.id)}
                >
                  <div className="style-card-media">
                    {a.previews[0]
                      ? <img src={a.previews[0]} alt={a.name} loading="lazy" />
                      : (
                        <div className="w-full h-full grid place-items-center" style={{ color: 'var(--text-muted)', background: 'linear-gradient(135deg, var(--surface-2), var(--accent-dim))' }}>
                          {a.previews.length ? <ImageOff size={22} /> : <Film size={24} style={{ color: 'var(--accent)' }} />}
                        </div>
                      )}
                  </div>
                  <div className="style-card-body">
                    <span className="style-card-name">{a.name}</span>
                    <span className="style-card-sub">{a.tags.slice(0, 3).join(' · ') || a.author}</span>
                  </div>
                </button>
              ))}
            </div>
            {pack && (
              <div className="mt-3 flex flex-col gap-1.5">
                <div className="flex items-baseline gap-2">
                  <span className="text-[14px] font-semibold">{pack.name}</span>
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>v{pack.version} · {pack.author}</span>
                </div>
                <p className="text-[11px] m-0 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{pack.description}</p>
                {pack.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1">{pack.tags.map((t) => <span key={t} className="style-tag">{t}</span>)}</div>
                )}
              </div>
            )}
          </div>

          {pack && value ? (
            <div className="flex-1 md:min-h-0 md:overflow-y-auto p-4 grid gap-4 md:grid-cols-2 content-start" data-testid={`ai-anim-form-${pack.id}`}>
              <section className="flex flex-col gap-2.5 md:col-span-2">
                <span className="eyebrow">一句话描述</span>
                <textarea
                  rows={3}
                  data-testid="ai-anim-idea"
                  maxLength={400}
                  placeholder="例如：上班族早上起床伸懒腰，然后刷牙，最后背上包出门"
                  value={idea}
                  onChange={(e) => { setIdea(e.target.value); setDirection(null) }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit() }}
                />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="btn btn-ghost"
                    data-testid="ai-anim-direct"
                    disabled={!idea.trim() || directing}
                    onClick={async () => { if (await direct()) setShowDetail(true) }}
                  >
                    {directing ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                    {directing ? 'AI 拆分中…' : 'AI 拆分 · 先看方案'}
                  </button>
                  <span className="text-[10px]" style={{ color: directErr ? 'var(--danger, #e11d48)' : 'var(--text-muted)' }} data-testid="ai-anim-direction">
                    {directErr
                      ?? (direction
                        ? `「${direction.title}」${sheets > 1 ? `分 ${sheets} 段` : '1 段'}${direction.notes ? ` · ${direction.notes}` : ''}`
                        : '直接点「生成」也行：AI 会自动写角色、拆分段和分镜')}
                  </span>
                </div>
                <div className="field">
                  <label>角色参照（保证每次生成同一个人物）</label>
                  <div className="tab-row" data-testid="ai-anim-character">
                    <button type="button" className={clsx('tab flex-1', value.character === 'auto' && 'active')} data-testid="ai-anim-char-auto" onClick={() => set({ character: 'auto' })}>
                      自动生成
                    </button>
                    <button type="button" className={clsx('tab flex-1', value.character === 'ref' && 'active')} data-testid="ai-anim-char-ref" disabled={!hasRef} onClick={() => set({ character: 'ref' })}>
                      用参考图
                    </button>
                    <button type="button" className={clsx('tab flex-1', value.character === 'reuse' && 'active')} data-testid="ai-anim-char-reuse" disabled={!characters.length} onClick={() => set({ character: 'reuse', characterFrom: value.characterFrom ?? characters[0]?.jobId ?? null })}>
                      沿用角色
                    </button>
                  </div>
                  {value.character === 'reuse' ? (
                    <div className="flex flex-wrap gap-1.5 pt-1" data-testid="ai-anim-char-list">
                      {characters.map((c) => (
                        <button
                          key={c.jobId}
                          type="button"
                          title={c.name}
                          data-testid={`ai-anim-char-${c.jobId}`}
                          className={clsx('rounded overflow-hidden border-2', value.characterFrom === c.jobId ? 'border-[var(--accent)]' : 'border-transparent')}
                          style={{ width: 52, height: 52, background: '#fff' }}
                          onClick={() => set({ characterFrom: c.jobId })}
                        >
                          <img src={c.url} alt={c.name} className="w-full h-full object-contain" />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <span className="text-[10px] px-0.5" style={{ color: 'var(--text-muted)' }}>
                      {value.character === 'ref'
                        ? '以 AI 面板的参考图作为角色设定，所有分段都参照它'
                        : `先按描述生成一张角色设定图（多 1 次生图），所有分段都参照它；生成后可在「沿用角色」里复用${hasRef ? '' : '。也可在 AI 面板截帧 / 上传参考图'}`}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="self-start flex items-center gap-1 text-[11px]"
                  style={{ color: 'var(--text-secondary)' }}
                  data-testid="ai-anim-detail-toggle"
                  onClick={() => setShowDetail((x) => !x)}
                >
                  {showDetail ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  详细设置（角色、分段动作、分镜、帧率等，AI 拆分后可在这里微调）
                </button>
              </section>

              {showDetail && (<>
              <section className="flex flex-col gap-2.5">
                <span className="eyebrow">角色与动作</span>
                {pack.inputs.map((inp) => (
                  <div className="field" key={inp.id}>
                    <label>{inp.label}{inp.type === 'text' && inp.required ? ' *' : ''}</label>
                    {inp.type === 'text' ? (
                      <textarea
                        rows={2}
                        data-testid={`ai-anim-input-${inp.id}`}
                        maxLength={inp.maxLength}
                        placeholder={inp.placeholder}
                        value={value.inputs[inp.id] ?? ''}
                        onChange={(e) => set({ inputs: { ...value.inputs, [inp.id]: e.target.value } })}
                      />
                    ) : (
                      <>
                        <select
                          data-testid={`ai-anim-input-${inp.id}`}
                          value={locked[inp.id] ?? value.inputs[inp.id] ?? inp.default}
                          disabled={inp.id in locked}
                          onChange={(e) => set({ inputs: { ...value.inputs, [inp.id]: e.target.value } })}
                        >
                          {inp.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                        {inp.id in locked && (
                          <span className="text-[10px] px-0.5" style={{ color: 'var(--text-muted)' }}>透明通道模式下固定，保证抠像干净</span>
                        )}
                      </>
                    )}
                  </div>
                ))}
                {maxSegs > 1 && segInput && (
                  <div className="field">
                    <label>长镜头分段（每段一张精灵图，下一段首帧接上一段末帧）</label>
                    <div className="flex flex-col gap-1" data-testid="ai-anim-segments">
                      <div className="flex items-center gap-1.5">
                        <span className="shrink-0 w-12 text-[10px] text-right" style={{ color: 'var(--text-muted)' }}>第 1 段</span>
                        <span className="flex-1 text-[11px] truncate" style={{ color: 'var(--text-secondary)' }}>
                          {value.inputs[segInput.id]?.trim() || `用上方「${segInput.label}」`}
                        </span>
                      </div>
                      {value.segments.map((s, i) => (
                        <div key={i} className="flex items-center gap-1.5">
                          <span className="shrink-0 w-12 text-[10px] text-right" style={{ color: 'var(--text-muted)' }}>第 {i + 2} 段</span>
                          <input
                            className="flex-1"
                            data-testid={`ai-anim-segment-${i + 1}`}
                            maxLength={segInput.type === 'text' ? segInput.maxLength : undefined}
                            placeholder="接着上一段的动作，如：转身走向门口"
                            value={s}
                            onChange={(e) => set({ segments: value.segments.map((x, j) => (j === i ? e.target.value : x)) })}
                          />
                          <button
                            type="button"
                            className="icon-btn"
                            aria-label="删除这一段"
                            onClick={() => set({ segments: value.segments.filter((_, j) => j !== i) })}
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                      {sheets < maxSegs && (
                        <button
                          type="button"
                          className="btn btn-ghost self-start"
                          data-testid="ai-anim-segment-add"
                          onClick={() => set({ segments: [...value.segments, ''] })}
                        >
                          <Plus size={12} />添加下一段（最多 {maxSegs} 段）
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </section>

              <section className="flex flex-col gap-2.5">
                <span className="eyebrow">精灵图</span>
                <div className="flex items-center gap-3" data-testid="ai-anim-sprite">
                  <div
                    className="shrink-0 grid gap-[2px] p-1 rounded"
                    style={{ gridTemplateColumns: `repeat(${grid}, 1fr)`, width: 64, height: 64, background: 'var(--surface-2)' }}
                    aria-hidden
                  >
                    {Array.from({ length: frames }, (_, i) => (
                      <span key={i} style={{ background: 'var(--accent-dim)', borderRadius: 1 }} />
                    ))}
                  </div>
                  <span className="text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                    {sheets > 1
                      ? `${sheets} 张 ${grid}×${grid} 精灵图接力，每张 ${frames} 帧，衔接处去重后共 ${totalFrames} 帧`
                      : `一次生成 ${grid}×${grid} 角色精灵图，自动切成 ${frames} 帧序列帧再拼成动画`}
                  </span>
                </div>
                {pack.image.resolutions.length > 1 && (
                  <div className="field">
                    <label>精灵图分辨率</label>
                    <select data-testid="ai-anim-resolution" value={value.resolution} onChange={(e) => set({ resolution: e.target.value })}>
                      {pack.image.resolutions.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>
                )}
                <div className="field">
                  <label>分镜（可选 · {sheets > 1 ? '仅作用于第 1 段 · ' : ''}每行 {grid} 帧一个阶段，留空自动均分动作）</label>
                  <div className="flex flex-col gap-1" data-testid="ai-anim-beats">
                    {value.beats.map((b, i) => (
                      <div key={i} className="flex items-center gap-1.5">
                        <span className="shrink-0 w-12 text-[10px] text-right tabular-nums" style={{ color: 'var(--text-muted)' }}>第 {i + 1} 行</span>
                        <input
                          className="flex-1"
                          data-testid={`ai-anim-beat-${i}`}
                          maxLength={80}
                          placeholder={i === 0 ? '起始阶段，如：站立，手伸向桌上的杯子' : i === value.beats.length - 1 ? '结束阶段' : '中间阶段'}
                          value={b}
                          onChange={(e) => set({ beats: value.beats.map((x, j) => (j === i ? e.target.value : x)) })}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              </section>

              <section className="flex flex-col gap-2.5 md:col-span-2">
                <span className="eyebrow">输出</span>
                <div className="grid gap-2 md:grid-cols-4 grid-cols-2">
                  <div className="field">
                    <label>帧率</label>
                    <select data-testid="ai-anim-fps" value={value.fps} onChange={(e) => set({ fps: Number(e.target.value) })}>
                      {pack.playback.fps.map((f) => <option key={f} value={f}>{f} fps</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label>播放</label>
                    <select data-testid="ai-anim-loop" value={value.loop} onChange={(e) => set({ loop: e.target.value as AnimValues['loop'] })}>
                      {pack.playback.loops.map((l) => <option key={l} value={l}>{l === 'pingpong' ? '往返' : '顺序'}</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label>重复</label>
                    <select data-testid="ai-anim-repeat" value={value.repeat} onChange={(e) => set({ repeat: Number(e.target.value) })}>
                      {Array.from({ length: pack.playback.maxRepeat }, (_, i) => i + 1).map((r) => <option key={r} value={r}>{r} 次</option>)}
                    </select>
                  </div>
                </div>
                {pack.cutout && (
                  <div className="field">
                    <label>透明通道</label>
                    <div className="tab-row" data-testid="ai-anim-alpha">
                      <button type="button" className={clsx('tab flex-1', value.alpha && 'active')} data-testid="ai-anim-alpha-on" onClick={() => set({ alpha: true })}>
                        <Scissors size={11} className="inline mr-1" />透明底 WebM
                      </button>
                      <button type="button" className={clsx('tab flex-1', !value.alpha && 'active')} data-testid="ai-anim-alpha-off" onClick={() => set({ alpha: false })}>
                        <Square size={11} className="inline mr-1" />保留背景 MP4
                      </button>
                    </div>
                    <span className="text-[10px] px-0.5" style={{ color: 'var(--text-muted)' }}>
                      {value.alpha ? '逐帧抠掉白底、统一裁边，可直接叠在画面上' : '输出完整画面，含背景'}
                    </span>
                  </div>
                )}
              </section>
              </>)}
            </div>
          ) : (
            <div className="flex-1 grid place-items-center text-[12px]" style={{ color: 'var(--text-muted)' }}>没有可用的风格动画包</div>
          )}
        </div>

        <div className="px-4 py-3 border-t flex items-center gap-3" style={{ borderColor: 'var(--border)' }}>
          {value && (
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }} data-testid="ai-anim-summary">
              {needsDirect
                ? `AI 拆分后生成 · 分段数由 AI 决定（最多 ${maxSegs} 段）`
                : `${sheets > 1 ? `${sheets} 张 ` : ''}${grid}×${grid} 精灵图 · ${totalFrames} 帧 · ${imageCalls} 次生图 · 成片 ${(playFrames(value, totalFrames) / value.fps).toFixed(1)} 秒 · ${value.alpha ? '透明' : '不透明'}`}
            </span>
          )}
          <button type="button" className="btn btn-ghost ml-auto" onClick={onClose}>取消</button>
          <button
            type="button"
            className="btn btn-primary"
            data-testid="ai-anim-submit"
            disabled={(!ready && !needsDirect) || submitting || directing}
            onClick={() => void submit()}
          >
            {submitting || directing ? <Loader2 size={13} className="animate-spin" /> : <Film size={13} />}
            {directing ? 'AI 拆分中…' : submitting ? '入队中…' : needsDirect ? '一键生成动画' : '生成动画 · 入队'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
