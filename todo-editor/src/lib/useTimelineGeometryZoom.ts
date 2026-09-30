import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/** Keep clip boxes stable during a zoom burst; only the containing layer scales. */
export function useTimelineGeometryZoom(zoom: number, sequenceId: string, editing = false) {
  const [settled, setSettled] = useState({ zoom, sequenceId })
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const finish = useCallback(() => {
    clearTimeout(timer.current)
    setSettled({ zoom, sequenceId })
  }, [zoom, sequenceId])

  useLayoutEffect(() => {
    if (settled.sequenceId !== sequenceId || (editing && settled.zoom !== zoom)) finish()
  }, [settled.sequenceId, settled.zoom, sequenceId, zoom, editing, finish])

  useEffect(() => {
    if (editing || (settled.zoom === zoom && settled.sequenceId === sequenceId)) return
    timer.current = setTimeout(finish, 120)
    return () => clearTimeout(timer.current)
  }, [zoom, sequenceId, settled, editing, finish])

  return { geometryZoom: !editing && settled.sequenceId === sequenceId ? settled.zoom : zoom, finish }
}
