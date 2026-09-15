/**
 * 安装路径验收（不跑完整 NSIS）：核对 electron-builder 配置与 native/server 产物齐套。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const build = pkg.build || {}
const out = resolve(root, 'native/test-output')
mkdirSync(out, { recursive: true })

function fail(msg) {
  throw new Error(msg)
}

const files = build.files || []
if (!files.includes('server/**/*')) fail('package.json build.files 缺少 server/**/*')
if (!files.includes('dist/**/*')) fail('package.json build.files 缺少 dist/**/*')
if (!files.includes('electron/**/*')) fail('package.json build.files 缺少 electron/**/*')

const unpack = build.asarUnpack || []
if (!unpack.some((x) => String(x).includes('server'))) fail('asarUnpack 未包含 server')

const extras = build.extraResources || []
const nativeExtra = extras.find((e) => e && e.from === 'native/bin' && e.to === 'native')
if (!nativeExtra) fail('extraResources 未把 native/bin → native')

const bin = resolve(root, 'native/bin')
const need = [
  'todo-media-engine.exe',
  'todo-media-probe.exe',
  'todo-gpu-view.exe',
  'ffmpeg.exe',
]
for (const n of need) {
  if (!existsSync(resolve(bin, n))) fail(`打包前缺少 native/bin/${n}（先 npm run native:build）`)
}

const main = readFileSync(resolve(root, 'electron/main.cjs'), 'utf8')
if (!main.includes('process.resourcesPath') || !main.includes("'native'")) {
  fail('main.cjs 未在 packaged 模式使用 resourcesPath/native')
}
if (!main.includes('app.asar.unpacked') || !main.includes('aiServer')) {
  fail('main.cjs 未配置 packaged AI server 路径')
}
if (!existsSync(resolve(root, 'server/aiServer.mjs'))) fail('缺少 server/aiServer.mjs')

/** 模拟安装后布局：resources/native + app.asar.unpacked/server */
const simulated = {
  resourcesNative: need.map((n) => `resources/native/${n}`),
  aiServer: 'resources/app.asar.unpacked/server/aiServer.mjs',
  ok: true,
}

writeFileSync(resolve(out, 'pack-paths-report.json'), JSON.stringify({
  ok: true,
  extraResources: nativeExtra,
  asarUnpack: unpack,
  nativeBin: need,
  simulated,
  at: new Date().toISOString(),
}, null, 2))

console.log('pack:paths 通过（extraResources + asarUnpack + native 齐套含 ffmpeg）')
