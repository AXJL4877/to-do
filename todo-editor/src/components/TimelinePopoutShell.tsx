import { useEffect, useRef } from 'react'
import { TimelineDock } from './TimelineDock'
import { desktop } from '../lib/desktop'

/** 独立时间轴窗：轨道高度自适应，窗口跟内容收紧（超出屏幕则内滚） */
export function TimelinePopoutShell() {
  const rootRef = useRef<HTMLDivElement>(null)
  const lastH = useRef(0)

  useEffect(() => {
    document.documentElement.style.height = 'auto'
    document.body.style.height = 'auto'
    const root = document.getElementById('root')
    if (root) root.style.height = 'auto'
    return () => {
      document.documentElement.style.height = ''
      document.body.style.height = ''
      if (root) root.style.height = ''
    }
  }, [])

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    let raf = 0
    const maxH = () => Math.max(200, Math.floor((window.screen?.availHeight || window.innerHeight) * 0.85))
    const sync = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const raw = Math.ceil(Math.max(el.scrollHeight, el.getBoundingClientRect().height))
        const h = Math.min(raw, maxH())
        if (h < 120 || Math.abs(h - lastH.current) < 2) return
        lastH.current = h
        void desktop()?.resizeTimelineWindow?.({ height: h })
      })
    }
    sync()
    const ro = new ResizeObserver(() => sync())
    ro.observe(el)
    // 主窗快照到达后轨道数量会变，再跟一次
    const t1 = window.setTimeout(sync, 300)
    const t2 = window.setTimeout(sync, 900)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.clearTimeout(t1)
      window.clearTimeout(t2)
    }
  }, [])

  return (
    <div
      ref={rootRef}
      className="min-h-0 flex flex-col overflow-y-auto outline-none"
      style={{ background: 'var(--surface-0)', maxHeight: '85vh' }}
      data-testid="timeline-popout-shell"
      tabIndex={-1}
    >
      <TimelineDock fill={false} />
    </div>
  )
}
