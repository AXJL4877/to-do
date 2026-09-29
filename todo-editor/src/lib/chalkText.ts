/** Local glyph skeletons and stable chalk grain. No network or skill jobs. */
const SIZE = 144
const PAD = 16
const EM = 108
type Glyph = { alpha: Uint8ClampedArray; order: Float32Array; width: number }
const glyphs = new Map<string, Glyph>()
const scratch = () => { const c = document.createElement('canvas'); c.width = c.height = SIZE; return c }

function glyph(char: string, family: string, weight: number): Glyph {
  const key = `${family}:${weight}:${char}`
  const hit = glyphs.get(key)
  if (hit) { glyphs.delete(key); glyphs.set(key, hit); return hit }
  const cv = scratch(), ctx = cv.getContext('2d', { willReadFrequently: true })!
  ctx.font = `${weight} ${EM}px "${family}", "KaiTi", serif`
  ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff'
  ctx.fillText(char, PAD, SIZE / 2)
  const pixels = ctx.getImageData(0, 0, SIZE, SIZE).data
  const alpha = new Uint8ClampedArray(SIZE * SIZE)
  const skeleton = new Uint8Array(alpha.length)
  for (let i = 0; i < alpha.length; i++) { alpha[i] = pixels[i * 4 + 3]; skeleton[i] = alpha[i] > 64 ? 1 : 0 }
  // Zhang–Suen thinning retains connected stroke centerlines.
  const offsets = [-SIZE, -SIZE + 1, 1, SIZE + 1, SIZE, SIZE - 1, -1, -SIZE - 1]
  let changed = true
  while (changed) {
    changed = false
    for (let pass = 0; pass < 2; pass++) {
      const remove: number[] = []
      for (let y = 1; y < SIZE - 1; y++) for (let x = 1; x < SIZE - 1; x++) {
        const i = y * SIZE + x
        if (!skeleton[i]) continue
        const n = offsets.map(d => skeleton[i + d])
        const count = n.reduce((a, b) => a + b, 0)
        if (count < 2 || count > 6) continue
        let transitions = 0
        for (let j = 0; j < 8; j++) if (!n[j] && n[(j + 1) % 8]) transitions++
        if (transitions !== 1) continue
        if (pass === 0 ? n[0] * n[2] * n[4] || n[2] * n[4] * n[6] : n[0] * n[2] * n[6] || n[0] * n[4] * n[6]) continue
        remove.push(i)
      }
      for (const i of remove) skeleton[i] = 0
      if (remove.length) changed = true
    }
  }
  const remaining = new Set<number>()
  skeleton.forEach((v, i) => { if (v) remaining.add(i) })
  const path: number[] = []
  let current = -1
  while (remaining.size) {
    let next = current < 0 ? undefined : offsets.map(d => current + d).find(i => remaining.has(i))
    if (next === undefined) {
      // Lift the chalk between disconnected strokes, prefer upper-left endpoints.
      const ends = [...remaining].filter(i => offsets.filter(d => remaining.has(i + d)).length <= 1)
      const candidates = ends.length ? ends : [...remaining]
      next = candidates.reduce((best, i) => (i % SIZE + Math.floor(i / SIZE) * 1.4) < (best % SIZE + Math.floor(best / SIZE) * 1.4) ? i : best)
    }
    current = next; path.push(current); remaining.delete(current)
  }
  // Propagate centerline order across each stroke's ink, never across blank paper.
  const order = new Float32Array(alpha.length).fill(-1)
  const queue: number[] = []
  path.forEach((i, j) => { order[i] = (j + 1) / Math.max(1, path.length); queue.push(i) })
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q]
    for (const d of offsets) {
      const n = i + d
      if (n < 0 || n >= alpha.length || Math.abs(n % SIZE - i % SIZE) > 1 || !alpha[n] || order[n] >= 0) continue
      order[n] = order[i]; queue.push(n)
    }
  }
  // Antialiased islands retain their pixels in the completed character.
  alpha.forEach((v, i) => { if (v && order[i] < 0) order[i] = 1 })
  const result = { alpha, order, width: ctx.measureText(char).width }
  glyphs.set(key, result)
  if (glyphs.size > 192) glyphs.delete(glyphs.keys().next().value!)
  return result
}

export type ChalkOptions = { duration: number; grain: number; hand: boolean }
export function drawChalkText(ctx: CanvasRenderingContext2D, o: {
  lines: string[]; family: string; fontPx: number; weight: number; align: CanvasTextAlign;
  lineHeight: number; spacing: number; color: string; chalk: ChalkOptions; time?: number;
}) {
  const chars = o.lines.map(line => Array.from(line))
  const count = chars.flat().filter(c => c.trim()).length
  const progress = o.time === undefined ? 1 : Math.min(1, Math.max(0, o.time / Math.max(0.05, o.chalk.duration)))
  if (!count || progress <= 0) return
  const scale = o.fontPx / EM
  const cv = scratch(), gc = cv.getContext('2d')!
  const rgba = gc.createImageData(SIZE, SIZE)
  let index = 0
  let tip: { x: number; y: number } | undefined
  chars.forEach((line, row) => {
    const gs = line.map(c => glyph(c, o.family, o.weight))
    const width = gs.reduce((sum, g) => sum + g.width * scale, 0) + Math.max(0, line.length - 1) * o.spacing
    let x = o.align === 'center' ? -width / 2 : o.align === 'right' || o.align === 'end' ? -width : 0
    const y = (row - (chars.length - 1) / 2) * o.fontPx * o.lineHeight
    gs.forEach((g, j) => {
      const p = line[j].trim() ? Math.min(1, Math.max(0, progress * count - index++)) : 0
      if (p > 0) {
        rgba.data.fill(0)
        let closest = Infinity, tipIndex = 0
        for (let i = 0; i < g.alpha.length; i++) {
          if (!g.alpha[i]) continue
          const delta = Math.abs(g.order[i] - p)
          if (delta < closest) { closest = delta; tipIndex = i }
          const reveal = p >= 1 ? 1 : Math.min(1, Math.max(0, (p - g.order[i]) * 90 + 0.5))
          // Coordinate hash: scrubbing/exporting never generates a different texture.
          const hash = Math.imul(i + 1, 374761393) ^ Math.imul(line[j].codePointAt(0)! + 1, 668265263)
          const noise = ((hash ^ (hash >>> 13)) >>> 0) / 4294967295
          const grain = Math.max(0, Math.min(1, o.chalk.grain))
          const a = noise < grain * 0.2 ? 0 : 1 - grain * (0.25 + noise * 0.65)
          rgba.data[i * 4 + 3] = g.alpha[i] * a * reveal
        }
        gc.clearRect(0, 0, SIZE, SIZE); gc.putImageData(rgba, 0, 0)
        gc.globalCompositeOperation = 'source-in'; gc.fillStyle = o.color; gc.fillRect(0, 0, SIZE, SIZE)
        gc.globalCompositeOperation = 'source-over'
        ctx.drawImage(cv, x - PAD * scale, y - SIZE / 2 * scale, SIZE * scale, SIZE * scale)
        if (p < 1) tip = { x: x + (tipIndex % SIZE - PAD) * scale, y: y + (Math.floor(tipIndex / SIZE) - SIZE / 2) * scale }
      }
      x += g.width * scale + o.spacing
    })
  })
  if (o.chalk.hand && tip && progress < 1) {
    ctx.save(); ctx.translate(tip.x, tip.y); ctx.rotate(-0.5)
    const s = o.fontPx / 80; ctx.scale(s, s)
    ctx.fillStyle = '#e1ae87'; ctx.strokeStyle = '#ad785c'; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(8, 14); ctx.bezierCurveTo(4, 2, 14, 1, 19, 10)
    ctx.bezierCurveTo(30, 5, 39, 20, 38, 36); ctx.lineTo(31, 49); ctx.lineTo(16, 45)
    ctx.bezierCurveTo(12, 31, 1, 23, 8, 14); ctx.fill(); ctx.stroke()
    ctx.fillStyle = o.color; ctx.beginPath(); ctx.roundRect(-2, -2, 7, 23, 2); ctx.fill()
    ctx.restore()
  }
}
