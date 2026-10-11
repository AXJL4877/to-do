/**
 * 工程存储：写锁 + 环形自动保存 + 崩溃恢复日志。
 *
 * 为什么要有它：现在「备份」靠人记着手工命名（这次会话里我就手工备份过两次），
 * 而工程文件一旦被两个进程同时打开就会互相覆盖。这三件事必须变成机制，不是纪律。
 *
 * 三件机制：
 *   写锁      <file>.lock         独占创建 + PID 活性检查 + 陈旧锁接管（崩溃后能自动恢复）
 *   恢复日志  <file>.journal.jsonl 每次命令追加一行；保存后清空 —— 未清空即"上次是崩溃退出"
 *   环形备份  <dir>/.history/*.json 每次保存留一份，只保留最近 N 份
 *
 * 恢复策略：**重放命令**而不是回滚文档快照。因为命令层是纯函数（server/core/commands.mjs），
 * 只要记下 id + args，就能在最后一次保存的文档上重放，得到崩溃前的状态；每步用文档哈希校验，
 * 对不上就停下并如实报告"第几步之后无法恢复"——而不是猜。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, appendFileSync } from 'node:fs'
import path from 'node:path'
import { DocumentSession } from './session.mjs'
import { applyCommand } from './commands.mjs'
import { migrate, versionOf } from '../spec/migrations.mjs'
import { validateProject } from '../spec/projectSpec.mjs'

export const DEFAULT_SNAPSHOT_LIMIT = 20
export const DEFAULT_STALE_LOCK_MS = 10 * 60 * 1000

const lockPathFor = (file) => `${file}.lock`
const journalPathFor = (file) => `${file}.journal.jsonl`
const historyDirFor = (file) => path.join(path.dirname(file), '.history')
const stamp = (d = new Date()) => d.toISOString().replace(/[:.]/g, '-').slice(0, 19)

/** 轻量确定性哈希（FNV-1a 32 位，十六进制）——只用来判断"文档变了没"，不做安全用途。 */
export function docHash(doc) {
  const s = JSON.stringify(doc)
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

/**
 * 获取写锁。陈旧锁（持有者已死 / 超过 staleMs）会被接管，并在返回值里如实说明。
 * @returns {{ok:true, path:string, tookOver:boolean, owner?:object} | {ok:false, error:object}}
 */
export function acquireLock(file, { staleMs = DEFAULT_STALE_LOCK_MS, pid = process.pid } = {}) {
  const lock = lockPathFor(file)
  const payload = `${JSON.stringify({ pid, host: 'local', at: new Date().toISOString(), file }, null, 2)}\n`
  const write = () => { writeFileSync(lock, payload, { encoding: 'utf8', flag: 'wx' }); return { ok: true, path: lock, tookOver: false } }
  try {
    return write()
  } catch (e) {
    if (e.code !== 'EEXIST') return { ok: false, error: { code: 'permission', message: `无法创建写锁 ${lock}：${e.message}`, hint: '确认工程目录可写' } }
  }
  let owner = null
  try { owner = JSON.parse(readFileSync(lock, 'utf8')) } catch { owner = null }
  const age = (() => { try { return Date.now() - statSync(lock).mtimeMs } catch { return Infinity } })()
  const alive = owner ? pidAlive(owner.pid) : false
  if (alive && owner.pid !== pid && age < staleMs) {
    return {
      ok: false,
      error: {
        code: 'conflict',
        message: `工程已被另一个进程打开（pid ${owner.pid}，${Math.round(age / 1000)}s 前写入锁）`,
        hint: '关掉那个窗口/进程后重试；若确认它是崩溃残留，删掉 .lock 或等锁过期',
        details: { lock, owner, ageMs: age },
      },
    }
  }
  // 陈旧锁：接管
  try { unlinkSync(lock) } catch { /* 已被别人清掉也无妨 */ }
  try {
    const r = write()
    return { ...r, tookOver: true, owner }
  } catch (e) {
    return { ok: false, error: { code: 'conflict', message: `接管陈旧锁失败：${e.message}` } }
  }
}

export function releaseLock(file) {
  try { unlinkSync(lockPathFor(file)); return { ok: true } } catch { return { ok: true, already: true } }
}

/** 列出环形备份（新→旧）。 */
export function listSnapshots(file, { limit = DEFAULT_SNAPSHOT_LIMIT } = {}) {
  const dir = historyDirFor(file)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((n) => n.endsWith('.json')).sort().reverse().slice(0, limit)
    .map((n) => {
      const p = path.join(dir, n)
      const st = statSync(p)
      return { name: n, path: p, bytes: st.size, at: st.mtime.toISOString() }
    })
}

/** 读恢复日志（未清空 = 上次没走到保存）。 */
export function readJournal(file) {
  const p = journalPathFor(file)
  if (!existsSync(p)) return { path: p, entries: [], crashed: false }
  const entries = []
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { entries.push(JSON.parse(t)) } catch { /* 尾巴撕裂的行丢掉（与 DSH 的恢复语义一致） */ }
  }
  return { path: p, entries, crashed: entries.length > 0 }
}

/**
 * 在给定文档上重放恢复日志。
 * @returns {{ok:boolean, doc?:object, replayed:string[], stoppedAt?:number, reason?:string}}
 */
export function replayJournal(doc, entries, { newId } = {}) {
  const replayed = []
  let cur = doc
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i]
    const expected = e.hashBefore
    if (expected && docHash(cur) !== expected) {
      return { ok: false, doc: cur, replayed, stoppedAt: i, reason: `第 ${i + 1} 条（${e.id}）之前文档状态与日志不符，后面无法确定` }
    }
    const r = applyCommand(cur, e.id, e.args ?? {}, { newId })
    if (!r.ok) {
      return { ok: false, doc: cur, replayed, stoppedAt: i, reason: `第 ${i + 1} 条（${e.id}）重放失败：${r.error.message}` }
    }
    cur = r.doc
    replayed.push(e.id)
  }
  return { ok: true, doc: cur, replayed }
}

/**
 * 工程存储：把一个 DocumentSession 与磁盘上的锁/恢复日志/环形备份绑起来。
 * UI、CLI、MCP 都应通过它改工程，于是三者共享同一套事务与崩溃恢复语义。
 */
export class ProjectStore {
  constructor(file, session, { snapshotLimit = DEFAULT_SNAPSHOT_LIMIT, locked = true } = {}) {
    this.file = path.resolve(file)
    this.session = session
    this.snapshotLimit = snapshotLimit
    this.locked = locked
    this.journalEntries = 0
  }

  /** 打开：取锁 → 迁移读入 → 读恢复日志（**不自动重放**，交给调用方决定）。 */
  static open(file, { staleMs, snapshotLimit, newId, validate, lock = true } = {}) {
    const abs = path.resolve(String(file ?? ''))
    let tookOver = false
    let owner = null
    if (lock) {
      const l = acquireLock(abs, { staleMs })
      if (!l.ok) return l
      tookOver = !!l.tookOver
      owner = l.owner ?? null
    }
    const bail = (r) => { if (lock) releaseLock(abs); return r }
    if (!existsSync(abs)) return bail({ ok: false, error: { code: 'not_found', message: `工程文件不存在: ${abs}` } })
    let raw
    try {
      raw = JSON.parse(readFileSync(abs, 'utf8'))
    } catch (e) {
      return bail({ ok: false, error: { code: 'bad_request', message: `工程 JSON 解析失败: ${e.message}` } })
    }
    const m = migrate(raw)
    if (!m.ok) return bail(m)
    const session = new DocumentSession(m.doc, { newId, validate, path: abs })
    const store = new ProjectStore(abs, session, { snapshotLimit: snapshotLimit ?? DEFAULT_SNAPSHOT_LIMIT, locked: lock })
    const journal = readJournal(abs)
    store.journalEntries = journal.entries.length
    return {
      ok: true, store, path: abs, from: versionOf(raw), to: m.to, applied: m.applied,
      lock: { locked: lock, tookOver, previousOwner: owner },
      journal: { entries: journal.entries.length, crashed: journal.crashed, path: journal.path },
    }
  }

  /** 崩溃恢复预演：把日志重放到最后保存的文档上（**不落盘**）。 */
  recoveryPlan() {
    const journal = readJournal(this.file)
    if (!journal.crashed) return { ok: true, crashed: false, entries: 0, note: '没有未保存的编辑' }
    const r = replayJournal(this.session.doc, journal.entries, { newId: this.session.newId })
    return {
      ok: r.ok, crashed: true, entries: journal.entries.length,
      replayed: r.replayed, stoppedAt: r.stoppedAt ?? null, reason: r.reason ?? null,
      recoveredValid: r.ok ? validateProject(r.doc).ok : null,
      recoveredClips: r.doc?.sequences?.[0]?.clips?.length ?? null,
      note: r.ok ? '可以完整恢复：全部编辑都能重放' : '只能恢复到某一步；后面的编辑无法确定，已如实标出',
    }
  }

  /** 应用崩溃恢复（把重放结果写回内存；落盘由调用方决定）。 */
  applyRecovery() {
    const journal = readJournal(this.file)
    if (!journal.crashed) return { ok: true, applied: 0 }
    const r = replayJournal(this.session.doc, journal.entries, { newId: this.session.newId })
    if (!r.ok) {
      return { ok: false, error: { code: 'conflict', message: `无法完整恢复：${r.reason}`, hint: '先检查 .journal.jsonl，或从 .history 里挑一份备份' } }
    }
    this.session.doc = r.doc
    this.session.dirty = true
    this.session.revision += 1
    this.session.past = []
    this.session.future = []
    return { ok: true, applied: r.replayed.length, replayed: r.replayed }
  }

  /** 执行命令并追加恢复日志（崩溃也不丢编辑轨迹）。 */
  exec(id, args = {}) {
    const before = docHash(this.session.doc)
    const r = this.session.exec(id, args)
    if (!r.ok) return r
    appendFileSync(journalPathFor(this.file), `${JSON.stringify({ seq: this.journalEntries + 1, at: new Date().toISOString(), id, args, hashBefore: before })}\n`, 'utf8')
    this.journalEntries += 1
    return r
  }

  /** 保存：原子写 + 环形备份 + 清空恢复日志。 */
  save() {
    const r = this.session.save(this.file)
    if (!r.ok) return r
    let snapshot = null
    try { snapshot = this.#writeSnapshot() } catch { /* 备份失败不阻断保存 */ }
    try { rmSync(journalPathFor(this.file), { force: true }) } catch { /* 清日志失败不阻断 */ }
    this.journalEntries = 0
    return { ...r, snapshot }
  }

  #writeSnapshot() {
    const dir = historyDirFor(this.file)
    mkdirSync(dir, { recursive: true })
    const base = path.basename(this.file).replace(/\.todo\.json$/i, '').replace(/\.json$/i, '')
    const name = `${base}-${stamp()}.json`
    const dest = path.join(dir, name)
    writeFileSync(dest, `${JSON.stringify(this.session.doc, null, 2)}\n`, 'utf8')
    const all = readdirSync(dir).filter((n) => n.endsWith('.json')).sort().reverse()
    for (const old of all.slice(this.snapshotLimit)) {
      try { rmSync(path.join(dir, old), { force: true }) } catch { /* 清理失败不阻断 */ }
    }
    return { name, path: dest, kept: Math.min(all.length, this.snapshotLimit) }
  }

  snapshots() { return listSnapshots(this.file, { limit: this.snapshotLimit }) }

  close({ save = false } = {}) {
    let saved = null
    if (save && this.session.dirty) saved = this.save()
    if (this.locked) releaseLock(this.file)
    return { ok: true, saved, dirty: this.session.dirty }
  }
}

/**
 * 「JSON 进 JSON 出」的写入：给 Electron 主进程（CommonJS）用。
 *
 * 与 ProjectStore.save 的区别：不读盘、不建会话——调用方已经在内存里拿着完整文档。
 * 但**同样**保证：原子写（tmp→rename）+ .bak + 环形备份 + 清空恢复日志。
 * 锁由调用方持有（主进程开工程时取锁），这里不碰锁，所以不会和 UI 抢。
 *
 * @returns {{ok:true, path:string, bytes:number, snapshot:object|null} | {ok:false, error:object}}
 */
export function writeProjectWithSnapshots(file, doc, { snapshotLimit = DEFAULT_SNAPSHOT_LIMIT, baseName = null } = {}) {
  const abs = path.resolve(String(file ?? ''))
  if (!abs) return { ok: false, error: { code: 'bad_request', message: '没有指定保存路径' } }
  const text = `${JSON.stringify(doc, null, 2)}\n`
  const tmp = `${abs}.tmp`
  try {
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(tmp, text, 'utf8')
    if (existsSync(abs)) {
      try { writeFileSync(`${abs}.bak`, readFileSync(abs)) } catch { /* 备份失败不阻断 */ }
    }
    renameSync(tmp, abs)
  } catch (e) {
    const code = e.code === 'EPERM' || e.code === 'EACCES' ? 'permission' : 'internal'
    return { ok: false, error: { code, message: `保存失败：${e.message}`, hint: '确认路径可写、且没有进程占用' } }
  }
  let snapshot = null
  try {
    const dir = historyDirFor(abs)
    mkdirSync(dir, { recursive: true })
    const base = baseName ?? path.basename(abs).replace(/\.todo\.json$/i, '').replace(/\.json$/i, '')
    const name = `${base}-${stamp()}.json`
    const dest = path.join(dir, name)
    writeFileSync(dest, text, 'utf8')
    const all = readdirSync(dir).filter((n) => n.endsWith('.json')).sort().reverse()
    for (const old of all.slice(snapshotLimit)) {
      try { rmSync(path.join(dir, old), { force: true }) } catch { /* 清理失败不阻断 */ }
    }
    snapshot = { name, path: dest, kept: Math.min(all.length, snapshotLimit) }
  } catch { /* 备份失败不阻断保存 */ }
  try { rmSync(journalPathFor(abs), { force: true }) } catch { /* 清日志失败不阻断 */ }
  return { ok: true, path: abs, bytes: Buffer.byteLength(text), snapshot }
}