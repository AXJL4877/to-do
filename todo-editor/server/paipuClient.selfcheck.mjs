import {
  buildImageRequestBody,
  imageSizeOptionsForModel,
  normalizeBaseUrl,
  parseImageResult,
  parseModels,
} from './paipuClient.mjs'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

assert(normalizeBaseUrl('https://api.paipu.net/') === 'https://api.paipu.net', 'trims trailing slash')
assert(normalizeBaseUrl('https://relay.example.com/v1') === 'https://relay.example.com', 'removes trailing v1')

const models = parseModels({
  data: [
    { id: 'gpt-image-2', owned_by: 'paipu', object: 'model' },
    { id: 'text-only', type: 'chat' },
    { id: 'seedream-pro', type: 'image' },
    { id: 'lec-wan3-720p', owned_by: 'custom', supported_endpoint_types: ['openai-video'] },
    { id: 'lec-ac-image-2', owned_by: 'custom', supported_endpoint_types: ['image-generation'] },
    { id: 'lec-ac-image-2-5-flare', owned_by: 'custom', supported_endpoint_types: ['openai'] },
  ],
})
assert(models.length === 4, `filters image models, got ${models.length}`)
assert(models[0].id === 'gpt-image-2', 'keeps image-looking model id')
assert(models[0].sizeOptions[0].value === '1024x1024', 'gpt-image-2 defaults to safe 1024 size')
assert(!models.some((m) => m.id === 'lec-wan3-720p'), 'filters video-only models out of image list')

const lecImageSizes = imageSizeOptionsForModel('lec-image-2')
assert(lecImageSizes.map((s) => s.value).join(',') === '1024x1024,1536x1024,1024x1536', 'lec-image-2 sizes')

const flareSizes = imageSizeOptionsForModel('lec-ac-image-2-5-flare')
assert(flareSizes.some((s) => s.value === '4K'), 'image 2.5 exposes 4K tier')

const wanSizes = imageSizeOptionsForModel('lec-wan3-720p')
assert(wanSizes.some((s) => s.value === '1280x720'), 'wan 720p exposes 720p landscape')

const image2Body = buildImageRequestBody({
  model: 'lec-image-2',
  prompt: 'test',
  size: 'auto',
  quality: '',
})
assert(image2Body.size === '1024x1024', 'lec-image-2 auto maps to safe 1024 square')
assert(image2Body.quality === 'low', 'lec-image-2 defaults to low quality')
assert(image2Body.response_format === 'b64_json', 'image requests prefer b64_json to avoid remote url download failures')

const flareBody = buildImageRequestBody({
  model: 'lec-ac-image-2-5-flare',
  prompt: 'test',
  size: '2K',
  quality: '',
})
assert(flareBody.size === '2K', 'image 2.5 keeps selected size tier')

const syncUrl = parseImageResult({
  data: [{ url: 'https://files.example.com/a.png' }],
})
assert(syncUrl.kind === 'url' && syncUrl.url.endsWith('/a.png'), 'parses sync url')

const syncB64 = parseImageResult({
  data: [{ b64_json: 'ZmFrZQ==' }],
})
assert(syncB64.kind === 'b64' && syncB64.b64 === 'ZmFrZQ==', 'parses sync base64')

const asyncTask = parseImageResult({
  task_id: 'task_123',
  status: 'queued',
})
assert(asyncTask.kind === 'task' && asyncTask.taskId === 'task_123', 'parses task_id')

const asyncId = parseImageResult({
  id: 'task_abc',
  status: 'in_progress',
})
assert(asyncId.kind === 'task' && asyncId.taskId === 'task_abc', 'parses async id')

console.log('paipuClient self-check ok')
