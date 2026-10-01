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

const BARS = [0.35, 0.7, 0.45, 0.95, 0.55, 0.8, 0.4, 0.65, 0.5, 0.85, 0.6, 0.75]

/** 按任务类型挑进度主题 */
export function progressThemeForJob(j: {
  kind?: string
  params?: { skill?: { pipeline?: string; id?: string; name?: string }; engine?: string }
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

/**
 * 富有场景感的加载条：烧字幕=音频波形+扫光；文案=打字光标；封面=笔刷；导出=胶片齿孔等。
 */
export function CreativeProgress({ theme = 'orbit', percent = null, label, compact, className }: Props) {
  const known = percent != null && Number.isFinite(percent)
  const pct = known ? Math.max(0, Math.min(100, Math.round(percent!))) : null

  return (
    <div
      className={clsx('cp', `cp-${theme}`, compact && 'is-compact', className)}
      data-testid={`creative-progress-${theme}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct ?? undefined}
      aria-label={label || '进行中'}
    >
      {theme === 'wave' ? (
        <div className="cp-wave" aria-hidden>
          <div className="cp-wave-bars">
            {BARS.map((h, i) => (
              <span key={i} style={{ ['--h' as string]: h, ['--i' as string]: i }} />
            ))}
          </div>
          <div className="cp-wave-beam" />
          {pct != null ? <div className="cp-wave-fill" style={{ width: `${pct}%` }} /> : null}
        </div>
      ) : null}

      {theme === 'type' ? (
        <div className="cp-type" aria-hidden>
          <div className="cp-type-track">
            <span className="cp-type-ghost">标题 · 简介 · 标签</span>
            <span className="cp-type-write" style={pct != null ? { width: `${pct}%` } : undefined}>
              标题 · 简介 · 标签
            </span>
            <span className="cp-type-caret" />
          </div>
        </div>
      ) : null}

      {theme === 'brush' ? (
        <div className="cp-brush" aria-hidden>
          <div className="cp-brush-canvas">
            <div className="cp-brush-stroke" style={pct != null ? { width: `${Math.max(12, pct)}%` } : undefined} />
            <div className="cp-brush-tip" style={pct != null ? { left: `${Math.max(8, pct)}%` } : undefined} />
          </div>
        </div>
      ) : null}

      {theme === 'film' ? (
        <div className="cp-film" aria-hidden>
          <div className="cp-film-strip">
            {Array.from({ length: 8 }, (_, i) => (
              <span key={i} className="cp-film-frame" style={{ ['--i' as string]: i }} />
            ))}
          </div>
          {pct != null ? <div className="cp-film-fill" style={{ width: `${pct}%` }} /> : null}
        </div>
      ) : null}

      {theme === 'chalk' ? (
        <div className="cp-chalk" aria-hidden>
          <div className="cp-chalk-board">
            <div className="cp-chalk-dust" />
            <div className="cp-chalk-line" style={pct != null ? { width: `${pct}%` } : undefined} />
            <div className="cp-chalk-hand" style={pct != null ? { left: `${pct}%` } : undefined} />
          </div>
        </div>
      ) : null}

      {theme === 'orbit' ? (
        <div className="cp-orbit" aria-hidden>
          <div className="cp-orbit-track">
            <div className="cp-orbit-fill" style={pct != null ? { width: `${pct}%` } : undefined} />
            <div className="cp-orbit-glow" style={pct != null ? { left: `${pct}%` } : undefined} />
          </div>
        </div>
      ) : null}

      {(label || pct != null) && (
        <div className="cp-meta">
          {label ? <span className="cp-label">{label}</span> : null}
          {pct != null ? <span className="cp-pct tabular-nums">{pct}%</span> : null}
        </div>
      )}
    </div>
  )
}
