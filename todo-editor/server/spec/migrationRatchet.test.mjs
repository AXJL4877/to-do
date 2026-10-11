/**
 * 防绕过守卫（棘轮）：**直接改工程状态的地方只能变少，不能变多**。
 *
 * 背景：不变量 I3 要求「一次编辑 = 一条命令 = 一次撤销」。但现在 `src/store.ts` 里还有十几处
 * 直接 `clips: seq.clips` 这样的写法绕过了命令层——UI 的写操作和 CLI/MCP 的写操作是**两套**。
 *
 * 为什么用棘轮而不是一次性全禁：一次性改写十几个 handler 会把风险集中在一个大改动里，
 * 而且 `razorAtTime` 这类动作还带联动片段配对、帧网格对齐等语义，需要先补对应命令。
 * 棘轮的价值是：**今天把现状钉住，之后每次只能往下调**。谁再写一处绕过，测试就红。
 *
 * 下调方式：完成一处迁移后，把下面的 BASELINE 数字改小（只能改小）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(here, '..', '..')

/**
 * 已记录的债务基线：只允许下调。
 *
 * 度量口径的演进（值得记一笔）：最初只数 `clips: x.clips` / `.clips =` 这类写法，
 * 结果**迁移 razorAtTime 时数字没动**——因为那段代码写的是 `patchSeq((s) => ...)`，
 * 而 patchSeq 才是 store 里"直接改序列"的真正漏斗。漏掉的度量等于没有度量，
 * 所以口径改成以 `patchSeq(` 为主：它覆盖片段/轨道/标记的全部直接写路径。
 */
const BASELINE = {
  'src/store.ts': 50,   // 已迁移：razorAtTime / deleteSelected / moveClips / trimClip（56 → 50）
  components: 4,
}

// 绕过命令层的直接写路径
const DIRECT_PATTERNS = [
  /patchSeq\(/g,                   // store 里直接改序列的唯一漏斗（主口径）
  /clips:\s*\w+\.clips/g,          // sequences[i].clips = ... / clips: seq.clips
  /\.clips\s*=\s*/g,               // seq.clips = ...
  /clips\.(push|splice|sort)\(/g,  // 原地改数组
]

function countIn(file, text) {
  const lines = text.split('\n')
  const hits = []
  lines.forEach((line, i) => {
    if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return
    if (DIRECT_PATTERNS.some((re) => { re.lastIndex = 0; return re.test(line) })) {
      hits.push({ line: i + 1, text: line.trim().slice(0, 100) })
    }
  })
  return hits
}

test('棘轮：src/store.ts 里绕过命令层直接改片段的处数不得超过基线', () => {
  const text = readFileSync(path.join(repoRoot, 'src/store.ts'), 'utf8')
  const hits = countIn('src/store.ts', text)
  assert.ok(
    hits.length <= BASELINE['src/store.ts'],
    `src/store.ts 里直接改片段的地方变多了：${hits.length} > 基线 ${BASELINE['src/store.ts']}。\n`
    + `新增的绕过点：\n${hits.map((h) => `  ${h.line}: ${h.text}`).join('\n')}\n`
    + '写操作应当走 src/lib/commandBridge.ts 的 runCommand()（命令表见 server/core/commands.mjs）。',
  )
})

test('棘轮：组件里绕过命令层直接改片段的处数不得超过基线', () => {
  const dir = path.join(repoRoot, 'src', 'components')
  const all = []
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.tsx'))) {
    all.push(...countIn(f, readFileSync(path.join(dir, f), 'utf8')).map((h) => ({ ...h, file: f })))
  }
  assert.ok(
    all.length <= BASELINE.components,
    `组件里直接改片段的地方变多了：${all.length} > 基线 ${BASELINE.components}。\n`
    + all.map((h) => `  ${h.file}:${h.line} ${h.text}`).join('\n'),
  )
})

test('命令桥是应用里唯一调用 applyCommand 的地方（不得有第二个入口）', () => {
  const callers = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { if (!/node_modules|\.git/.test(e.name)) walk(p); continue }
      if (!/\.(ts|tsx|mjs|cjs)$/.test(e.name)) continue
      if (e.name.endsWith('.d.ts')) continue // 类型声明不是调用
      const rel = path.relative(repoRoot, p).replace(/\\/g, '/')
      if (!rel.startsWith('src/')) continue
      const text = readFileSync(p, 'utf8')
      if (/\bapplyCommand\s*\(/.test(text)) callers.push(rel)
    }
  }
  walk(path.join(repoRoot, 'src'))
  assert.deepEqual(callers, ['src/lib/commandBridge.ts'], `applyCommand 只应被命令桥调用，实际：${callers.join(', ')}`)
})

test('棘轮基线说明：迁移完成一处就要把基线调小（防止只加不减）', () => {
  // 这条测试本身不下断言，只把"基线是活的"这件事写进测试输出，提醒维护者
  const storeHits = countIn('src/store.ts', readFileSync(path.join(repoRoot, 'src/store.ts'), 'utf8')).length
  assert.ok(storeHits >= 0)
  assert.ok(BASELINE['src/store.ts'] >= storeHits, '基线不能小于实际值（那就成了假绿）')
})
