import { useLayoutEffect, useRef, type RefObject } from 'react'
import type { Sequence } from '../types'
import { indexClips } from '../lib/sequenceIndex'

/** Viewport-sized text layer: geometry can scale without scaling glyphs or
 * restyling hundreds of label elements. DOM clip boxes retain all hit targets. */
export function TimelineLabels({ seq, pxPerSec, scrollRef, viewportWidth, geometryScale = 1, geometryZoom }: {
  seq: Sequence
  pxPerSec: number
  scrollRef: RefObject<HTMLDivElement | null>
  viewportWidth: number
  /** 缩放过渡期 timeline-geometry 的 scaleX；settled 时为 1 */
  geometryScale?: number
  /** 片段定位用的冻结 zoom；缺省等于 pxPerSec */
  geometryZoom?: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const widths = useRef(new Map<string, number>())
  const zoom = geometryZoom ?? pxPerSec
  const scale = geometryScale || 1
  useLayoutEffect(() => {
    const scroll = scrollRef.current, canvas = canvasRef.current
    if (!scroll || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const style = getComputedStyle(scroll)
    const family = style.fontFamily
    const labelColors = Object.fromEntries(['text', 'solid', 'audio', 'video'].map(tone =>
      [tone, style.getPropertyValue(`--timeline-clip-${tone}-text`).trim() || (tone === 'text' || tone === 'solid' ? '#ffffff' : '#171717')]))
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
          // 与 TimelineClip 像素取整 + geometry scaleX 对齐
          const x0 = Math.round(clip.start * zoom) * scale
          const x1 = Math.round((clip.start + clip.duration) * zoom) * scale
          const x = x0 - left + (offset?.m41 ?? 0)
          const clipW = Math.max(1, x1 - x0)
          if (cy + track.height < 0 || cy >= h || x + clipW <= 0 || x >= w || clipW < 12) continue
          const labelX = x + 6, labelY = cy + 6
          const available = clipW - 12
          if (available <= 0) continue
          ctx.save()
          ctx.beginPath()
          ctx.rect(labelX, cy + 4, Math.max(0, clipW - 10), track.height - 8)
          ctx.clip()
          ctx.globalAlpha = clip.enabled ? 1 : 0.4
          const tone = clip.text ? 'text' : clip.solid ? 'solid' : track.kind === 'audio' ? 'audio' : 'video'
          ctx.font = `600 10px ${family}`
          ctx.fillStyle = labelColors[tone]
          let textX = labelX, remaining = available
          if (Math.abs((clip.speed || 1) - 1) > 1e-3) {
            const rate = `${(clip.speed || 1).toFixed(2)}×`
            const badgeW = measure(rate) + 8
            ctx.fillStyle = '#ffffff'
            ctx.fillRect(textX, labelY, badgeW, 12)
            ctx.fillStyle = '#1e1e1e'
            ctx.fillText(rate, textX + 4, labelY)
            textX += badgeW + 4; remaining -= badgeW + 4
            ctx.fillStyle = labelColors[tone]
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
      if (records.some(r => (r.target as HTMLElement).hasAttribute('data-clip-start') || (r.target as HTMLElement).getAttribute?.('data-testid') === 'timeline-geometry')) draw()
    })
    if (geometry) mo.observe(geometry, { attributes: true, attributeFilter: ['style'], subtree: true })
    return () => { scroll.removeEventListener('scroll', draw); ro.disconnect(); mo.disconnect() }
  }, [seq, pxPerSec, scrollRef, viewportWidth, zoom, scale])
  return <canvas ref={canvasRef} data-testid="timeline-labels" aria-hidden="true"
    style={{ position: 'absolute', pointerEvents: 'none', zIndex: 2 }} />
}
