import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.env.TODO_DATA_DIR = path.join(root, '.data')
delete process.env.TTS_TIMELINE_ROOT
delete process.env.MISHI_ROOT

const { resolveTtsTimelineRoot, resolveMishiRoot, ttsTimelineReady, mishiReady } = await import('../server/toolRoots.mjs')
const { readAiConfig } = await import('../server/huniuConfig.mjs')

const tts = resolveTtsTimelineRoot()
const mishi = resolveMishiRoot()
assert.ok(tts.includes(`${path.sep}vendor${path.sep}tts-timeline`), tts)
assert.ok(mishi.includes(`${path.sep}vendor${path.sep}mishi`), mishi)
assert.ok(ttsTimelineReady(tts), `missing ${path.join(tts, 'run.py')}`)
assert.ok(mishiReady(mishi), `missing mishi at ${mishi}`)
assert.ok(existsSync(path.join(mishi, '.env')), 'vendor mishi .env required for Volc TTS')

const cfg = readAiConfig()
assert.equal(cfg.ttsTimelineReady, true)
assert.equal(cfg.mishiReady, true)
console.log('vendor tools self-check ok')
