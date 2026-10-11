/**
 * full-run-attribution.mjs — 一次全量生成，并把"设计阶段为什么慢"的归因直接打出来。
 *
 * 为什么单独做一个入口：设计阶段的 980s 只有在**全量跑**里才复现，
 * 而它需要真实生图（花钱）。所以把"跑 + 归因"合成一条命令，
 * 谁跑都能立刻拿到结论，不必再人工翻 design_report.json。
 *
 * 用法: node scripts/full-run-attribution.mjs <productionId> [--force]
 *
 * 输出三块：
 *   1) 各阶段耗时（pipeline_timing.json）
 *   2) 设计阶段的逐步耗时与**超时次数**（design_report.json 的 timing_per_attempt / timeouts）
 *   3) 生图延迟分布 p50/p90/max（gen_report.json）—— 慢尾是否又是主因
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const imp = (rel) => import(pathToFileURL(path.join(REPO, rel)).href)
const DATA = process.env.TODO_DATA_DIR || path.join(process.env.APPDATA || '', 'todo-editor', 'data')
const id = process.argv[2]
const force = process.argv.includes('--force')
if (!id) { console.error('用法: node scripts/full-run-attribution.mjs <productionId> [--force]'); process.exit(2) }

const docs = path.join(DATA, 'productions', `${id}.json`)
if (!existsSync(docs)) { console.error(`找不到成片文档 ${docs}`); process.exit(2) }
const doc0 = JSON.parse(readFileSync(docs, 'utf8'))
const work = doc0.params?.sourceWork
  || path.join(DATA, 'ai-generated', `${id}_koubo`)
console.log(`production : ${id}`)
console.log(`work dir   : ${work}\n`)

const { executeProductionJob } = await imp('server/production/job.mjs')
const { defaultServices } = await imp('server/production/layers.mjs')

const job = {
  id: `s_attrib_${Date.now().toString(36)}`,
  kind: 'skill',
  params: {
    size: doc0.params?.size || '1920x1080',
    autoTimeline: true,
    skill: { id: doc0.skillId, pipeline: 'production' },
    request: { skillId: doc0.skillId, productionId: id, scope: null, stopAfter: null, force },
  },
}

let last = ''
const t0 = Date.now()
const res = await executeProductionJob(job, {
  outDir: path.join(DATA, 'ai-generated'),
  services: defaultServices({}, (fn) => fn()),
  phase: (s) => { if (s !== last) { last = s; console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] ${s}`) } },
  withRetry: (fn) => fn(),
})
console.log(`\nphase = ${res?.phase}  （耗时 ${Math.round((Date.now() - t0) / 1000)}s）`)
console.log(`production = ${JSON.stringify(res?.production)}\n`)

const read = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }

// 1) 阶段耗时
const timing = read(path.join(work, '04_动画渲染', 'output', 'pipeline_timing.json'))
console.log('=== 各阶段耗时 ===')
if (timing?.stages) {
  for (const [k, v] of Object.entries(timing.stages)) {
    console.log(`  ${k.padEnd(8)} ${String(v.sec).padStart(9)}s  rc=${v.rc}${v.reused ? '  (reused)' : ''}`)
  }
  console.log(`  ${'total'.padEnd(8)} ${String(timing.total_sec).padStart(9)}s  end_to_end=${timing.end_to_end}`)
} else { console.log('  (缺 pipeline_timing.json)') }

// 2) 设计阶段归因 —— 这是本脚本存在的理由
const dr = read(path.join(work, '02_镜头设计', 'logs', 'design_report.json'))
console.log('\n=== 设计阶段归因 ===')
if (dr) {
  console.log(`  chat_timeout_s = ${dr.chat_timeout_s}   max_attempts = ${dr.max_attempts}`)
  console.log(`  total_s        = ${dr.total_s}   ok=${dr.ok} source=${dr.source}`)
  const tpa = dr.timing_per_attempt || []
  if (tpa.length) {
    for (const a of tpa) {
      console.log(`  attempt ${a.n}: classify_bgm=${a.classify_bgm_s}s  assets_parallel=${a.assets_parallel_s}s  attempt=${a.attempt_s}s`)
    }
    const sum = tpa.reduce((n, a) => n + (a.attempt_s || 0), 0)
    console.log(`  各 attempt 合计 ${Math.round(sum)}s —— 与阶段耗时对比即可看出**重试**占了多少`)
  } else {
    console.log('  (没有 timing_per_attempt：这份报告是补计时之前的版本)')
  }
  const to = dr.timeouts || []
  console.log(`  超时次数 = ${to.length}${to.length ? '  ' + JSON.stringify(to) : ''}`)
  for (const a of dr.attempts || []) {
    if (a.timeout || (a.errors || []).some((e) => String(e).includes('TIMEOUT'))) {
      console.log(`  ★ attempt ${a.n} 是超时：${String((a.errors || [])[0] || '').slice(0, 120)}`)
    }
  }
  if (!to.length) console.log('  → 本次没有超时；980s 若再出现，就得看别的原因（不是 chat 卡顿）')
} else { console.log('  (缺 design_report.json)') }

// 3) 生图延迟分布
const gr = read(path.join(work, '03_素材生成', 'logs', 'gen_report.json'))
console.log('\n=== 生图延迟分布 ===')
if (gr) {
  console.log(`  ok=${gr.ok}/${gr.total}  jobs=${gr.jobs_launched}  elapsed=${gr.elapsed_sec}s`)
  console.log(`  p50=${gr.latency_p50}s  p90=${gr.latency_p90}s  max=${gr.latency_max}s  n=${gr.latency_n}`)
  if (gr.latency_max != null && gr.elapsed_sec != null) {
    const tailShare = gr.latency_max / Math.max(1, gr.elapsed_sec)
    console.log(`  最慢一张占整个素材阶段的 ${(tailShare * 100).toFixed(0)}% —— 慢尾是不是主因，看这个比值`)
  }
} else { console.log('  (缺 gen_report.json)') }
