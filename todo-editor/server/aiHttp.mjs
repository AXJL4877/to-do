/**
 * /api/ai-* 与 /ai-generated/*：Vite 中间件与独立 aiServer 共用。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { capabilities } from './spec/capabilities.mjs'
import { COMMAND_IDS } from './core/commands.mjs'
import { installExtensionPack, uninstallExtensionPack, MAX_EXTENSION_BYTES } from './extensionPacks.mjs'
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
  cancelProductionRun,
  enqueueProductionRun,
  isJobRunning,
  kickWorker,
  listAiJobs,
  liveProductionStatus,
  retryAiJob,
} from './aiJobs.mjs'
import { deleteProduction, listProductions, loadProduction } from './production/doc.mjs'
import { createProduction, editProduction, productionEntry, uploadVariant } from './production/job.mjs'
import { publicView } from './production/runner.mjs'
import { listModels } from './huniuClient.mjs'
import { importAiConfigFromMishi, readAiConfig, writeAiConfig } from './huniuConfig.mjs'
import { listStylePacks, stylePreviewPath } from './stylePacks.mjs'
import { animPreviewPath, listAnimPacks } from './animPacks.mjs'
import { H3_QUALITIES, ensureH3, h3Health } from './h3Client.mjs'
import { designFancyText, texturePrompt } from './fancyTextAi.mjs'
import { designDouyinMeta, buildDouyinCoverPrompt } from './douyinMetaAi.mjs'
import { assistScript } from './scriptRewriteAi.mjs'
import { runScriptStage } from './scriptStageAi.mjs'
import { directAnim } from './animDirector.mjs'
import { getSkillEntry, listSkillPacks, planSkill, resolveSkillParams, skillPreviewPath } from './skillPacks.mjs'
import { cleanText } from './stylePacks.mjs'
import { createMediaCleanup } from './mediaCleanup.mjs'

const mediaCleanup = createMediaCleanup({ outDir: AI_OUT })

export { kickWorker as kickAiWorker }

function readBody(req) {
  return (async () => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    return raw
  })()
}

/**
 * 调用 scripts/app-command.mjs：把命令发给**运行中的应用**执行。
 * 唯一入口——HTTP / MCP / CLI 三条面都走这个脚本，避免出现第二套实现。
 * @returns {{ok:boolean, data?:object, error?:{code:string,message:string}}}
 */
/**
 * 首选通路：**进程内桥**（主进程控制端口 → IPC → 渲染进程命令层）。
 * 这是打包版也存在的接口（token 在 userData/ai-control.json），不依赖调试端口。
 * @returns {Promise<{ok:boolean, data?:object, error?:object}|null>} null = 不可用，交给兜底
 */
async function viaControlServer(argv) {
  try {
    const infoPath = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'todo-editor', 'ai-control.json')
    if (!existsSync(infoPath)) return null
    const info = JSON.parse(readFileSync(infoPath, 'utf8'))
    if (!info?.port || !info?.token) return null
    const base = `http://127.0.0.1:${info.port}`
    const headers = { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' }
    const action = argv[0]
    if (['inspect', 'commands', 'document', 'undo', 'redo'].includes(action)) {
      const r = await fetch(`${base}/renderer`, { method: 'POST', headers, body: JSON.stringify({ action }), signal: AbortSignal.timeout(25000) })
      const j = await r.json()
      return j && j.ok !== false
        ? { ok: true, data: { ...j, via: 'ipc' } }
        : { ok: false, data: j, error: j?.error ?? { code: 'internal', message: '渲染进程返回失败' } }
    }
    if (action === 'run' || action === 'preview') {
      const i = argv.indexOf('--args')
      let args = {}
      try { args = i >= 0 ? JSON.parse(argv[i + 1] ?? '{}') : {} } catch { return { ok: false, error: { code: 'bad_request', message: '--args 不是合法 JSON' } } }
      const r = await fetch(`${base}/command`, { method: 'POST', headers, body: JSON.stringify({ id: argv[1], args, commit: action === 'run' }), signal: AbortSignal.timeout(25000) })
      const j = await r.json()
      return { ok: r.ok && j?.ok !== false, data: { ...j, action, via: 'ipc' }, error: j?.error }
    }
    return null
  } catch {
    return null
  }
}

/** 兜底通路：调试协议（仅开发模式存在）。 */
/** 对外统一入口：先试进程内桥，再退回调试协议。 */
async function runAppCli(argv) {
  const viaIpc = await viaControlServer(argv)
  if (viaIpc) return viaIpc
  return runAppCliSync(argv)
}

function runAppCliSync(argv) {
  const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  const r = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'app-command.mjs'), ...argv], { cwd: repoRoot, encoding: 'utf8', timeout: 30000 })
  const out = (r.stdout || '').trim()
  if (!out) {
    return { ok: false, error: { code: 'unavailable', message: (r.stderr || '').trim() || '连不上应用（没在跑，或没用 --debug-port 启动？）' } }
  }
  let parsed = null
  try { parsed = JSON.parse(out) } catch { return { ok: false, error: { code: 'internal', message: `应用返回的不是 JSON：${out.slice(0, 200)}` } } }
  if (parsed.ok === false && parsed.error) return { ok: false, error: parsed.error, data: parsed }
  return { ok: true, data: parsed }
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
  if (n.endsWith('.wav')) return 'audio/wav'
  if (n.endsWith('.mp3')) return 'audio/mpeg'
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

const productionCtx = { isRunning: isJobRunning, outDir: AI_OUT }

function viewOf(doc) {
  return liveProductionStatus(publicView(doc, productionEntry(doc.skillId), AI_OUT))
}

/**
 * 成片（server/production/PROTOCOL.md）：
 *   GET    /api/ai-productions?ids=a,b     摘要列表
 *   POST   /api/ai-productions             新建 { skillId, script, params?, title?, run?, stopAfter?, autoTimeline?, placement?, placeAt? }
 *   GET    /api/ai-productions/<id>        整份文档（带 url 与「待生成」标记）
 *   POST   /api/ai-productions/<id>/edit   { ops: [...] }
 *   POST   /api/ai-productions/<id>/run    { scope?, stopAfter? }
 *   POST   /api/ai-productions/<id>/cancel
 *   POST   /api/ai-productions/<id>/upload { element, dataUrl }
 *   DELETE /api/ai-productions/<id>
 */
async function handleProductions(req, res, url) {
  const [pathname, query = ''] = url.split('?')
  const rest = pathname.slice('/api/ai-productions'.length).split('/').filter(Boolean).map(decodeURIComponent)
  const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || '{}') : {}
  try {
    if (!rest.length) {
      if (req.method === 'GET') {
        const ids = new URLSearchParams(query).get('ids')?.split(',').filter(Boolean)
        sendJson(res, 200, { ok: true, items: listProductions(ids).map(liveProductionStatus) })
        return
      }
      if (req.method === 'POST') {
        const doc = createProduction(body)
        const job = body.run === false ? null : enqueueProductionRun(doc.id, body)
        sendJson(res, 200, { ok: true, production: viewOf(loadProduction(doc.id)), job })
        return
      }
    } else {
      const [id, action] = rest
      if (!action && req.method === 'GET') {
        sendJson(res, 200, { ok: true, production: viewOf(loadProduction(id)) })
        return
      }
      if (!action && req.method === 'DELETE') {
        const doc = loadProduction(id)
        if (new URLSearchParams(query).get('terminalOnly') === '1') {
          const live = liveProductionStatus(doc)
          if (live.runningJobId || live.queuedJobId) {
            sendJson(res, 409, { ok: false, error: '成片已开始生成或排队，请刷新后再处理记录' })
            return
          }
        }
        if (isJobRunning(doc.lock?.jobId)) throw new Error('正在生成，先停止再删除')
        cancelProductionRun(id, null)
        sendJson(res, 200, { ok: deleteProduction(id) })
        return
      }
      if (req.method === 'POST' && action === 'edit') {
        if (!Array.isArray(body.ops)) throw new Error('ops 须为数组')
        editProduction(id, body.ops, productionCtx)
        sendJson(res, 200, { ok: true, production: viewOf(loadProduction(id)) })
        return
      }
      if (req.method === 'POST' && action === 'run') {
        const job = enqueueProductionRun(id, body)
        sendJson(res, 200, { ok: true, job, production: viewOf(loadProduction(id)) })
        return
      }
      if (req.method === 'POST' && action === 'cancel') {
        const doc = loadProduction(id)
        sendJson(res, 200, cancelProductionRun(id, doc.lock?.jobId))
        return
      }
      if (req.method === 'POST' && action === 'upload') {
        uploadVariant(id, body.element, body.dataUrl, productionCtx)
        sendJson(res, 200, { ok: true, production: viewOf(loadProduction(id)) })
        return
      }
    }
    sendJson(res, 405, { ok: false, error: 'method not allowed' })
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e)
    sendJson(res, /^找不到成片/.test(msg) ? 404 : 400, { ok: false, error: msg })
  }
}

/** @returns {Promise<boolean>} true 表示已处理 */
export async function handleAiHttp(req, res) {
  const url = req.url || ''
  if (serveAiGenerated(req, res, url)) return true
  if (!url.startsWith('/api/ai-')) return false

  try {
    if (/^\/api\/ai-media-cleanup\/(preview|execute)(?:\?|$)/.test(url)) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return true
      }
      const origin = req.headers?.origin
      let local = !origin || origin === 'null'
      try {
        const parsed = new URL(origin)
        local ||= ['http:', 'https:'].includes(parsed.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
      } catch {}
      if (!local) { sendJson(res, 403, { ok: false, error: '只允许本地应用清理生成文件' }); return true }
      if ((req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
        sendJson(res, 415, { ok: false, error: '清理请求须使用 application/json' })
        return true
      }
      const action = url.split('?')[0].split('/').pop()
      try {
        let raw = ''
        for await (const chunk of req) {
          raw += chunk
          if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error('清理请求过大')
        }
        const body = JSON.parse(raw || '{}')
        sendJson(res, 200, mediaCleanup[action](body))
      } catch (error) { sendJson(res, 400, { ok: false, error: error.message }) }
      return true
    }
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
        const id = decodeURIComponent(oneMatch[1])
        if (new URL(url, 'http://x').searchParams.get('terminalOnly') === '1') {
          const job = getAiJob(id)
          if (!job) { sendJson(res, 404, { ok: false, error: 'not found' }); return true }
          if (!['done', 'error', 'imported'].includes(job.status)) {
            sendJson(res, 409, { ok: false, error: '任务已开始生成或排队，请刷新后再处理记录' })
            return true
          }
        }
        sendJson(res, 200, cancelAiJob(id))
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

    if (url.startsWith('/api/ai-productions')) {
      await handleProductions(req, res, url)
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

    if (url === '/api/ai-script' && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const result = await assistScript(readAiConfig({ revealKey: true }), body)
        sendJson(res, 200, { ok: true, ...result })
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e instanceof Error ? e.message : e) })
      }
      return true
    }

    if (url === '/api/ai-script-stage' && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const result = await runScriptStage(readAiConfig({ revealKey: true }), body)
        sendJson(res, 200, { ok: true, ...result })
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e instanceof Error ? e.message : e) })
      }
      return true
    }

    if (url === '/api/ai-douyin-cover' && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const title = cleanText(body.title) || cleanText(body.projectName) || '成片'
        // 封面硬锁纯文生图：忽略任何参考图/截帧，避免第一次按示例图改图、第二次才正常
        const prompt = buildDouyinCoverPrompt({
          title,
          styleHint: body.styleHint,
          script: body.script,
        })
        const job = enqueueAiJob({
          kind: 'image',
          prompt,
          size: '3:4',
          quality: body.quality === '2K' ? '2K' : '1K',
          model: body.model || 'gpt-image-2',
          purpose: 'douyin-cover',
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

    if (url === '/api/ai-config/import-mishi' && req.method === 'POST') {
      try {
        sendJson(res, 200, { ok: true, config: importAiConfigFromMishi() })
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e instanceof Error ? e.message : e) })
      }
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
    // 能力清单：智能体读的第一个端点——不用读源码就知道能做什么、怎么失败。
    if (url.split('?')[0] === '/api/capabilities' || url.split('?')[0] === '/api/ai-capabilities') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendJson(res, 405, { ok: false, error: { code: 'bad_request', message: 'GET only' } })
      }
      const view = new URLSearchParams(url.split('?')[1] ?? '').get('view') === 'catalog' ? 'catalog' : 'full'
      return sendJson(res, 200, capabilities({ aiBaseUrl: `http://127.0.0.1:${req.socket?.localPort ?? ''}`, view }))
    }
    // 写入口与运行态：智能体通过稳定的本地 HTTP API 驱动**运行中的应用**里的同一套命令。
    // 为什么要绕到应用里执行：工程的真身是渲染进程内存中的文档，磁盘文件只是快照——
    // 外部直接改文件，应用不知道，下次保存就覆盖掉。
    if (url.split('?')[0] === '/api/app/status') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { ok: false, error: { code: 'bad_request', message: 'GET only' } })
      const r = await runAppCli(['inspect'])
      return sendJson(res, r.ok ? 200 : 503, {
        ok: r.ok,
        app: r.ok
          ? { reachable: true, title: r.data?.live?.title ?? null, projectOpen: !!r.data?.live?.started, dirty: !!r.data?.live?.dirty, clips: r.data?.validate?.stats?.clipCount ?? null, errors: r.data?.validate?.errors?.length ?? null }
          : { reachable: false },
        error: r.ok ? null : r.error,
        hint: r.ok ? null : '应用需以开发模式运行：node scripts/open-todo-app.mjs --debug-port 9222',
      })
    }
    if (url.split('?')[0] === '/api/timeline/undo' || url.split('?')[0] === '/api/timeline/redo') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: { code: 'bad_request', message: 'POST only' } })
      const which = url.split('?')[0].endsWith('/redo') ? 'redo' : 'undo'
      const r = await runAppCli([which])
      if (!r.ok) {
        const code = r.error?.code ?? 'internal'
        return sendJson(res, code === 'unavailable' ? 503 : 409, { ok: false, error: { ...r.error, code } })
      }
      return sendJson(res, 200, { ok: true, action: which, summaryAfter: r.data?.summaryAfter ?? null, live: r.data?.live ?? null, via: r.data?.via ?? null })
    }
    if (url.split('?')[0] === '/api/timeline/command') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: { code: 'bad_request', message: 'POST only' } })
      let body = null
      try { body = JSON.parse((await readBody(req)) || '{}') } catch (e) {
        return sendJson(res, 400, { ok: false, error: { code: 'bad_request', message: `请求体不是合法 JSON：${e.message}` } })
      }
      const { id, args, dryRun } = body ?? {}
      if (!id || typeof id !== 'string') {
        return sendJson(res, 400, { ok: false, error: { code: 'bad_request', message: '需要 { id: "<commandId>", args?: {...}, dryRun?: false }', hint: `可用命令：GET /api/capabilities 里的 commands.discover，或 POST {"action":"commands"}` } })
      }
      // 先把命令 id 校验掉：命令名写错属于**请求**错误，不该被"应用里没开工程"这类状态问题盖住。
      if (!COMMAND_IDS.includes(id)) {
        return sendJson(res, 404, { ok: false, error: { code: 'not_found', message: `未知命令 ${id}`, hint: `可用命令：${COMMAND_IDS.join(', ')}` } })
      }
      const r = await runAppCli([dryRun ? 'preview' : 'run', id, '--args', JSON.stringify(args ?? {})])
      if (!r.ok) {
        const code = r.error?.code === 'unavailable' ? 'unavailable' : (r.error?.code ?? 'internal')
        return sendJson(res, code === 'unavailable' ? 503 : 409, { ok: false, error: { ...r.error, code }, hint: code === 'unavailable' ? '应用需以开发模式运行（--debug-port 9222）' : undefined })
      }
      return sendJson(res, 200, { ok: true, id, dryRun: !!dryRun, summary: r.data?.summary ?? null, changed: r.data?.changed ?? [], created: r.data?.created ?? [], live: r.data?.live ?? null })
    }
    if (url.split('?')[0] === '/api/ai-extensions/import') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
      const origin = req.headers.origin
      let local = !origin || origin === 'null'
      try { const parsed = new URL(origin); local ||= ['http:', 'https:'].includes(parsed.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) } catch {}
      if (!local) return sendJson(res, 403, { ok: false, error: '只允许本地应用安装扩展' })
      // Opaque browser origins can send simple requests; require a non-simple
      // binary content type so sandboxed foreign pages cannot install packages.
      if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/octet-stream') {
        return sendJson(res, 415, { ok: false, error: '扩展上传须使用 application/octet-stream' })
      }
      try {
        let size = 0
        const chunks = []
        if (Number(req.headers['content-length']) > MAX_EXTENSION_BYTES) return sendJson(res, 413, { ok: false, error: '扩展包不能超过 512 MB' })
        for await (const chunk of req) {
          size += chunk.length
          if (size > MAX_EXTENSION_BYTES) return sendJson(res, 413, { ok: false, error: '扩展包不能超过 512 MB' })
          chunks.push(chunk)
        }
        return sendJson(res, 200, { ok: true, extension: installExtensionPack(Buffer.concat(chunks)) })
      } catch (e) { return sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) }) }
    }
    if (url.split('?')[0] === '/api/ai-extensions/uninstall') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
      const origin = req.headers.origin
      let local = !origin || origin === 'null'
      try { const parsed = new URL(origin); local ||= ['http:', 'https:'].includes(parsed.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) } catch {}
      if (!local) return sendJson(res, 403, { ok: false, error: '只允许本地应用移除扩展' })
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        return sendJson(res, 200, { ok: true, extension: uninstallExtensionPack(body) })
      } catch (e) { return sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) }) }
    }
    if (!url.startsWith('/api/ai-') && !url.startsWith('/ai-generated/')) return next()
    const handled = await handleAiHttp(req, res)
    if (!handled) next()
  }
}
