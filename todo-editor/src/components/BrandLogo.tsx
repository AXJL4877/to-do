import { Film } from 'lucide-react'

export function BrandLogo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2 min-w-0" data-testid="brand-logo">
      <div
        className="shrink-0 grid place-items-center rounded-[9px]"
        style={{ width: compact ? 28 : 32, height: compact ? 28 : 32, background: 'var(--surface-ink)' }}
      >
        <Film size={compact ? 13 : 15} color="var(--text-on-ink)" strokeWidth={1.75} />
      </div>
      <div className="min-w-0 leading-none">
        <div className="brand-mark" style={{ fontSize: compact ? '1rem' : '1.25rem' }}>TO DO</div>
        {!compact && <div className="eyebrow mt-0.5">Editor</div>}
      </div>
    </div>
  )
}
