import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeBaseUrl } from './paipuClient.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = path.join(ROOT, '.data')
const CONFIG_PATH = path.join(DATA_DIR, 'ai-config.json')

mkdirSync(DATA_DIR, { recursive: true })

function maskKey(apiKey) {
  const key = String(apiKey || '')
  if (!key) return ''
  if (key.length <= 10) return `${key.slice(0, 3)}...`
  return `${key.slice(0, 6)}...${key.slice(-4)}`
}

export function readAiConfig({ revealKey = false } = {}) {
  let cfg = {}
  if (existsSync(CONFIG_PATH)) {
    try { cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) } catch { cfg = {} }
  }
  const apiKey = String(cfg.apiKey || '')
  const baseUrl = String(cfg.baseUrl || 'https://api.paipu.net')
  return {
    apiKey: revealKey ? apiKey : '',
    apiKeyMasked: maskKey(apiKey),
    hasApiKey: !!apiKey,
    baseUrl: normalizeBaseUrl(baseUrl),
  }
}

export function writeAiConfig(body) {
  const current = readAiConfig({ revealKey: true })
  const apiKeyInput = body.apiKey
  const apiKey = apiKeyInput === undefined ? current.apiKey : String(apiKeyInput || '').trim()
  const baseUrl = normalizeBaseUrl(String(body.baseUrl || current.baseUrl || 'https://api.paipu.net'))
  const next = { apiKey, baseUrl }
  writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`)
  return readAiConfig()
}
