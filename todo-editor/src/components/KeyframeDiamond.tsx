import { Diamond } from 'lucide-react'
import clsx from 'clsx'
import type { MouseEvent } from 'react'

type Props = {
  active: boolean
  testId?: string
  title?: string
  onClick: (e?: MouseEvent) => void
}

export function KeyframeDiamond({ active, testId, title, onClick }: Props) {
  return (
    <button
      type="button"
      className={clsx(
        'w-7 h-7 shrink-0 mt-0.5 grid place-items-center rounded-md border transition-colors',
        active
          ? 'border-[hsl(0_0%_46%/0.35)] bg-[var(--accent-dim)] text-[var(--accent)]'
          : 'border-[var(--border)] bg-[var(--surface-1)] text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--surface-2)]',
      )}
      data-testid={testId}
      title={title ?? (active ? '当前位置已有关键帧（点击更新）' : '在当前播放头打关键帧')}
      aria-label={title ?? '关键帧'}
      onClick={(e) => {
        e.stopPropagation()
        onClick(e)
      }}
    >
      <Diamond size={12} strokeWidth={active ? 2.25 : 1.75} fill={active ? 'currentColor' : 'none'} />
    </button>
  )
}
