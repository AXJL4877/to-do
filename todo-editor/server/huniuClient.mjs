import { writeFileSync } from 'node:fs'

const DEFAULT_BASE_URL = 'https://huniuai.com'

const DOC_IMAGE_MODELS = new Set([
  'gpt-image-2',
  'gemini-2.5-flash-image',
  'gemini-3.0-pro-image',
  'nano banana 2',
  'nano-banana-2',
  'grok-imagine-image-pro',
])

const DOC_VIDEO_MODELS = new Set([
  'veo-3.1',
  'veo-4-omni',
  'sora-2-official',
  'grok-imagine-video',
])

const DOC_AUDIO_MODELS = new Set([
  'music',
  'tts-1',
  'tts-1-hd',
  'speech-2.8',
  'voice-clone',
  'voice-design',
  'gpt-4o-mini-tts',
])

const ASPECT_RATIO_OPTIONS = [
  option('1:1', '1:1'),
  option('16:9', '16:9'),
  option('9:16', '9:16'),
  option('3:2', '3:2'),
  option('2:3', '2:3'),
  option('4:3', '4:3'),
  option('3:4', '3:4'),
]

const RESOLUTION_OPTIONS = [
  option('1K', '1K'),
  option('2K', '2K'),
  option('4K', '4K'),
]

function option(value, label) {
  return { value, label }
}

function joinApi(baseUrl, path) {
  return `${normalizeBaseUrl(baseUrl)}${path}`
}

function authHeaders(apiKey, extra = {}) {
  return {
    Authorization: `Bearer ${apiKey}`,
    ...extra,
  }
}

function modelKey(id) {
  return String(id || '').trim().toLowerCase()
}

function documentedModelsForCapability(capability) {
  if (capability === 'video') return DOC_VIDEO_MODELS
  if (capability === 'audio') return DOC_AUDIO_MODELS
  return DOC_IMAGE_MODELS
}

function looksLikeCapabilityModel(model, capability) {
  const id = modelKey(model.id)
  if (documentedModelsForCapability(capability).has(id)) return true

  const category = String(model.category || model.type || model.kind || '').toLowerCase()
  const capabilities = Array.isArray(model.capabilities)
    ? model.capabilities.map((x) => String(x).toLowerCase())
    : []
  if (category === capability || capabilities.includes(capability)) return true
  if (category === 'chat' || capabilities.includes('text')) return false
  if (['image', 'video', 'audio'].some((x) => x !== capability && (category === x || capabilities.includes(x)))) return false

  if (capability === 'image') return /\bimage\b|(^|[-_\s])img($|[-_\s])|gpt-image|nano.?banana|imagine-image/.test(id)
  if (capability === 'video') return /\bvideo\b|veo|sora|kling|seedance/.test(id)
  if (capability === 'audio') return /\baudio\b|\btts\b|speech|voice|music|suno/.test(id)
  return false
}

function resultFromDataArray(data) {
  const first = Array.isArray(data) ? data[0] : null
  if (!first) return null
  if (first.url) return { kind: 'url', url: String(first.url) }
  if (first.b64_json) return { kind: 'b64', b64: String(first.b64_json) }
  return null
}

export function normalizeBaseUrl(raw) {
  let s = String(raw || DEFAULT_BASE_URL).trim()
  if (!s) s = DEFAULT_BASE_URL
  s = s.replace(/\/+$/, '')
  s = s.replace(/\/v1$/i, '')
  return s
}

export function parseModels(payload, capability = 'image') {
  const raw = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : []
  return raw
    .map((m) => ({
      id: String(m.id || m.model || m.name || '').trim(),
      label: String(m.display_name || m.label || m.name || m.id || m.model || '').trim(),
      ownedBy: String(m.owned_by || m.provider || m.owner || '').trim(),
      raw: m,
    }))
    .filter((m) => m.id && looksLikeCapabilityModel({ ...m.raw, id: m.id }, capability))
    .map((m) => ({
      id: m.id,
      label: m.label || m.id,
      ownedBy: m.ownedBy,
      sizeOptions: ASPECT_RATIO_OPTIONS,
      defaultSize: '1:1',
      qualityOptions: RESOLUTION_OPTIONS,
      defaultQuality: '1K',
    }))
}

export function parseImageResult(payload) {
  const direct = resultFromDataArray(payload?.data)
  if (direct) return direct

  const nested = resultFromDataArray(payload?.data?.results || payload?.result?.data || payload?.results)
  if (nested) return nested

  if (payload?.url) return { kind: 'url', url: String(payload.url) }
  if (payload?.result_url) return { kind: 'url', url: String(payload.result_url) }
  if (payload?.b64_json) return { kind: 'b64', b64: String(payload.b64_json) }

  return { kind: 'unknown' }
}

export async function listModels(config, capability = 'image') {
  requireConfig(config)
  const res = await fetch(joinApi(config.baseUrl, '/v1/models'), {
    headers: authHeaders(config.apiKey),
  })
  const payload = await readJson(res)
  if (!res.ok) throw new Error(apiError(payload, `模型列表读取失败 (${res.status})`))
  return parseModels(payload, capability)
}

export async function listImageModels(config) {
  return listModels(config, 'image')
}

export async function submitImageGeneration(config, params) {
  requireConfig(config)
  const request = buildImageRequest(params)
  const res = await fetch(joinApi(config.baseUrl, request.path), {
    method: 'POST',
    headers: authHeaders(config.apiKey, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(request.body),
  })
  const payload = await readJson(res)
  if (!res.ok) throw new Error(apiError(payload, `生图提交失败 (${res.status})`))
  return parseImageResult(payload)
}

/** 只有真正的 data:image… 才走改图；空串/假值一律文生图，避免误进 edits 吃到示例图 */
export function normalizeImageDataUrl(raw) {
  const s = typeof raw === 'string' ? raw.trim() : ''
  return /^data:image\/[a-z0-9+.-]+;base64,/i.test(s) ? s : ''
}

export function buildImageRequest(params) {
  const aspectRatio = ASPECT_RATIO_OPTIONS.some((x) => x.value === params.size) ? params.size : '1:1'
  const outputResolution = RESOLUTION_OPTIONS.some((x) => x.value === params.quality) ? params.quality : '1K'
  const imageDataUrl = normalizeImageDataUrl(params.imageDataUrl)
  const body = {
    model: params.model,
    prompt: params.prompt,
    aspect_ratio: aspectRatio,
    output_resolution: outputResolution,
    n: 1,
    response_format: 'url',
  }
  if (imageDataUrl) body.image = imageDataUrl
  return {
    path: imageDataUrl ? '/v1/images/edits' : '/v1/images/generations',
    body,
  }
}

export async function saveImageResult(config, result, outPath) {
  if (result.kind === 'b64') {
    writeFileSync(outPath, Buffer.from(result.b64, 'base64'))
    return outPath
  }
  if (result.kind !== 'url') throw new Error('生成结果缺少图片地址')

  const headers = sameHost(config.baseUrl, result.url) ? authHeaders(config.apiKey) : undefined
  const res = await fetch(result.url, { headers, redirect: 'follow' })
  if (!res.ok) throw new Error(`图片下载失败 (${res.status})`)
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(outPath, buf)
  return outPath
}

function requireConfig(config) {
  if (!config?.apiKey) throw new Error('请先配置 API Key')
  if (!config?.baseUrl) throw new Error('请先配置 Base URL')
}

async function readJson(res) {
  const text = await res.text()
  if (!text) return {}
  try { return JSON.parse(text) } catch { return { error: text.slice(0, 500) } }
}

function apiError(payload, fallback) {
  return String(payload?.error?.message || payload?.error_msg || payload?.message || payload?.error || fallback)
}

function sameHost(baseUrl, url) {
  try {
    return new URL(baseUrl).host === new URL(url).host
  } catch {
    return false
  }
}
