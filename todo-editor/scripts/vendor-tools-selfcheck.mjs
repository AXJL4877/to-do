import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.env.TODO_DATA_DIR = path.join(root, '.data')
for (const k of ['TTS_TIMELINE_ROOT', 'MISHI_ROOT', 'BLACKBOARD_ROOT', 'BURN_SUBTITLES_DIR']) delete process.env[k]

const {
  resolveTtsTimelineRoot, resolveMishiRoot, resolveBlackboardRoot, resolveBurnSubtitlesRoot,
  ttsTimelineReady, mishiReady, blackboardReady, burnSubtitlesReady,
} = await import('../server/toolRoots.mjs')
const { readAiConfig } = await import('../server/huniuConfig.mjs')

assert.ok(ttsTimelineReady(resolveTtsTimelineRoot()))
assert.ok(mishiReady(resolveMishiRoot()))
assert.ok(blackboardReady(resolveBlackboardRoot()))
assert.ok(burnSubtitlesReady(resolveBurnSubtitlesRoot()))
assert.ok(existsSync(path.join(resolveMishiRoot(), '.env')))

const cfg = readAiConfig()
assert.equal(cfg.ttsTimelineReady, true)
assert.equal(cfg.mishiReady, true)
assert.equal(cfg.blackboardReady, true)
assert.equal(cfg.burnSubtitlesReady, true)
console.log('vendor tools self-check ok')
