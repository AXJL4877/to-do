import { useCallback, useEffect, useRef } from 'react'

export function useResize(onDelta: (dx: number, dy: number) => void) {
  const dragging = useRef(false)
  const start = useRef({ x: 0, y: 0 })

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true
    start.current = { x: e.clientX, y: e.clientY }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }, [])

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragging.current) return
      const dx = e.clientX - start.current.x
      const dy = e.clientY - start.current.y
      start.current = { x: e.clientX, y: e.clientY }
      onDelta(dx, dy)
    }
    const onUp = () => { dragging.current = false }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [onDelta])

  return onPointerDown
}
