import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const data = mkdtempSync(path.join(tmpdir(), 'todo-ai-cfg-'))
const mishi = mkdtempSync(path.join(tmpdir(), 'todo-mishi-'))
process.env.TODO_DATA_DIR = data
process.env.MISHI_ROOT = mishi

const {
  readAiConfig, writeAiConfig, importAiConfigFromMishi, peekMishiEnv, mishiEnvFromAiConfig,
} = await import('../server/huniuConfig.mjs')

assert.equal(readAiConfig().hasApiKey, false)
assert.equal(readAiConfig().canImportMishi, false)

writeFileSync(path.join(mishi, '.env'), [
  'huniu_api_key=sk-test-abc1234567890xyz',
  'HUNIU_BASE_URL=https://huniuai.com/',
  'HUNIU_CHAT_MODEL=gpt-6-astra',
  '',
].join('\n'))

const peek = peekMishiEnv()
assert.equal(peek.available, true)
assert.equal(peek.hasApiKey, true)
assert.match(peek.apiKeyMasked, /^sk-tes/)

const imported = importAiConfigFromMishi()
assert.equal(imported.hasApiKey, true)
assert.equal(imported.chatModel, 'gpt-6-astra')
assert.equal(imported.importedFrom, 'mishi')
assert.equal(imported.canImportMishi, true)

const env = mishiEnvFromAiConfig()
assert.equal(env.huniu_api_key, 'sk-test-abc1234567890xyz')
assert.equal(env.HUNIU_BASE_URL, 'https://huniuai.com')

writeAiConfig({ apiKey: 'sk-custom-manual-key-0001', chatModel: 'gemini-3.8-flash' })
const manual = readAiConfig({ revealKey: true })
assert.equal(manual.apiKey, 'sk-custom-manual-key-0001')
assert.equal(manual.importedFrom, 'manual')

writeAiConfig({ clearApiKey: true })
assert.equal(readAiConfig().hasApiKey, false)

// 空配置 + 密匙有 Key：bootstrap 应写入
const data2 = mkdtempSync(path.join(tmpdir(), 'todo-ai-cfg2-'))
process.env.TODO_DATA_DIR = data2
// 重新加载模块状态：用动态 import cache bust
const mod2 = await import(`../server/huniuConfig.mjs?boot=${Date.now()}`)
const boot = mod2.readAiConfig({ revealKey: true })
assert.equal(boot.hasApiKey, true, 'bootstrap from mishi when empty')
assert.equal(boot.apiKey, 'sk-test-abc1234567890xyz')

console.log('huniuConfig self-check ok')
