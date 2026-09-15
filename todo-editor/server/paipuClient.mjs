import { writeFileSync } from 'node:fs'

const IMAGE_MODEL_HINTS = [
  'image',
  'img',
  'gpt-image',
  'seedream',
  'flux',
  'dall',
  'midjourney',
  'mj',
  'nano-banana',
  'wan',
]

function joinApi(baseUrl, path) {
  return `${normalizeBaseUrl(baseUrl)}${path}`
}

function authHeaders(apiKey, extra = {}) {
  return {
    Authorization: `Bearer ${apiKey}`,
    ...extra,
  }
}

function looksLikeImageModel(m) {
  const endpoints = Array.isArray(m.supported_endpoint_types)
    ? m.supported_endpoint_types.map((x) => String(x).toLowerCase())
    : []
  if (endpoints.some((x) => x.includes('video')) && !endpoints.some((x) => x.includes('image'))) return false
  if (endpoints.some((x) => x === 'image-generation' || x === 'images' || x === 'openai-images')) return true

  const text = [
    m.id,
    m.name,
    m.type,
    m.kind,
    m.modality,
    m.category,
    m.group,
    m.object,
    Array.isArray(m.modalities) ? m.modalities.join(' ') : '',
    Array.isArray(m.input_modalities) ? m.input_modalities.join(' ') : '',
    Array.isArray(m.output_modalities) ? m.output_modalities.join(' ') : '',
  ].filter(Boolean).join(' ').toLowerCase()
  if (/\bchat\b|\btext\b|\bembedding\b|\baudio\b|\bvideo\b/.test(String(m.type || '').toLowerCase())) return false
  return IMAGE_MODEL_HINTS.some((hint) => text.includes(hint))
}

function resultFromDataArray(data) {
  const first = Array.isArray(data) ? data[0] : null
  if (!first) return null
  if (first.url) return { kind: 'url', url: String(first.url) }
  if (first.b64_json) return { kind: 'b64', b64: String(first.b64_json) }
  return null
}

function option(value, label) {
  return { value, label }
}

const AUTO_1K_SIZES = [
  option('1024x1024', '1:1 1024'),
  option('1536x1024', '横版 3:2'),
  option('1024x1536', '竖版 2:3'),
]

const TIER_SIZES = [
  option('1K', '1K'),
  option('2K', '2K'),
  option('4K', '4K'),
]

const BASIC_SIZES = [
  option('1024x1024', '1:1 1024'),
]

const IMAGE2_QUALITY_OPTIONS = [
  option('low', '草稿'),
  option('medium', '标准'),
  option('high', '高质量'),
]

const TIER_QUALITY_OPTIONS = [
  option('standard', '标准'),
  option('high', '高质量'),
]

const BASIC_QUALITY_OPTIONS = [
  option('standard', '标准'),
]

export function imageModelProfile(modelId) {
  const id = String(modelId || '').toLowerCase()
  if (id === 'image2' || id === 'lec-image-2' || id.endsWith('-image-2') || id.includes('gpt-image-2')) {
    return {
      sizeOptions: AUTO_1K_SIZES,
      qualityOptions: IMAGE2_QUALITY_OPTIONS,
      defaultSize: '1024x1024',
      defaultQuality: 'low',
      qualityParam: 'quality',
    }
  }
  if (id.includes('image-2-5')) {
    return {
      sizeOptions: TIER_SIZES,
      qualityOptions: TIER_QUALITY_OPTIONS,
      defaultSize: '1K',
      defaultQuality: 'standard',
      qualityParam: 'quality',
    }
  }
  if (id.includes('seedream') || id.includes('banana') || id.includes('nano-banana')) {
    return {
      sizeOptions: TIER_SIZES,
      qualityOptions: BASIC_QUALITY_OPTIONS,
      defaultSize: '1K',
      defaultQuality: 'standard',
      qualityParam: '',
    }
  }
  return {
    sizeOptions: BASIC_SIZES,
    qualityOptions: BASIC_QUALITY_OPTIONS,
    defaultSize: '1024x1024',
    defaultQuality: 'standard',
    qualityParam: '',
  }
}

export function imageSizeOptionsForModel(modelId) {
  const id = String(modelId || '').toLowerCase()
  if (id.includes('wan') && id.includes('720p')) {
    return [
      option('auto', '自动'),
      option('1280x720', '16:9 720p'),
      option('720x1280', '9:16 720p'),
    ]
  }
  if (id.includes('wan') && id.includes('1080p')) {
    return [
      option('auto', '自动'),
      option('1920x1080', '16:9 1080p'),
      option('1080x1920', '9:16 1080p'),
    ]
  }
  if (id.includes('image-2-5') || id.includes('seedream') || id.includes('nano-banana')) {
    return TIER_SIZES
  }
  if (id === 'image2' || id === 'lec-image-2' || id.endsWith('-image-2') || id.includes('gpt-image-2')) {
    return AUTO_1K_SIZES
  }
  return BASIC_SIZES
}

export function normalizeBaseUrl(raw) {
  let s = String(raw || 'https://api.paipu.net').trim()
  if (!s) s = 'https://api.paipu.net'
  s = s.replace(/\/+$/, '')
  s = s.replace(/\/v1$/i, '')
  s = s.replace(/\/async\/v1$/i, '')
  return s
}

export function parseModels(payload) {
  const raw = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : []
  const mapped = raw
    .map((m) => ({
      id: String(m.id || m.model || m.name || '').trim(),
      label: String(m.display_name || m.label || m.name || m.id || m.model || '').trim(),
      ownedBy: String(m.owned_by || m.provider || m.owner || '').trim(),
      raw: m,
    }))
    .filter((m) => m.id)

  const imageModels = mapped.filter((m) => looksLikeImageModel({ ...m.raw, id: m.id, name: m.label }))
  return imageModels.map((m) => {
    const profile = imageModelProfile(m.id)
    return {
      id: m.id,
      label: m.label || m.id,
      ownedBy: m.ownedBy,
      sizeOptions: profile.sizeOptions,
      defaultSize: profile.defaultSize,
      qualityOptions: profile.qualityOptions,
      defaultQuality: profile.defaultQuality,
    }
  })
}

export function parseImageResult(payload) {
  const direct = resultFromDataArray(payload?.data)
  if (direct) return direct

  const nested = resultFromDataArray(payload?.data?.results || payload?.result?.data || payload?.results)
  if (nested) return nested

  const taskId = payload?.task_id || payload?.taskId || (
    typeof payload?.id === 'string' && /^task[_-]/i.test(payload.id) ? payload.id : ''
  )
  if (taskId) return { kind: 'task', taskId: String(taskId) }

  return { kind: 'unknown' }
}

export function parseTaskStatus(payload) {
  const status = String(payload?.status || payload?.data?.status || '').toLowerCase()
  const error = payload?.error || payload?.error_msg || payload?.message || payload?.data?.error || ''
  const parsed = parseImageResult(payload)
  if (parsed.kind === 'url' || parsed.kind === 'b64') return { done: true, result: parsed }
  if (['completed', 'succeeded', 'success', 'done'].includes(status)) {
    const dataResult = resultFromDataArray(payload?.data?.results || payload?.results)
    if (dataResult) return { done: true, result: dataResult }
  }
  if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
    return { done: true, error: String(error || '任务失败') }
  }
  return { done: false, phase: payload?.progress ? `生成中 ${payload.progress}` : '生成中...' }
}

export async function listImageModels(config) {
  requireConfig(config)
  const res = await fetch(joinApi(config.baseUrl, '/v1/models'), {
    headers: authHeaders(config.apiKey),
  })
  const payload = await readJson(res)
  if (!res.ok) throw new Error(apiError(payload, `模型列表读取失败 (${res.status})`))
  return parseModels(payload)
}

export async function submitImageGeneration(config, params) {
  requireConfig(config)
  const body = buildImageRequestBody(params)

  const res = await fetch(joinApi(config.baseUrl, '/v1/images/generations'), {
    method: 'POST',
    headers: authHeaders(config.apiKey, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  })
  const payload = await readJson(res)
  if (!res.ok) throw new Error(apiError(payload, `生图提交失败 (${res.status})`))
  return parseImageResult(payload)
}

export function buildImageRequestBody(params) {
  const profile = imageModelProfile(params.model)
  const allowedSizes = profile.sizeOptions.map((x) => x.value)
  const size = allowedSizes.includes(params.size) ? params.size : profile.defaultSize
  const allowedQualities = profile.qualityOptions.map((x) => x.value)
  const quality = allowedQualities.includes(params.quality) ? params.quality : profile.defaultQuality
  const body = {
    model: params.model,
    prompt: params.prompt,
    n: 1,
    response_format: 'b64_json',
  }
  if (size) body.size = size
  if (profile.qualityParam && quality) body[profile.qualityParam] = quality
  if (params.imageDataUrl) {
    body.image = params.imageDataUrl
    body.reference_image_urls = [params.imageDataUrl]
  }
  return body
}

export async function pollImageGeneration(config, taskId, onPhase) {
  requireConfig(config)
  const paths = [
    `/v1/images/generations/${encodeURIComponent(taskId)}`,
    `/async/v1/images/generations/${encodeURIComponent(taskId)}`,
  ]
  const deadline = Date.now() + 10 * 60_000
  let lastError = ''

  while (Date.now() < deadline) {
    for (const p of paths) {
      const res = await fetch(joinApi(config.baseUrl, p), { headers: authHeaders(config.apiKey) })
      const payload = await readJson(res)
      if (res.status === 404) continue
      if (!res.ok) {
        lastError = apiError(payload, `查询失败 (${res.status})`)
        continue
      }
      const status = parseTaskStatus(payload)
      if (status.error) throw new Error(status.error)
      if (status.done) return status.result
      if (status.phase) onPhase?.(status.phase)
      break
    }
    await delay(3500)
  }
  throw new Error(lastError || '生成超时，请稍后重试')
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
