/** 海绵宝宝贴纸：crop → 宿主 elementTransform，改缩放后采样变化。 */
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(repo, 'native', 'test-output', 'spongebob-koubo')
mkdirSync(outDir, { recursive: true })
const outfile = path.join(outDir, 'transform.mjs')
await build({
  stdin: {
    sourcefile: 'sb-transform.ts',
    contents: `
import { elementTransform } from './src/lib/chalkHandLayers.ts'
const frame = { width: 1280, height: 720 }
const proj = { width: 1920, height: 1080 }
const a = elementTransform([100, 200, 300, 400], frame, proj)
const b = elementTransform([700, 180, 280, 360], frame, proj)
const edited = { ...a, scaleX: a.scaleX * 1.4, scaleY: a.scaleY * 1.4, x: a.x + 0.1 }
if (a.x === b.x && a.y === b.y) throw new Error('two elements collapsed')
if (edited.scaleX === a.scaleX) throw new Error('scale edit ignored')
console.log(JSON.stringify({ ok: true, a, b, edited }))
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
const data = JSON.parse(run.stdout.trim().split(/\r?\n/).pop())
writeFileSync(path.join(outDir, 'timeline.json'), JSON.stringify(data, null, 2))
console.log('timeline ok', data.a.x.toFixed(3), data.edited.scaleX.toFixed(3))
