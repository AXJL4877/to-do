/** ZIP transport for the existing registries. No code is executed on installation. */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { zipSync, unzipSync, strToU8 } from 'fflate'
import { USER_SKILL_DIR, validateSkillPack } from './skillPacks.mjs'
import { USER_STYLE_DIR, validateStylePack } from './stylePacks.mjs'
import { USER_ANIM_DIR, validateAnimPack } from './animPacks.mjs'

export const EXTENSION_SPEC = 'todo-extension-pack/1'
export const MAX_EXTENSION_BYTES = 32 * 1024 * 1024
const MAX_EXPANDED = 64 * 1024 * 1024
const MAX_FILE = 16 * 1024 * 1024
const MAX_FILES = 256
const TYPES = {
  skill: { manifest: 'skill.json', spec: 'todo-skill-pack/1', directory: USER_SKILL_DIR, validate: validateSkillPack },
  style: { manifest: 'style.json', spec: 'todo-style-pack/1', directory: USER_STYLE_DIR, validate: validateStylePack },
  animation: { manifest: 'anim.json', spec: 'todo-anim-pack/2', directory: USER_ANIM_DIR, validate: validateAnimPack },
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const reject = message => { throw new Error(message) }

function safePath(name) {
  if (typeof name !== 'string' || !name || name.length > 240 || name.includes('\\') || name.startsWith('/') || /[\x00-\x1f:]/.test(name)) reject('扩展包路径不合法')
  for (const part of name.split('/')) {
    if (!part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part) || ['__proto__', 'constructor', 'prototype'].includes(part)) reject(`扩展包路径不合法：${name}`)
  }
  return name
}

function parseJson(bytes, name) {
  if (!bytes || bytes.length > 2 * 1024 * 1024) reject(`${name} 缺失或过大`)
  try { return JSON.parse(Buffer.from(bytes).toString('utf8')) }
  catch { reject(`${name} 不是有效的 JSON`) }
}

function validateEnvelope(files) {
  const envelope = parseJson(files['extension.json'], 'extension.json')
  const type = Object.hasOwn(TYPES, envelope.kind) ? TYPES[envelope.kind] : null
  if (envelope.spec !== EXTENSION_SPEC || !type || envelope.manifest !== type.manifest) reject('扩展包格式或类型不支持')
  if (!Array.isArray(envelope.files) || !envelope.files.length || envelope.files.length > MAX_FILES - 1) reject('扩展包文件清单不合法')
  const names = new Set()
  for (const item of envelope.files) {
    const name = safePath(item.path)
    if (name === 'extension.json' || names.has(name.toLowerCase())) reject('扩展包文件清单重复')
    names.add(name.toLowerCase())
    const data = files[name]
    if (!Number.isSafeInteger(item.size) || item.size < 0 || item.size > MAX_FILE || !/^[a-f0-9]{64}$/.test(item.sha256 || '') || !data || data.length !== item.size || hash(data) !== item.sha256) reject(`文件完整性校验失败：${name}（大小 / SHA-256）`)
  }
  const actual = Object.keys(files).filter(name => name !== 'extension.json')
  if (actual.length !== names.size || actual.some(name => !names.has(name.toLowerCase()))) reject('扩展包存在未声明文件')
  const manifest = parseJson(files[type.manifest], type.manifest)
  if (manifest.spec !== type.spec) reject('内部 manifest 与扩展包类型不匹配')
  if (String(manifest.id).startsWith('builtin.')) reject('builtin 为内置扩展命名空间，请为自己的扩展使用独立 id')
  return { type, envelope, manifest }
}

function unpack(buffer) {
  if (!buffer?.length || buffer.length > MAX_EXTENSION_BYTES) reject('扩展包过大（最多 32 MB）或为空')
  const seen = new Set()
  let total = 0, count = 0
  const files = unzipSync(new Uint8Array(buffer), { filter(info) {
    const directory = info.name.endsWith('/')
    const name = safePath(directory ? info.name.slice(0, -1) : info.name)
    if (seen.has(name.toLowerCase())) reject(`扩展包路径重复：${name}`)
    seen.add(name.toLowerCase())
    if (++count > MAX_FILES || info.originalSize > MAX_FILE || (total += info.originalSize) > MAX_EXPANDED) reject('扩展包解压大小或文件数量超限')
    if (directory && info.originalSize !== 0) reject('扩展包目录不合法')
    return !directory
  } })
  // Recheck output as well as ZIP header declarations before any filesystem write.
  let expanded = 0
  for (const [name, bytes] of Object.entries(files)) {
    safePath(name)
    if (bytes.length > MAX_FILE || (expanded += bytes.length) > MAX_EXPANDED) reject('扩展包解压大小超限')
  }
  return files
}

function removePrivateDirectory(dir, root) {
  if (!path.resolve(dir).startsWith(path.resolve(root) + path.sep)) reject('临时目录越界')
  rmSync(dir, { recursive: true, force: true })
}

function compareVersions(a, b) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1
  return 0
}

export function installExtensionPack(buffer) {
  const files = unpack(buffer)
  const { type, envelope, manifest } = validateEnvelope(files)
  const root = path.dirname(type.directory)
  mkdirSync(root, { recursive: true })
  const stage = mkdtempSync(path.join(root, '.extension-stage-'))
  let backup, target, moved = false
  try {
    for (const [name, bytes] of Object.entries(files)) {
      const destination = path.join(stage, name)
      mkdirSync(path.dirname(destination), { recursive: true })
      writeFileSync(destination, bytes)
    }
    type.validate(manifest, stage)
    mkdirSync(type.directory, { recursive: true })
    if (lstatSync(type.directory).isSymbolicLink()) reject('用户扩展目录不能是符号链接')
    target = path.join(type.directory, manifest.id)
    const result = { id: manifest.id, name: manifest.name, version: manifest.version, kind: envelope.kind, action: 'installed' }
    if (existsSync(target)) {
      if (lstatSync(target).isSymbolicLink() || !lstatSync(target).isDirectory()) reject('已安装扩展路径不合法')
      const old = JSON.parse(readFileSync(path.join(target, type.manifest), 'utf8'))
      const comparison = compareVersions(manifest.version, old.version)
      if (comparison < 0) reject('不能导入旧版本或降级扩展')
      if (comparison === 0) {
        const identical = Object.entries(files).every(([name, bytes]) => existsSync(path.join(target, name)) && hash(readFileSync(path.join(target, name))) === hash(bytes))
        if (!identical) reject('同版本扩展内容不同，请先提高 version')
        return { ...result, action: 'unchanged' }
      }
      backup = path.join(root, `.extension-backup-${randomUUID()}`)
      renameSync(target, backup)
      moved = true
      result.action = 'updated'
    }
    try { renameSync(stage, target) }
    catch (error) { if (moved) { renameSync(backup, target); moved = false }; throw error }
    if (moved) {
      // A recoverable backup may remain if antivirus temporarily holds a file.
      try { removePrivateDirectory(backup, root) } catch { /* preserve backup */ }
    }
    return result
  } finally {
    if (existsSync(stage)) removePrivateDirectory(stage, root)
  }
}

/** Remove a user-installed pack only. Builtin directories are never deleted. */
export function uninstallExtensionPack({ kind, id }) {
  const type = Object.hasOwn(TYPES, kind) ? TYPES[kind] : null
  if (!type) reject('不支持的扩展类型')
  const packId = String(id || '')
  if (!packId || packId.includes('/') || packId.includes('\\') || packId.includes('..') || /[\x00-\x1f:]/.test(packId)) {
    reject('扩展 id 不合法')
  }
  if (packId.startsWith('builtin.')) reject('不能移除内置扩展')
  mkdirSync(type.directory, { recursive: true })
  if (lstatSync(type.directory).isSymbolicLink()) reject('用户扩展目录不能是符号链接')
  const target = path.join(type.directory, packId)
  if (!path.resolve(target).startsWith(path.resolve(type.directory) + path.sep)) reject('扩展路径越界')
  if (!existsSync(target)) reject('未安装该扩展')
  if (lstatSync(target).isSymbolicLink() || !lstatSync(target).isDirectory()) reject('已安装扩展路径不合法')
  const manifestPath = path.join(target, type.manifest)
  if (!existsSync(manifestPath)) reject('扩展包不完整')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (String(manifest.id) !== packId) reject('扩展 id 与目录不一致')
  removePrivateDirectory(target, type.directory)
  return { id: packId, name: manifest.name, version: manifest.version, kind, action: 'removed' }
}

/** Authors ship the same manifest their local workflow already uses. */
export function buildExtensionPack(packDirectory) {
  const directory = path.resolve(packDirectory)
  const matches = Object.entries(TYPES).filter(([, type]) => existsSync(path.join(directory, type.manifest)))
  if (matches.length !== 1) reject('包根目录须且只能有 skill.json / style.json / anim.json 之一')
  const [kind, type] = matches[0]
  const manifest = JSON.parse(readFileSync(path.join(directory, type.manifest), 'utf8'))
  if (String(manifest.id).startsWith('builtin.')) reject('builtin 为内置命名空间，请修改 id')
  type.validate(manifest, directory)
  const files = Object.create(null)
  let total = 0
  function walk(base, prefix = '') {
    for (const name of readdirSync(base)) {
      if (['.git', 'node_modules', '__pycache__', 'extension.json'].includes(name)) continue
      const relative = safePath(prefix + name), absolute = path.join(base, name), stat = lstatSync(absolute)
      if (stat.isSymbolicLink()) reject(`扩展包不支持符号链接：${relative}`)
      if (stat.isDirectory()) walk(absolute, relative + '/')
      else if (stat.isFile()) {
        if (stat.size > MAX_FILE || (total += stat.size) > MAX_EXPANDED || Object.keys(files).length >= MAX_FILES - 1) reject('扩展包大小或文件数量超限')
        files[relative] = new Uint8Array(readFileSync(absolute))
      } else reject(`扩展包文件不支持：${relative}`)
    }
  }
  walk(directory)
  files['extension.json'] = strToU8(JSON.stringify({ spec: EXTENSION_SPEC, kind, manifest: type.manifest,
    files: Object.entries(files).map(([name, data]) => ({ path: name, size: data.length, sha256: hash(data) })) }, null, 2))
  validateEnvelope(files)
  const packed = zipSync(files, { level: 6 })
  if (packed.length > MAX_EXTENSION_BYTES) reject('扩展包过大（最多 32 MB）')
  return Buffer.from(packed)
}
