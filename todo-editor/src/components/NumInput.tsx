import { useRef } from 'react'
import clsx from 'clsx'

type Props = {
  label?: string
  value: number
  min?: number
  max?: number
  step?: number
  defaultValue?: number
  unit?: string
  testId?: string
  onChange: (v: number) => void
  showSlider?: boolean
}

/** 规范 2.4：标签拖拽 + 数值框 + 可选滑块 */
export function NumInput({
  label, value, min, max, step = 1, defaultValue = 0, unit, testId, onChange, showSlider = true,
}: Props) {
  const drag = useRef<{ x: number; v: number } | null>(null)

  function clamp(v: number) {
    let n = v
    if (min != null) n = Math.max(min, n)
    if (max != null) n = Math.min(max, n)
    return n
  }

  function onLabelPointerDown(e: React.PointerEvent) {
    e.preventDefault()
    drag.current = { x: e.clientX, v: value }
    const onMove = (ev: PointerEvent) => {
      if (!drag.current) return
      const dx = ev.clientX - drag.current.x
      const mult = ev.shiftKey ? 0.1 : ev.ctrlKey || ev.metaKey ? 5 : 1
      onChange(clamp(drag.current.v + dx * step * mult * 0.1))
    }
    const onUp = () => {
      drag.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const hasSlider = showSlider && min != null && max != null

  return (
    <div className={clsx('num-input-row', !label && 'num-input-row--bare')} data-testid={testId}>
      {label != null && label !== '' && (
        <label onPointerDown={onLabelPointerDown} title="左右拖拽调整；Shift 精调，Ctrl 大步">
          {label}
        </label>
      )}
      <div className="flex items-center gap-1">
        <input
          type="number"
          aria-label={label || testId || '数值'}
          value={Number.isFinite(value) ? value : 0}
          step={step}
          min={min}
          max={max}
          onChange={(e) => onChange(clamp(Number(e.target.value)))}
          onDoubleClick={() => onChange(defaultValue)}
          title="双击恢复默认"
        />
        {unit && <span className="text-[10px] w-4" style={{ color: 'var(--text-muted)' }}>{unit}</span>}
      </div>
      {hasSlider && (
        <input
          type="range"
          aria-label={`${label || testId || '数值'}滑块`}
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      )}
    </div>
  )
}
