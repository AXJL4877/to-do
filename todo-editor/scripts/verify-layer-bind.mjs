/**
 * 验证入轨：用真实产出的 layers_manifest 跑宿主的 bindLayerBoards + publicProduction。
 * 走应用自己的代码；只读产物 + 写临时数据目录（不碰用户工程）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const imp = (rel) => import(pathToFileURL(path.join(REPO, rel)).href)

const WORK = process.argv[2]        // 控制实例里的 workflow 副本（提供 skill 包）
const LAYER_OUT = process.argv[3]   // 真实产物目录（含 layers_manifest.json）
const manifest = JSON.parse(readFileSync(path.join(LAYER_OUT, 'layers_manifest.json'), 'utf8'))
const layerDir = path.join(LAYER_OUT, manifest.dir || 'layers')

process.env.TODO_DATA_DIR = process.env.TODO_DATA_DIR || mkdtempSync(path.join(tmpdir(), 'todo-bind-'))
const outDir = path.join(process.env.TODO_DATA_DIR, 'ai-generated')
mkdirSync(outDir, { recursive: true })

const { bindLayerBoards } = await imp('server/production/sourceWorkflow.mjs')
const { newProductionId, newSegment, publicProduction } = await imp('server/production/doc.mjs')
const { getSkillEntry } = await imp('server/skillPacks.mjs')

const entry = getSkillEntry('studio.spongebob-koubo')
const doc = {
  spec: 'todo-production/1', id: newProductionId(), skillId: 'studio.spongebob-koubo',
  title: '入轨验证', script: '入轨验证', params: { size: '1920x1080', fps: '30' },
  cast: [], segments: [], counters: {}, sourceRun: null, status: null, lock: null,
}
const seg = newSegment(doc, { text: '入轨验证', title: '验证' })
doc.segments = [seg]

const ok = bindLayerBoards({ doc, outDir, pack: entry.pack, entry }, seg, { manifest, layerDir, width: 1920, height: 1080 })
console.log('bindLayerBoards =', ok)

const els = seg.boards.flatMap((b) => b.render?.result?.elements || [])
console.log(`boards=${seg.boards.length}  elements=${els.length}`)
const sfxEls = els.filter((e) => e.sfx)
console.log(`带音效元素=${sfxEls.length}`)

const problems = []
for (const e of els) {
  for (const k of ['video', 'hold']) {
    const f = path.join(outDir, String(e[k]))
    if (!existsSync(f)) problems.push(`缺 ${k}: ${e[k]}`)
  }
}
for (const e of sfxEls) {
  const f = path.join(outDir, String(e.sfx))
  if (!existsSync(f)) problems.push(`缺音效: ${e.sfx}`)
  else console.log(`  音效 ${e.sfx} ${statSync(f).size}B`)
}

const view = publicProduction(doc, { voice: () => false, plan: () => false, subtitles: () => false, asset: () => false, render: () => false })
const vEls = view.segments.flatMap((s) => s.boards.flatMap((b) => b.render?.result?.elements || []))
for (const e of vEls) {
  for (const k of ['video', 'hold', 'sfx']) {
    if (e[k] != null && !String(e[k]).startsWith('/ai-generated/')) problems.push(`${e.id}.${k} 不是宿主 URL: ${e[k]}`)
  }
}
console.log(`视图：${vEls.length} 个元素，URL 全部合格=${problems.length === 0}`)

console.log(`\n${problems.length ? '× ' + problems.length + ' 个问题' : '✓ 入轨通过：分层与音效都能进时间轴'}`)
for (const p of problems.slice(0, 10)) console.log('   -', p)
process.exit(problems.length ? 1 : 0)
