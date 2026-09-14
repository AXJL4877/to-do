import { useEffect } from 'react'
import clsx from 'clsx'

export type MenuItem = {
  id: string
  label: string
  shortcut?: string
  disabled?: boolean
  danger?: boolean
  onClick: () => void
}

type Props = {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

/** 规范 2.3：右键菜单，不可用项置灰不隐藏 */
export function ContextMenu({ x, y, items, onClose }: Props) {
  useEffect(() => {
    const close = () => onClose()
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [onClose])

  return (
    <div
      className="fixed z-[100] min-w-[180px] rounded-lg border py-1 shadow-lg"
      style={{ left: x, top: y, background: 'var(--surface-1)', borderColor: 'var(--border)' }}
      data-testid="context-menu"
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((item) => (
        <button
          key={item.id}
          className={clsx(
            'w-full text-left px-3 py-1.5 text-[12px] flex justify-between gap-4',
            item.disabled && 'opacity-40 cursor-not-allowed',
            item.danger && !item.disabled && 'text-[var(--error)]',
          )}
          disabled={item.disabled}
          data-testid={`ctx-${item.id}`}
          onClick={() => { if (!item.disabled) { item.onClick(); onClose() } }}
        >
          <span>{item.label}</span>
          {item.shortcut && <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{item.shortcut}</span>}
        </button>
      ))}
    </div>
  )
}
