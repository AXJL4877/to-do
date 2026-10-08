/** 完整编排导出合并烘焙：同段多镜应共用一条成片再切片 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { fullCompositionKey, buildBakeClip } = require('../electron/chalkTextExport.cjs')

function clip(offset, duration, content, scenes) {
  return {
    id: content,
    duration,
    text: {
      content,
      fontFamily: 'Microsoft YaHei',
      fontSize: 96,
      color: '#fff',
      fancy: {
        fontWeight: 700,
        fill: ['#fff'],
        dynamic: {
          version: 2,
          engine: 'jizura',
          presetId: 'dynamic-full',
          seed: 1,
          motion: 0.7,
          accent: '#ffb454',
          duration,
          composition: {
            style: 'noir',
            mood: 'graphic',
            background: 'transparent',
            unify: true,
            parts: {},
            fx: { decor: 0.6, chroma: 0.4, glitch: 0.25, texture: 0.5, bgSwitch: 0.5 },
            offset,
            scenes,
          },
        },
      },
    },
  }
}

const scenes = [
  { content: '第一句', start: 0, end: 2 },
  { content: '第二句', start: 2, end: 5 },
  { content: '第三句', start: 5, end: 8 },
]
const a = clip(0, 2, '第一句改', scenes)
const b = clip(2, 3, '第二句改', scenes)
const c = clip(5, 3, '第三句改', scenes)
assert.equal(fullCompositionKey(a), fullCompositionKey(b))
assert.equal(fullCompositionKey(b), fullCompositionKey(c))
assert.equal(fullCompositionKey(clip(0, 2, 'x', [{ content: '别的', start: 0, end: 2 }])) === fullCompositionKey(a), false)

const { bake, t0 } = buildBakeClip([c, a, b])
assert.equal(t0, 0)
assert.equal(bake.duration, 8)
assert.equal(bake.text.fancy.dynamic.composition.offset, 0)
assert.deepEqual(
  bake.text.fancy.dynamic.composition.scenes.map((s) => s.content),
  ['第一句改', '第二句改', '第三句改'],
)
assert.equal(fullCompositionKey({ text: { fancy: { dynamic: { version: 1 } } } }), null)
console.log('chalk export bake: full composition merge ok')
