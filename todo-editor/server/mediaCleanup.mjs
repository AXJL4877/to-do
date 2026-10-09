/** Previewed, nonrecursive cleanup confined to generated output. All reference audits fail closed. */
import { randomBytes, createHash } from 'node:crypto'
import { closeSync, existsSync, lstatSync, openSync, readSync, readdirSync, readFileSync, realpathSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const MAX_FILES = 10000
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,239}$/
const safeName = (s) => typeof s === 'string' && NAME.test(s) && !s.includes('..')

export function generatedFileName(value) {
  if (typeof value !== 'string' || value.length > 4096) return null
  if (safeName(value)) return value
  const match = /(?:^|\/)ai-generated\/([^/?#]+)(?:[?#].*)?$/.exec(value)
  if (!match) return null
  try { const name = decodeURIComponent(match[1]); return safeName(name) ? name : null } catch { return null }
}

export function readCleanupRecords(outDir) {
  const dataDir = path.dirname(outDir)
  const productions = []
  const prodDir = path.join(dataDir, 'productions')
  if (existsSync(prodDir)) {
    for (const name of readdirSync(prodDir)) {
      if (!name.endsWith('.json')) continue
      productions.push(JSON.parse(readFileSync(path.join(prodDir, name), 'utf8')))
    }
  }
  const dbFile = path.join(dataDir, 'ai-assets.sqlite')
  let jobs = []
  if (existsSync(dbFile)) {
    const db = new DatabaseSync(dbFile, { readOnly: true })
    try {
      jobs = db.prepare('SELECT id, status, params, ref_path, result_name, result_url FROM ai_jobs').all().map((row) => ({ ...row, params: JSON.parse(row.params || '{}') }))
    } finally { db.close() }
  }
  return { productions, jobs }
}

export function createMediaCleanup({ outDir, getRecords = () => readCleanupRecords(outDir), now = Date.now, tokenTtlMs = 5 * 60 * 1000, maxTokens = 32 }) {
  const root = path.resolve(outDir)
  const tokens = new Map()
  const list = (value, required) => {
    if (value === undefined && !required) return undefined
    if (!Array.isArray(value) || value.length > MAX_FILES || value.some((s) => typeof s !== 'string' || s.length > 4096)) throw new Error('文件列表格式或数量不合法（最多 10000 项）')
    return value
  }
  const rootReal = () => {
    if (lstatSync(root).isSymbolicLink()) throw new Error('生成目录是链接，无法安全清理')
    const real = realpathSync(root)
    if (path.resolve(real).toLowerCase() !== root.toLowerCase()) throw new Error('生成目录真实路径不一致，无法安全清理')
    return real
  }
  const inspect = (name) => {
    if (!safeName(name)) throw new Error('只允许生成目录内的安全文件名')
    const realRoot = rootReal()
    const file = path.join(root, name)
    const stat = lstatSync(file)
    if (stat.isSymbolicLink()) throw new Error('链接文件禁止清理')
    if (!stat.isFile()) throw new Error('目录或特殊文件不会递归删除')
    if (path.dirname(realpathSync(file)).toLowerCase() !== realRoot.toLowerCase()) throw new Error('文件不在生成目录内')
    const digest = createHash('sha256')
    const fd = openSync(file, 'r')
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024)
      let bytes
      while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, bytes))
    } finally { closeSync(fd) }
    const hash = digest.digest('hex')
    return { bytes: stat.size, fingerprint: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${hash}` }
  }
  const references = (retainedFiles, names) => {
    const reasons = new Map()
    const add = (name, reason) => { if (safeName(name) && names.has(name) && !reasons.has(name)) reasons.set(name, reason) }
    const walk = (value, reason) => {
      if (typeof value === 'string') {
        let name = generatedFileName(value)
        // Absolute ref_path values must resolve directly under this output root.
        if (!name && path.isAbsolute(value) && path.dirname(path.resolve(value)).toLowerCase() === root.toLowerCase()) name = path.basename(value)
        if (name) add(name, reason)
      } else if (Array.isArray(value)) value.forEach((v) => walk(v, reason))
      else if (value && typeof value === 'object') Object.values(value).forEach((v) => walk(v, reason))
    }
    retainedFiles.forEach((s) => walk(s, '当前项目、草稿或撤销记录仍引用此文件'))
    let records
    try { records = getRecords() } catch (error) { throw new Error(`无法核对生成记录，已停止清理：${error.message}`) }
    for (const doc of records.productions) {
      walk(doc, `成片 ${doc.id || ''} 仍引用此文件`)
      if (doc.lock) for (const name of names) if (name.startsWith(`${doc.id}_`) || name.startsWith(`${doc.id}.`)) add(name, `成片 ${doc.id} 正在生成`)
    }
    for (const job of records.jobs) {
      walk(job, `生成任务 ${job.id || ''}（${job.status || ''}）仍引用此文件`)
      if (job.status === 'running' || job.status === 'queued') for (const name of names) if (name.startsWith(`${job.id}_`) || name.startsWith(`${job.id}.`)) add(name, `生成任务 ${job.id} 正在进行或排队`)
    }
    // Referenced audio requires timing/text siblings; referenced metadata may name further artifacts.
    const expanded = new Set()
    while ([...reasons.keys()].some((name) => !expanded.has(name))) {
      for (const [name, reason] of [...reasons]) {
        if (expanded.has(name)) continue
        expanded.add(name)
        if (/\.(wav|mp3|m4a|aac|ogg|flac)$/i.test(name)) {
          const stem = name.replace(/\.[^.]+$/, '')
          for (const sibling of names) if (sibling.startsWith(`${stem}.`) || sibling.startsWith(`${stem}_`)) add(sibling, `配音 ${name} 的配套文件仍需保留`)
          if (stem.endsWith('_voice')) {
            const base = stem.slice(0, -6)
            for (const suffix of ['_timing.json', '_script.txt', '.json']) add(`${base}${suffix}`, `配音 ${name} 的配套文件仍需保留`)
          }
        }
        if (name.endsWith('.json')) {
          try { inspect(name); walk(JSON.parse(readFileSync(path.join(root, name), 'utf8')), reason) }
          catch (error) { throw new Error(`无法核对配套记录 ${name}，已停止清理：${error.message}`) }
        }
      }
    }
    return reasons
  }
  const prune = () => { for (const [token, p] of tokens) if (now() - p.at >= tokenTtlMs) tokens.delete(token) }
  return {
    preview(body = {}) {
      const files = list(body.files, false)
      const retained = list(body.retainedFiles, true)
      rootReal()
      const names = new Set(readdirSync(root))
      if (names.size > MAX_FILES) throw new Error('生成文件数量超过安全清理上限，请先分批整理')
      const reasons = references(retained, names)
      const candidates = [], blocked = [], fingerprints = new Map()
      for (const value of new Set(files ?? [...names].sort())) {
        const name = generatedFileName(value)
        if (!name) { blocked.push({ name: value, reason: '只允许生成目录内的安全文件名' }); continue }
        try {
          if (reasons.has(name)) { blocked.push({ name, reason: reasons.get(name) }); continue }
          const info = inspect(name)
          candidates.push({ name, bytes: info.bytes }); fingerprints.set(name, info.fingerprint)
        } catch (error) { blocked.push({ name, reason: error.message }) }
      }
      prune()
      while (tokens.size >= maxTokens) tokens.delete(tokens.keys().next().value)
      const token = randomBytes(24).toString('hex')
      tokens.set(token, { at: now(), candidates, fingerprints, retained })
      return { ok: true, token, candidates, blocked, totalBytes: candidates.reduce((sum, f) => sum + f.bytes, 0) }
    },
    execute(body = {}) {
      const retained = list(body.retainedFiles, true)
      prune()
      const preview = tokens.get(body.token)
      if (!preview) throw new Error('清理预览已过期或 token 无效，请重新预览')
      tokens.delete(body.token)
      rootReal()
      const names = new Set(readdirSync(root))
      const reasons = references([...preview.retained, ...retained], names)
      const deleted = [], blocked = [], failed = []
      let freedBytes = 0
      for (const { name, bytes } of preview.candidates) {
        if (reasons.has(name)) { blocked.push({ name, reason: reasons.get(name) }); continue }
        try {
          if (inspect(name).fingerprint !== preview.fingerprints.get(name)) { blocked.push({ name, reason: '文件在预览后发生变化，请重新预览' }); continue }
          unlinkSync(path.join(root, name)); deleted.push(name); freedBytes += bytes
        } catch (error) { failed.push({ name, error: error.message }) }
      }
      return { ok: true, deleted, blocked, failed, freedBytes }
    },
  }
}
