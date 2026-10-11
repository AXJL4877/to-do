/**
 * 架构守卫（node:test）：**纯核心层不得依赖任何 node: 内置模块**。
 *
 * 为什么这条重要：objective 要求「在 Electron 与 Web 客户端间共享的无 UI 核心层」。
 * 只要有一个 `node:` 导入，浏览器端就 import 不了，共享层立刻退化成"服务端专用"——
 * 而且这种退化是静默的（在 Node 里跑测试完全正常）。所以把它变成一条会红的测试。
 *
 * 允许依赖 node: 的只有真正做文件 IO 的模块：session / projectStore / cli / mcp / files。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(here, '..', '..')

const PURE = [
  'server/spec/params.mjs',
  'server/spec/projectSpec.mjs',
  'server/spec/capabilities.mjs',
  'server/spec/migrations.mjs',
  'server/core/commands.mjs',
]

test('纯核心层不含 node: 导入（浏览器可直接 import）', () => {
  const bad = []
  for (const rel of PURE) {
    const text = readFileSync(path.join(repoRoot, rel), 'utf8')
    const hits = [...text.matchAll(/from '(node:[^']+)'/g)].map((m) => m[1])
    if (hits.length) bad.push(`${rel}: ${hits.join(', ')}`)
  }
  assert.deepEqual(bad, [], `这些纯核心模块引入了 node 内置模块，浏览器端会 import 失败：\n${bad.join('\n')}`)
})

test('纯核心层只依赖彼此，不反向依赖 IO 模块', () => {
  const bad = []
  for (const rel of PURE) {
    const text = readFileSync(path.join(repoRoot, rel), 'utf8')
    for (const m of text.matchAll(/from '([^']+)'/g)) {
      const spec = m[1]
      if (!spec.startsWith('.')) continue
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec))
      const ioModules = ['server/core/session.mjs', 'server/core/projectStore.mjs', 'server/spec/projectFiles.mjs', 'server/cli.mjs', 'server/mcp.mjs']
      if (ioModules.includes(resolved)) bad.push(`${rel} → ${spec}`)
    }
  }
  assert.deepEqual(bad, [], `纯核心不得依赖 IO 模块：\n${bad.join('\n')}`)
})

test('server/spec 与 server/core 的文件都能被 Node 解析（语法/导入健全）', () => {
  const dirs = ['server/spec', 'server/core']
  const problems = []
  for (const d of dirs) {
    for (const f of readdirSync(path.join(repoRoot, d))) {
      if (!f.endsWith('.mjs')) continue
      // 只查"模块"：测试与冒烟脚本不是模块，不需要导出
      if (/\.(test|smoke)\.mjs$/.test(f)) continue
      const text = readFileSync(path.join(repoRoot, d, f), 'utf8')
      if (!text.includes('export ')) problems.push(`${d}/${f} 没有任何导出（可能是遗留文件）`)
    }
  }
  assert.deepEqual(problems, [], `疑似遗留文件：\n${problems.join('\n')}`)
})