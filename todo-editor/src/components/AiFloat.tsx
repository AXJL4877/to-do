import { useEffect, useRef, useState } from 'react'
import { PanelBottomClose, PanelTopOpen } from 'lucide-react'
import { useApp } from '../store'
import { AiPanel } from './AiPanel'
import { desktop } from '../lib/desktop'
import { openAiPopoutBrowser, openAiPopoutElectron } from '../lib/aiPopout'
import { useResize } from '../hooks/useResize'

function fitPanel(p: { x: number; y: number; w: number; h: number }) {
  const w = Math.min(Math.max(300, p.w), Math.max(160, window.innerWidth - 16))
  const h = Math.min(Math.max(240, p.h), Math.max(180, window.innerHeight - 16))
  return { w, h, x: Math.max(8, Math.min(p.x, window.innerWidth - w - 8)), y: Math.max(8, Math.min(p.y, window.innerHeight - h - 8)) }
}

/** 应用内浮窗回退 */
export function AiFloatWindow() {
  const setAiFloat = useApp((s) => s.setAiFloat)
  const [pos, setPos] = useState(() => fitPanel({
    x: Math.max(24, Math.floor(window.innerWidth - 420)),
    y: Math.max(48, Math.floor(window.innerHeight * 0.12)),
    w: 380,
    h: Math.min(640, Math.floor(window.innerHeight * 0.78)),
  }))
  const resizeBy = (dx: number, dy: number) => setPos(p => fitPanel({ ...p,
    w: Math.min(p.w + dx, window.innerWidth - p.x - 8),
    h: Math.min(p.h + dy, window.innerHeight - p.y - 8),
  }))
  const onResize = useResize(resizeBy)
  useEffect(() => {
    const fit = () => setPos(p => fitPanel(p))
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])
  const drag = useRef<{ mx: number; my: number; x: number; y: number } | null>(null)

  function onHeaderDown(e: React.PointerEvent) {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    drag.current = { mx: e.clientX, my: e.clientY, x: pos.x, y: pos.y }
    const move = (ev: PointerEvent) => {
      const d = drag.current
      if (!d) return
      setPos((p) => fitPanel({
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
      data-testid="ai-float"
    >
      <div
        className="shrink-0 h-7 flex items-center gap-2 px-2 cursor-grab active:cursor-grabbing select-none border-b"
        style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
        onPointerDown={onHeaderDown}
        data-testid="ai-float-header"
      >
        <span className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>AI+</span>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>拖标题移动 · 拖右下角缩放</span>
        <div className="flex-1" />
        <button
          type="button"
          className="icon-btn"
          style={{ width: 24, height: 24 }}
          data-testid="ai-float-dock"
          title="还原到侧栏"
          onClick={() => setAiFloat(false)}
        >
          <PanelBottomClose size={13} />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-2">
        <AiPanel />
      </div>
      <div className="floating-resize-grip" role="button" tabIndex={0} aria-label="调整 AI 窗口大小"
        onPointerDown={onResize}
        onKeyDown={e => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
          e.preventDefault()
          resizeBy(e.key === 'ArrowLeft' ? -24 : e.key === 'ArrowRight' ? 24 : 0,
            e.key === 'ArrowUp' ? -24 : e.key === 'ArrowDown' ? 24 : 0)
        }} />
    </div>
  )
}

function fallBackPanel(msg: string) {
  useApp.setState({
    aiFloat: true,
    aiFloatKind: 'panel',
  })
  useApp.getState().setToast(msg)
}

export function AiFloatLaunch({ compact }: { compact?: boolean }) {
  return (
    <button
      type="button"
      className={compact ? 'icon-btn' : 'icon-btn shrink-0'}
      style={compact ? { width: 22, height: 22 } : undefined}
      data-testid="btn-ai-float"
      title="弹出独立 AI 窗口（可拖到副屏；失败则应用内浮窗）"
      onClick={() => {
        const d = desktop()
        if (d?.openAiWindow) {
          useApp.setState({ aiFloat: true, aiFloatKind: 'window' })
          void openAiPopoutElectron().then((ok) => {
            if (!ok) fallBackPanel('独立窗口打开失败，已改用应用内浮窗')
          })
          return
        }
        const r = openAiPopoutBrowser()
        if (r.ok) {
          useApp.setState({ aiFloat: true, aiFloatKind: 'window' })
        } else {
          fallBackPanel('独立窗口被拦截，已改用应用内浮窗')
        }
      }}
    >
      <PanelTopOpen size={compact ? 12 : 13} />
    </button>
  )
}
