/**
 * 把一份已经跑完的包内工作目录【导入成 TO DO 里的成片】。
 *
 * 为什么需要它：手工/命令行跑完 run_pipeline.py 后，产物只是磁盘上的工作目录，
 * APP 里看不见。这个脚本用宿主自己的绑定代码（bindFilm）建出成片文档、
 * 把配音/时间戳/分层/BGM/成片全部收进 APP 数据目录，并可选登记到某个工程里，
 * 打开工程后宿主就会把时间轴绑出来。
 *
 * 用法:
 *   node scripts/import-koubo-workdir.mjs <工作目录> [--title 标题] [--project <工程.todo.json>] [--dry]
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const dry = argv.includes('--dry')
const work = path.resolve(argv.find((a) => !a.startsWith('--') && !argv[argv.indexOf(a) - 1]?.startsWith('--')) || '')
if (!work || !existsSync(work)) {
  console.error('用法: node scripts/import-koubo-workdir.mjs <工作目录> [--title 标题] [--project 工程.todo.json]')
  process.exit(1)
}

// 宿主数据目录：和 APP 用同一个，否则 APP 看不见
if (!process.env.TODO_DATA_DIR) {
  const devRoot = path.join(repo, '.data')
  const link = path.join(devRoot, 'skills', 'studio.spongebob-koubo')
  let target = null
  try { if (existsSync(link)) target = readFileSync(link) } catch { /* */ }
  process.env.TODO_DATA_DIR = path.join(process.env.APPDATA || '', 'todo-editor', 'data')
}
const dataDir = process.env.TODO_DATA_DIR
const outDir = path.join(dataDir, 'ai-generated')
mkdirSync(outDir, { recursive: true })
console.log(`工作目录 ${work}\n数据目录 ${dataDir}`)

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const timingPath = path.join(work, '01_口播试听', 'timing.json')
const filmPath = path.join(work, '04_动画渲染', 'output', '成片.mp4')
const scriptPath = path.join(work, '01_口播试听', '口播.txt')
for (const [label, p] of [['timing.json', timingPath], ['成片.mp4', filmPath], ['口播.txt', scriptPath]]) {
  if (!existsSync(p)) { console.error(`缺少 ${label}: ${p}`); process.exit(1) }
}

const { createProduction, productionEntry } = await import('../server/production/job.mjs')
const { bindFilm } = await import('../server/production/sourceWorkflow.mjs')
const { newSegment, saveProduction } = await import('../server/production/doc.mjs')
const { resolveFfmpeg } = await import('../server/animBuild.mjs')

// 用真实技能包当 entry：绑定时要用 pack.planner / pack.id 等字段
const entry = productionEntry('studio.spongebob-koubo')
const script = readFileSync(scriptPath, 'utf8').trim()
const title = arg('--title', '')
const doc = dry
  ? { id: 'dry', title: title || '(dry)', params: {}, cast: [], segments: [], counters: { g: 0, b: 0, e: 0, v: 0 } }
  : createProduction({ skillId: 'studio.spongebob-koubo', script, params: {}, title })

// 复用同一个工作目录已存在的成片 id。
// 为什么必须：宿主是按片段的 meta.source.jobId 认领时间轴的——每次导入都换新 id，
// 宿主就会**追加**而不是替换，时间轴直接翻倍（实测 83 → 165 个片段、8 → 15 条轨道）✗
// 复用 id 后，宿主按同一 jobId 重新认领，行为与"应用自己重跑一遍"一致。
const productionsDir = path.join(dataDir, 'productions')
let reuseId = null
if (!dry && existsSync(productionsDir)) {
  for (const f of readdirSync(productionsDir)) {
    if (!f.endsWith('.json')) continue
    try {
      const d = JSON.parse(readFileSync(path.join(productionsDir, f), 'utf8'))
      if (d && d.id !== doc.id && d.params && d.params.sourceWork === work) { reuseId = d.id; break }
    } catch { /* 单个文档坏了不影响导入 */ }
  }
}
if (reuseId) {
  console.log(`复用同工作目录的成片 id ${reuseId}（避免时间轴翻倍）`)
  rmSync(path.join(productionsDir, `${doc.id}.json`), { force: true })
  doc.id = reuseId
}
doc.params = { ...(doc.params || {}), sourceWork: work }
console.log(`成片 id ${doc.id}`)

// 时长/画幅：只用 ffmpeg 读（本机常缺 ffprobe）
const ffmpeg = resolveFfmpeg()
const { spawnSync } = await import('node:child_process')
const probe = spawnSync(ffmpeg, ['-hide_banner', '-i', filmPath], { encoding: 'utf8' })
const text = `${probe.stderr || ''}\n${probe.stdout || ''}`
const dm = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
const sm = text.match(/Video:.*?(\d{2,5})x(\d{2,5})/)
const duration = dm ? Number(dm[1]) * 3600 + Number(dm[2]) * 60 + Number(dm[3]) : 0
const width = sm ? Number(sm[1]) : 1920
const height = sm ? Number(sm[2]) : 1080
console.log(`成片 ${duration.toFixed(2)}s ${width}x${height}`)

const timing = readJson(timingPath)
const seg = newSegment(doc, { text: script, title: doc.title || '口播' })
doc.segments = [seg]
// 先在仓库内暂存：某些环境下 ffmpeg 子进程只允许写工作区，绑完再用 Node 搬进数据目录
const stage = path.join(repo, 'native', 'test-output', 'import-stage')
mkdirSync(stage, { recursive: true })
for (const f of readdirSync(stage)) rmSync(path.join(stage, f), { force: true })
const ctx = { doc, pack: entry.pack, entry, outDir: stage }
bindFilm(ctx, seg, { timing, film: filmPath, width, height, duration, work })

// 写完状态：**这一步以前漏了**，于是命令行导入的成片在 APP 里卡片一直显示「待生成」，
// 明明 35 个元素都有图、成片也在，用户却会误以为没生成（甚至误点重试把片子覆盖）。
// 这里如实写成已完成，并注明来源，便于和"由 APP 跑出来的"区分。
doc.status = {
  running: false,
  phase: '完成（命令行导入）',
  pct: 100,
  failed: [],
  error: null,
}

if (!dry) {
  let moved = 0
  for (const name of readdirSync(stage)) {
    copyFileSync(path.join(stage, name), path.join(outDir, name))
    rmSync(path.join(stage, name), { force: true })
    moved++
  }
  saveProduction(doc)
  const layers = doc.sourceLayers
  console.log(`已搬入 APP 数据目录 ${moved} 个文件 → ${outDir}`)
  console.log('已写入成片文档:', path.join(dataDir, 'productions', `${doc.id}.json`))
  console.log('分层:', JSON.stringify(layers))
  console.log('BGM 段:', (doc.sourceBgmPlan?.segments || []).map((s) => s.id).join(' → ') || '无')
}

const project = arg('--project', '')
const registerId = arg('--register', '')
if (registerId) {
  // 只登记一个已存在的成片到工程，不做导入（早退，避免又多建一份文档）
  const p = path.resolve(arg('--into', project || ''))
  if (!p || !existsSync(p)) { console.error('需要 --into <工程.todo.json>'); process.exit(1) }
  const j = JSON.parse(readFileSync(p, 'utf8'))
  copyFileSync(p, `${p}.before-import.bak`)
  j.settings = j.settings || {}
  j.settings.aiProductions = { ...(j.settings.aiProductions || {}), [registerId]: { t0: 0, auto: true, placed: {}, createdAt: Date.now() } }
  writeFileSync(p, JSON.stringify(j))
  console.log(`已把 ${registerId} 登记到 ${p}（原文件已备份 .before-import.bak）`)
  console.log('该工程现有成片:', Object.keys(j.settings.aiProductions).join(', '))
  process.exit(0)
}
if (project && !dry) {
  const p = path.resolve(project)
  const j = readJson(p)
  const projMedia = path.join(path.dirname(p), 'ai-generated')
  // 工程用的是**工程文件夹内**的媒体（设计如此：一个项目一个文件夹，可整个拷走）。
  // 只更新 %APPDATA% 那份是不够的——工程回放读的是自己文件夹里的同名文件，
  // 于是"改了图层却还是旧画面"（实测：卡片虚化元素补进导出后，时间轴仍旧 ✗）。
  // 这里按同 id 前缀覆盖同步一次；文件名与 id 绑定，覆盖是安全的。
  let synced = 0
  if (existsSync(projMedia) && existsSync(outDir)) {
    for (const name of readdirSync(outDir)) {
      if (!name.startsWith(`${doc.id}_`)) continue
      copyFileSync(path.join(outDir, name), path.join(projMedia, name))
      synced++
    }
  }
  j.settings = j.settings || {}
  j.settings.aiProductions = { ...(j.settings.aiProductions || {}), [doc.id]: { t0: 0, auto: true, placed: {}, createdAt: Date.now() } }
  copyFileSync(p, `${p}.before-import.bak`)
  writeFileSync(p, JSON.stringify(j))
  console.log(`已同步 ${synced} 个媒体到工程文件夹 ${projMedia}`)
  console.log(`已登记到工程 ${p}（打开后宿主会把时间轴绑出来）`)
}
console.log(dry ? '（dry-run，未落盘）' : '完成')
