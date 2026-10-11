/**
 * 把扩展源码目录打成 .todoext 并装进本机用户扩展目录。
 *
 * 改了包内代码（workflow/、render.py、skill.json）后必须装一次，宿主才跑新代码；
 * 版本必须提高，否则 installExtensionPack 会以「同版本内容不同」拒绝。
 *
 * 注意：本仓库把 <repo>/.data 当开发数据根，而 .data/skills/<id> 常是指向
 * %APPDATA%/todo-editor/data/skills/<id> 的目录联接；installExtensionPack 会拒绝
 * 带 ReparsePoint 的目标。这里先把 TODO_DATA_DIR 指到联接真身，再安装。
 *
 * 用法: node scripts/install-extension.mjs <扩展源目录>
 */
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url))
const source = path.resolve(process.argv[2] || '')
if (!source) {
  console.error('用法：node scripts/install-extension.mjs <扩展源目录>')
  process.exit(1)
}
const manifest = JSON.parse(readFileSync(path.join(source, 'skill.json'), 'utf8'))

if (!process.env.TODO_DATA_DIR) {
  const devRoot = path.join(repo, '.data')
  const link = path.join(devRoot, 'skills', manifest.id)
  let target = null
  try { if (lstatSync(link).isSymbolicLink()) target = realpathSync(link) } catch { /* 没装过 */ }
  if (target) {
    process.env.TODO_DATA_DIR = path.dirname(path.dirname(target))
    console.log(`dev 数据根通过目录联接指向 ${process.env.TODO_DATA_DIR}，装到那里`)
  }
}

const { buildExtensionPack, installExtensionPack } = await import('../server/extensionPacks.mjs')
const bytes = buildExtensionPack(source)
const result = installExtensionPack(bytes)
console.log(JSON.stringify({ ok: true, source, id: manifest.id, version: manifest.version, bytes: bytes.length, ...result }, null, 2))
