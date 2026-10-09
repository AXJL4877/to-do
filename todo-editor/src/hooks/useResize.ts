import { useCallback, useEffect, useRef } from 'react'

export function useResize(onDelta: (dx: number, dy: number) => void, lifecycle?: {
  onStart?: () => void
  onEnd?: () => void
}) {
  const pointer = useRef<number | null>(null)
  const start = useRef({ x: 0, y: 0 })
  const pending = useRef({ x: 0, y: 0 })
  const raf = useRef<number | null>(null)
  const callback = useRef(onDelta)
  callback.current = onDelta
  const lifecycleRef = useRef(lifecycle)
  lifecycleRef.current = lifecycle

  const flush = useCallback(() => {
    if (raf.current !== null) cancelAnimationFrame(raf.current)
    raf.current = null
    const { x, y } = pending.current
    pending.current = { x: 0, y: 0 }
    if (x || y) callback.current(x, y)
  }, [])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0 || pointer.current !== null) return
    e.preventDefault()
    lifecycleRef.current?.onStart?.()
    pointer.current = e.pointerId
    start.current = { x: e.clientX, y: e.clientY }
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [])

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (pointer.current !== e.pointerId) return
      const dx = e.clientX - start.current.x
      const dy = e.clientY - start.current.y
      start.current = { x: e.clientX, y: e.clientY }
      pending.current.x += dx
      pending.current.y += dy
      if (raf.current === null) raf.current = requestAnimationFrame(flush)
    }
    const stop = () => {
      if (pointer.current === null) return
      pointer.current = null
      flush()
      lifecycleRef.current?.onEnd?.()
    }
    const onUp = (e: PointerEvent) => { if (pointer.current === e.pointerId) stop() }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    window.addEventListener('lostpointercapture', onUp)
    window.addEventListener('blur', stop)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('lostpointercapture', onUp)
      window.removeEventListener('blur', stop)
      if (raf.current !== null) cancelAnimationFrame(raf.current)
      pointer.current = null
      pending.current = { x: 0, y: 0 }
    }
  }, [flush])

  return onPointerDown
}
