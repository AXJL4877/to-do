import clsx from 'clsx'

export type CreativeProgressTheme = 'wave' | 'type' | 'brush' | 'film' | 'chalk' | 'orbit'

type Props = {
  theme?: CreativeProgressTheme
  /** 0–100；不传则不定进度 */
  percent?: number | null
  label?: string
  /** 紧凑：任务卡片行内 */
  compact?: boolean
  className?: string
}

/** 按任务类型挑进度主题 */
export function progressThemeForJob(j: {
  kind?: string
  params?: { skill?: { pipeline?: string; id?: string; name?: string } | null; engine?: string }
}): CreativeProgressTheme {
  const pipe = j.params?.skill?.pipeline || ''
  const id = j.params?.skill?.id || ''
  const name = j.params?.skill?.name || ''
  if (pipe === 'subtitle' || id.includes('subtitle') || /字幕|烧录/.test(name)) return 'wave'
  if (pipe === 'tts' || pipe === 'voice' || id.includes('tts') || id.includes('voice')) return 'wave'
  if (pipe === 'chalk' || id.includes('chalk') || /黑板|粉笔/.test(name)) return 'chalk'
  if (j.kind === 'video' || j.params?.engine === 'h3') return 'film'
  if (j.kind === 'image') return 'brush'
  if (j.kind === 'audio') return 'wave'
  return 'orbit'
}

/** Monochrome pencil strokes; determinate progress never runs a fake loop. */
export function CreativeProgress({ theme = 'orbit', percent = null, label, compact, className }: Props) {
  const pct = percent != null && Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : null
  return (
    <div className={clsx('cp', 'cp-handdrawn', `cp-theme-${theme}`, compact && 'is-compact', pct == null && 'is-indeterminate', className)}
      data-testid={`creative-progress-${theme}`} role="progressbar" aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={pct ?? undefined} aria-valuetext={label} aria-label={label || '进行中'}>
      <div className="cp-sketch-track" aria-hidden="true">
        <div className="cp-sketch-fill" style={pct != null ? {width:`${pct}%`} : undefined} />
        <svg className="cp-sketch-outline" viewBox="0 0 300 20" preserveAspectRatio="none" fill="none">
          <path d="M3 3L78 2.3L146 3L222 2L297 3.1L296.2 17L226 17.8L147 17L74 18L2.5 17.3Z" />
          <path d="M5 1.5L108 1L209 1.7L298.5 1.4M298.5 4L299 15.6M294 19L203 18.8L99 19.2L1 19M1 15L1.5 4" />
        </svg>
        <div className="cp-sketch-ticks" />
      </div>
      {(label || pct != null) && <div className="cp-meta">{label ? <span className="cp-label" title={label}>{label}</span> : null}{pct != null ? <span className="cp-pct tabular-nums">{pct}%</span> : null}</div>}
    </div>
  )
}
