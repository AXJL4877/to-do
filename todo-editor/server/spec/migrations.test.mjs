/**
 * 迁移框架测试（node:test）。
 *
 * 现在还没有真实迁移（当前格式 v2 就是最老支持版本），所以这里用**合成目录**验证机制本身：
 * 相邻边、缺口检测、重复边、越界边、拒绝未来版本、按序应用、每步失败可定位。
 * v3 落地时只需把真实边加进 EDGES + 放一个 project-v2.todo.json 旧形状 fixture。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EDGES, PROJECT_CURRENT_VERSION, PROJECT_OLDEST_SUPPORTED,
  migrate, validateCatalog, versionOf,
} from './migrations.mjs'

test('versionOf 同时认裸整数与 spec 字符串', () => {
  assert.equal(versionOf({ version: 2 }), 2)
  assert.equal(versionOf({ spec: 'todo-project/3' }), 3)
  assert.equal(versionOf({ spec: 'todo-production/1' }), null)
  assert.equal(versionOf({}), null)
  assert.equal(versionOf(null), null)
})

test('当前发布目录自校验通过（无缺口：oldest=current）', () => {
  const r = validateCatalog()
  assert.deepEqual(r.errors, [], JSON.stringify(r.errors))
  assert.equal(r.currentVersion, PROJECT_CURRENT_VERSION)
  assert.equal(r.oldestSupported, PROJECT_OLDEST_SUPPORTED)
  assert.equal(r.edgeCount, EDGES.length)
})

test('目录缺口被抓出来', () => {
  const r = validateCatalog({ currentVersion: 4, oldestSupported: 2, edges: [{ from: 2, to: 3, run: (d) => d }] })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.code === 'gap_in_catalog' && e.at === 'v3'), JSON.stringify(r.errors))
})

test('重复边 / 非相邻边 / 越界边都被抓出来', () => {
  const r = validateCatalog({
    currentVersion: 3, oldestSupported: 2,
    edges: [
      { from: 2, to: 3, run: (d) => d },
      { from: 2, to: 3, run: (d) => d },
      { from: 2, to: 4, run: (d) => d },
      { from: 3, to: 4, run: (d) => d },
    ],
  })
  const codes = r.errors.map((e) => e.code)
  assert.ok(codes.includes('duplicate_edge'))
  assert.ok(codes.includes('non_adjacent_edge'))
  assert.ok(codes.includes('edge_beyond_current'))
})

test('合成链 v2→v3→v4 按序应用', () => {
  const edges = [
    { from: 2, to: 3, summary: '加 canvas.frameRate', run: (d) => ({ ...d, spec: 'todo-project/3', added: 'frameRate' }) },
    { from: 3, to: 4, summary: '拆 document/session', run: (d) => ({ ...d, spec: 'todo-project/4', split: true }) },
  ]
  const r = migrate({ version: 2, a: 1 }, { target: 4, currentVersion: 4, oldestSupported: 2, edges })
  assert.equal(r.ok, true)
  assert.equal(r.from, 2)
  assert.equal(r.to, 4)
  assert.deepEqual(r.applied, ['v2→v3 (加 canvas.frameRate)', 'v3→v4 (拆 document/session)'])
  assert.equal(r.doc.split, true)
  assert.equal(r.doc.version, 2, '迁移不改写原始 version 字段，由边自己决定')
})

test('未来版本：明确拒绝，并给出可操作提示', () => {
  const r = migrate({ version: 9 })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'unsupported')
  assert.match(r.error.message, /更新的版本保存/)
  assert.ok(r.error.hint, '必须给修复建议')
  assert.equal(r.error.retryable, false)
})

test('过老版本：拒绝而不是猜', () => {
  const r = migrate({ version: 1 })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'unsupported')
  assert.match(r.error.message, /太旧/)
})

test('没有版本字段：报 bad_request 并指出缺什么', () => {
  const r = migrate({ foo: 1 })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'bad_request')
  assert.match(r.error.hint, /version/)
})

test('目标是当前版本且来源就是当前版本：零步通过', () => {
  const r = migrate({ version: 2 })
  assert.equal(r.ok, true)
  assert.deepEqual(r.applied, [])
  assert.equal(r.to, 2)
})

test('某一步抛错：错误里带上是哪一步', () => {
  const edges = [{ from: 2, to: 3, run: () => { throw new Error('boom') } }]
  const r = migrate({ version: 2 }, { target: 3, currentVersion: 3, oldestSupported: 2, edges })
  assert.equal(r.ok, false)
  assert.match(r.error.message, /v2→v3 失败：boom/)
})

test('迁移边目录当前为空（v2 就是最老支持版本）', () => {
  // 约定：每个迁移边配一个旧形状 fixture __fixtures__/project-v<from>.todo.json
  // 现在还没有边，所以没有 fixture 要求；这条测试锁住"边的数量"这个事实
  assert.equal(EDGES.length, 0)
})
