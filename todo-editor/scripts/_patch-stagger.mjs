/**
 * 让同一镜头里的元素**先后出现**（错开），而不是一起蹦出来。
 *
 * 背景（查证结果）：
 *   原管线 `kit/stage.py` 里每个图层有自己的进场时刻 `enter_at`（口播绝对秒），
 *   渲染时 `t_abs < enter_at + delay` 就不画——所以元素是**一个接一个**出现的。
 *   其中 `_swap_delay` 只在"同站位换状态"时补一个 SWAP_GAP，等旧状态淡出。
 *   但导出给时间轴的层清单（layers_manifest）**只记录了 board 的 startMs**，
 *   每个元素的 enter_at 丢了 → 时间轴上同镜头的元素全部同时出现。这就是"没有渐进出现"的根因。
 *
 * 本命令是**桥**：把已有的时间轴按"同一时刻起步的一组元素"重新错开，
 * 不必重跑管线。要根治还得让层清单带上每元素的 enter_at（另一件事）。
 *
 * 语义（明确定义，避免"看起来差不多"）：
 *   · 分组：**起点相同**（±3ms）且带 `显现` 的片段 —— 一组就是"一个镜头的一层元素"
 *   · 组内排序：按轨道在序列中的顺序（与渲染叠放顺序一致），同轨按名字
 *   · 第 i 个元素（i 从 0 起）：显现片段与它的 hold 一起后移 i × gapSeconds
 *   · hold 的**结束时刻保持不变**（时长相应缩短，最短 0.2s）—— 镜头边界不动，
 *     所以不会把后面的镜头往后推
 *   · 已被错开过的组（起点本来就不同）不动：幂等
 */
import { readFileSync, writeFileSync } from 'node:fs'

const f = 'server/core/commands.mjs'
let t = readFileSync(f, 'utf8')

const command = `  {
    id: 'timeline.stagger_elements',
    label: '让同镜头的元素先后出现（错开）',
    category: 'timeline',
    params: {
      gapSeconds: num('相邻元素的错开量（秒）', { minimum: 0.05, maximum: 2 }),
      sequenceId: { type: 'string' },
      from: num('只处理起点 ≥ 该时刻的组（秒）'),
      to: num('只处理起点 < 该时刻的组（秒）'),
    },
    enabled: (doc, p) => {
      const { seq, error } = resolveSequence(doc, p.sequenceId)
      if (error) return error
      const groups = staggerGroups(seq, p)
      if (!groups.length) return '没有找到"同一时刻起步、带显现动画"的元素组（可能已经错开过了）'
      if (!groups.some((g) => g.items.length > 1)) return '所有组的元素数都是 1，无需错开'
      return null
    },
    run: (doc, p) => {
      const { seq } = resolveSequence(doc, p.sequenceId)
      const gap = p.gapSeconds ?? 0.3
      const groups = staggerGroups(seq, p).filter((g) => g.items.length > 1)
      const moved = []
      const clamped = []
      for (const g of groups) {
        g.items.forEach((item, i) => {
          const shift = round(i * gap)
          if (shift <= 0) return
          // 显现片段与其 hold 一起后移
          const reveal = seq.clips.find((c) => c.id === item.revealId)
          const hold = item.holdId ? seq.clips.find((c) => c.id === item.holdId) : null
          if (reveal) {
            reveal.start = round(reveal.start + shift)
            reveal.meta = mirrorMeta(reveal, seq)
            moved.push(reveal.id)
          }
          if (hold) {
            const end = round(hold.start + hold.duration) // 保持结束时刻不变
            hold.start = round(hold.start + shift)
            const next = round(end - hold.start)
            if (next < 0.2) {
              // 错开量太大，hold 会被压没：夹到 0.2s 并如实报告
              hold.duration = 0.2
              hold.start = round(end - 0.2)
              clamped.push(hold.id)
            } else {
              hold.duration = next
            }
            hold.meta = mirrorMeta(hold, seq)
            moved.push(hold.id)
          }
        })
      }
      return {
        doc,
        changed: [...new Set(moved)],
        created: [],
        summary: \`错开 \${groups.length} 组元素（间距 \${gap}s，共移动 \${new Set(moved).size} 个片段）\${clamped.length ? \`；\${clamped.length} 个 hold 被压到最短 0.2s\` : ''}\`,
      }
    },
  },
`

if (!t.includes('timeline.stagger_elements')) {
  const marker = '// ── 派生结构必须在'
  const idx = t.indexOf(marker)
  if (idx < 0) { console.error('✗ 找不到派生结构注释'); process.exit(1) }
  const before = t.slice(0, idx)
  const lastParen = before.lastIndexOf(')')
  t = before.slice(0, lastParen) + '\n' + command + before.slice(lastParen) + t.slice(idx)
  console.log('✓ commands.mjs :: timeline.stagger_elements 已插入')
}

if (!t.includes('function staggerGroups')) {
  const anchor = 'export function describeCommands('
  if (!t.includes(anchor)) { console.error('✗ staggerGroups 锚点未命中'); process.exit(1) }
  const helper = `/**
 * 把"同一时刻起步的一组元素"找出来。
 * 一个元素 = 一个显现片段（名字含"显现"或有 video 素材）+ 紧随其后的 hold（同轨、紧接其结束）。
 */
function staggerGroups(seq, p) {
  const clips = seq.clips ?? []
  const within = (a, b, tol = 0.003) => Math.abs(a - b) <= tol
  const reveals = clips.filter((c) => typeof c.name === 'string' && c.name.includes('显现'))
  const byStart = new Map()
  for (const r of reveals) {
    const key = r.start.toFixed(3)
    if (!byStart.has(key)) byStart.set(key, [])
    byStart.get(key).push(r)
  }
  const groups = []
  for (const [key, list] of byStart) {
    const start = Number(key)
    if (p.from != null && start < p.from) continue
    if (p.to != null && start >= p.to) continue
    // 组内按轨道顺序（= 渲染叠放顺序）排，同轨按名字
    const trackOrder = new Map((seq.tracks ?? []).map((tr, i) => [tr.id, i]))
    list.sort((a, b) => (trackOrder.get(a.trackId) ?? 99) - (trackOrder.get(b.trackId) ?? 99) || String(a.name).localeCompare(String(b.name)))
    const items = list.map((r) => {
      const hold = clips.find((c) => c.trackId === r.trackId && !c.name.includes('显现')
        && within(c.start, r.start + r.duration, 0.02))
      return { revealId: r.id, holdId: hold?.id ?? null }
    })
    groups.push({ start, items })
  }
  return groups.sort((a, b) => a.start - b.start)
}

`
  t = t.replace(anchor, helper + anchor)
  console.log('✓ commands.mjs :: staggerGroups 已插入')
}
writeFileSync(f, t)
