import { useCallback, useState, useSyncExternalStore, type ReactNode } from 'react'
import { MediaLibrary } from './MediaLibrary'
import { Monitor } from './Monitor'
import { AiPanel } from './AiPanel'
import { AiFloatLaunch } from './AiFloat'
import { useApp } from '../store'
import { useResize } from '../hooks/useResize'
import {
  beginDockDrag,
  getDockDrag,
  panelsIn,
  subscribeDockDrag,
  type DockPanel,
  type DockSlot,
} from '../lib/panelDock'
import clsx from 'clsx'
import { usePreviewSuspend } from '../hooks/usePreviewSuspend'

function ResizeHandle({ axis, onDelta, testId }: {
  axis: 'x' | 'y'
  onDelta: (dx: number, dy: number) => void
  testId?: string
}) {
  const onPointerDown = useResize(onDelta)
  return (
    <div
      className={clsx('resize-handle', axis === 'x' ? 'resize-handle-x' : 'resize-handle-y')}
      data-testid={testId ?? `resize-${axis}`}
      onPointerDown={onPointerDown}
    />
  )
}

function MonitorArea() {
  const monitorView = useApp((s) => s.monitorView)
  const setMonitorView = useApp((s) => s.setMonitorView)
  const [viewOpen, setViewOpen] = useState(false)
  usePreviewSuspend(viewOpen, 'menu')

  const viewLabel =
    monitorView === 'dual' ? '编辑+节目'
      : monitorView === 'edit' ? '编辑'
        : monitorView === 'source' ? '源'
          : '节目'

  return (
    <div className="flex flex-col flex-1 min-h-0 min-w-0" data-testid="monitor-area">
      <div className="flex items-center gap-1 px-1.5 py-0.5 shrink-0 relative" data-testid="monitor-view-tabs">
        <button
          type="button"
          className="tab active"
          data-testid="monitor-view-menu"
          onClick={() => setViewOpen((v) => !v)}
        >
          {viewLabel} ▾
        </button>
        {viewOpen && (
          <div
            className="absolute left-1 top-full z-20 mt-0.5 min-w-[132px] rounded-lg border p-1 shadow-lg menu-pop"
            style={{ background: 'var(--surface-1)', borderColor: 'var(--border)' }}
            data-testid="monitor-view-dropdown"
          >
            {([
              ['dual', '编辑 + 节目'],
              ['edit', '编辑窗'],
              ['program', '节目窗'],
              ['source', '源监视器'],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={clsx(
                  'w-full text-left px-2.5 py-1.5 rounded-md text-[12px]',
                  monitorView === id ? 'bg-[var(--accent-dim)] text-[var(--accent)]' : 'hover:bg-[var(--surface-2)]',
                )}
                data-testid={`monitor-view-${id}`}
                onClick={() => { setMonitorView(id); setViewOpen(false) }}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {monitorView === 'dual' && (
        <div className="flex flex-1 min-h-0 min-w-0 gap-1" data-testid="dual-monitors" onClick={() => setViewOpen(false)}>
          <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
            <Monitor mode="edit" />
          </div>
          <div className="w-px shrink-0 self-stretch" style={{ background: 'var(--border)' }} />
          <div className="flex-[1.15] min-w-0 min-h-0 overflow-hidden">
            <Monitor mode="program" />
          </div>
        </div>
      )}

      {monitorView === 'edit' && (
        <div className="flex-1 min-h-0 overflow-hidden" onClick={() => setViewOpen(false)}>
          <Monitor mode="edit" />
        </div>
      )}

      {monitorView === 'program' && (
        <div className="flex-1 min-h-0 overflow-hidden" onClick={() => setViewOpen(false)}>
          <Monitor mode="program" />
        </div>
      )}

      {monitorView === 'source' && (
        <div className="flex-1 min-h-0 overflow-hidden" onClick={() => setViewOpen(false)}>
          <Monitor mode="source" />
        </div>
      )}
    </div>
  )
}

function DockTitle({
  id,
  label,
  extra,
}: {
  id: DockPanel
  label: string
  extra?: ReactNode
}) {
  return (
    <div
      className="flex items-center justify-between px-3 py-2 border-b shrink-0 select-none cursor-grab active:cursor-grabbing"
      style={{ borderColor: 'var(--border)' }}
      data-testid={`dock-title-${id}`}
      title="拖到窗口左 / 右 / 下边缘停靠"
      onPointerDown={(e) => {
        beginDockDrag(id, e, (slot) => {
          useApp.getState().setLayout({ panelDock: { ...useApp.getState().layout.panelDock, [id]: slot } })
          if (id === 'ai') useApp.getState().setLibraryTab('media')
        })
      }}
    >
      <span className="eyebrow pointer-events-none">{label}</span>
      {extra}
    </div>
  )
}

function AiDockPanel() {
  const aiFloat = useApp((s) => s.aiFloat)
  const aiFloatKind = useApp((s) => s.aiFloatKind)
  const setAiFloat = useApp((s) => s.setAiFloat)
  const setLayout = useApp((s) => s.setLayout)
  const panelDock = useApp((s) => s.layout.panelDock)

  return (
    <aside className="panel h-full min-h-0 flex flex-col" data-testid="ai-dock">
      <DockTitle
        id="ai"
        label="AI+"
        extra={
          <div className="flex gap-0.5" onPointerDown={(e) => e.stopPropagation()}>
            <AiFloatLaunch compact />
            <button
              type="button"
              className="icon-btn"
              style={{ width: 22, height: 22 }}
              title="收回媒体库标签"
              data-testid="ai-dock-to-tab"
              onClick={() => {
                setAiFloat(false)
                setLayout({ panelDock: { ...panelDock, ai: 'tab' } })
                useApp.getState().setLibraryTab('ai')
              }}
            >
              <span className="text-[9px]">库</span>
            </button>
          </div>
        }
      />
      <div className="flex-1 min-h-0 overflow-y-auto p-2">
        {aiFloat && aiFloatKind === 'window' ? (
          <div className="grid place-items-center py-8 text-[12px]" style={{ color: 'var(--text-muted)' }}>
            已弹出独立窗口
          </div>
        ) : (
          <AiPanel hideTitle />
        )}
      </div>
    </aside>
  )
}

function MediaDockPanel() {
  return (
    <div className="h-full min-h-0 flex flex-col" data-testid="media-dock">
      <MediaLibrary />
    </div>
  )
}

function renderPanel(id: DockPanel) {
  return id === 'ai' ? <AiDockPanel key="ai" /> : <MediaDockPanel key="media" />
}

function DockStack({ ids, testId }: { ids: DockPanel[]; testId: string }) {
  if (ids.length === 0) return null
  if (ids.length === 1) {
    return <div className="h-full min-h-0 min-w-0" data-testid={testId}>{renderPanel(ids[0])}</div>
  }
  return (
    <div className="h-full min-h-0 min-w-0 flex flex-col gap-1" data-testid={testId}>
      <div className="flex-1 min-h-0">{renderPanel(ids[0])}</div>
      <div className="flex-1 min-h-0">{renderPanel(ids[1])}</div>
    </div>
  )
}

function DockDropOverlay() {
  const drag = useSyncExternalStore(subscribeDockDrag, getDockDrag, getDockDrag)
  if (!drag) return null
  const Slot = ({ slot, label, cls }: { slot: DockSlot; label: string; cls: string }) => (
    <div
      className={clsx('absolute grid place-items-center text-[11px] font-medium pointer-events-none', cls)}
      data-testid={`dock-zone-${slot}`}
      style={{
        background: drag.hover === slot
          ? 'color-mix(in oklab, var(--accent) 28%, transparent)'
          : 'color-mix(in oklab, var(--accent) 10%, transparent)',
        color: 'var(--accent)',
        outline: drag.hover === slot ? '2px solid var(--accent)' : '1px dashed color-mix(in oklab, var(--accent) 50%, transparent)',
      }}
    >
      {label}
    </div>
  )
  return (
    <div className="absolute inset-0 z-50 pointer-events-none" data-testid="dock-overlay">
      <Slot slot="left" label="停靠左侧" cls="top-2 bottom-2 left-2 w-[18%]" />
      <Slot slot="right" label="停靠右侧" cls="top-2 bottom-2 right-2 w-[18%]" />
      <Slot slot="bottom" label="停靠底部" cls="left-2 right-2 bottom-2 h-[26%]" />
    </div>
  )
}

/** 右侧属性栏已移除：改用片段旁渐进式属性轮盘 */
export function Workspace() {
  const layout = useApp((s) => s.layout)
  const setLayout = useApp((s) => s.setLayout)
  const dock = layout.panelDock ?? { media: 'left' as const, ai: 'tab' as const }
  const left = panelsIn('left', dock)
  const right = panelsIn('right', dock)
  const bottom = panelsIn('bottom', dock)

  const resizeSidebar = useCallback((dx: number) => {
    setLayout({ sidebarW: Math.min(420, Math.max(180, layout.sidebarW + dx)) })
  }, [layout.sidebarW, setLayout])
  const resizeRight = useCallback((dx: number) => {
    setLayout({ rightW: Math.min(420, Math.max(180, (layout.rightW ?? 280) - dx)) })
  }, [layout.rightW, setLayout])
  const resizeDock = useCallback((_dx: number, dy: number) => {
    setLayout({ dockH: Math.min(360, Math.max(140, (layout.dockH ?? 220) - dy)) })
  }, [layout.dockH, setLayout])

  return (
    <div className="nle-upper flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden relative" data-testid="workspace">
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {left.length > 0 && (
          <>
            <aside className="nle-panel-col shrink-0" style={{ width: layout.sidebarW }}>
              <DockStack ids={left} testId="dock-left" />
            </aside>
            <ResizeHandle axis="x" testId="resize-sidebar" onDelta={resizeSidebar} />
          </>
        )}
        <main className="nle-center flex-1 min-w-0 min-h-0 flex flex-col p-1 overflow-hidden">
          <MonitorArea />
        </main>
        {right.length > 0 && (
          <>
            <ResizeHandle axis="x" testId="resize-right" onDelta={resizeRight} />
            <aside className="nle-panel-col shrink-0" style={{ width: layout.rightW ?? 280 }}>
              <DockStack ids={right} testId="dock-right" />
            </aside>
          </>
        )}
      </div>
      {bottom.length > 0 && (
        <>
          <ResizeHandle axis="y" testId="resize-dock-bottom" onDelta={resizeDock} />
          <div className="shrink-0 min-h-0 px-1 pb-1" style={{ height: layout.dockH ?? 220 }} data-testid="dock-bottom">
            <DockStack ids={bottom} testId="dock-bottom-stack" />
          </div>
        </>
      )}
      <DockDropOverlay />
    </div>
  )
}

export function TimelineResizeHandle() {
  const layout = useApp((s) => s.layout)
  const setLayout = useApp((s) => s.setLayout)
  const onDelta = useCallback((_dx: number, dy: number) => {
    const maxH = Math.max(280, Math.floor(window.innerHeight * 0.72))
    setLayout({ timelineH: Math.min(maxH, Math.max(160, layout.timelineH - dy)) })
  }, [layout.timelineH, setLayout])
  const onPointerDown = useResize(onDelta)
  return (
    <div className="resize-handle resize-handle-y shrink-0 min-w-0 w-full" data-testid="resize-timeline" onPointerDown={onPointerDown} />
  )
}
