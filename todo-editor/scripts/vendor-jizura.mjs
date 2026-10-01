// Reproduce the vendored factory from the pinned upstream checkout; never fetches code.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const source = resolve(process.argv[2] || '../to_do-research/JIZURA')
const commit = 'fc16bfe43ea4a6c25a21f1caf04d17326de14f00'
if (execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== commit) throw new Error('Expected pinned JIZURA revision')
const out = fileURLToPath(new URL('../src/lib/jizura/', import.meta.url))
mkdirSync(out, { recursive: true })
const files = ['01_util', '02_fonts', '02b_lang', '03_text', '04_styles', '05_anim', '05b_registry', '06_layouts', '07_decor', '08_planner', '09_render', '11p_kinetic1', '11p_typo1']
function readSource(f) {
  let text = readFileSync(resolve(source, 'src', `${f}.js`), 'utf8')
  if (f === '11p_kinetic1') {
    // Local patch: scale the stack's spatial impulses, preserving word onset timing.
    const replacements = [
      ['size *= 1 + 1.6 * f;', 'size *= 1 + 1.6 * f * (env.fx.motion ?? 1);'],
      ['rot = f * 8 * (i % 2 ? 1 : -1);', 'rot = f * 8 * (i % 2 ? 1 : -1) * (env.fx.motion ?? 1);'],
      ['y -= H * 0.7 * Math.pow(1 - clamp(q), 2);', 'y -= H * 0.7 * Math.pow(1 - clamp(q), 2) * (env.fx.motion ?? 1);'],
      ['x += (i % 2 ? 1 : -1) * W * 0.9 * f;', 'x += (i % 2 ? 1 : -1) * W * 0.9 * f * (env.fx.motion ?? 1);'],
      ['A.sizes[k - 1] * 0.07 * sprg(land, 9, 26)', 'A.sizes[k - 1] * 0.07 * (env.fx.motion ?? 1) * sprg(land, 9, 26)'],
    ]
    for (const [from, to] of replacements) {
      if (!text.includes(from)) throw new Error(`Upstream stack changed: ${from}`)
      text = text.replace(from, to)
    }
  }
  return text
}
const body = files.map(f => `\n// Upstream src/${f}.js\n${readSource(f)}`).join('\n')
const isolated = body.replace('const J = (window.J = window.J || {});', 'const J = {};')
if (isolated === body) throw new Error('Upstream namespace changed')
writeFileSync(resolve(out, 'engine.js'), `/*! JIZURA 0.10.1 | Copyright (c) 2026 hakoniwa | MIT | see licenses/JIZURA.txt\n * Upstream ${commit}; local changes: private factory, stack motion strength.\n * Full-frame renderer/remote font loaders are not called by the adapter. */\nexport function createJizura() {\n${isolated}\nreturn J;\n}\n`)
writeFileSync(resolve(out, 'LICENSE'), readFileSync(resolve(source, 'LICENSE')))
const publicNotices = fileURLToPath(new URL('../public/licenses/', import.meta.url))
mkdirSync(publicNotices, { recursive: true })
writeFileSync(resolve(publicNotices, 'JIZURA.txt'), readFileSync(resolve(source, 'LICENSE')))
