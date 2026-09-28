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

module.exports = { createRecentProjects, writeProjectFile, readProjectFile }
