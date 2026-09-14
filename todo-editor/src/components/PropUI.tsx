import clsx from 'clsx'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState, type ButtonHTMLAttributes, type ReactNode } from 'react'

export function PropSection({
  title,
  children,
  defaultOpen = true,
  dense,
}: {
  title?: string
  children: ReactNode
  defaultOpen?: boolean
  /** 更紧凑的内边距 */
  dense?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  if (!title) {
    return (
      <section
        className={clsx('rounded-[10px] border flex flex-col', dense ? 'p-1.5 gap-1.5' : 'p-2.5 gap-2')}
        style={{ borderColor: 'var(--border)', background: 'var(--surface-0)' }}
      >
        {children}
      </section>
    )
  }
  return (
    <section
      className={clsx('rounded-[10px] border flex flex-col', dense ? 'p-1.5 gap-1.5' : 'p-2 gap-1.5')}
      style={{ borderColor: 'var(--border)', background: 'var(--surface-0)' }}
    >
      <button
        type="button"
        className="flex items-center gap-1 w-full text-left"
        onClick={() => setOpen((v) => !v)}
        title={open ? '收起' : '展开'}
      >
        {open ? <ChevronDown size={12} className="shrink-0 opacity-50" /> : <ChevronRight size={12} className="shrink-0 opacity-50" />}
        <h3 className="text-[10px] font-semibold uppercase tracking-wider m-0" style={{ color: 'var(--text-muted)' }}>
          {title}
        </h3>
      </button>
      {open && children}
    </section>
  )
}

export function PropGrid({ children, cols = 2 }: { children: ReactNode; cols?: 2 | 3 | 5 }) {
  return (
    <div
      className={clsx(
        'grid gap-1 w-full',
        cols === 5 ? 'grid-cols-5' : cols === 3 ? 'grid-cols-3' : 'grid-cols-2',
      )}
    >
      {children}
    </div>
  )
}

export function PropBtn({
  active,
  className,
  children,
  compact,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean; compact?: boolean }) {
  return (
    <button
      type="button"
      className={clsx(
        'w-full min-w-0 px-1.5 rounded-lg border text-[11px] font-medium',
        'inline-flex items-center justify-center gap-1 shrink-0',
        'transition-colors',
        compact ? 'h-7' : 'h-9 px-2',
        active
          ? 'border-[hsl(18_76%_46%/0.4)] bg-[var(--accent-dim)] text-[var(--accent)]'
          : 'border-[var(--border)] bg-[var(--surface-1)] text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

export function PropCallout({ children, ...rest }: { children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className="rounded-[10px] border px-2.5 py-2 text-[11px] leading-relaxed"
      style={{ borderColor: 'var(--border)', background: 'var(--surface-2)', color: 'var(--text-muted)' }}
      {...rest}
    >
      {children}
    </div>
  )
}

/** 一行：标签 + 控件，减少纵向占位 */
export function PropRow({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="flex items-center gap-1.5 min-h-7" title={title}>
      <span className="text-[10px] w-8 shrink-0" style={{ color: 'var(--text-muted)' }}>{label}</span>
      <div className="flex-1 min-w-0 flex items-center gap-1">{children}</div>
    </div>
  )
}
