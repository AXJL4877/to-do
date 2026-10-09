import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { makePng, render, request, root } from './lib.mjs'

const out = path.join(root, 'check-output', 'base')
mkdirSync(out, { recursive: true })
const image = path.join(out, 'sprite.png')
makePng(image)
const slow = render(request(path.join(out, 'slow'), image), { SB_RENDER: 'python' })
const fast = render(request(path.join(out, 'fast'), image), { SB_RENDER: 'ffmpeg' })
assert.deepEqual(fast.scene.elements.map((e) => e.id), ['hero', 'prop'])
assert.deepEqual(slow.scene.elements.map((e) => e.id), fast.scene.elements.map((e) => e.id))
assert.equal(fast.alpha, true)
assert.equal(fast.width, 1280)
for (const e of fast.scene.elements) {
  assert.equal(e.crop.length, 4)
  assert.ok(e.frames >= 8)
}
const report = {
  ok: true,
  ids: fast.scene.elements.map((e) => e.id),
  slowFrames: slow.scene.elements.map((e) => e.frames),
  fastFrames: fast.scene.elements.map((e) => e.frames),
}
writeFileSync(path.join(root, 'check-output', 'baseline.json'), JSON.stringify(report, null, 2))
console.log('baseline ok')
