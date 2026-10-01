/**
 * /api/ai-* 与 /ai-generated/*：Vite 中间件与独立 aiServer 共用。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  bufferToDataUrl,
  dataUrlToBuffer,
  deleteAiAsset,
  getAiAsset,
  insertAiAsset,
  listAiAssets,
} from './aiAssetsDb.mjs'
import {
  AI_OUT,
  ackAiJob,
  cancelAiJob,
  enqueueAiJob,
  getAiJob,
  kickWorker,
  listAiJobs,
  retryAiJob,
} from './aiJobs.mjs'
import { listModels } from './huniuClient.mjs'
import { readAiConfig, writeAiConfig } from './huniuConfig.mjs'
import { listStylePacks, stylePreviewPath } from './stylePacks.mjs'
import { animPreviewPath, listAnimPacks } from './animPacks.mjs'
import { H3_QUALITIES, ensureH3, h3Health } from './h3Client.mjs'
import { designFancyText, texturePrompt } from './fancyTextAi.mjs'
import { designDouyinMeta, buildDouyinCoverPrompt } from './douyinMetaAi.mjs'
import { directAnim } from './animDirector.mjs'
import { getSkillEntry, listSkillPacks, planSkill, resolveSkillParams, skillPreviewPath } from './skillPacks.mjs'
import { cleanText } from './stylePacks.mjs'

export { kickWorker as kickAiWorker }

function readBody(req) {
  return (async () => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    return raw
  })()
}

function sendJson(res, code, body) {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function mimeFor(name) {
  const n = name.toLowerCase()
  if (n.endsWith('.png')) return 'image/png'
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg'
  if (n.endsWith('.webp')) return 'image/webp'
  if (n.endsWith('.gif')) return 'image/gif'
  if (n.endsWith('.mp4')) return 'video/mp4'
  if (n.endsWith('.webm')) return 'video/webm'
  if (n.endsWith('.json')) return 'application/json; charset=utf-8'
  return 'application/octet-stream'
}

/** @returns {boolean} */
function serveAiGenerated(req, res, url) {
  if (!url.startsWith('/ai-generated/')) return false
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { ok: false, error: 'GET only' })
    return true
  }
  const name = decodeURIComponent(url.slice('/ai-generated/'.length).split('?')[0] || '')
  if (!name || name.includes('..') || /[/\\]/.test(name)) {
    sendJson(res, 400, { ok: false, error: 'bad path' })
    return true
  }
  const file = path.join(AI_OUT, name)
  if (!existsSync(file) || !statSync(file).isFile()) {
    sendJson(res, 404, { ok: false, error: 'not found' })
    return true
  }
  const buf = readFileSync(file)
  res.statusCode = 200
  res.setHeader('Content-Type', mimeFor(name))
  res.setHeader('Content-Length', String(buf.length))
  res.setHeader('Cache-Control', 'private, max-age=3600')
  if (req.method === 'HEAD') res.end()
  else res.end(buf)
  return true
}

/** @returns {Promise<boolean>} true 表示已处理 */
export async function handleAiHttp(req, res) {
  const url = req.url || ''
  if (serveAiGenerated(req, res, url)) return true
  if (!url.startsWith('/api/ai-')) return false

  try {
    if (url.startsWith('/api/ai-assets')) {
      if (req.method === 'GET' && (url === '/api/ai-assets' || url.startsWith('/api/ai-assets?'))) {
        const lim = Number(new URL(url, 'http://x').searchParams.get('limit') || 24)
        sendJson(res, 200, { ok: true, items: listAiAssets(lim) })
        return true
      }

      const fileMatch = url.match(/^\/api\/ai-assets\/([^/?]+)\/file/)
      if (req.method === 'GET' && fileMatch) {
        const asset = getAiAsset(decodeURIComponent(fileMatch[1]))
        if (!asset) {
          sendJson(res, 404, { ok: false, error: 'not found' })
          return true
        }
        const buf = Buffer.isBuffer(asset.data) ? asset.data : Buffer.from(asset.data)
        res.statusCode = 200
        res.setHeader('Content-Type', asset.mime)
        res.setHeader('Cache-Control', 'private, max-age=3600')
        res.end(buf)
        return true
      }

      const metaMatch = url.match(/^\/api\/ai-assets\/([^/?]+)/)
      if (req.method === 'GET' && metaMatch && !url.includes('/file')) {
        const asset = getAiAsset(decodeURIComponent(metaMatch[1]))
        if (!asset) {
          sendJson(res, 404, { ok: false, error: 'not found' })
          return true
        }
        sendJson(res, 200, {
          ok: true,
          id: asset.id,
          kind: asset.kind,
          name: asset.name,
          mime: asset.mime,
          createdAt: asset.createdAt,
          dataUrl: bufferToDataUrl(asset.mime, asset.data),
          url: `/api/ai-assets/${asset.id}/file`,
        })
        return true
      }

      if (req.method === 'POST' && (url === '/api/ai-assets' || url.startsWith('/api/ai-assets?'))) {
        const body = JSON.parse((await readBody(req)) || '{}')
        const parsed = dataUrlToBuffer(body.dataUrl || '')
        if (!parsed) {
          sendJson(res, 400, { ok: false, error: '缺少 dataUrl' })
          return true
        }
        const row = insertAiAsset({
          kind: body.kind || 'capture',
          name: body.name,
          mime: parsed.mime,
          data: parsed.data,
        })
        sendJson(res, 200, {
          ok: true,
          ...row,
          url: `/api/ai-assets/${row.id}/file`,
          dataUrl: body.dataUrl,
        })
        return true
      }

      const delMatch = url.match(/^\/api\/ai-assets\/([^/?]+)/)
      if (req.method === 'DELETE' && delMatch) {
        sendJson(res, 200, { ok: deleteAiAsset(decodeURIComponent(delMatch[1])) })
        return true
      }

      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return true
    }

    if (url.startsWith('/api/ai-jobs')) {
      if (req.method === 'GET' && (url === '/api/ai-jobs' || url.startsWith('/api/ai-jobs?'))) {
        const lim = Number(new URL(url, 'http://x').searchParams.get('limit') || 40)
        kickWorker()
        sendJson(res, 200, { ok: true, items: listAiJobs(lim) })
        return true
      }

      const outMatch = url.match(/^\/api\/ai-jobs\/([^/?]+)\/output/)
      if (req.method === 'GET' && outMatch) {
        const job = getAiJob(decodeURIComponent(outMatch[1]))
        if (!job) {
          sendJson(res, 404, { ok: false, error: 'not found' })
        } else if (job.status !== 'done' && job.status !== 'imported') {
          sendJson(res, 409, { ok: false, status: job.status, phase: job.phase, error: job.error || '任务未完成' })
        } else {
          sendJson(res, 200, {
            ok: true,
            output: job.params.output || {
              jobId: job.id, kind: job.resultKind, video: job.resultUrl, duration: job.duration,
              width: job.params.width ?? null, height: job.params.height ?? null,
            },
          })
        }
        return true
      }

      const ackMatch = url.match(/^\/api\/ai-jobs\/([^/?]+)\/ack/)
      if (req.method === 'POST' && ackMatch) {
        sendJson(res, 200, ackAiJob(decodeURIComponent(ackMatch[1])))
        return true
      }

      const retryMatch = url.match(/^\/api\/ai-jobs\/([^/?]+)\/retry/)
      if (req.method === 'POST' && retryMatch) {
        const r = retryAiJob(decodeURIComponent(retryMatch[1]))
        sendJson(res, r.ok ? 200 : 409, r)
        return true
      }

      const oneMatch = url.match(/^\/api\/ai-jobs\/([^/?]+)/)
      if (req.method === 'GET' && oneMatch) {
        const job = getAiJob(decodeURIComponent(oneMatch[1]))
        if (!job) {
          sendJson(res, 404, { ok: false, error: 'not found' })
          return true
        }
        sendJson(res, 200, { ok: true, job })
        return true
      }

      if (req.method === 'DELETE' && oneMatch) {
        sendJson(res, 200, cancelAiJob(decodeURIComponent(oneMatch[1])))
        return true
      }

      if (req.method === 'POST' && (url === '/api/ai-jobs' || url.startsWith('/api/ai-jobs?'))) {
        const body = JSON.parse((await readBody(req)) || '{}')
        try {
          const job = enqueueAiJob(body)
          sendJson(res, 200, { ok: true, job })
        } catch (e) {
          sendJson(res, 400, { ok: false, error: String(e instanceof Error ? e.message : e) })
        }
        return true
      }

      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return true
    }

    const previewMatch = url.match(/^\/api\/ai-(styles|anims|skills)\/([^/?]+)\/previews\/(\d+)/)
    if (previewMatch) {
      const lookup = { anims: animPreviewPath, skills: skillPreviewPath, styles: stylePreviewPath }[previewMatch[1]]
      const file = lookup(decodeURIComponent(previewMatch[2]), Number(previewMatch[3]))
      if (!file || !existsSync(file)) {
        sendJson(res, 404, { ok: false, error: 'not found' })
        return true
      }
      const buf = readFileSync(file)
      res.statusCode = 200
      res.setHeader('Content-Type', mimeFor(file))
      res.setHeader('Content-Length', String(buf.length))
      res.setHeader('Cache-Control', 'private, max-age=3600')
      res.end(buf)
      return true
    }

    if (url === '/api/ai-skills' || url.startsWith('/api/ai-skills?')) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'GET only' })
        return true
      }
      sendJson(res, 200, { ok: true, ...listSkillPacks() })
      return true
    }

    if (url === '/api/ai-skill-plan' && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const entry = getSkillEntry(body.skillId)
        const prompt = cleanText(body.prompt)
        if (!prompt) throw new Error(`请填写「${entry.pack.input.label}」`)
        const plan = await planSkill(readAiConfig({ revealKey: true }), entry, prompt.slice(0, entry.pack.input.maxLength), resolveSkillParams(entry.pack, body.params))
        sendJson(res, 200, { ok: true, plan })
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e instanceof Error ? e.message : e) })
      }
      return true
    }

    if (url === '/api/ai-anim-direct' && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const direction = await directAnim(readAiConfig({ revealKey: true }), body)
        sendJson(res, 200, { ok: true, direction })
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e instanceof Error ? e.message : e) })
      }
      return true
    }

    if (url === '/api/ai-fancy-text' && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const style = await designFancyText(readAiConfig({ revealKey: true }), body)
        sendJson(res, 200, { ok: true, style })
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e instanceof Error ? e.message : e) })
      }
      return true
    }

    if (url === '/api/ai-fancy-texture' && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const job = enqueueAiJob({
          kind: 'image', prompt: texturePrompt(body.desc), size: '1:1', quality: '1K',
          model: 'gpt-image-2', purpose: 'texture',
        })
        sendJson(res, 200, { ok: true, job })
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e instanceof Error ? e.message : e) })
      }
      return true
    }

    if (url === '/api/ai-douyin-meta' && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const meta = await designDouyinMeta(readAiConfig({ revealKey: true }), body)
        sendJson(res, 200, { ok: true, meta })
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e instanceof Error ? e.message : e) })
      }
      return true
    }

    if (url === '/api/ai-douyin-cover' && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const title = cleanText(body.title) || cleanText(body.projectName) || '成片'
        const prompt = buildDouyinCoverPrompt({
          title,
          styleHint: body.styleHint,
        })
        const job = enqueueAiJob({
          kind: 'image',
          prompt,
          size: '3:4',
          quality: body.quality === '1K' ? '1K' : '2K',
          model: body.model || 'gpt-image-2',
          purpose: 'douyin-cover',
          imageDataUrl: typeof body.imageDataUrl === 'string' ? body.imageDataUrl : undefined,
        })
        sendJson(res, 200, { ok: true, job, prompt })
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e instanceof Error ? e.message : e) })
      }
      return true
    }

    if (url === '/api/ai-styles' || url.startsWith('/api/ai-styles?')) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'GET only' })
        return true
      }
      sendJson(res, 200, { ok: true, ...listStylePacks() })
      return true
    }

    if (url === '/api/ai-h3' || url.startsWith('/api/ai-h3?')) {
      sendJson(res, 200, { ok: true, ...(await h3Health()), qualities: H3_QUALITIES })
      return true
    }
    if (url.startsWith('/api/ai-h3/start') && req.method === 'POST') {
      try {
        sendJson(res, 200, { ok: true, ...(await ensureH3()) })
      } catch (e) {
        sendJson(res, 500, { ok: false, error: String(e instanceof Error ? e.message : e) })
      }
      return true
    }

    if (url === '/api/ai-anims' || url.startsWith('/api/ai-anims?')) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'GET only' })
        return true
      }
      sendJson(res, 200, { ok: true, ...listAnimPacks() })
      return true
    }

    if (url.startsWith('/api/ai-config')) {
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, config: readAiConfig() })
        return true
      }
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        sendJson(res, 200, { ok: true, config: writeAiConfig(body) })
        return true
      }
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return true
    }

    if (url.startsWith('/api/ai-models')) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return true
      }
      try {
        const config = readAiConfig({ revealKey: true })
        const mode = new URL(url, 'http://x').searchParams.get('mode') || 'image'
        const models = await listModels(config, mode)
        sendJson(res, 200, { ok: true, models })
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e instanceof Error ? e.message : e) })
      }
      return true
    }

    if (url === '/api/ai-image' || url.startsWith('/api/ai-image?')) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' })
        return true
      }
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const job = enqueueAiJob({ ...body, kind: 'image' })
        sendJson(res, 200, { ok: true, async: true, job })
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e instanceof Error ? e.message : e) })
      }
      return true
    }

    if (url === '/api/ai-video' || url.startsWith('/api/ai-video?')) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' })
        return true
      }
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const job = enqueueAiJob({ ...body, kind: 'video' })
        sendJson(res, 200, { ok: true, async: true, job })
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e instanceof Error ? e.message : e) })
      }
      return true
    }
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String(e) })
    return true
  }

  return false
}

/** Connect/Vite 中间件 */
export function createAiMiddleware() {
  return async (req, res, next) => {
    const url = req.url || ''
    if (!url.startsWith('/api/ai-') && !url.startsWith('/ai-generated/')) return next()
    const handled = await handleAiHttp(req, res)
    if (!handled) next()
  }
}
