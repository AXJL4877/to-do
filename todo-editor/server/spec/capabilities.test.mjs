/**
 * 能力清单自校验 + 两级披露测试（node:test）。
 * 为什么要这份测试：清单是智能体读的**第一个**文件，它错了会让智能体一路错下去；
 * 所以清单本身必须有作者期校验（照 DSH：非法清单在模块初始化时就炸，而不是等运行时踩）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CAPABILITIES_SPEC, ERROR_CODES, DEFAULT_RETRYABLE_CODES,
  capabilities, compileParams, validateCapabilities,
} from './capabilities.mjs'

test('清单自校验通过（作者期不变量）', () => {
  const r = validateCapabilities(capabilities())
  assert.deepEqual(r.errors, [], JSON.stringify(r.errors, null, 2))
  assert.equal(r.ok, true)
})

test('author DSL 编译成规范 JSON Schema：逐属性 required 收拢成根级数组', () => {
  const s = compileParams({ a: 'string', b: { type: 'number', required: true, minimum: 0 }, c: 'boolean?' })
  assert.equal(s.type, 'object')
  assert.equal(s.additionalProperties, false, 'object 必须显式声明 additionalProperties')
  assert.deepEqual(s.required, ['b'])
  assert.equal(s.properties.a.type, 'string')
  assert.equal(s.properties.b.minimum, 0)
  assert.equal(s.properties.c.type, 'boolean')
})

test('类型不在闭集里 → 编译期报错（不给模糊余地）', () => {
  assert.throws(() => compileParams({ x: 'dataURL' }), /不在闭集里/)
})

test('已是 JSON Schema 的 object 缺 additionalProperties → 报错', () => {
  assert.throws(() => compileParams({ type: 'object', properties: {} }), /additionalProperties/)
})

test('catalog 视图只给签名，full 视图附编译后的参数 schema', () => {
  const cat = capabilities({ view: 'catalog' })
  const full = capabilities({ view: 'full' })
  assert.ok(cat.operations.every((o) => o.params === undefined), 'catalog 不该带 params')
  assert.ok(cat.operations.every((o) => o.id && o.method && o.path && o.status && o.summary))
  const img = full.operations.find((o) => o.id === 'ai.image')
  assert.equal(img.params.type, 'object')
  assert.ok(img.params.required.includes('prompt'))
  assert.ok(cat.operations.length > full.operations.filter((o) => o.status === 'planned').length)
})

test('错误码用导出常量，可重试性用集合表达且是 codes 的子集', () => {
  const cap = capabilities()
  const codes = cap.errorContract.codes.map((c) => c.code)
  assert.deepEqual(codes.sort(), Object.values(ERROR_CODES).sort())
  for (const r of cap.errorContract.retryableCodes) assert.ok(codes.includes(r), `${r} 不在 codes 里`)
  assert.deepEqual(DEFAULT_RETRYABLE_CODES, cap.errorContract.retryableCodes)
  assert.ok(!DEFAULT_RETRYABLE_CODES.includes(ERROR_CODES.NEEDS_CONFIG), '缺配置不该可重试')
})

test('自校验能抓住坏清单（重复 id / 未知 method / 缺 summary）', () => {
  const bad = capabilities()
  bad.operations = [
    ...bad.operations,
    { id: 'ai.image', method: 'FETCH', path: 'no-slash', status: 'weird' },
  ]
  const r = validateCapabilities(bad)
  assert.equal(r.ok, false)
  const codes = r.errors.map((e) => e.code)
  assert.ok(codes.includes('duplicate_id'))
  assert.ok(codes.includes('bad_method'))
  assert.ok(codes.includes('bad_path'))
  assert.ok(codes.includes('bad_status'))
  assert.ok(codes.includes('missing_summary'))
})

test('每个操作都声明了 sideEffects / idempotent（智能体据此决定并行与重试）', () => {
  for (const o of capabilities().operations) {
    assert.equal(typeof o.sideEffects, 'boolean', `${o.id} 缺 sideEffects`)
    assert.equal(typeof o.idempotent, 'boolean', `${o.id} 缺 idempotent`)
    assert.equal(typeof o.longRunning, 'boolean', `${o.id} 缺 longRunning`)
  }
})

test('planned 操作必须写明 note（诚实边界）', () => {
  for (const o of capabilities().operations.filter((x) => x.status === 'planned')) {
    assert.ok(o.note || o.summary, `${o.id} 应说明缺口`)
  }
})

test('接入面声明完整且 spec 串正确', () => {
  const cap = capabilities()
  assert.equal(cap.spec, CAPABILITIES_SPEC)
  assert.equal(cap.projectSpec, 'todo-project/2')
  assert.ok(cap.transports.some((t) => t.kind === 'http'))
  assert.ok(cap.transports.some((t) => t.kind === 'mcp' && t.status === 'stable'))
  assert.ok(cap.transports.some((t) => t.kind === 'cli' && t.status === 'stable'))
})
