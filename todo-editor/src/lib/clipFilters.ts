import type { BlendMode, Clip, ColorGrade, EffectInstance } from '../types'

export function colorGradeFilter(c: ColorGrade): string {
  const brightness = 1 + c.exposure * 0.22 + c.highlights * 0.08 - c.shadows * 0.06 + c.whites * 0.04 - c.blacks * 0.04
  const contrast = 1 + c.contrast * 0.35
  const sat = 1 + c.saturation * 0.45
  const hue = c.temperature * 14 + c.tint * 8 + c.hueShift * 36
  const parts = [
    `brightness(${brightness.toFixed(3)})`,
    `contrast(${contrast.toFixed(3)})`,
    `saturate(${sat.toFixed(3)})`,
    `hue-rotate(${hue.toFixed(1)}deg)`,
  ]
  if (c.lutStrength > 0.01) parts.push(`sepia(${(c.lutStrength * 0.35).toFixed(3)})`)
  return parts.join(' ')
}

export function effectFilterStack(effects: EffectInstance[]): string {
  return effects
    .filter((e) => e.enabled && e.strength > 0)
    .map((e) => {
      const s = e.strength
      switch (e.type) {
        case 'blur': return `blur(${(s * 12).toFixed(1)}px)`
        case 'sharpen': return `contrast(${(1 + s * 0.25).toFixed(3)})`
        case 'filter': return `saturate(${(1 + s * 0.5).toFixed(3)})`
        case 'noiseReduce': return `contrast(${(1 - s * 0.08).toFixed(3)})`
        default: return ''
      }
    })
    .filter(Boolean)
    .join(' ')
}

export function clipCanvasFilter(clip: Clip): string {
  return [colorGradeFilter(clip.color), effectFilterStack(clip.effects)].filter(Boolean).join(' ')
}

export function blendToComposite(mode: BlendMode): GlobalCompositeOperation {
  switch (mode) {
    case 'multiply': return 'multiply'
    case 'screen': return 'screen'
    case 'overlay': return 'overlay'
    case 'soft-light': return 'soft-light'
    case 'add': return 'lighter'
    default: return 'source-over'
  }
}
