/** 盖章入场的粉笔灰。u 为这段进场的 0~1，撞击之后才扬起，结束时散尽。 */

/** 飞散基准 = 元素较短边的这个比例。预览、画布和导出用同一个数。 */
export const DUST_SPREAD_OF_ELEMENT = 0.42

/**
 * 元素在画面上的较短边（像素）。素材先等比放进画幅，再乘缩放和裁切。
 * 粉尘范围用它，不跟整幅画面走。
 */
export function elementDustSpread(
  frameW: number, frameH: number,
  mediaW: number, mediaH: number,
  scaleX: number, scaleY: number,
  cropW = 1, cropH = 1,
): number {
  const iw = mediaW > 1 ? mediaW : frameW
  const ih = mediaH > 1 ? mediaH : frameH
  const fit = Math.min(frameW / Math.max(iw, 1), frameH / Math.max(ih, 1))
  const dw = iw * fit * Math.abs(scaleX || 1) * Math.min(1, Math.max(0.05, cropW))
  const dh = ih * fit * Math.abs(scaleY || 1) * Math.min(1, Math.max(0.05, cropH))
  return Math.max(4, Math.min(dw, dh)) * DUST_SPREAD_OF_ELEMENT
}

export type DustSpeck = { x: number; y: number; r: number; a: number }

function hash01(seed: string, i: number): number {
  let h = 2166136261 ^ i
  for (let k = 0; k < seed.length; k++) h = Math.imul(h ^ seed.charCodeAt(k), 16777619)
  h = Math.imul(h ^ (h >>> 15), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}

export function stampDustSpecks(seed: string, u: number, cx: number, cy: number, spread: number, strength: number): DustSpeck[] {
  const impact = 0.36
  if (u < impact || u >= 0.995 || strength <= 0 || spread <= 0) return []
  const q = Math.min(1, (u - impact) / (1 - impact))
  const n = Math.round(16 + 30 * strength)
  const out: DustSpeck[] = []
  for (let i = 0; i < n; i++) {
    const h1 = hash01(seed, i)
    const h2 = hash01(seed, i + 101)
    const h3 = hash01(seed, i + 202)
    const h4 = hash01(seed, i + 303)
    const life = 0.42 + h1 * 0.58
    if (q >= life) continue
    const age = q / life
    const ang = h2 * Math.PI * 2
    const speed = spread * (0.35 + h3 * 1.15)
    const rise = spread * (0.85 + h4 * 1.35)
    const puff = h4 > 0.84
    out.push({
      x: cx + Math.cos(ang) * speed * age,
      y: cy - rise * age + spread * 0.5 * age * age + Math.sin(ang) * speed * 0.22 * age,
      r: Math.max(0.7, spread * (puff ? 0.2 : 0.035 + h1 * 0.04) * (1 + age * 0.7)),
      a: strength * (1 - age) ** 1.25 * (puff ? 0.28 : 0.4 + h3 * 0.55),
    })
  }
  return out
}

export function paintStampDust(ctx: CanvasRenderingContext2D, specks: DustSpeck[]) {
  for (const s of specks) {
    ctx.beginPath()
    ctx.fillStyle = `rgba(236, 228, 210, ${s.a.toFixed(3)})`
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2)
    ctx.fill()
  }
}
