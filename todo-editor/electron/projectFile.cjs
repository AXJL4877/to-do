const path = require('path')
const fs = require('fs')
const { pathToFileURL } = require('url')

const RECENT_MAX = 12

function samePath(a, b) {
  const norm = (p) => path.resolve(p).toLowerCase()
  return norm(a) === norm(b)
}

/** 最近工程列表（JSON 数组存到 userData） */
function createRecentProjects(getFile) {
  const read = () => {
    try {
      const list = JSON.parse(fs.readFileSync(getFile(), 'utf8'))
      return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : []
    } catch {
      return []
    }
  }
  const write = (list) => {
    try { fs.writeFileSync(getFile(), JSON.stringify(list, null, 2), 'utf8') } catch { /* */ }
    return list
  }
  return {
    list: read,
    push: (filePath) => write([filePath, ...read().filter((p) => !samePath(p, filePath))].slice(0, RECENT_MAX)),
    remove: (filePath) => write(read().filter((p) => !samePath(p, filePath))),
    /** 把发现的工程路径合并进最近列表（已有的保持原有顺序优先） */
    merge: (paths) => {
      const cur = read()
      const extra = (paths || []).filter((p) => typeof p === 'string' && path.isAbsolute(p)
        && !cur.some((c) => samePath(c, p)))
      return write([...cur, ...extra].slice(0, RECENT_MAX))
    },
  }
}

/**
 * 素材同时记绝对路径与相对工程文件的 relPath，工程连同素材整体搬家后仍可找回。
 * 先写 .tmp 再替换，旧文件留一份 .bak。
 */
function writeProjectFile(filePath, json) {
  const dir = path.dirname(filePath)
  const data = typeof json === 'string' ? JSON.parse(json) : { ...json }
  if (Array.isArray(data.media)) {
    data.media = data.media.map((m) => {
      if (!m || typeof m.path !== 'string' || !path.isAbsolute(m.path)) return m
      const rel = path.relative(dir, m.path)
      if (!rel || path.isAbsolute(rel)) return m
      return { ...m, relPath: rel.split(path.sep).join('/') }
    })
  }
  data.savedAt = new Date().toISOString()
  const text = JSON.stringify(data, null, 2)
  const tmp = `${filePath}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  if (fs.existsSync(filePath)) {
    try { fs.copyFileSync(filePath, `${filePath}.bak`) } catch { /* */ }
  }
  try {
    fs.renameSync(tmp, filePath)
  } catch {
    // 目标被占用（杀软/同步盘）时 rename 可能 EPERM：退回直接覆盖
    fs.writeFileSync(filePath, text, 'utf8')
    try { fs.unlinkSync(tmp) } catch { /* */ }
  }
}

function readProjectFile(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  const dir = path.dirname(filePath)
  let relinked = 0
  let missing = 0
  if (Array.isArray(data.media)) {
    data.media = data.media.map((m) => {
      if (!m || typeof m.path !== 'string' || !m.path) return m
      if (fs.existsSync(m.path)) return m
      if (typeof m.relPath === 'string' && m.relPath) {
        const cand = path.resolve(dir, m.relPath)
        if (fs.existsSync(cand)) {
          relinked++
          return { ...m, path: cand, url: pathToFileURL(cand).href, offline: false }
        }
      }
      missing++
      return m
    })
  }
  return { data, relinked, missing }
}

/** 项目文件夹里的子目录；AI 生成物目录名须含 ai-generated（编辑器按它从文件名认出配音任务） */
const PROJECT_SUBDIRS = { ai: 'ai-generated', exports: 'exports', cache: 'cache' }

// Windows 文件名禁用字符与保留名
const BAD_NAME = /[<>:"/\\|?*\u0000-\u001f]/
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i

/**
 * 新建项目：<parentDir>/<name>/ 下建子目录，返回工程文件路径 <name>.todo.json（由渲染端写入内容）。
 * 同名文件夹已存在且非空时拒绝，避免覆盖别的项目。
 */
function createProjectFolder(parentDir, rawName) {
  const name = String(rawName || '').trim().replace(/[. ]+$/, '')
  if (!name) throw new Error('请填写项目名称')
  if (name.length > 80) throw new Error('项目名称太长（最多 80 字）')
  if (BAD_NAME.test(name) || RESERVED.test(name)) throw new Error('项目名称不能包含 < > : " / \\ | ? * 等字符')
  if (typeof parentDir !== 'string' || !path.isAbsolute(parentDir)) throw new Error('请选择保存位置')
  const dir = path.join(parentDir, name)
  if (fs.existsSync(dir)) {
    if (!fs.statSync(dir).isDirectory()) throw new Error(`已存在同名文件：${dir}`)
    if (fs.readdirSync(dir).length) throw new Error(`文件夹已存在且不为空：${dir}`)
  }
  fs.mkdirSync(dir, { recursive: true })
  for (const sub of Object.values(PROJECT_SUBDIRS)) fs.mkdirSync(path.join(dir, sub), { recursive: true })
  return { dir, filePath: path.join(dir, `${name}.todo.json`) }
}

module.exports = { createRecentProjects, writeProjectFile, readProjectFile, createProjectFolder, PROJECT_SUBDIRS }
