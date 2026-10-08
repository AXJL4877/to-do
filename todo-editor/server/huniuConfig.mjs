import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeBaseUrl } from './huniuClient.mjs'
import { mishiReady, resolveMishiRoot, resolveTtsTimelineRoot, ttsTimelineReady } from './toolRoots.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = process.env.TODO_DATA_DIR
  ? path.resolve(process.env.TODO_DATA_DIR)
  : path.join(ROOT, '.data')
const CONFIG_PATH = path.join(DATA_DIR, 'ai-config.json')

/** 口播/规划/导演等聊天默认模型（虎妞可用） */
export const DEFAULT_CHAT_MODEL = 'gemini-3.8-flash'
export const DEFAULT_BASE_URL = 'https://huniuai.com'

/** 内嵌密匙根目录（可用 MISHI_ROOT 覆盖） */
export const MISHI_ROOT = resolveMishiRoot()

mkdirSync(DATA_DIR, { recursive: true })

let didBootstrap = false

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

function parseDotEnv(text) {
  const out = {}
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i <= 0) continue
    const key = t.slice(0, i).trim()
    let val = t.slice(i + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    out[key] = val
  }
  return out
}

/** 读取内嵌/外挂密匙 .env 中的虎妞字段（不落盘、不回显完整 Key） */
export function peekMishiEnv() {
  const mishiRoot = resolveMishiRoot()
  const envPath = path.join(mishiRoot, '.env')
  if (!existsSync(envPath)) {
    return { available: false, mishiRoot, hasApiKey: false, apiKeyMasked: '', baseUrl: '', chatModel: '' }
  }
  let env = {}
  try { env = parseDotEnv(readFileSync(envPath, 'utf8')) } catch {
    return { available: false, mishiRoot, hasApiKey: false, apiKeyMasked: '', baseUrl: '', chatModel: '' }
  }
  const apiKey = String(env.huniu_api_key || env.HUNIU_API_KEY || '').trim()
  const baseUrl = normalizeBaseUrl(env.HUNIU_BASE_URL || DEFAULT_BASE_URL)
  const chatModel = normalizeChatModel(env.HUNIU_CHAT_MODEL || env.HUNIU_VISION_MODEL || DEFAULT_CHAT_MODEL)
  return {
    available: true,
    mishiRoot,
    hasApiKey: !!apiKey,
    apiKeyMasked: maskKey(apiKey),
    baseUrl,
    chatModel,
    /** 仅内部导入用 */
    _apiKey: apiKey,
  }
}

function loadRawConfig() {
  if (!existsSync(CONFIG_PATH)) return {}
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) } catch { return {} }
}

function persistConfig(next) {
  writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`)
}

/** 本地无 Key 时，静默从密匙 .env 导入一次，方便本机开箱 */
export function bootstrapAiConfigFromMishi() {
  if (didBootstrap) return
  didBootstrap = true
  const cfg = loadRawConfig()
  if (String(cfg.apiKey || '').trim()) return
  const mishi = peekMishiEnv()
  if (!mishi.hasApiKey || !mishi._apiKey) return
  persistConfig({
    apiKey: mishi._apiKey,
    baseUrl: mishi.baseUrl || DEFAULT_BASE_URL,
    chatModel: mishi.chatModel || DEFAULT_CHAT_MODEL,
    importedFrom: 'mishi',
    importedAt: Date.now(),
  })
}

/** 手动「从密匙导入」：覆盖写入 TODO AI 设置 */
export function importAiConfigFromMishi() {
  const mishi = peekMishiEnv()
  if (!mishi.available) throw new Error(`未找到密匙目录：${mishi.mishiRoot}`)
  if (!mishi.hasApiKey || !mishi._apiKey) throw new Error('密匙 .env 中没有 huniu_api_key')
  const current = readAiConfig({ revealKey: true })
  persistConfig({
    apiKey: mishi._apiKey,
    baseUrl: mishi.baseUrl || current.baseUrl || DEFAULT_BASE_URL,
    chatModel: mishi.chatModel || current.chatModel || DEFAULT_CHAT_MODEL,
    importedFrom: 'mishi',
    importedAt: Date.now(),
  })
  return readAiConfig()
}

export function readAiConfig({ revealKey = false } = {}) {
  bootstrapAiConfigFromMishi()
  const cfg = loadRawConfig()
  const apiKey = String(cfg.apiKey || '')
  const baseUrl = String(cfg.baseUrl || DEFAULT_BASE_URL)
  const chatModel = normalizeChatModel(
    process.env.TODO_AI_SCRIPT_MODEL
      || process.env.TODO_AI_SKILL_MODEL
      || cfg.chatModel,
  )
  const mishi = peekMishiEnv()
  const ttsRoot = resolveTtsTimelineRoot()
  return {
    apiKey: revealKey ? apiKey : '',
    apiKeyMasked: maskKey(apiKey),
    hasApiKey: !!apiKey,
    baseUrl: normalizeBaseUrl(baseUrl),
    chatModel,
    canImportMishi: mishi.available && mishi.hasApiKey,
    mishiRoot: mishi.mishiRoot,
    mishiReady: mishiReady(mishi.mishiRoot),
    ttsTimelineRoot: ttsRoot,
    ttsTimelineReady: ttsTimelineReady(ttsRoot),
    importedFrom: cfg.importedFrom === 'mishi' ? 'mishi' : (apiKey ? 'manual' : ''),
  }
}

export function writeAiConfig(body) {
  const current = readAiConfig({ revealKey: true })
  let apiKey = current.apiKey
  if (body.clearApiKey) apiKey = ''
  else if (body.apiKey !== undefined) apiKey = String(body.apiKey || '').trim()
  const baseUrl = normalizeBaseUrl(String(body.baseUrl ?? current.baseUrl ?? DEFAULT_BASE_URL))
  const chatModel = body.chatModel === undefined
    ? current.chatModel
    : normalizeChatModel(body.chatModel)
  const next = {
    apiKey,
    baseUrl,
    chatModel,
    importedFrom: body.apiKey || body.clearApiKey ? 'manual' : (loadRawConfig().importedFrom || 'manual'),
    updatedAt: Date.now(),
  }
  persistConfig(next)
  return readAiConfig()
}

/** 供调用外挂密匙 CLI 时注入，使视频/host 也走 TODO AI 设置里的 Key */
export function mishiEnvFromAiConfig() {
  const config = readAiConfig({ revealKey: true })
  const out = {}
  if (config.apiKey) {
    out.huniu_api_key = config.apiKey
    out.HUNIU_API_KEY = config.apiKey
  }
  if (config.baseUrl) out.HUNIU_BASE_URL = config.baseUrl
  if (config.chatModel) {
    out.HUNIU_CHAT_MODEL = config.chatModel
    out.HUNIU_VISION_MODEL = config.chatModel
  }
  return out
}
