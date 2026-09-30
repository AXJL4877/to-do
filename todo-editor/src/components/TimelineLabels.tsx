import { useLayoutEffect, useRef, type RefObject } from 'react'
import type { Sequence } from '../types'
import { indexClips } from '../lib/sequenceIndex'

/** Viewport-sized text layer: geometry can scale without scaling glyphs or
 * restyling hundreds of label elements. DOM clip boxes retain all hit targets. */
export function TimelineLabels({ seq, pxPerSec, scrollRef, viewportWidth }: {
  seq: Sequence
  pxPerSec: number
  scrollRef: RefObject<HTMLDivElement | null>
  viewportWidth: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const widths = useRef(new Map<string, number>())
  useLayoutEffect(() => {
    const scroll = scrollRef.current, canvas = canvasRef.current
    if (!scroll || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const style = getComputedStyle(scroll)
    const family = style.fontFamily
    const color = style.getPropertyValue('--text-primary').trim() || '#1b1f1d'
    const byTrack = indexClips(seq.clips).byTrack
    const geometry = canvas.parentElement?.querySelector('[data-testid="timeline-geometry"]')
    const totalH = seq.tracks.reduce((n, track) => n + track.height, 0)
    const measure = (text: string) => {
      const key = `${ctx.font}:${text}`
      let width = widths.current.get(key)
      if (width == null) {
        width = ctx.measureText(text).width
        if (widths.current.size > 4096) widths.current.clear()
        widths.current.set(key, width)
      }
      return width
    }
    const draw = () => {
      const left = scroll.scrollLeft, top = Math.max(0, scroll.scrollTop - 28)
      const w = scroll.clientWidth, h = Math.min(totalH - top, scroll.clientHeight)
      if (w <= 0 || h <= 0) return
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const bw = Math.ceil(w * dpr), bh = Math.ceil(h * dpr)
      if (canvas.width !== bw) canvas.width = bw
      if (canvas.height !== bh) canvas.height = bh
      Object.assign(canvas.style, { left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px` })
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      ctx.textBaseline = 'top'
      const offsets = new Map<string, DOMMatrix>()
      geometry?.querySelectorAll<HTMLElement>('[data-clip-start][style*="translate"]').forEach(el => {
        offsets.set(el.dataset.testid!.slice(5), new DOMMatrix(el.style.transform))
      })
      let y = -top
      for (const track of seq.tracks) {
        for (const clip of byTrack.get(track.id) ?? []) {
          const offset = offsets.get(clip.id)
          const cy = y + (offset?.m42 ?? 0)
          const x = clip.start * pxPerSec - left + (offset?.m41 ?? 0)
          const clipW = clip.duration * pxPerSec
          if (cy + track.height < 0 || cy >= h || x + clipW <= 0 || x >= w || clipW < 12) continue
          const labelX = x + 6, labelY = cy + 6
          const available = clipW - 12
          if (available <= 0) continue
          ctx.save()
          ctx.beginPath()
          ctx.rect(labelX, cy + 4, Math.max(0, clipW - 10), track.height - 8)
          ctx.clip()
          ctx.globalAlpha = clip.enabled ? 1 : 0.4
          ctx.font = `500 10px ${family}`
          ctx.fillStyle = track.kind === 'audio' ? 'hsl(158 45% 30%)' : color
          let textX = labelX, remaining = available
          if (Math.abs((clip.speed || 1) - 1) > 1e-3) {
            const rate = `${(clip.speed || 1).toFixed(2)}×`
            const badgeW = measure(rate) + 8
            ctx.fillStyle = 'hsl(38 92% 50% / 0.9)'
            ctx.fillRect(textX, labelY, badgeW, 12)
            ctx.fillStyle = '#1b1f1d'
            ctx.fillText(rate, textX + 4, labelY)
            textX += badgeW + 4; remaining -= badgeW + 4
            ctx.fillStyle = track.kind === 'audio' ? 'hsl(158 45% 30%)' : color
          }
          let label = clip.name
          if (remaining > 0) {
            if (measure(label) > remaining) {
              const ellipsis = measure('…')
              let lo = 0, hi = label.length
              while (lo < hi) {
                const mid = Math.ceil((lo + hi) / 2)
                if (measure(label.slice(0, mid)) + ellipsis <= remaining) lo = mid
                else hi = mid - 1
              }
              label = remaining >= ellipsis ? label.slice(0, lo) + '…' : ''
            }
            ctx.fillText(label, textX, labelY)
          }
          ctx.restore()
        }
        y += track.height
      }
    }
    draw()
    scroll.addEventListener('scroll', draw, { passive: true })
    const ro = new ResizeObserver(draw)
    ro.observe(scroll)
    const mo = new MutationObserver(records => {
      if (records.some(r => (r.target as HTMLElement).hasAttribute('data-clip-start'))) draw()
    })
    if (geometry) mo.observe(geometry, { attributes: true, attributeFilter: ['style'], subtree: true })
    return () => { scroll.removeEventListener('scroll', draw); ro.disconnect(); mo.disconnect() }
  }, [seq, pxPerSec, scrollRef, viewportWidth])
  return <canvas ref={canvasRef} data-testid="timeline-labels" aria-hidden="true"
    style={{ position: 'absolute', pointerEvents: 'none', zIndex: 2 }} />
}
