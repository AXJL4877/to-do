import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { RotateCcw, Save, X } from 'lucide-react'
import { useApp } from '../store'
import { defaultAudio, defaultColor, defaultTransform, uid, type Clip } from '../types'
import { resolveClipTransform } from '../lib/keyframeEval'
import {
  applyPresetKeyframes, defaultValues, findMotionPreset, MOTION_PRESETS, PRESET_GROUPS, presetDuration,
  resolveValues, type MotionPreset, type ParamValues, type PresetGroup,
} from '../lib/motionPresets'

interface CustomPreset { id: string; name: string; base: string; values: ParamValues }

const CUSTOM_KEY = 'todo-motion-custom'
const LOOP_PREVIEW = 2.4
const HOLD_AFTER = 0.6

function loadCustom(): CustomPreset[] {
  try {
    const list = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? '[]') as CustomPreset[]
    return Array.isArray(list) ? list.filter((c) => findMotionPreset(c.base)) : []
  } catch { return [] }
}

function previewPlan(preset: MotionPreset, values: ParamValues) {
  const T = presetDuration(preset, values) ?? LOOP_PREVIEW
  const clip: Clip = {
    id: `preview_${preset.id}`, trackId: '', name: '', start: 0, duration: T,
    inPoint: 0, outPoint: T, enabled: true, speed: 1, reverse: false, speedKeyframes: [],
    transform: defaultTransform(), color: defaultColor(), audio: defaultAudio(),
    effects: [], blend: 'normal', keyframes: {},
  }
  return {
    clip: applyPresetKeyframes(clip, preset, values, { t0: 0, t1: T, fps: 60 }),
    T,
    loop: preset.group === 'loop' ? T : T + HOLD_AFTER,
  }
}

function PresetPreview({ preset, values, active, className }: {
  preset: MotionPreset; values: ParamValues; active: boolean; className?: string
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const plan = useMemo(() => previewPlan(preset, values), [preset, values])

  useEffect(() => {
    const el = boxRef.current
    const wrap = wrapRef.current
    if (!el || !wrap) return
    if (!active) { el.style.transform = ''; el.style.opacity = ''; return }
    let raf = 0
    const start = performance.now()
    const tick = (now: number) => {
      const t = Math.min(plan.T, ((now - start) / 1000) % plan.loop)
      const tr = resolveClipTransform(plan.clip, t)
      const hw = wrap.clientWidth / 2, hh = wrap.clientHeight / 2
      el.style.transform = `translate(${tr.x * hw}px, ${tr.y * hh}px) rotate(${tr.rotation}deg) scale(${tr.scaleX})`
      el.style.opacity = String(tr.opacity)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [active, plan])

  return (
    <div ref={wrapRef} className={clsx('grid place-items-center rounded-md overflow-hidden', className)} style={{ background: 'var(--surface-2)' }}>
      <div ref={boxRef} className="w-5 h-5 rounded-[4px]" style={{ background: 'var(--accent)' }} />
    </div>
  )
}

function PresetCard({ preset, values, label, selected, onClick, onDelete, testId }: {
  preset: MotionPreset; values: ParamValues; label: string; selected: boolean
  onClick: () => void; onDelete?: () => void; testId: string
}) {
  const [hover, setHover] = useState(false)
  return (
    <button
      type="button"
      className={clsx('btn btn-ghost relative', selected && 'ring-2')}
      style={{ height: 'auto', padding: 6, flexDirection: 'column', alignItems: 'stretch', gap: 4, '--tw-ring-color': 'var(--accent)' } as React.CSSProperties}
      data-testid={testId}
      title={`${preset.desc}（悬停预览）`}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onClick={onClick}
    >
      <PresetPreview preset={preset} values={values} active={hover} className="h-10" />
      <span className="text-[11px] truncate text-center">{label}</span>
      {onDelete && (
        <span
          role="button"
          aria-label="删除"
          className="absolute top-0.5 right-0.5 icon-btn"
          style={{ width: 18, height: 18 }}
          onClick={(e) => { e.stopPropagation(); onDelete() }}
        >
          <X size={11} />
        </span>
      )}
    </button>
  )
}

export function MotionPresetLibrary() {
  const applyAnim = useApp((s) => s.applyAnimPreset)
  const hasSelection = useApp((s) => s.selectedClipIds.length > 0)
  const [group, setGroup] = useState<PresetGroup | 'mine'>('loop')
  const [selId, setSelId] = useState<string>('shake')
  const [customId, setCustomId] = useState<string | null>(null)
  const [valuesById, setValuesById] = useState<Record<string, ParamValues>>({})
  const [range, setRange] = useState<'clip' | 'playhead'>('clip')
  const [seconds, setSeconds] = useState(1)
  const [custom, setCustom] = useState<CustomPreset[]>(loadCustom)
  const [saveName, setSaveName] = useState<string | null>(null)

  const preset = findMotionPreset(selId) ?? MOTION_PRESETS[0]
  const values = useMemo(() => resolveValues(preset, valuesById[preset.id]), [preset, valuesById])
  const customName = customId ? custom.find((c) => c.id === customId)?.name : undefined

  useEffect(() => { localStorage.setItem(CUSTOM_KEY, JSON.stringify(custom)) }, [custom])

  const setValue = (key: string, v: number | string) =>
    setValuesById((m) => ({ ...m, [preset.id]: { ...values, [key]: v } }))

  const select = (id: string, vals?: ParamValues, cid: string | null = null) => {
    setSelId(id)
    setCustomId(cid)
    if (vals) setValuesById((m) => ({ ...m, [id]: { ...vals } }))
  }

  const saveCustom = () => {
    const name = (saveName ?? '').trim() || `${preset.name} · 自定义`
    const item: CustomPreset = { id: uid('mp'), name, base: preset.id, values: { ...values } }
    setCustom((l) => [...l, item])
    setCustomId(item.id)
    setSaveName(null)
  }

  const list = group === 'mine' ? [] : MOTION_PRESETS.filter((p) => p.group === group)
  const oneShot = preset.group !== 'loop'
  const anchorLabel = preset.group === 'in' ? '片段开头' : preset.group === 'out' ? '片段结尾' : '片段开头'

  return (
    <div className="grid gap-2" data-testid="motion-presets">
      <div className="eyebrow px-1">动效预设</div>
      <div className="tab-row">
        {PRESET_GROUPS.map((g) => (
          <button key={g.id} type="button" className={clsx('tab', group === g.id && 'active')} data-testid={`motion-group-${g.id}`} onClick={() => setGroup(g.id)}>
            {g.label}
          </button>
        ))}
        <button type="button" className={clsx('tab', group === 'mine' && 'active')} data-testid="motion-group-mine" onClick={() => setGroup('mine')}>
          我的{custom.length ? ` ${custom.length}` : ''}
        </button>
      </div>

      <div className="grid grid-cols-3 gap-1.5">
        {list.map((p) => (
          <PresetCard
            key={p.id}
            testId={`motion-${p.id}`}
            preset={p}
            label={p.name}
            values={resolveValues(p, valuesById[p.id])}
            selected={selId === p.id && !customId}
            onClick={() => select(p.id)}
          />
        ))}
        {group === 'mine' && custom.map((c) => {
          const base = findMotionPreset(c.base)!
          return (
            <PresetCard
              key={c.id}
              testId={`motion-custom-${c.id}`}
              preset={base}
              label={c.name}
              values={resolveValues(base, c.values)}
              selected={customId === c.id}
              onClick={() => select(c.base, c.values, c.id)}
              onDelete={() => { setCustom((l) => l.filter((x) => x.id !== c.id)); if (customId === c.id) setCustomId(null) }}
            />
          )
        })}
      </div>
      {group === 'mine' && custom.length === 0 && (
        <p className="text-[11px] px-1 m-0" style={{ color: 'var(--text-muted)' }}>调好参数后点「保存」，会出现在这里</p>
      )}

      <div className="grid gap-2 rounded-lg border p-2" style={{ borderColor: 'var(--border)' }} data-testid="motion-detail">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[12px] font-medium truncate">{customName ?? preset.name}</span>
          <span className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>{preset.desc}</span>
        </div>
        <PresetPreview preset={preset} values={values} active className="h-20" />

        <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
          {preset.params.map((p) => (
            <div key={p.key} className="field" data-testid={`motion-param-${p.key}`}>
              <label>
                {p.label}
                {p.type === 'range' && <span style={{ color: 'var(--text-muted)' }}> {Number(values[p.key]).toFixed(p.step < 1 ? (p.step < 0.1 ? 2 : 1) : 0)}{p.unit ?? ''}</span>}
              </label>
              {p.type === 'range' ? (
                <input type="range" min={p.min} max={p.max} step={p.step} value={Number(values[p.key])} onChange={(e) => setValue(p.key, Number(e.target.value))} />
              ) : (
                <select value={String(values[p.key])} onChange={(e) => setValue(p.key, e.target.value)}>
                  {p.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              )}
            </div>
          ))}
          <div className="field">
            <label>{oneShot ? '位置' : '范围'}</label>
            <select value={range} data-testid="motion-range" onChange={(e) => setRange(e.target.value as 'clip' | 'playhead')}>
              <option value="clip">{oneShot ? anchorLabel : '整个片段'}</option>
              <option value="playhead">{oneShot ? '从播放头开始' : '从播放头起'}</option>
            </select>
          </div>
          {!oneShot && range === 'playhead' && (
            <div className="field">
              <label>持续</label>
              <select value={seconds} data-testid="motion-seconds" onChange={(e) => setSeconds(Number(e.target.value))}>
                {[0.5, 1, 2, 3, 5, 10].map((s) => <option key={s} value={s}>{s} 秒</option>)}
              </select>
            </div>
          )}
        </div>

        {saveName !== null ? (
          <div className="flex gap-1">
            <input
              autoFocus
              className="flex-1 min-w-0"
              placeholder={`${preset.name} · 自定义`}
              value={saveName}
              data-testid="motion-save-name"
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') saveCustom(); if (e.key === 'Escape') setSaveName(null) }}
            />
            <button type="button" className="btn btn-primary" onClick={saveCustom}>保存</button>
            <button type="button" className="btn btn-ghost" onClick={() => setSaveName(null)}>取消</button>
          </div>
        ) : (
          <div className="flex gap-1">
            <button
              type="button"
              className="btn btn-primary flex-1"
              data-testid="motion-apply"
              onClick={() => applyAnim(preset.id, values, { range, seconds, label: customName })}
            >
              应用到选中片段
            </button>
            <button type="button" className="icon-btn" title="恢复默认参数" aria-label="恢复默认参数" data-testid="motion-reset" onClick={() => setValuesById((m) => ({ ...m, [preset.id]: defaultValues(preset) }))}>
              <RotateCcw size={13} />
            </button>
            <button type="button" className="icon-btn" title="保存为我的预设" aria-label="保存为我的预设" data-testid="motion-save" onClick={() => setSaveName('')}>
              <Save size={13} />
            </button>
          </div>
        )}
        {!hasSelection && (
          <p className="text-[11px] m-0" style={{ color: 'var(--text-muted)' }}>先在时间线选中画面片段；可撤销（Ctrl+Z）</p>
        )}
      </div>
    </div>
  )
}
