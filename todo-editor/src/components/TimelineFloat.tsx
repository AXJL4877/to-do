import { useRef, useState } from 'react'
import { PanelBottomClose, PanelBottomOpen } from 'lucide-react'
import { useApp } from '../store'
import { TimelineDock } from './TimelineDock'
import { desktop } from '../lib/desktop'
import { openTimelinePopoutBrowser, openTimelinePopoutElectron } from '../lib/timelinePopout'

/** 应用内浮窗回退：独立窗口打不开时仍能用时间轴/K帧 */
export function TimelineFloatWindow() {
  const setTimelineFloat = useApp((s) => s.setTimelineFloat)
  const [pos, setPos] = useState(() => ({
    x: Math.max(24, Math.floor(window.innerWidth * 0.08)),
    y: Math.max(48, Math.floor(window.innerHeight * 0.42)),
    w: Math.min(1100, Math.floor(window.innerWidth * 0.84)),
    h: Math.min(380, Math.floor(window.innerHeight * 0.42)),
  }))
  const drag = useRef<{ mx: number; my: number; x: number; y: number } | null>(null)

  function onHeaderDown(e: React.PointerEvent) {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    drag.current = { mx: e.clientX, my: e.clientY, x: pos.x, y: pos.y }
    const move = (ev: PointerEvent) => {
      const d = drag.current
      if (!d) return
      setPos((p) => ({
        ...p,
        x: Math.max(0, d.x + (ev.clientX - d.mx)),
        y: Math.max(0, d.y + (ev.clientY - d.my)),
      }))
    }
    const up = () => {
      drag.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div
      className="fixed z-40 flex flex-col rounded-lg border shadow-2xl overflow-hidden"
      style={{
        left: pos.x,
        top: pos.y,
        width: pos.w,
        height: pos.h,
        background: 'var(--surface-1)',
        borderColor: 'var(--border)',
      }}
      data-testid="timeline-float"
    >
      <div
        className="shrink-0 h-7 flex items-center gap-2 px-2 cursor-grab active:cursor-grabbing select-none border-b"
        style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
        onPointerDown={onHeaderDown}
        data-testid="timeline-float-header"
      >
        <span className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>
          时间轴 / K帧
        </span>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>应用内浮窗 · 拖标题移动</span>
        <div className="flex-1" />
        <button
          type="button"
          className="icon-btn"
          style={{ width: 24, height: 24 }}
          data-testid="timeline-float-dock"
          title="还原到底部"
          onClick={() => setTimelineFloat(false)}
        >
          <PanelBottomClose size={13} />
        </button>
      </div>
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <TimelineDock fill />
      </div>
    </div>
  )
}

function fallBackPanel(msg: string) {
  useApp.setState({
    timelineFloat: true,
    timelineFloatKind: 'panel',
  })
  useApp.getState().setToast(msg)
}

export function TimelineFloatLaunch() {
  return (
    <button
      type="button"
      className="icon-btn shrink-0"
      data-testid="btn-timeline-float"
      title="弹出独立时间轴窗口（可拖到副屏；失败则应用内浮窗）"
      onClick={() => {
        const d = desktop()
        if (d?.openTimelineWindow) {
          // 先藏主窗时间轴，避免独立窗打开期间叠两份
          useApp.setState({ timelineFloat: true, timelineFloatKind: 'window' })
          void openTimelinePopoutElectron().then((ok) => {
            if (!ok) fallBackPanel('独立窗口打开失败，已改用应用内浮窗')
          })
          return
        }
        const r = openTimelinePopoutBrowser()
        if (r.ok) {
          useApp.setState({ timelineFloat: true, timelineFloatKind: 'window' })
        } else {
          fallBackPanel('独立窗口被拦截，已改用应用内浮窗')
        }
      }}
    >
      <PanelBottomOpen size={13} />
    </button>
  )
}
