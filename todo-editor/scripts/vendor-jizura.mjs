// Reproduce the vendored factory from the pinned upstream checkout; never fetches code.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const source = resolve(process.argv[2] || '../to_do-research/JIZURA')
const commit = 'fc16bfe43ea4a6c25a21f1caf04d17326de14f00'
if (execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== commit) throw new Error('Expected pinned JIZURA revision')
const out = fileURLToPath(new URL('../src/lib/jizura/', import.meta.url))
mkdirSync(out, { recursive: true })
const files = readdirSync(resolve(source, 'src')).filter(f => /^(0[1-9]|11p_|11q_).*\.js$/.test(f)).sort().map(f => f.slice(0, -3))
function readSource(f) {
  let text = readFileSync(resolve(source, 'src', `${f}.js`), 'utf8')
  if (f === '09_render') {
    text = text.replace('constructor() {', 'constructor() {\n    const noise = J.rng(0x4a495a55);')
      .replace('c.height = Math.max(1, h | 0); return c;', "c.height = Math.max(1, h | 0); c.getContext('2d', { willReadFrequently: true }); return c;")
      .replace('paper(W, H) {', 'paper(W, H) {\n    const noise = J.rng(J.h(0x50415045, W, H));')
      .replaceAll('Math.random()', 'noise()')
  }
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
  return text.replaceAll(".getContext('2d')", ".getContext('2d', { willReadFrequently: true })")
}
const labels = readFileSync(resolve(source, 'app/chinese_hans.js'), 'utf8')
const styleNames = JSON.parse(readFileSync(new URL('../shared/jizura-style-zh.json', import.meta.url), 'utf8'))
const localLabels = `\nfor (const [id, [name, desc]] of Object.entries(${JSON.stringify(styleNames)})) if (J.STYLES[id]) Object.assign(J.STYLES[id], {name, desc});`
const body = files.map(f => `\n// Upstream src/${f}.js\n${readSource(f)}`).join('\n') + '\n' + labels + localLabels
const isolated = body.replace('const J = (window.J = window.J || {});', 'const J = {};')
if (isolated === body) throw new Error('Upstream namespace changed')
writeFileSync(resolve(out, 'engine.js'), `/*! JIZURA 0.10.1 | Copyright (c) 2026 hakoniwa | MIT | see licenses/JIZURA.txt\n * Upstream ${commit}; local changes: private factory, seeded textures, stack strength.\n * All expression packs; local fonts and host export. */\nexport function createJizura() {\n${isolated}\nreturn J;\n}\n`)
writeFileSync(resolve(out, 'LICENSE'), readFileSync(resolve(source, 'LICENSE')))
const publicNotices = fileURLToPath(new URL('../public/licenses/', import.meta.url))
mkdirSync(publicNotices, { recursive: true })
writeFileSync(resolve(publicNotices, 'JIZURA.txt'), readFileSync(resolve(source, 'LICENSE')))
