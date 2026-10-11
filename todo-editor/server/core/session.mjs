/**
 * 文档会话：把「一条命令 = 一次编辑 = 一次撤销」落成机制。
 *
 * 这是无 UI 核心层的第二块：UI、CLI、MCP、未来的 Web 客户端都通过它改工程，
 * 于是三者共享同一份事务边界、同一份校验闸门、同一份历史。
 *
 * 设计取舍：
 *   - 历史用**整文档快照**（不是操作逆运算）。理由：工程文档几十 KB~几百 KB，快照简单、不可能出错；
 *     filmcraft 用 Arc 快照、TO DO 前端现在也用 pushHistory 整 store 快照，方向一致。
 *   - 每次 exec 前拍快照，undo/redo 只是换指针，所以撤销天然精确。
 *   - 保存走**原子写**（tmp → rename），已是仓库既有约定（electron/projectFile.cjs）。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { COMMAND_IDS, applyCommand, defaultNewId, describeCommands } from './commands.mjs'
import { summarizeProject, validateProject } from '../spec/projectSpec.mjs'
import { migrate, versionOf } from '../spec/migrations.mjs'

export const DEFAULT_HISTORY_LIMIT = 64

export class DocumentSession {
  /**
   * @param {object} doc 工程文档（会被深拷贝，调用方那份不受影响）
   * @param {{limit?:number, newId?:Function, validate?:boolean, path?:string|null}} opts
   */
  constructor(doc, opts = {}) {
    this.doc = structuredClone(doc)
    this.limit = opts.limit ?? DEFAULT_HISTORY_LIMIT
    // 防御：newId 必须是函数（传成字符串会让命令内部调用失败，报成 internal 很难查）
    this.newId = typeof opts.newId === 'function' ? opts.newId : defaultNewId
    this.validateAfter = opts.validate !== false
    this.path = opts.path ?? null
    this.past = []
    this.future = []
    this.revision = 0
    this.dirty = false
    this.lastSummary = null
  }

  get docRef() { return this.doc }

  /** 机器可读摘要（智能体规划编辑前读它）。 */
  summary() { return summarizeProject(this.doc) }

  /** 规范校验（写入闸门的读侧）。 */
  validate() { return validateProject(this.doc) }

  history() {
    return { canUndo: this.past.length > 0, canRedo: this.future.length > 0, undoDepth: this.past.length, redoDepth: this.future.length, revision: this.revision }
  }

  commands() { return describeCommands() }

  /**
   * 执行一条命令。失败时**文档不变**（命令是纯函数，闸门在写回之前）。
   * @returns {{ok:boolean, summary?:string, changed?:string[], created?:string[], error?:object, undoDepth?:number}}
   */
  exec(id, args = {}, opts = {}) {
    const r = applyCommand(this.doc, id, args, { newId: this.newId, validateAfter: this.validateAfter, ...opts })
    if (!r.ok) return r
    this.past.push(this.doc)
    if (this.past.length > this.limit) this.past.shift()
    this.future = []
    this.doc = r.doc
    this.revision += 1
    this.dirty = true
    this.lastSummary = r.summary
    return { ok: true, summary: r.summary, changed: r.changed, created: r.created, undoDepth: this.past.length, revision: this.revision }
  }

  /** 批量执行：任一条失败即整体回滚（全成功或全不变）。 */
  execMany(list) {
    const snapshot = this.doc
    const done = []
    for (const item of list) {
      const id = Array.isArray(item) ? item[0] : item.id
      const args = Array.isArray(item) ? (item[1] ?? {}) : (item.args ?? {})
      const r = this.exec(id, args)
      if (!r.ok) {
        // 回滚：把这次批量里已成功的都撤掉
        for (let i = 0; i < done.length; i += 1) this.undo()
        this.doc = snapshot
        return { ok: false, error: { ...r.error, message: `批量第 ${done.length + 1} 条失败：${r.error.message}` }, done: done.length }
      }
      done.push(r)
    }
    return { ok: true, count: done.length, summaries: done.map((d) => d.summary) }
  }

  undo() {
    if (!this.past.length) return { ok: false, error: { code: 'conflict', message: '没有可撤销的编辑' } }
    this.future.push(this.doc)
    this.doc = this.past.pop()
    this.revision += 1
    this.dirty = true
    return { ok: true, revision: this.revision, undoDepth: this.past.length, redoDepth: this.future.length }
  }

  redo() {
    if (!this.future.length) return { ok: false, error: { code: 'conflict', message: '没有可重做的编辑' } }
    this.past.push(this.doc)
    this.doc = this.future.pop()
    this.revision += 1
    this.dirty = true
    return { ok: true, revision: this.revision, undoDepth: this.past.length, redoDepth: this.future.length }
  }

  /** 原子保存（tmp → rename），保留一份 .bak。 */
  save(file = this.path) {
    if (!file) return { ok: false, error: { code: 'bad_request', message: '没有指定保存路径' } }
    const abs = path.resolve(file)
    const text = `${JSON.stringify(this.doc, null, 2)}\n`
    const tmp = `${abs}.tmp`
    try {
      writeFileSync(tmp, text, 'utf8')
      if (existsSync(abs)) {
        try { writeFileSync(`${abs}.bak`, readFileSync(abs)) } catch { /* 备份失败不阻断 */ }
      }
      renameSync(tmp, abs)
    } catch (e) {
      return { ok: false, error: { code: e.code === 'EPERM' || e.code === 'EACCES' ? 'permission' : 'internal', message: `保存失败：${e.message}`, hint: '确认路径可写、且没有进程占用' } }
    }
    this.path = abs
    this.dirty = false
    return { ok: true, path: abs, bytes: Buffer.byteLength(text) }
  }
}

/** 从文件开一个会话（读入时按迁移框架处理版本）。 */
export function openSession(file, opts = {}) {
  const abs = path.resolve(String(file ?? ''))
  if (!existsSync(abs)) return { ok: false, error: { code: 'not_found', message: `工程文件不存在: ${abs}` } }
  let raw
  try {
    raw = JSON.parse(readFileSync(abs, 'utf8'))
  } catch (e) {
    return { ok: false, error: { code: 'bad_request', message: `工程 JSON 解析失败: ${e.message}` } }
  }
  const m = migrate(raw)
  if (!m.ok) return m
  const session = new DocumentSession(m.doc, { ...opts, path: abs })
  return { ok: true, session, from: versionOf(raw), to: m.to, applied: m.applied, path: abs }
}

export { COMMAND_IDS }
