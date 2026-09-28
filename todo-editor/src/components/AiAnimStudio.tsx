import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Clapperboard, Film, Grid3x3, ImageOff, Layers, Loader2, Scissors, Square, X } from 'lucide-react'
import clsx from 'clsx'
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
  keyframes: { modes: ('sheet' | 'sequence')[]; defaultMode: 'sheet' | 'sequence'; counts: number[]; defaultCount: number; align: string }
  playback: { fps: number[]; defaultFps: number; loops: ('forward' | 'pingpong')[]; defaultLoop: 'forward' | 'pingpong'; maxRepeat: number }
  image: { models: string[]; aspectRatios: string[]; defaultAspectRatio: string; resolutions: string[]; defaultResolution: string }
  cutout: { default: boolean; lockInputs: Record<string, string> } | null
}

export type AnimValues = {
  inputs: Record<string, string>
  mode: 'sheet' | 'sequence'
  frames: number
  beats: string[]
  fps: number
  loop: 'forward' | 'pingpong'
  repeat: number
  aspectRatio: string
  resolution: string
  model: string
  alpha: boolean
}

export function defaultAnimValues(pack: AnimPack): AnimValues {
  const inputs: Record<string, string> = {}
  for (const inp of pack.inputs) inputs[inp.id] = inp.type === 'select' ? inp.default : ''
  return {
    inputs,
    mode: pack.keyframes.defaultMode,
    frames: pack.keyframes.defaultCount,
    beats: Array(pack.keyframes.defaultCount).fill(''),
    fps: pack.playback.defaultFps,
    loop: pack.playback.defaultLoop,
    repeat: 1,
    aspectRatio: pack.image.defaultAspectRatio,
    resolution: pack.image.defaultResolution,
    model: pack.image.models[0],
    alpha: pack.cutout?.default ?? false,
  }
}

function playFrames(v: AnimValues) {
  const one = v.loop === 'pingpong' && v.frames > 2 ? v.frames * 2 - 2 : v.frames
  return one * v.repeat
}

const SHEET_GRID: Record<number, string> = { 4: '2×2', 6: '3×2', 8: '4×2', 9: '3×3', 12: '4×3' }

/** 风格动画弹窗：左侧动画包，右侧关键帧规划 + 输出设置，直接入队 */
export function AiAnimStudio({ anims, hasRef, onSubmit, onClose }: {
  anims: AnimPack[]
  hasRef: boolean
  onSubmit: (pack: AnimPack, v: AnimValues) => Promise<boolean>
  onClose: () => void
}) {
  const [packId, setPackId] = useState(anims[0]?.id ?? '')
  const pack = anims.find((a) => a.id === packId) ?? null
  const [value, setValue] = useState<AnimValues | null>(pack ? defaultAnimValues(pack) : null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function choose(id: string) {
    if (id === packId) return
    setPackId(id)
    const p = anims.find((a) => a.id === id)
    setValue(p ? defaultAnimValues(p) : null)
  }

  const ready = useMemo(() => !!pack && !!value
    && pack.inputs.every((inp) => inp.type !== 'text' || !inp.required || !!value.inputs[inp.id]?.trim()), [pack, value])

  async function submit() {
    if (!pack || !value || !ready || submitting) return
    setSubmitting(true)
    try {
      if (await onSubmit(pack, value)) onClose()
    } finally {
      setSubmitting(false)
    }
  }

  const set = (patch: Partial<AnimValues>) => value && setValue({ ...value, ...patch })
  const setFrames = (n: number) => value && setValue({
    ...value, frames: n, beats: Array.from({ length: n }, (_, i) => value.beats[i] ?? ''),
  })
  const locked = value?.alpha && pack?.cutout ? pack.cutout.lockInputs : {}
  const calls = value ? (value.mode === 'sheet' ? 1 : value.frames) : 0

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
                <p className="text-[10px] m-0 px-0.5" style={{ color: 'var(--text-muted)' }}>
                  {hasRef ? '已带参考图：角色外观以参考图为准' : '可在 AI 面板先截帧 / 上传参考图，锁定角色外观'}
                </p>
              </section>

              <section className="flex flex-col gap-2.5">
                <span className="eyebrow">关键帧规划</span>
                {pack.keyframes.modes.length > 1 && (
                  <div className="field">
                    <label>生成方式</label>
                    <div className="tab-row" data-testid="ai-anim-mode">
                      <button type="button" className={clsx('tab flex-1', value.mode === 'sheet' && 'active')} data-testid="ai-anim-mode-sheet" onClick={() => set({ mode: 'sheet' })}>
                        <Grid3x3 size={11} className="inline mr-1" />拼图一次出
                      </button>
                      <button type="button" className={clsx('tab flex-1', value.mode === 'sequence' && 'active')} data-testid="ai-anim-mode-sequence" onClick={() => set({ mode: 'sequence' })}>
                        <Layers size={11} className="inline mr-1" />逐帧生成
                      </button>
                    </div>
                    <span className="text-[10px] px-0.5" style={{ color: 'var(--text-muted)' }}>
                      {value.mode === 'sheet'
                        ? `一张 ${SHEET_GRID[value.frames]} 关键帧拼图后自动切格，角色最一致、最省（1 次生图）`
                        : `首帧定角色，其余帧以首帧为参考逐张重绘，画幅可选（${value.frames} 次生图）`}
                    </span>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <div className="field">
                    <label>关键帧数</label>
                    <select data-testid="ai-anim-frames" value={value.frames} onChange={(e) => setFrames(Number(e.target.value))}>
                      {pack.keyframes.counts.map((n) => <option key={n} value={n}>{n} 帧</option>)}
                    </select>
                  </div>
                  {value.mode === 'sequence' ? (
                    <div className="field">
                      <label>画幅</label>
                      <select data-testid="ai-anim-aspect" value={value.aspectRatio} onChange={(e) => set({ aspectRatio: e.target.value })}>
                        {pack.image.aspectRatios.map((a) => <option key={a} value={a}>{a}</option>)}
                      </select>
                    </div>
                  ) : (
                    <div className="field">
                      <label>分辨率</label>
                      <select data-testid="ai-anim-resolution" value={value.resolution} onChange={(e) => set({ resolution: e.target.value })}>
                        {pack.image.resolutions.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </div>
                  )}
                </div>
                <div className="field">
                  <label>分镜（可选 · 留空自动均分动作）</label>
                  <div className="flex flex-col gap-1" data-testid="ai-anim-beats">
                    {value.beats.map((b, i) => (
                      <div key={i} className="flex items-center gap-1.5">
                        <span className="shrink-0 w-5 text-[10px] text-right tabular-nums" style={{ color: 'var(--text-muted)' }}>{i + 1}</span>
                        <input
                          className="flex-1"
                          data-testid={`ai-anim-beat-${i}`}
                          maxLength={80}
                          placeholder={i === 0 ? '起始姿势，如：站立，手伸向桌上的杯子' : i === value.beats.length - 1 ? '结束姿势' : '中间姿势'}
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
                  {value.mode === 'sequence' && pack.image.resolutions.length > 1 && (
                    <div className="field">
                      <label>分辨率</label>
                      <select data-testid="ai-anim-resolution" value={value.resolution} onChange={(e) => set({ resolution: e.target.value })}>
                        {pack.image.resolutions.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </div>
                  )}
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
            </div>
          ) : (
            <div className="flex-1 grid place-items-center text-[12px]" style={{ color: 'var(--text-muted)' }}>没有可用的风格动画包</div>
          )}
        </div>

        <div className="px-4 py-3 border-t flex items-center gap-3" style={{ borderColor: 'var(--border)' }}>
          {value && (
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }} data-testid="ai-anim-summary">
              {value.frames} 关键帧 · {calls} 次生图 · 成片 {(playFrames(value) / value.fps).toFixed(1)} 秒 · {value.alpha ? '透明' : '不透明'}
            </span>
          )}
          <button type="button" className="btn btn-ghost ml-auto" onClick={onClose}>取消</button>
          <button
            type="button"
            className="btn btn-primary"
            data-testid="ai-anim-submit"
            disabled={!ready || submitting}
            onClick={() => void submit()}
          >
            {submitting ? <Loader2 size={13} className="animate-spin" /> : <Film size={13} />}
            {submitting ? '入队中…' : '生成动画 · 入队'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
