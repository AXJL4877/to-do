import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { buildExtensionPack } from '../server/extensionPacks.mjs'

const [source, output] = process.argv.slice(2)
if (!source || !output) {
  console.error('用法：npm run extension:pack -- <扩展源目录> <输出.todoext>')
  process.exit(1)
}
const destination = path.resolve(output)
const root = path.resolve(source)
if (destination === root || destination.startsWith(root + path.sep)) throw new Error('输出文件须在扩展源目录之外，避免把包自身再次打包')
const bytes = buildExtensionPack(root)
mkdirSync(path.dirname(destination), { recursive: true })
writeFileSync(destination, bytes)
console.log(JSON.stringify({ ok: true, file: destination, bytes: bytes.length }))
