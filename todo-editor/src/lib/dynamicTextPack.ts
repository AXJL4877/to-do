import { DYNAMIC_PRESETS } from './dynamicText'
import type { FancyPreset } from './fancyText'

/** Local extension: editable templates, independent of the font-style registry. */
export const DYNAMIC_TEXT_PACK = {
  id: 'jizura-dynamic-text', name: '动态文字', version: '1.0.0',
  description: '六种文字排版与运动模板，可编辑、透明叠加并导出。',
} as const

export const DYNAMIC_TEXT_PRESETS: FancyPreset[] = DYNAMIC_PRESETS.map(p => ({
  id: p.id, name: p.name, category: 'dynamic', fonts: ['Microsoft YaHei', 'SimHei'],
  fancy: { fontWeight: 700, fill: ['#f8f5e9'], fillAngle: 90, strokes: [],
    dynamic: { version: 1, engine: 'jizura', presetId: p.id, seed: 20261002, duration: 3, motion: 0.7, accent: '#ffb454' } },
}))
