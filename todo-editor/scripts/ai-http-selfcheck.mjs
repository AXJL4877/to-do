import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.TODO_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'todo-ai-http-'))
// 隔离密匙，避免本机 .env 被 bootstrap 进测试目录
process.env.MISHI_ROOT = mkdtempSync(path.join(tmpdir(), 'todo-ai-http-mishi-'))

const { handleAiHttp } = await import('../server/aiHttp.mjs')

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

function req(method, url, body) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function res() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) {
      this.headers[k] = v
    },
    end(s = '') {
      this.body = String(s)
    },
    json() {
      return JSON.parse(this.body || '{}')
    },
  }
}

async function roundtrip(method, url, body) {
  const out = res()
  const handled = await handleAiHttp(req(method, url, body), out)
  return { handled, res: out, data: out.json() }
}

const configGet = await roundtrip('GET', '/api/ai-config')
assert(configGet.handled, 'GET /api/ai-config is handled')
assert(configGet.res.statusCode === 200, 'GET /api/ai-config returns 200')
assert(configGet.data.ok === true, 'GET /api/ai-config returns ok')
assert(configGet.data.config.baseUrl === 'https://huniuai.com', 'config defaults to Huniu base URL')
assert(!configGet.data.config.apiKey, 'config does not reveal apiKey')

const modelsNoKey = await roundtrip('GET', '/api/ai-models')
assert(modelsNoKey.handled, 'GET /api/ai-models is handled')
assert(modelsNoKey.res.statusCode === 400, 'GET /api/ai-models without key returns 400')
assert(modelsNoKey.data.ok === false, 'GET /api/ai-models without key returns error')

console.log('aiHttp self-check ok')
