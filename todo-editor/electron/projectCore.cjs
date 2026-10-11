/**
 * 主进程 ↔ 无 UI 核心层的桥（CommonJS）。
 *
 * 为什么要这层：`electron/main.cjs` 是 CJS，而核心层（server/core/*.mjs）是 ESM，
 * CJS 不能同步 require ESM —— 所以这里用**动态 import()**（进程内缓存一次）把两者接起来。
 *
 * 它负责三件事：
 *   1. 写锁的**生命周期**：开工程时取锁，关掉/切换时释放。两个进程同时开同一个工程会拿到 conflict，
 *      而不是像以前那样互相静默覆盖（这次会话里就发生过：activeSeqId 悬空 + 片段堆叠）。
 *   2. 保存时走核心层的写入（原子写 + .bak + 环形备份 + 清空恢复日志）。
 *   3. 打开时报告**崩溃残留**（.journal.jsonl 未清空 = 上次没保存成功就退出了）。
 *
 * 设计原则：**核心层不可用也不能让保存失败**。任何一步抛错都退回旧的 projectFile.cjs 行为，
 * 并把降级原因记下来（`degraded`），而不是把用户的保存操作搞坏。
 */
const path = require('node:path')

let corePromise = null
let heldLock = null
let lastDegraded = null

/** 懒加载核心层；失败返回 null（调用方退回旧路径）。 */
function core() {
  if (!corePromise) {
    corePromise = import('../server/core/projectStore.mjs').catch((e) => {
      lastDegraded = `核心层加载失败：${e.message}`
      return null
    })
  }
  return corePromise
}

function lockPathFor(file) { return `${file}.lock` }

/**
 * 确保本进程持有该工程的写锁。
 * @returns {Promise<{ok:true, tookOver:boolean} | {ok:false, error:object}>}
 */
async function ensureLock(file) {
  const abs = path.resolve(String(file ?? ''))
  if (!abs) return { ok: false, error: { code: 'bad_request', message: '没有工程路径' } }
  if (heldLock === abs) return { ok: true, tookOver: false }
  const c = await core()
  if (!c) return { ok: true, degraded: lastDegraded } // 核心层不可用：不挡用户，只是没有锁
  if (heldLock) { try { c.releaseLock(heldLock) } catch { /* 忽略 */ } ; heldLock = null }
  const r = c.acquireLock(abs)
  if (!r.ok) return r
  heldLock = abs
  return { ok: true, tookOver: !!r.tookOver, previousOwner: r.owner ?? null }
}

/** 释放当前持有的锁（切换工程 / 退出时调用）。 */
async function releaseCurrentLock() {
  const c = await core()
  const f = heldLock
  heldLock = null
  if (!c || !f) return { ok: true, released: null }
  try { c.releaseLock(f) } catch { /* 忽略 */ }
  return { ok: true, released: f }
}

function currentLock() { return heldLock }

/**
 * 保存：核心层可用则原子写 + 环形备份 + 清日志；不可用则返回 ok:false 让调用方退回旧实现。
 */
async function saveProject(file, doc, { snapshotLimit = 20 } = {}) {
  const abs = path.resolve(String(file ?? ''))
  const c = await core()
  if (!c) return { ok: false, degraded: lastDegraded, error: { code: 'internal', message: lastDegraded ?? '核心层不可用' } }
  // 保存前确认锁：如果别的进程正开着这个工程，明确报冲突而不是覆盖
  const lock = await ensureLock(abs)
  if (!lock.ok) return lock
  const w = c.writeProjectWithSnapshots(abs, doc, { snapshotLimit })
  if (!w.ok) return { ok: false, error: w.error, degraded: lock.degraded ?? null }
  return { ok: true, path: w.path, bytes: w.bytes, snapshot: w.snapshot, lock: { locked: lock.ok, tookOver: lock.tookOver ?? false } }
}

/**
 * 打开：取锁 + 报告崩溃残留与可用备份。**不解析/不改写文档**（读与 relink 仍由 projectFile.cjs 负责）。
 */
async function inspectOpen(file, { staleMs } = {}) {
  const abs = path.resolve(String(file ?? ''))
  const c = await core()
  if (!c) return { ok: true, degraded: lastDegraded, journal: null, snapshots: 0 }
  const lock = await ensureLock(abs)
  if (!lock.ok) return lock
  let journal = { crashed: false, entries: 0 }
  let snapshots = 0
  try {
    const j = c.readJournal(abs)
    journal = { crashed: j.crashed, entries: j.entries.length, path: j.path, lastCommand: j.entries.length ? j.entries[j.entries.length - 1].id : null }
    snapshots = c.listSnapshots(abs, { limit: 99 }).length
  } catch { /* 读日志失败不影响打开 */ }
  return { ok: true, lock: { locked: true, tookOver: lock.tookOver ?? false }, journal, snapshots, degraded: lock.degraded ?? null }
}

/** 崩溃恢复计划的只读查询（供 UI 弹「要不要恢复」用）。 */
async function recoveryPlan(file) {
  const abs = path.resolve(String(file ?? ''))
  const c = await core()
  if (!c) return { ok: false, error: { code: 'unsupported', message: '核心层不可用' } }
  const opened = c.ProjectStore.open(abs, { lock: false })
  if (!opened.ok) return opened
  const plan = opened.store.recoveryPlan()
  const snapshots = opened.store.snapshots().slice(0, 10)
  return { ok: plan.ok, file: abs, plan, snapshots }
}

/** 断线自检：核心层能不能用、当前锁在哪个工程上。 */
async function status() {
  const c = await core()
  return {
    coreAvailable: !!c,
    degraded: lastDegraded,
    lockedFile: heldLock,
    lockExistsOnDisk: heldLock ? require('node:fs').existsSync(lockPathFor(heldLock)) : false,
    corePath: c ? 'server/core/projectStore.mjs' : null,
  }
}

module.exports = { ensureLock, releaseCurrentLock, currentLock, saveProject, inspectOpen, recoveryPlan, status }
