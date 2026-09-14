/**
 * AI 冷素材库（截帧/上传参考图）— 不进媒体库，SQLite 存 BLOB。
 * Node 内置 node:sqlite（实验特性，Node 22+）。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.data')
mkdirSync(DATA_DIR, { recursive: true })

const db = new DatabaseSync(path.join(DATA_DIR, 'ai-assets.sqlite'))
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_assets (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    data BLOB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ai_assets_created ON ai_assets(created_at DESC);
`)

const insertStmt = db.prepare(
  'INSERT INTO ai_assets (id, kind, name, mime, created_at, data) VALUES (?, ?, ?, ?, ?, ?)',
)
const listStmt = db.prepare(
  'SELECT id, kind, name, mime, created_at FROM ai_assets ORDER BY created_at DESC LIMIT ?',
)
const getStmt = db.prepare('SELECT id, kind, name, mime, created_at, data FROM ai_assets WHERE id = ?')
const delStmt = db.prepare('DELETE FROM ai_assets WHERE id = ?')

export function insertAiAsset(opts) {
  const id = opts.id || `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
  const mime = opts.mime || 'image/png'
  const name = opts.name || `ref_${id}.png`
  const kind = opts.kind || 'capture'
  const createdAt = Date.now()
  insertStmt.run(id, kind, name, mime, createdAt, opts.data)
  return { id, kind, name, mime, createdAt }
}

export function listAiAssets(limit = 24) {
  return listStmt.all(Math.min(100, Math.max(1, limit))).map((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    mime: r.mime,
    createdAt: r.created_at,
    url: `/api/ai-assets/${r.id}/file`,
  }))
}

export function getAiAsset(id) {
  const r = getStmt.get(id)
  if (!r) return null
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    mime: r.mime,
    createdAt: r.created_at,
    data: r.data,
  }
}

export function deleteAiAsset(id) {
  return delStmt.run(id).changes > 0
}

export function dataUrlToBuffer(dataUrl) {
  const m = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/)
  if (!m) return null
  return { mime: m[1], data: Buffer.from(m[2], 'base64') }
}

export function bufferToDataUrl(mime, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
  return `data:${mime};base64,${buf.toString('base64')}`
}
