/**
 * final-pipeline-check.mjs — 用修好的代码，对一份**已存在**的成片跑一次真实生成。
 *
 * 目的：验证整条链在"宿主真正调用的那条路径"上闭合：
 *   executeProductionJob → runPreservedSource → run_pipeline.py（含验收门）
 *   → 产物成功 → bindLayers/bindFilm → 成片文档里有分层
 * 不新建成片、不复用我自己的 executeSkillJob 包装。
 *
 * 用法: node scripts/final-pipeline-check.mjs <productionId>
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const imp = (rel) => import(pathToFileURL(path.join(REPO, rel)).href)
const id = process.argv[2]
if (!id) { console.error('用法: node scripts/final-pipeline-check.mjs <productionId>'); process.exit(2) }

const { executeProductionJob } = await imp('server/production/job.mjs')
const { loadProduction, publicProduction } = await imp('server/production/doc.mjs')
const { defaultServices } = await imp('server/production/layers.mjs')

const job = {
  id: 's_final_check',
  kind: 'skill',
  params: {
    size: '1920x1080',
    autoTimeline: true,
    skill: { id: 'studio.spongebob-koubo', pipeline: 'production' },
    request: { skillId: 'studio.spongebob-koubo', productionId: id, scope: null, stopAfter: null, force: true },
  },
}

let lastPhase = ''
const t0 = Date.now()
const result = await executeProductionJob(job, {
  outDir: path.join(process.env.APPDATA, 'todo-editor', 'data', 'ai-generated'),
  services: defaultServices({}, (fn) => fn()),
  phase: (s) => {
    if (s !== lastPhase) {
      lastPhase = s
      console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] ${s}`)
    }
  },
  withRetry: (fn) => fn(),
})

console.log(`\n=== executeProductionJob 返回（${Math.round((Date.now() - t0) / 1000)}s）===`)
console.log('spec       =', result?.spec)
console.log('phase      =', result?.phase)
console.log('production =', JSON.stringify(result?.production))

const doc = loadProduction(id)
const view = publicProduction(doc, { voice: () => false, plan: () => false, subtitles: () => false, asset: () => false, render: () => false })
const els = view.segments.flatMap((s) => s.boards.flatMap((b) => b.render?.result?.elements || []))
const sfx = els.filter((e) => e.sfx)
console.log(`\n=== 成片文档 ===`)
console.log('status.phase =', doc.status?.phase, ' error =', doc.status?.error || '-')
console.log('segments =', doc.segments.length, ' boards =', doc.segments.reduce((n, s) => n + s.boards.length, 0))
console.log('入轨元素 =', els.length)
console.log('带音效元素 =', sfx.length)
for (const e of sfx.slice(0, 3)) console.log(`  ${e.id} ${e.label} sfx=${e.sfx}`)

const problems = []
if (!doc.status?.phase || !String(doc.status.phase).includes('完成')) problems.push(`阶段不是完成：${doc.status?.phase}`)
if (!els.length) problems.push('没有任何元素入轨（时间轴会是空的）')
if (!sfx.length) problems.push('元素级音效没有入轨')
for (const e of els) {
  for (const k of ['video', 'hold', 'sfx']) {
    if (e[k] != null && !String(e[k]).startsWith('/ai-generated/')) problems.push(`${e.id}.${k} URL 不合格：${e[k]}`)
  }
}

console.log(`\n${problems.length ? '× ' + problems.length + ' 个问题' : '✓ 整条链闭合：生成成功且分层/音效都入轨'}`)
for (const p of problems) console.log('   -', p)
process.exit(problems.length ? 1 : 0)
