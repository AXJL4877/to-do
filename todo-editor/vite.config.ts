import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import {
  bufferToDataUrl,
  dataUrlToBuffer,
  deleteAiAsset,
  getAiAsset,
  insertAiAsset,
  listAiAssets,
} from './server/aiAssetsDb.mjs'
import {
  ackAiJob,
  cancelAiJob,
  enqueueAiJob,
  getAiJob,
  kickWorker,
  listAiJobs,
} from './server/aiJobs.mjs'

function readBody(req: { [Symbol.asyncIterator](): AsyncIterator<Buffer> }): Promise<string> {
  return (async () => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    return raw
  })()
}

function sendJson(res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (s: string) => void }, code: number, body: unknown) {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function aiApi(): Plugin {
  return {
    name: 'todo-ai-api',
    configureServer(server) {
      kickWorker()

      server.middlewares.use(async (req, res, next) => {
        const url = req.url || ''
        if (!url.startsWith('/api/ai-assets')) return next()

        try {
          if (req.method === 'GET' && (url === '/api/ai-assets' || url.startsWith('/api/ai-assets?'))) {
            const lim = Number(new URL(url, 'http://x').searchParams.get('limit') || 24)
            sendJson(res, 200, { ok: true, items: listAiAssets(lim) })
            return
          }

          const fileMatch = url.match(/^\/api\/ai-assets\/([^/?]+)\/file/)
          if (req.method === 'GET' && fileMatch) {
            const asset = getAiAsset(decodeURIComponent(fileMatch[1]))
            if (!asset) {
              sendJson(res, 404, { ok: false, error: 'not found' })
              return
            }
            const buf = Buffer.isBuffer(asset.data) ? asset.data : Buffer.from(asset.data as Uint8Array)
            res.statusCode = 200
            res.setHeader('Content-Type', asset.mime)
            res.setHeader('Cache-Control', 'private, max-age=3600')
            res.end(buf)
            return
          }

          const metaMatch = url.match(/^\/api\/ai-assets\/([^/?]+)/)
          if (req.method === 'GET' && metaMatch && !url.includes('/file')) {
            const asset = getAiAsset(decodeURIComponent(metaMatch[1]))
            if (!asset) {
              sendJson(res, 404, { ok: false, error: 'not found' })
              return
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
            return
          }

          if (req.method === 'POST' && (url === '/api/ai-assets' || url.startsWith('/api/ai-assets?'))) {
            const body = JSON.parse((await readBody(req)) || '{}') as {
              dataUrl?: string
              kind?: string
              name?: string
            }
            const parsed = dataUrlToBuffer(body.dataUrl || '')
            if (!parsed) {
              sendJson(res, 400, { ok: false, error: '缺少 dataUrl' })
              return
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
            return
          }

          const delMatch = url.match(/^\/api\/ai-assets\/([^/?]+)/)
          if (req.method === 'DELETE' && delMatch) {
            sendJson(res, 200, { ok: deleteAiAsset(decodeURIComponent(delMatch[1])) })
            return
          }

          sendJson(res, 405, { ok: false, error: 'method not allowed' })
        } catch (e) {
          sendJson(res, 500, { ok: false, error: String(e) })
        }
      })

      server.middlewares.use(async (req, res, next) => {
        const url = req.url || ''
        if (!url.startsWith('/api/ai-jobs')) return next()

        try {
          if (req.method === 'GET' && (url === '/api/ai-jobs' || url.startsWith('/api/ai-jobs?'))) {
            const lim = Number(new URL(url, 'http://x').searchParams.get('limit') || 40)
            kickWorker()
            sendJson(res, 200, { ok: true, items: listAiJobs(lim) })
            return
          }

          const ackMatch = url.match(/^\/api\/ai-jobs\/([^/?]+)\/ack/)
          if (req.method === 'POST' && ackMatch) {
            sendJson(res, 200, ackAiJob(decodeURIComponent(ackMatch[1])))
            return
          }

          const oneMatch = url.match(/^\/api\/ai-jobs\/([^/?]+)/)
          if (req.method === 'GET' && oneMatch) {
            const job = getAiJob(decodeURIComponent(oneMatch[1]))
            if (!job) {
              sendJson(res, 404, { ok: false, error: 'not found' })
              return
            }
            sendJson(res, 200, { ok: true, job })
            return
          }

          if (req.method === 'DELETE' && oneMatch) {
            sendJson(res, 200, cancelAiJob(decodeURIComponent(oneMatch[1])))
            return
          }

          if (req.method === 'POST' && (url === '/api/ai-jobs' || url.startsWith('/api/ai-jobs?'))) {
            const body = JSON.parse((await readBody(req)) || '{}')
            try {
              const job = enqueueAiJob(body)
              sendJson(res, 200, { ok: true, job })
            } catch (e) {
              sendJson(res, 400, { ok: false, error: String(e instanceof Error ? e.message : e) })
            }
            return
          }

          sendJson(res, 405, { ok: false, error: 'method not allowed' })
        } catch (e) {
          sendJson(res, 500, { ok: false, error: String(e) })
        }
      })

      server.middlewares.use('/api/ai-image', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'POST only' })
          return
        }
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const job = enqueueAiJob({ ...body, kind: 'image' })
          sendJson(res, 200, { ok: true, async: true, job })
        } catch (e) {
          sendJson(res, 400, { ok: false, error: String(e instanceof Error ? e.message : e) })
        }
      })

      server.middlewares.use('/api/ai-video', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'POST only' })
          return
        }
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const job = enqueueAiJob({ ...body, kind: 'video' })
          sendJson(res, 200, { ok: true, async: true, job })
        } catch (e) {
          sendJson(res, 400, { ok: false, error: String(e instanceof Error ? e.message : e) })
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), aiApi()],
  base: './',
  server: { port: 5173, strictPort: true },
})
