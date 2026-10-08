import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeBaseUrl } from './huniuClient.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = process.env.TODO_DATA_DIR
  ? path.resolve(process.env.TODO_DATA_DIR)
  : path.join(ROOT, '.data')
const CONFIG_PATH = path.join(DATA_DIR, 'ai-config.json')

/** 口播/规划/导演等聊天默认模型（虎妞可用） */
export const DEFAULT_CHAT_MODEL = 'gemini-3.8-flash'

mkdirSync(DATA_DIR, { recursive: true })

function maskKey(apiKey) {
  const key = String(apiKey || '')
  if (!key) return ''
  if (key.length <= 10) return `${key.slice(0, 3)}...`
  return `${key.slice(0, 6)}...${key.slice(-4)}`
}

function normalizeChatModel(v) {
  const s = String(v || '').trim()
  return s || DEFAULT_CHAT_MODEL
}

export function readAiConfig({ revealKey = false } = {}) {
  let cfg = {}
  if (existsSync(CONFIG_PATH)) {
    try { cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) } catch { cfg = {} }
  }
  const apiKey = String(cfg.apiKey || '')
  const baseUrl = String(cfg.baseUrl || 'https://huniuai.com')
  const chatModel = normalizeChatModel(
    process.env.TODO_AI_SCRIPT_MODEL
      || process.env.TODO_AI_SKILL_MODEL
      || cfg.chatModel,
  )
  return {
    apiKey: revealKey ? apiKey : '',
    apiKeyMasked: maskKey(apiKey),
    hasApiKey: !!apiKey,
    baseUrl: normalizeBaseUrl(baseUrl),
    chatModel,
  }
}

export function writeAiConfig(body) {
  const current = readAiConfig({ revealKey: true })
  const apiKeyInput = body.apiKey
  const apiKey = apiKeyInput === undefined ? current.apiKey : String(apiKeyInput || '').trim()
  const baseUrl = normalizeBaseUrl(String(body.baseUrl || current.baseUrl || 'https://huniuai.com'))
  const chatModel = body.chatModel === undefined
    ? current.chatModel
    : normalizeChatModel(body.chatModel)
  const next = { apiKey, baseUrl, chatModel }
  writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`)
  return readAiConfig()
}
