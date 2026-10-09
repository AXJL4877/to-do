import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
process.env.TODO_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'todo-segment-budget-'))
const { segmentScript } = await import('../server/production/segment.mjs')
const { defaultServices } = await import('../server/production/layers.mjs')
const { getSkillEntry, chatPlanner } = await import('../server/skillPacks.mjs')
const { createProduction } = await import('../server/production/job.mjs')
const { runProduction, requestCancel, ProductionCanceled } = await import('../server/production/runner.mjs')
const script = '第一句话保留。第二句话也保留。第三句话不能改写。'
const opts = { mode: 'semantic', target: 10, max: 20, timeoutMs: 20, retryDelayMs: 1, progressIntervalMs: 5 }
const outline = { title: '测试', segments: [{ start: 0 }, { start: 1 }] }
// Slow external dependency gets a finite safety completion so the old code fails, rather than hanging this test.
function slowChat(_messages, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(outline), 80)
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
  })
}
const progress = []
let aborted = false
const start = Date.now()
const result = await segmentScript(script, { ...opts, onProgress: p => progress.push(p), chat: (m, o) => {
  o?.signal?.addEventListener('abort', () => { aborted = true }, { once: true })
  return slowChat(m, o)
} })
assert.equal(result.source, 'fallback', 'a slow provider must fall back within the total segmentation budget')
assert.equal(result.segments.map(s => s.text).join(''), script)
assert.ok(aborted, 'the in-flight operation must be aborted before falling back')
assert.ok(Date.now() - start < 75)
assert.match(result.notes, /超时/)
assert.ok(progress.some(p => p.elapsedMs > 0 && p.phase === 'waiting'))

let attempts = 0
const recovered = await segmentScript(script, { ...opts, timeoutMs: 100, chat: async () => {
  if (++attempts === 1) throw new Error('503 temporarily unavailable')
  return outline
} })
assert.equal(recovered.source, 'ai')
assert.equal(attempts, 2)
let permanentCalls = 0
const permanent = await segmentScript(script, { ...opts, chat: async () => { permanentCalls++; throw new Error('invalid API key') } })
assert.equal(permanent.source, 'fallback')
assert.equal(permanentCalls, 1)
assert.equal(permanent.segments.map(s => s.text).join(''), script)
const heuristic = await segmentScript(script, { ...opts, mode: 'paragraph', chat: () => { throw new Error('must not call AI') } })
assert.equal(heuristic.segments.map(s => s.text).join(''), script)

// The real default adapter and chatPlanner must pass the signal all the way to fetch.
const originalFetch = globalThis.fetch
let transportAborted = false
let genericRetries = 0
globalThis.fetch = async (_url, o) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => resolve({ ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(outline) } }] }) }), 80)
  o.signal.addEventListener('abort', () => { transportAborted = true; clearTimeout(timer); reject(o.signal.reason) }, { once: true })
})
try {
  const services = defaultServices({ apiKey: 'test-only', baseUrl: 'https://example.invalid' }, async fn => { genericRetries++; return fn() })
  const adapter = await segmentScript(script, { ...opts, chat: services.chat })
  assert.equal(adapter.source, 'fallback')
  assert.ok(transportAborted)
  assert.equal(genericRetries, 0, 'segmentation budget must own retries instead of entering long generic backoff')
  const canceled = new AbortController(); canceled.abort(new Error('caller canceled'))
  await assert.rejects(chatPlanner({ apiKey: 'test-only', baseUrl: 'https://example.invalid' }, [], { signal: canceled.signal }), /caller canceled/)
} finally { globalThis.fetch = originalFetch }

const entry = getSkillEntry('builtin.dynamic-text')
const doc = createProduction({ skillId: entry.pack.id, script, params: { split: 'semantic', subtitles: 'off' } })
const outDir = path.join(process.env.TODO_DATA_DIR, 'ai-generated'); mkdirSync(outDir)
let synthCalls = 0
const run = runProduction(doc, { entry, outDir, phase: () => {}, services: {
  chat: (m, o) => { setTimeout(() => requestCancel(doc.id), 5); return slowChat(m, o) },
  synth: async () => { synthCalls++; throw new Error('no TTS after cancel') },
} })
await assert.rejects(run, ProductionCanceled)
assert.equal(synthCalls, 0)
assert.equal(doc.status.phase, '已停止')
assert.equal(doc.segments.length, 0)
console.log('PASS segmentation deadline, abort transport, bounded retries, original text, heuristic, cancellation before TTS')
