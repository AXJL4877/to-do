/**
 * 验证「运行中状态文案」的逻辑（不跑生成、不花钱）。
 *
 * 复刻 ProductionStudio.tsx 里的 runStatusText 决策，喂真实形状的输入，
 * 断言：能区分"在跑很久"和"卡死"、不把 0% 当进度、跑完不显示运行文案。
 */
const fmtCase = ({ running, since, phase, now }) => {
  if (!running) return ''
  const mins = typeof since === 'number' && since > 0 ? Math.floor((now - since) / 60000) : null
  const base = mins == null ? '生成中' : `生成中 · 已运行 ${mins < 1 ? '不到 1 分钟' : `${mins} 分钟`}`
  const p = String(phase || '').trim()
  const tail = p && !/^原工作流/.test(p) ? ` · ${p}` : ''
  return `${base}${tail}（改动请等这一轮结束，或先停止）`
}

const NOW = 1_800_000_000_000
const cases = [
  {
    name: '跑了 38 分钟、只有"原工作流（0%）"这种无信息阶段',
    input: { running: true, since: NOW - 38 * 60000, phase: '原工作流（0%）', now: NOW },
    must: ['已运行 38 分钟', '改动请等这一轮结束'],
    mustNot: ['0%', '原工作流'],
  },
  {
    name: '刚起步（<1 分钟）',
    input: { running: true, since: NOW - 20_000, phase: '开始', now: NOW },
    must: ['不到 1 分钟', '开始'],
    mustNot: ['0 分钟'],
  },
  {
    name: '工作流已给出具体阶段',
    input: { running: true, since: NOW - 5 * 60000, phase: '工作流 progress 16/19 elapsed=540s', now: NOW },
    must: ['已运行 5 分钟', 'progress 16/19'],
    mustNot: [],
  },
  {
    name: 'lock.since 缺失（老文档 / 异常）',
    input: { running: true, since: null, phase: '工作流 tts 0', now: NOW },
    must: ['生成中', 'tts'],
    mustNot: ['NaN', 'undefined', 'null'],
  },
  {
    name: '没在跑 → 不显示运行文案',
    input: { running: false, since: NOW - 60000, phase: '完成', now: NOW },
    must: [],
    mustNot: ['生成中'],
  },
]

let bad = 0
for (const c of cases) {
  const out = fmtCase(c.input)
  const missing = c.must.filter((m) => !out.includes(m))
  const leaked = c.mustNot.filter((m) => out.includes(m))
  const ok = !missing.length && !leaked.length
  if (!ok) bad++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`)
  console.log(`      → ${JSON.stringify(out)}`)
  if (missing.length) console.log(`      ✗ 缺少: ${missing.join(', ')}`)
  if (leaked.length) console.log(`      ✗ 不该出现: ${leaked.join(', ')}`)
}
console.log()
if (bad) { console.log(`× ${bad}/${cases.length} 个用例失败`); process.exit(1) }
console.log(`✓ ${cases.length}/${cases.length} 通过：运行中的文案能区分"在跑"与"卡死"，且不把 0% 当进度`)
