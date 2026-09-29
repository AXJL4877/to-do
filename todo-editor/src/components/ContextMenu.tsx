import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { usePreviewSuspend } from '../hooks/usePreviewSuspend'

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
  usePreviewSuspend(true, 'menu')
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const close = () => onCloseRef.current()
    // 打开菜单的那次 contextmenu 可能还在冒泡（Electron 里 effect 会在冒泡途中挂上），推迟一拍再监听
    const t = window.setTimeout(() => {
      window.addEventListener('click', close)
      window.addEventListener('contextmenu', close)
      window.addEventListener('scroll', close, true)
    }, 0)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [])

  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  // 靠近窗口右 / 下边缘时往回翻，保证整个菜单可见
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const pad = 6
    setPos({
      left: Math.max(pad, x + width > window.innerWidth - pad ? x - width : x),
      top: Math.max(pad, y + height > window.innerHeight - pad ? Math.max(pad, window.innerHeight - pad - height) : y),
    })
  }, [x, y, items.length])

  return (
    <div
      ref={ref}
      className="fixed z-[100] min-w-[180px] rounded-lg border py-1 shadow-lg overflow-y-auto"
      style={{ left: pos.left, top: pos.top, maxHeight: 'calc(100vh - 12px)', background: 'var(--surface-1)', borderColor: 'var(--border)' }}
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
