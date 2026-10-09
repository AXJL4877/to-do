import assert from 'node:assert/strict'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { makePng, render, request, root } from './lib.mjs'

const out = path.join(root, 'check-output', 'run')
mkdirSync(out, { recursive: true })
const image = path.join(out, 'sprite.png')
makePng(image)
const a = render(request(path.join(out, 'a'), image, { enter: 'fade', drawSpeed: 1 }))
const b = render(request(path.join(out, 'b'), image, { enter: 'fade', drawSpeed: 2 }))
assert.equal(a.scene.elements[0].id, 'hero')
assert.ok(b.scene.elements[0].frames < a.scene.elements[0].frames, 'drawSpeed must change entrance length')
for (const e of a.scene.elements) {
  const video = path.join(out, 'a', e.video)
  const hold = path.join(out, 'a', e.hold)
  assert.ok(existsSync(video) && statSync(video).size > 100)
  assert.ok(existsSync(hold) && statSync(hold).size > 100)
}
writeFileSync(path.join(root, 'check-output', 'result.json'), JSON.stringify({
  ok: true, fps: a.fps, ids: a.scene.elements.map((e) => e.id),
  frames1: a.scene.elements[0].frames, frames2: b.scene.elements[0].frames,
}, null, 2))
console.log('runtime ok')
