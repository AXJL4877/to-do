/**
 * 验证「产物成功 vs 质量门」这条信息真的能到达前端视图。
 *
 * 读真实成片文档 → 走宿主自己的 publicProduction → 断言 view.quality 存在且字段正确。
 * 只读，不生成、不花钱。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const imp = (rel) => import(pathToFileURL(path.join(REPO, rel)).href)
const DATA = process.env.TODO_DATA_DIR || path.join(process.env.APPDATA || '', 'todo-editor', 'data')
const id = process.argv[2]
if (!id) { console.error('用法: node scripts/verify-quality-visible.mjs <productionId>'); process.exit(2) }

const rawPath = path.join(DATA, 'productions', `${id}.json`)
const doc = JSON.parse(readFileSync(rawPath, 'utf8'))
console.log('doc.quality (磁盘上的原始字段) =', JSON.stringify(doc.quality))

const { publicProduction } = await imp('server/production/doc.mjs')
const { readGateStatus } = await imp('server/production/sourceWorkflow.mjs')

// 这个成片文档是接线之前跑的，磁盘上还没有 quality；用真实 gate_status.json
// 喂给新的 readGateStatus，确认"下次跑就会带上"这件事成立。
const work = doc.params?.sourceWork || path.join(DATA, 'ai-generated', `${id}_koubo`)
const fresh = readGateStatus(work)
console.log('readGateStatus(真实产物)       =', JSON.stringify(fresh))
if (!doc.quality && fresh) {
  doc.quality = fresh
  console.log('（已用真实 gate_status.json 注入，模拟下一次运行）')
}

const view = publicProduction(doc, { voice: () => false, plan: () => false, subtitles: () => false, asset: () => false, render: () => false })
console.log('view.quality (前端拿到的)       =', JSON.stringify(view.quality))

const problems = []
if (!('quality' in view)) {
  problems.push('视图里没有 quality 字段 —— 前端无从展示"质量门未过"')
}
if (view.quality) {
  for (const k of ['productOk', 'gatesOk', 'failedGates']) {
    if (!(k in view.quality)) problems.push(`quality 缺字段 ${k}`)
  }
  if (!Array.isArray(view.quality.failedGates)) problems.push('failedGates 不是数组')
  // 与 summary.json 对照：未通过的门必须被列出来
  const summaryPath = path.join(DATA, 'ai-generated', `${id}_koubo`, '04_动画渲染', 'output', 'accept_gates', 'summary.json')
  try {
    const rows = JSON.parse(readFileSync(summaryPath, 'utf8')).results || []
    const failed = rows.filter((r) => r && r.ok === false).map((r) => r.gate)
    console.log(`summary.json 里未通过的门      = ${JSON.stringify(failed)}`)
    if (view.quality.gatesOk === false && failed.length && view.quality.failedGates.length === 0) {
      problems.push('gatesOk=false 却没列出任何未通过的门名')
    }
  } catch { console.log('（summary.json 读不到，跳过对照）') }
}

console.log()
if (problems.length) {
  console.log('× ' + problems.join('; '))
  process.exit(1)
}
console.log(view.quality?.gatesOk === false
  ? '✓ 质量门未过的信息已能到达前端视图（含未通过门名）'
  : '✓ quality 字段已贯通（本次该成片的质量门是通过的）')
