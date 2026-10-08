import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createJizura } from '../src/lib/jizura/engine.js'
// Registration only: no rendering, fonts, networking or browser UI runs here.
globalThis.document = { createElement: () => ({ getContext: () => ({ measureText: t => ({ width: String(t).length * 48 }) }) }) }
const J = createJizura()
const groups = Object.fromEntries(J.GROUP_KEYS.map(g => [g, J.order(g).map(id => {
  const d = J.registry(g)[id]
  return { id, name: d.name, pack: d.pack || 'core', set: d.set || null, tags: d.tags || [] }
})]))
const styles = J.STYLE_ORDER.map(id => ({ id, name: J.STYLES[id].name, description: J.STYLES[id].desc || '', set: J.STYLES[id].set || null }))
const catalog = { revision: 'fc16bfe43ea4a6c25a21f1caf04d17326de14f00', groups, styles }
mkdirSync(resolve('shared'), { recursive: true })
writeFileSync(resolve('shared/jizura-catalog.json'), JSON.stringify(catalog, null, 2) + '\n')
console.log(JSON.stringify({ styles: styles.length, groups: Object.fromEntries(Object.entries(groups).map(([g, v]) => [g, v.length])) }))

// Keep server and bundled fallback selectors aligned with the pinned engine.
const manifestPath = resolve('server/skills/dynamic-text/skill.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
for (const p of manifest.params) {
  const items = p.id === 'style' ? styles : groups[p.id]
  if (!items) continue
  p.options = [...(p.id === 'style' ? [] : [{value:'auto',label:'自动搭配'}]), ...items.map(x => ({value:x.id,label:x.name}))]
  if (['decor','treat','bg','cam','fx','trans'].includes(p.id) && !items.some(x => x.id === 'none')) p.options.splice(1,0,{value:'none',label:'关闭'})
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
