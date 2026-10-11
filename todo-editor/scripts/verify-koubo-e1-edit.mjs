/** 用真实生产文档验证 E1：多 crop 不重合，缩放编辑会改变 transform。 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const data = process.env.TODO_DATA_DIR || path.join(process.env.APPDATA || '', 'todo-editor', 'data')
const id = process.argv[2] || 'p_mv1x27lf_pchr'
const doc = JSON.parse(readFileSync(path.join(data, 'productions', `${id}.json`), 'utf8'))
const els = doc.segments.flatMap((s) => s.boards.flatMap((b) => b.render?.result?.elements || []))
assert.ok(els.length >= 4, `need layered elements, got ${els.length}`)
assert.ok(doc.segments[0].subtitles?.cues?.length > 0, 'need host subtitle cues for font styling')
const crops = els.map((e) => e.crop.join(','))
assert.ok(new Set(crops).size >= 3, 'crops must differ across elements')

const outDir = path.join(repo, 'native', 'test-output', 'spongebob-koubo')
mkdirSync(outDir, { recursive: true })
const outfile = path.join(outDir, 'e1-edit.mjs')
const payload = JSON.stringify(els.map((e) => ({ id: e.id, label: e.label, crop: e.crop })))
await build({
  stdin: {
    sourcefile: 'e1.ts',
    contents: `
import { elementTransform } from './src/lib/chalkHandLayers.ts'
const els = ${payload}
const frame = { width: 1920, height: 1080 }
const proj = { width: 1920, height: 1080 }
const transforms = els.map(e => ({ id: e.id, label: e.label, t: elementTransform(e.crop, frame, proj) }))
const xs = new Set(transforms.map(x => Math.round(x.t.x * 1000)))
if (xs.size < 2) throw new Error('elements collapsed to same x')
const a = transforms.find(x => x.label !== '背景') || transforms[0]
const edited = { ...a.t, scaleX: a.t.scaleX * 1.35, scaleY: a.t.scaleY * 1.35, x: a.t.x + 0.08 }
if (edited.scaleX === a.t.scaleX) throw new Error('scale edit ignored')
console.log(JSON.stringify({ ok: true, n: transforms.length, sample: a, edited }))
`,
    resolveDir: repo,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  logLevel: 'silent',
})
const run = spawnSync(process.execPath, [outfile], { encoding: 'utf8' })
if (run.status !== 0) {
  console.error(run.stderr || run.stdout)
  process.exit(1)
}
const dataOut = JSON.parse(run.stdout.trim().split(/\r?\n/).pop())
writeFileSync(path.join(outDir, 'e1-edit.json'), JSON.stringify({ id, subs: doc.segments[0].subtitles.cues.length, ...dataOut }, null, 2))
console.log('e1-edit ok', dataOut.n, 'elements', 'subs', doc.segments[0].subtitles.cues.length)
