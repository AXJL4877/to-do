import { useEffect, useRef } from 'react'
import { useApp } from '../store'
import { Scene3dRenderer, webglOk } from '../lib/scene3d'

/** 节目监视器 3D 视口：与 Zustand 解耦，仅时间/场景变更时 sync */
export function Monitor3dViewport({
  width,
  height,
  onFallback,
}: {
  width: number
  height: number
  onFallback: () => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<Scene3dRenderer | null>(null)

  const media = useApp((s) => s.media)
  const settings = useApp((s) => s.settings)
  const prefs = useApp((s) => s.prefs)
  const playhead = useApp((s) => s.playhead)
  const playing = useApp((s) => s.playing)
  const selectedClipIds = useApp((s) => s.selectedClipIds)
  const sequences = useApp((s) => s.sequences)
  const activeSeqId = useApp((s) => s.activeSeqId)
  const seq = sequences.find((q) => q.id === activeSeqId) ?? sequences[0]

  useEffect(() => {
    if (!webglOk()) {
      onFallback()
      return
    }
    const canvas = canvasRef.current
    if (!canvas) return
    try {
      engineRef.current = new Scene3dRenderer(canvas)
    } catch {
      onFallback()
      return
    }
    return () => {
      engineRef.current?.dispose()
      engineRef.current = null
    }
  }, [onFallback])

  useEffect(() => {
    const eng = engineRef.current
    if (!eng || width <= 0 || height <= 0) return
    eng.resize(width, height)
    eng.sync({
      scene: seq.scene3d,
      clips: seq.clips,
      tracks: seq.tracks,
      media,
      playhead,
      aspect: settings.width / settings.height,
      performance: prefs.performance,
      selectedIds: selectedClipIds,
    })
    eng.render()
  }, [width, height, seq, media, playhead, settings.width, settings.height, prefs.performance, selectedClipIds])

  useEffect(() => {
    if (!playing) return
    let raf = 0
    const loop = () => {
      const eng = engineRef.current
      const st = useApp.getState()
      const q = st.seq()
      if (eng) {
        eng.sync({
          scene: q.scene3d,
          clips: q.clips,
          tracks: q.tracks,
          media: st.media,
          playhead: st.playhead,
          aspect: st.settings.width / st.settings.height,
          performance: st.prefs.performance,
          selectedIds: st.selectedClipIds,
        })
        eng.render()
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [playing])

  // 简易轨道旋转：Alt+拖拽旋转相机 Y/X
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    let drag: null | { x: number; y: number; camY: number; camX: number } = null
    const down = (e: PointerEvent) => {
      if (!e.altKey) return
      e.preventDefault()
      const cam = useApp.getState().seq().scene3d.camera
      drag = { x: e.clientX, y: e.clientY, camY: cam.rotationY, camX: cam.rotationX }
      el.setPointerCapture(e.pointerId)
    }
    const move = (e: PointerEvent) => {
      if (!drag) return
      const dy = (e.clientX - drag.x) * 0.25
      const dx = (e.clientY - drag.y) * 0.25
      useApp.getState().updateCamera3d({
        rotationY: drag.camY + dy,
        rotationX: Math.max(-80, Math.min(80, drag.camX + dx)),
      }, { record: false })
    }
    const up = () => { drag = null }
    const wheel = (e: WheelEvent) => {
      if (!e.altKey) return
      e.preventDefault()
      const cam = useApp.getState().seq().scene3d.camera
      useApp.getState().updateCamera3d({ z: Math.max(0.5, cam.z + e.deltaY * 0.005) }, { record: false })
    }
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('wheel', wheel, { passive: false })
    return () => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('wheel', wheel)
    }
  }, [])

  return (
    <div ref={hostRef} className="relative w-full h-full" data-testid="monitor-3d-host">
      <canvas
        ref={canvasRef}
        data-testid="program-canvas-3d"
        className="block w-full h-full"
        style={{ width, height }}
        title="3D 视口：Alt+拖旋转 · Alt+滚轮推拉"
      />
    </div>
  )
}
