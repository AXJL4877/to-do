import { useEffect, useRef } from 'react'
import { useApp } from './store'
import { Workspace, TimelineResizeHandle } from './components/Workspace'
import { TimelineDock } from './components/TimelineDock'
import { TimelineFloatWindow } from './components/TimelineFloat'
import { TimelinePopoutShell } from './components/TimelinePopoutShell'
import { AiFloatWindow } from './components/AiFloat'
import { AiPanel } from './components/AiPanel'
import { Modals } from './components/Modals'
import { NewProjectDialog, StartScreen } from './components/ProjectStart'
import { ScriptMemo } from './components/ScriptMemo'
import { Monitor } from './components/Monitor'
import { PropWheel } from './components/PropWheel'
import { TransformGesture } from './components/TransformGesture'
import { tryAutoBezierPickedKeyframes, tryDeletePickedKeyframes, trySelectAllKeyframes } from './lib/kfDelete'
import { initStoreSync, isAiPopout, isStoreAuthority, isTimelinePopout, isLocalPlayheadScrubbing } from './lib/storeSync'
import { setLivePlayhead } from './lib/livePlayhead'
import { desktop } from './lib/desktop'
import { bindNativePreviewLifecycle } from './lib/nativePreviewBridge'
import { startNarratedTimelineSync } from './lib/narratedTimeline'
import { startChalkHandFollow } from './lib/chalkHand'
import { stepZoom } from './lib/timelineZoom'
import { PanelBottomClose } from 'lucide-react'
import { bindExtensionDropImport } from './lib/extensionImport'

const TIMELINE_POPOUT = isTimelinePopout()
const AI_POPOUT = isAiPopout()
const POPOUT = TIMELINE_POPOUT || AI_POPOUT

export default function App() {
  const toast = useApp((s) => s.toast)
  const fullscreen = useApp((s) => s.fullscreen)
  const timelineFloat = useApp((s) => s.timelineFloat)
  const timelineFloatKind = useApp((s) => s.timelineFloatKind)
  const aiFloat = useApp((s) => s.aiFloat)
  const aiFloatKind = useApp((s) => s.aiFloatKind)
  const seedDemo = useApp((s) => s.seedDemo)
  const setLayout = useApp((s) => s.setLayout)
  const layout = useApp((s) => s.layout)
  const setTimelineFloat = useApp((s) => s.setTimelineFloat)
  const setAiFloat = useApp((s) => s.setAiFloat)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => bindExtensionDropImport({
    onMessage: message => useApp.getState().setToast(message),
    onInstalled: extension => useApp.getState().setLibraryTab(extension.kind === 'skill' ? 'skill' : 'ai'),
    onMedia: async files => {
      const { parseMediaFiles } = await import('./lib/importFiles')
      useApp.getState().importMedia(await parseMediaFiles(files))
    },
  }), [])

  useEffect(() => {
    return initStoreSync()
  }, [])

  useEffect(() => {
    void import('./lib/textFonts').then((m) => m.ensureSmileyFont())
  }, [])

  useEffect(() => {
    if (POPOUT) return
    return bindNativePreviewLifecycle()
  }, [])

  useEffect(() => {
    if (POPOUT) return
    const stopSync = startNarratedTimelineSync()
    const stopHands = startChalkHandFollow()
    return () => { stopSync(); stopHands() }
  }, [])

  useEffect(() => {
    // 弹窗初始是空工程；等主窗快照后再由主窗权威维护链接，避免空 sequences 回写冲掉素材
    if (POPOUT) return
    useApp.getState().syncVideoAudioLinks()
  }, [])

  // 独立窗：停播跟 store；播放跟主窗 broadcast 的 live（见 Monitor）
  useEffect(() => {
    if (!POPOUT) return
    const sync = (s: { playing: boolean; playhead: number }) => { if (!s.playing) setLivePlayhead(s.playhead) }
    sync(useApp.getState())
    return useApp.subscribe((s, prev) => { if (s.playhead !== prev.playhead || s.playing !== prev.playing) sync(s) })
  }, [])

  useEffect(() => {
    if (TIMELINE_POPOUT) {
      document.title = 'TO DO · 时间轴'
      useApp.setState({ timelineFloat: true, timelineFloatKind: 'window' })
      return
    }
    if (AI_POPOUT) {
      document.title = 'TO DO · AI+'
      useApp.setState({ aiFloat: true, aiFloatKind: 'window' })
      return
    }
    setLayout(layout)
    const s = useApp.getState()
    const raw = localStorage.getItem(`todo-draft-${s.projectId}`)
    void s.refreshRecentProjects()
    if (desktop()) {
      // 桌面版每次冷启动回到项目起始页（不自动进上一次剪辑）
      useApp.setState({ started: false })
      void desktop()?.setProject?.(null)
      void desktop()?.discoverProjects?.().then((r) => {
        if (r?.ok && r.projects) useApp.setState({ recentProjects: r.projects })
      })
    } else if (raw) {
      try {
        const data = JSON.parse(raw)
        if (
          (Array.isArray(data.sequences) && data.sequences.some((q: { clips?: unknown[] }) => q.clips?.length))
          || (Array.isArray(data.media) && data.media.length > 0)
        ) {
          s.openDraft(s.projectId)
          useApp.setState({ toast: null, started: true })
        }
      } catch { /* */ }
    }
    if (!desktop() && !useApp.getState().started) {
      seedDemo()
      useApp.setState({ dirty: false, started: true })
    }
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('[data-testid="app-shell"]')?.focus({ preventScroll: true })
    })
    const autosave = window.setInterval(() => {
      const st = useApp.getState()
      if (!st.dirty || !st.started) return
      if (st.projectPath && desktop()) void st.saveProjectToFile({ silent: true })
      else if (st.sequences.some((q) => q.clips.length) || st.media.length) st.saveProject({ silent: true })
    }, 30000)
    const d = desktop()
    const offClose = d?.onRequestClose?.(() => {
      void useApp.getState().flushProject().finally(() => d.closeReady?.())
    })
    // 刷新 / 重载前把没存的改动写下去（写工程文件的请求同步发出，主进程收到就会写完）
    const onUnload = () => {
      if (isStoreAuthority() && useApp.getState().dirty) void useApp.getState().flushProject()
    }
    window.addEventListener('beforeunload', onUnload)
    return () => {
      clearInterval(autosave)
      offClose?.()
      window.removeEventListener('beforeunload', onUnload)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const projectName = useApp((s) => s.projectName)
  const projectPath = useApp((s) => s.projectPath)
  const dirty = useApp((s) => s.dirty)
  const started = useApp((s) => s.started)
  const scriptOpen = useApp((s) => s.scriptOpen)
  const media = useApp((s) => s.media)
  // AI 产物（本窗或 AI 独立窗入库的）复制进项目文件夹；只由主窗做
  useEffect(() => {
    if (POPOUT || !started || !projectPath) return
    const t = window.setTimeout(() => void useApp.getState().collectAiMedia(), 300)
    return () => window.clearTimeout(t)
  }, [media, started, projectPath])
  useEffect(() => {
    if (POPOUT) return
    if (!started) { document.title = 'TO DO'; return }
    const noFile = desktop() && !projectPath ? '（未存为工程文件）' : ''
    document.title = `${dirty ? '● ' : ''}${projectName}${noFile} — TO DO`
  }, [projectName, projectPath, dirty, started])

  useEffect(() => {
    if (POPOUT) return
    const d = desktop()
    const cleanups: Array<() => void> = []
    // 热更新/重载后若独立时间轴窗还在，主窗必须继续藏 dock
    void d?.timelineWindowAlive?.().then((r) => {
      if (r?.ok) useApp.setState({ timelineFloat: true, timelineFloatKind: 'window' })
    })
    if (d?.onTimelineWindowOpened) {
      cleanups.push(d.onTimelineWindowOpened(() => {
        useApp.setState({ timelineFloat: true, timelineFloatKind: 'window' })
      }))
    }
    if (d?.onTimelineWindowClosed) {
      cleanups.push(d.onTimelineWindowClosed(() => {
        useApp.setState({ timelineFloat: false, timelineFloatKind: null })
      }))
    }
    if (d?.onAiWindowClosed) {
      cleanups.push(d.onAiWindowClosed(() => {
        useApp.setState({ aiFloat: false, aiFloatKind: null })
      }))
    }
    return () => { for (const c of cleanups) c() }
  }, [])

  useEffect(() => {
    const isPlainTextField = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false
      if (!el.isConnected) return false
      if (el.isContentEditable) return true
      if (el instanceof HTMLTextAreaElement) return true
      if (el instanceof HTMLSelectElement) return true
      if (el instanceof HTMLInputElement) {
        const t = el.type
        return t === 'text' || t === 'search' || t === 'password' || t === 'email' || t === 'url' || t === 'tel' || t === 'number' || t === ''
      }
      return false
    }

    const onKey = (e: KeyboardEvent) => {
      // Separators own arrow keys, including modified arrows. This listener
      // runs in capture phase, before their local keyboard handlers.
      if (e.target instanceof HTMLElement && e.target.closest('[role="separator"]') && e.key.startsWith('Arrow')) return
      const s = useApp.getState()
      const mod = e.ctrlKey || e.metaKey
      if (s.transformGesture) return
      if (!POPOUT && (!s.started || s.newProjectDialog)) {
        if (!s.started && mod && e.code === 'KeyO') { e.preventDefault(); void s.openProjectFromFile() }
        return
      }

      if (!POPOUT && e.code === 'Backquote' && !mod && !e.altKey && !e.isComposing) {
        const inMemo = e.target instanceof HTMLElement && e.target.hasAttribute('data-script-memo')
        if (inMemo || !isPlainTextField(e.target)) {
          e.preventDefault()
          s.toggleScript()
          return
        }
      }

      if (mod && e.code === 'KeyZ') {
        const inMemo = e.target instanceof HTMLElement && e.target.hasAttribute('data-script-memo')
        if (inMemo) {
          e.preventDefault()
          if (e.shiftKey) s.redoScript()
          else s.undoScript()
          return
        }
        if (isPlainTextField(e.target)) return
        e.preventDefault()
        if (e.shiftKey) s.redo()
        else s.undo()
        return
      }
      if (mod && e.code === 'KeyY') {
        const inMemo = e.target instanceof HTMLElement && e.target.hasAttribute('data-script-memo')
        if (inMemo) { e.preventDefault(); s.redoScript(); return }
        if (isPlainTextField(e.target)) return
        e.preventDefault()
        s.redo()
        return
      }
      if (mod && e.code === 'KeyS') {
        if (isPlainTextField(e.target)) return
        e.preventDefault()
        void s.saveProjectToFile({ saveAs: e.shiftKey })
        return
      }
      if (mod && e.code === 'KeyO') {
        if (isPlainTextField(e.target)) return
        e.preventDefault()
        void s.openProjectFromFile()
        return
      }

      if (s.scriptOpen || isPlainTextField(e.target)) return

      if (e.code === 'Space') {
        e.preventDefault()
        if (isLocalPlayheadScrubbing()) return
        s.togglePlay()
      }
      if (e.key === 'j' || e.key === 'J') s.stepFrame(-1)
      if (e.key === 'k' || e.key === 'K') {
        if (isLocalPlayheadScrubbing()) return
        s.togglePlay()
      }
      if (e.key === 'l' || e.key === 'L') { s.togglePlay(); s.setPlayhead(s.playhead + 1 / s.settings.fps) }
      if (mod && !e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault()
        s.nudgeAfterPlayhead(e.key === 'ArrowLeft' ? -1 : 1)
        return
      }
      if (e.key === 'ArrowLeft') s.stepFrame(-1)
      if (e.key === 'ArrowRight') s.stepFrame(1)
      const hasSelection = s.selectedClipIds.length > 0
      if (!mod && (e.key === 's' || e.key === 'S')) {
        if (hasSelection || s.autoKeyframe) {
          e.preventDefault()
          s.closePropWheel()
          s.beginTransformGesture('scale')
          return
        }
        s.setSnap(!s.settings.snap)
      }
      if (!mod && (e.key === 'r' || e.key === 'R') && document.querySelector('.nle-timeline:hover')) {
        e.preventDefault()
        s.setTool(s.tool === 'rate' ? 'select' : 'rate')
        return
      }
      if (!mod && (e.key === 'r' || e.key === 'R') && (hasSelection || s.autoKeyframe)) {
        e.preventDefault()
        s.closePropWheel()
        s.beginTransformGesture('rotation')
        return
      }
      if (e.key === 't' || e.key === 'T') {
        if (s.autoKeyframe) {
          e.preventDefault()
          s.openPropDialOnMonitor('opacity')
          return
        }
        s.setTool('trim')
      }
      if (!mod && (e.key === 'v' || e.key === 'V')) { e.preventDefault(); s.setTool('select') }
      if (!mod && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); s.setTool('razor') }
      if (!mod && (e.key === 'y' || e.key === 'Y')) s.setTool('slip')
      if (!mod && (e.key === 'h' || e.key === 'H')) s.setTool('hand')
      if (e.key === 'i' || e.key === 'I') s.setSourceIO(s.playhead, s.sourceOut)
      if (e.key === 'o' || e.key === 'O') s.setSourceIO(s.sourceIn, Math.max(s.sourceIn + 0.1, s.playhead))
      if (mod && e.code === 'KeyK') { e.preventDefault(); s.razorAtPlayhead() }
      if (mod && e.code === 'KeyM') { e.preventDefault(); s.setModal('export') }
      if (mod && e.code === 'KeyI') { e.preventDefault(); fileRef.current?.click() }
      if (mod && e.code === 'KeyD') { e.preventDefault(); s.duplicateSelected() }

      if (mod && !e.shiftKey && e.code === 'KeyA') {
        e.preventDefault()
        if (!trySelectAllKeyframes()) s.selectAllClips()
      }
      if (mod && e.shiftKey && e.code === 'KeyA') { e.preventDefault(); s.selectClips([]) }
      if (mod && e.code === 'KeyC' && !e.shiftKey) { e.preventDefault(); s.copySelected() }
      if (mod && e.code === 'KeyX') { e.preventDefault(); s.cutSelected() }
      if (mod && e.code === 'KeyV') { e.preventDefault(); s.pasteClipboard() }
      if (e.key === 'Escape') {
        if (s.propWheel) { s.closePropWheel(); return }
        if (s.autoKeyframe) { s.setAutoKeyframe(false); return }
        s.selectClips([])
      }
      {
        const digit =
          e.code === 'Digit1' || e.code === 'Numpad1' ? '1'
            : e.code === 'Digit2' || e.code === 'Numpad2' ? '2'
              : e.code === 'Digit3' || e.code === 'Numpad3' ? '3'
                : null
        if (!mod && digit) {
          e.preventDefault()
          if (digit === '2') {
            s.setAutoKeyframe(!s.autoKeyframe)
            s.closePropWheel()
            return
          }
          const ring = digit === '1' ? 'static' : 'transition'
          s.openPropWheelOnMonitor(ring)
          return
        }
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        if (s.propWheel) s.closePropWheel()
        else s.openPropWheelOnMonitor()
      }
      if (e.key === 'Home') { e.preventDefault(); s.setPlayhead(0) }
      if (e.key === 'End') {
        e.preventDefault()
        const seq = s.seq()
        const end = Math.max(seq.workOut, ...seq.clips.map((c) => c.start + c.duration), 0)
        s.setPlayhead(end)
      }
      if (e.key === 'F3') {
        e.preventDefault()
        if (!tryAutoBezierPickedKeyframes()) s.autoBezierAll()
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (tryDeletePickedKeyframes()) {
          e.preventDefault()
          return
        }
        if (e.key === 'Delete') s.deleteSelected(e.shiftKey)
      }
      if (e.key === '=' || e.key === '+') s.setTimelineZoom(stepZoom(s.timelineZoom, 1))
      if (e.key === '-') s.setTimelineZoom(stepZoom(s.timelineZoom, -1))
      if (e.key === 'm' || e.key === 'M') s.addMarker()
      if (e.key === '?' || (e.shiftKey && e.key === '/')) { e.preventDefault(); s.setModal('shortcuts') }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // 独立时间轴窗口：只渲染 dock，状态靠 BroadcastChannel 与主窗同步；高度跟轨道收紧
  if (TIMELINE_POPOUT) {
    return <TimelinePopoutShell />
  }

  // 独立 AI 窗口
  if (AI_POPOUT) {
    return (
      <div
        className="h-full min-h-0 flex flex-col overflow-hidden outline-none"
        style={{ background: 'var(--surface-0)' }}
        data-testid="ai-popout-shell"
        tabIndex={-1}
      >
        <div
          className="shrink-0 h-7 flex items-center gap-2 px-2 border-b"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
        >
          <span className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>
            AI+ · 独立窗口
          </span>
          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>截帧由主窗执行</span>
          <div className="flex-1" />
          <button
            type="button"
            className="icon-btn"
            style={{ width: 24, height: 24 }}
            data-testid="ai-popout-close"
            title="关闭并还原到主窗口"
            onClick={() => {
              useApp.setState({ aiFloat: false, aiFloatKind: null })
              window.close()
            }}
          >
            <PanelBottomClose size={13} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-2">
          <AiPanel />
        </div>
        {toast && <div className="toast" data-testid="toast">{toast}</div>}
      </div>
    )
  }

  if (!started) return <><StartScreen />{toast && <div className="toast" data-testid="toast">{toast}</div>}</>

  if (fullscreen) {
    return (
      <>
        <div className="fixed inset-0 z-50 bg-black grid place-items-center" data-testid="fullscreen">
          <div className="w-full h-full max-w-[1600px] p-4">
            <Monitor mode="program" />
          </div>
          <button
            className="absolute top-4 right-4 btn btn-ink"
            data-testid="btn-exit-fullscreen"
            onClick={() => useApp.getState().setFullscreen(false)}
          >
            退出全屏
          </button>
        </div>
        {/* 弹出时间轴始终盖在节目监视器前面（含全屏） */}
        {timelineFloat && timelineFloatKind === 'panel' && <TimelineFloatWindow />}
        {timelineFloat && timelineFloatKind === 'window' && (
          <button
            type="button"
            className="fixed bottom-3 right-3 z-[70] btn btn-ink text-[11px] h-8"
            data-testid="btn-timeline-float-restore"
            onClick={() => setTimelineFloat(false)}
          >
            还原时间轴
          </button>
        )}
        {toast && <div className="toast" data-testid="toast">{toast}</div>}
      </>
    )
  }

  return (
    <div
      className="h-full w-full min-w-0 min-h-0 grid overflow-hidden outline-none"
      style={{
        gridTemplateRows: timelineFloat ? '1fr' : 'minmax(0, 1fr) 6px auto',
        gridTemplateColumns: 'minmax(0, 1fr)',
        background: 'var(--surface-0)',
      }}
      data-testid="app-shell"
      tabIndex={-1}
    >
      <Workspace />
      {!timelineFloat && (
        <>
          <TimelineResizeHandle />
          <TimelineDock />
        </>
      )}
      {timelineFloat && timelineFloatKind === 'panel' && <TimelineFloatWindow />}
      {timelineFloat && timelineFloatKind === 'window' && (
        <button
          type="button"
          className="fixed bottom-3 right-3 z-[70] btn btn-ink text-[11px] h-8"
          data-testid="btn-timeline-float-restore"
          onClick={() => setTimelineFloat(false)}
        >
          还原时间轴
        </button>
      )}
      {aiFloat && aiFloatKind === 'panel' && <AiFloatWindow />}
      {aiFloat && aiFloatKind === 'window' && !TIMELINE_POPOUT && (
        <button
          type="button"
          className="fixed bottom-3 left-3 z-30 btn btn-ink text-[11px] h-8"
          data-testid="btn-ai-float-restore"
          onClick={() => setAiFloat(false)}
        >
          还原 AI+
        </button>
      )}
      <PropWheel />
      <TransformGesture />
      <input ref={fileRef} type="file" multiple accept="video/*,audio/*,image/*" className="hidden" data-testid="global-import" onChange={(e) => {
        const files = e.target.files
        if (!files?.length) return
        import('./lib/importFiles').then(({ parseMediaFiles }) => parseMediaFiles([...files]).then(useApp.getState().importMedia))
      }} />
      <Modals />
      <NewProjectDialog />
      {scriptOpen && <ScriptMemo />}
      {toast && <div className="toast" data-testid="toast">{toast}</div>}
    </div>
  )
}
