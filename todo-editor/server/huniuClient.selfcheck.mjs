import {
  buildImageRequest,
  normalizeBaseUrl,
  parseImageResult,
  parseModels,
} from './huniuClient.mjs'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

assert(normalizeBaseUrl('https://huniuai.com/') === 'https://huniuai.com', 'trims trailing slash')
assert(normalizeBaseUrl('https://huniuai.com/v1') === 'https://huniuai.com', 'removes trailing v1')
assert(normalizeBaseUrl('') === 'https://huniuai.com', 'defaults to Huniu base URL')

const payload = {
  data: [
    { id: 'gpt-image-2', object: 'model', owned_by: 'openai' },
    { id: 'aliyun-image-superres', category: 'image', capabilities: ['image'] },
    { id: 'veo-4-omni', category: 'video', capabilities: ['video'] },
    { id: 'tts-1-hd', category: 'audio', capabilities: ['audio'] },
    { id: 'gemini-3.0-pro-image', object: 'model', owned_by: 'google' },
    { id: 'Nano Banana 2', object: 'model', owned_by: 'google' },
    { id: 'gpt-5.5', object: 'model', owned_by: 'openai' },
    { id: 'grok-imagine-video', object: 'model', owned_by: 'xai' },
    { id: 'not-image-but-has-text', type: 'chat' },
  ],
}
const models = parseModels(payload, 'image')
assert(models.length === 4, `keeps only image-capable models, got ${models.length}`)
assert(models.some((m) => m.id === 'gpt-image-2'), 'keeps gpt-image-2')
assert(models.some((m) => m.id === 'aliyun-image-superres'), 'keeps category image models')
assert(!models.some((m) => m.id === 'veo-4-omni'), 'image list filters video models')
assert(!models.some((m) => m.id === 'tts-1-hd'), 'image list filters audio models')
assert(models.some((m) => m.id === 'gemini-3.0-pro-image'), 'keeps gemini image')
assert(models.some((m) => m.id === 'Nano Banana 2'), 'keeps Nano Banana 2')
assert(!models.some((m) => m.id === 'grok-imagine-video'), 'filters video models')
assert(models[0].sizeOptions.some((s) => s.value === '1:1'), 'exposes aspect ratio options')
assert(models[0].qualityOptions.some((q) => q.value === '1K'), 'exposes output resolution options')

const videoModels = parseModels(payload, 'video')
assert(videoModels.length === 2, `video list keeps only video models, got ${videoModels.length}`)
assert(videoModels.some((m) => m.id === 'veo-4-omni'), 'video list keeps category video models')
assert(videoModels.some((m) => m.id === 'grok-imagine-video'), 'video list keeps documented video models')
assert(!videoModels.some((m) => m.id === 'gpt-image-2' || m.id === 'tts-1-hd'), 'video list filters non-video models')

const audioModels = parseModels(payload, 'audio')
assert(audioModels.length === 1 && audioModels[0].id === 'tts-1-hd', 'audio list keeps only audio models')

const generation = buildImageRequest({
  model: 'gpt-image-2',
  prompt: 'test',
  size: '16:9',
  quality: '2K',
})
assert(generation.path === '/v1/images/generations', 'text-to-image uses generations endpoint')
assert(generation.body.aspect_ratio === '16:9', 'maps size to aspect_ratio')
assert(generation.body.output_resolution === '2K', 'maps quality to output_resolution')
assert(generation.body.response_format === 'url', 'requests URL results')
assert(!('image' in generation.body), 'text-to-image has no image field')

const edit = buildImageRequest({
  model: 'gpt-image-2',
  prompt: 'edit',
  size: '1:1',
  quality: '1K',
  imageDataUrl: 'data:image/png;base64,ZmFrZQ==',
})
assert(edit.path === '/v1/images/edits', 'image-to-image uses edits endpoint')
assert(edit.body.image === 'data:image/png;base64,ZmFrZQ==', 'image-to-image sends full Data URI')

const urlResult = parseImageResult({
  data: [{ url: 'https://dlff.manjuapi.com/files/example.png' }],
})
assert(urlResult.kind === 'url' && urlResult.url.endsWith('/example.png'), 'parses data[0].url')

const compatResult = parseImageResult({
  result_url: 'https://dlff.manjuapi.com/files/compat.png',
})
assert(compatResult.kind === 'url' && compatResult.url.endsWith('/compat.png'), 'parses compatible result_url')

console.log('huniuClient self-check ok')
