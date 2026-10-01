import { DYNAMIC_PRESETS } from './dynamicText'
import type { FancyPreset } from './fancyText'
import type { SkillPack } from './aiSkills'
import manifest from '../../server/skills/dynamic-text/skill.json'

/** Local extension: editable templates, independent of the font-style registry. */
export const DYNAMIC_TEXT_PACK: SkillPack = {
  ...manifest, previews: [],
  planner: { maxElements: manifest.planner.maxElements, countParam: null },
} as unknown as SkillPack

export const DYNAMIC_TEXT_PRESETS: FancyPreset[] = DYNAMIC_PRESETS.map(p => ({
  id: p.id, name: p.name, category: 'dynamic', fonts: ['Microsoft YaHei', 'SimHei'],
  fancy: { fontWeight: 700, fill: ['#f8f5e9'], fillAngle: 90, strokes: [],
    dynamic: { version: 1, engine: 'jizura', presetId: p.id, seed: 20261002, duration: 3, motion: 0.7, accent: '#ffb454' } },
}))
