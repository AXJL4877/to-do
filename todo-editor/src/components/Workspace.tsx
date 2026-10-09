import { Inspector } from './Inspector'
import { useCallback, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
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

function ResizeHandle({ axis, onDelta, preview, testId }: {
  axis: 'x' | 'y'
  onDelta: (dx: number, dy: number) => void
  testId?: string
  preview?: { onStart: () => void; onDelta: (dx: number, dy: number) => void; onEnd: () => void }
}) {
  const onPointerDown = useResize(preview?.onDelta ?? onDelta, preview)
  return (
    <div
      className={clsx('resize-handle', axis === 'x' ? 'resize-handle-x' : 'resize-handle-y')}
      data-testid={testId ?? `resize-${axis}`}
      role="separator"
      tabIndex={0}
      aria-label={axis === 'x' ? '调整面板宽度' : '调整面板高度'}
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      title="拖动调整大小，或使用方向键；Shift 加速"
      onKeyDown={(e) => {
        const step = e.shiftKey ? 32 : 8
        const delta = axis === 'x' ? { ArrowLeft: -step, ArrowRight: step } : { ArrowUp: -step, ArrowDown: step }
        const value = delta[e.key as keyof typeof delta]
        if (value !== undefined) { e.preventDefault(); e.stopPropagation(); onDelta(axis === 'x' ? value : 0, axis === 'y' ? value : 0) }
      }}
      onPointerDown={onPointerDown}
    />
  )
}

function MonitorArea({ focused, onFocus, inspector, onInspector }: { focused: boolean; onFocus: () => void; inspector: boolean; onInspector: () => void }) {
  const monitorView = useApp((s) => s.monitorView)
  const setMonitorView = useApp((s) => s.setMonitorView)
  const performance = useApp(s => s.prefs.performance)
  const updatePrefs = useApp(s => s.updatePrefs)
  return (
    <div className="flex flex-col flex-1 min-h-0 min-w-0" data-testid="monitor-area">
      <div className="preview-toolbar" data-testid="monitor-view-tabs">
        <div className="preview-tabs" aria-label="预览模式">{([
          ['edit', '编辑'], ['program', '节目'], ['dual', '双窗'], ['source', '源素材'],
        ] as const).map(([id, label]) => <button key={id} type="button" className={monitorView === id ? 'active' : ''} aria-pressed={monitorView === id} data-testid={`monitor-view-${id}`} onClick={() => setMonitorView(id)}>{label}</button>)}</div>
        <div className="preview-tools">
          <select aria-label="预览画质" value={performance} onChange={e => updatePrefs({ performance: e.target.value as typeof performance })} title="只调整预览精度，导出保持工程画质"><option value="speed">流畅</option><option value="balanced">均衡</option><option value="quality">清晰</option></select>
          <button type="button" className={focused ? 'active' : ''} aria-pressed={focused} onClick={onFocus} data-testid="preview-focus">{focused ? '返回编辑' : '预览优先'}</button>
          {!inspector && <button type="button" onClick={onInspector} title="展开右侧属性栏" data-testid="inspector-toggle">属性</button>}
        </div>
      </div>

      {monitorView === 'dual' && (
        <div className="flex flex-1 min-h-0 min-w-0 gap-1" data-testid="dual-monitors">
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
        <div className="flex-1 min-h-0 overflow-hidden">
          <Monitor mode="edit" />
        </div>
      )}

      {monitorView === 'program' && (
        <div className="flex-1 min-h-0 overflow-hidden">
          <Monitor mode="program" />
        </div>
      )}

      {monitorView === 'source' && (
        <div className="flex-1 min-h-0 overflow-hidden">
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

/** 常用属性常驻，保留片段轮盘快捷操作。 */
const compactQuery = () => window.matchMedia('(max-width: 900px)')
const subscribeCompact = (notify: () => void) => {
  const query = compactQuery()
  query.addEventListener('change', notify)
  return () => query.removeEventListener('change', notify)
}
const getCompact = () => compactQuery().matches

function resizePanelWidth(panel: HTMLElement | null, fallback: number, delta: number) {
  const actual = panel?.getBoundingClientRect().width ?? fallback
  const cssMax = panel ? parseFloat(getComputedStyle(panel).maxWidth) : NaN
  const max = Number.isFinite(cssMax) ? Math.min(420, cssMax) : 420
  return Math.min(max, Math.max(180, actual + delta))
}

/** Resize the element on the animation frame; publish/persist its final size once.
 * Reading bounds at pointerdown keeps layout reads out of the drag's write path. */
function usePanelResize(key: 'sidebarW' | 'rightW' | 'dockH' | 'timelineH', dimension: 'width' | 'height',
  element: () => HTMLElement | null, direction: number, min: number, maximum: () => number) {
  const config = useRef({ key, dimension, element, direction, min, maximum })
  config.current = { key, dimension, element, direction, min, maximum }
  const gesture = useRef<{ element: HTMLElement; dimension: 'width' | 'height'; value: number; initialValue: number; initialStyle: string; min: number; max: number; direction: number } | null>(null)
  const onStart = useCallback(() => {
    const c = config.current, el = c.element()
    if (!el) return
    const cssMax = parseFloat(getComputedStyle(el)[c.dimension === 'width' ? 'maxWidth' : 'maxHeight'])
    const max = Math.max(c.min, Math.min(c.maximum(), Number.isFinite(cssMax) ? cssMax : Infinity))
    const value = el.getBoundingClientRect()[c.dimension]
    gesture.current = { element: el, dimension: c.dimension, value, initialValue: value, initialStyle: el.style[c.dimension], min: c.min, max, direction: c.direction }
  }, [])
  const onDelta = useCallback((dx: number, dy: number) => {
    const g = gesture.current
    if (!g) return
    const delta = (g.dimension === 'width' ? dx : dy) * g.direction
    g.value = Math.min(g.max, Math.max(g.min, g.value + delta))
    g.element.style[g.dimension] = `${g.value}px`
  }, [])
  const onEnd = useCallback(() => {
    const g = gesture.current
    gesture.current = null
    if (!g) return
    if (g.value === g.initialValue) {
      g.element.style[g.dimension] = g.initialStyle
      return
    }
    const c = config.current
    if (useApp.getState().layout[c.key] !== g.value) useApp.getState().setLayout({ [c.key]: g.value })
  }, [])
  return { onStart, onDelta, onEnd }
}

export function Workspace() {
  const [focused, setFocused] = useState(false)
  const [inspector, setInspector] = useState(true)
  const [compactInspector, setCompactInspector] = useState(false)
  const compact = useSyncExternalStore(subscribeCompact, getCompact, () => false)
  const showInspector = !focused && (compact ? compactInspector : inspector)
  const leftPanel = useRef<HTMLElement>(null)
  const rightPanel = useRef<HTMLElement>(null)
  const bottomPanel = useRef<HTMLDivElement>(null)
  const sidebarResize = usePanelResize('sidebarW', 'width', () => leftPanel.current, 1, 180, () => 420)
  const rightResize = usePanelResize('rightW', 'width', () => rightPanel.current, -1, 180, () => 420)
  const dockResize = usePanelResize('dockH', 'height', () => bottomPanel.current, -1, 140, () => 360)
  const layout = useApp((s) => s.layout)
  const setLayout = useApp((s) => s.setLayout)
  const dock = layout.panelDock ?? { media: 'left' as const, ai: 'tab' as const }
  const left = panelsIn('left', dock)
  const right = panelsIn('right', dock)
  const bottom = panelsIn('bottom', dock)

  const resizeSidebar = useCallback((dx: number) => {
    setLayout({ sidebarW: resizePanelWidth(leftPanel.current, useApp.getState().layout.sidebarW, dx) })
  }, [setLayout])
  const resizeRight = useCallback((dx: number) => {
    setLayout({ rightW: resizePanelWidth(rightPanel.current, useApp.getState().layout.rightW ?? 280, -dx) })
  }, [setLayout])
  const resizeDock = useCallback((_dx: number, dy: number) => {
    setLayout({ dockH: Math.min(360, Math.max(140, (useApp.getState().layout.dockH ?? 220) - dy)) })
  }, [setLayout])

  return (
    <div className="nle-upper flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden relative" data-testid="workspace" data-preview-focused={focused} data-compact={compact}>
      <div className="workspace-row flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {left.length > 0 && (
          <>
            <aside ref={leftPanel} className="nle-panel-col shrink-0" style={{ width: layout.sidebarW }}>
              <DockStack ids={left} testId="dock-left" />
            </aside>
            <ResizeHandle axis="x" testId="resize-sidebar" onDelta={resizeSidebar} preview={sidebarResize} />
          </>
        )}
        <main className="nle-center flex-1 min-w-0 min-h-0 flex flex-col p-1 overflow-hidden">
          <MonitorArea focused={focused} onFocus={() => setFocused(v => !v)} inspector={showInspector} onInspector={() => { setFocused(false); if (compact) setCompactInspector(true); else setInspector(true) }} />
        </main>
        {right.length > 0 && (
          <>
            <ResizeHandle axis="x" testId="resize-right" onDelta={resizeRight} preview={rightResize} />
            <aside ref={rightPanel} className="nle-panel-col shrink-0" style={{ width: layout.rightW ?? 280 }}>
              <DockStack ids={right} testId="dock-right" />
            </aside>
          </>
        )}
        {showInspector && <Inspector onClose={() => { if (compact) setCompactInspector(false); else setInspector(false) }} />}
      </div>
      {bottom.length > 0 && (
        <>
          <ResizeHandle axis="y" testId="resize-dock-bottom" onDelta={resizeDock} preview={dockResize} />
          <div ref={bottomPanel} className="shrink-0 min-h-0 px-1 pb-1" style={{ height: layout.dockH ?? 220 }} data-testid="dock-bottom">
            <DockStack ids={bottom} testId="dock-bottom-stack" />
          </div>
        </>
      )}
      <DockDropOverlay />
    </div>
  )
}

export function TimelineResizeHandle() {
  const preview = usePanelResize('timelineH', 'height',
    () => document.querySelector<HTMLElement>('[data-testid="timeline"]'), -1, 160,
    () => Math.max(280, Math.floor(window.innerHeight * 0.72)))
  const setLayout = useApp((s) => s.setLayout)
  const onDelta = useCallback((_dx: number, dy: number) => {
    const maxH = Math.max(280, Math.floor(window.innerHeight * 0.72))
    setLayout({ timelineH: Math.min(maxH, Math.max(160, useApp.getState().layout.timelineH - dy)) })
  }, [setLayout])
  return <ResizeHandle axis="y" testId="resize-timeline" onDelta={onDelta} preview={preview} />
}
