/**
 * 把 Python 运行时 + 管线需要的包搬进 APP 自己的目录：<repo>/runtime/python/
 *
 * 目标（用户要求）：APP 必须像一个真安装包——不依赖机器上另装的 Python / 包。
 * 只搬白名单里真正用到的包，避免把 PyQt6/pandas 之类几十上百 MB 的无关依赖一起拖进来。
 *
 * 用法: node scripts/bundle-python.mjs [--python <python.exe>] [--out <dir>] [--dry]
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const dry = argv.includes('--dry')
const python = arg('--python', process.env.PYTHON || 'python')
const outRoot = path.resolve(arg('--out', path.join(repo, 'runtime', 'python')))

/** 管线真正 import 的第三方包（含 Qt 系一概不要）。 */
const MODULES = ['numpy', 'cv2', 'PIL', 'fontTools']
/** 同名 .libs 目录（numpy/Pillow 的随包 DLL），按目录名搬。 */
const LIB_DIRS = ['numpy.libs', 'Pillow.libs']
const PACKAGES = [...MODULES, ...LIB_DIRS]

const MB = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`
function dirSize(dir) {
  let total = 0
  const walk = (p) => {
    for (const name of readdirSync(p)) {
      const abs = path.join(p, name)
      const st = statSync(abs)
      if (st.isDirectory()) walk(abs)
      else total += st.size
    }
  }
  try { walk(dir) } catch { /* */ }
  return total
}

const probe = spawnSync(python, ['-c', [
  'import json,sys,importlib.util',
  'origin={}',
  'for m in (' + MODULES.map((p) => `'${p}'`).join(',') + '):',
  '    try:',
  '        s=importlib.util.find_spec(m)',
  '    except Exception:',
  '        s=None',
  '    origin[m]=s.origin if s else None',
  'print(json.dumps({"prefix":sys.prefix,"exe":sys.executable,"origin":origin,"version":sys.version.split()[0],"sp":sys.path}))',
].join('\n')], { encoding: 'utf8' })

if (probe.status !== 0) {
  console.error('探测 Python 失败:', (probe.stderr || '').slice(-500))
  process.exit(1)
}
const info = JSON.parse(probe.stdout.trim().split(/\r?\n/).pop())
console.log(`源 Python ${info.version}  prefix=${info.prefix}`)

if (dry) {
  console.log('将会搬运：')
  for (const p of PACKAGES) console.log(`  ${p.padEnd(14)} ${info.origin[p] || '(未安装)'}`)
  process.exit(0)
}

if (existsSync(outRoot)) {
  console.log(`清理旧产物 ${outRoot}`)
  rmSync(outRoot, { recursive: true, force: true })
}
mkdirSync(outRoot, { recursive: true })

// 1) 解释器本体 + 标准库（跳过整个 site-packages，稍后只放白名单）
const SKIP_TOP = new Set(['site-packages', 'Lib'])
const copier = (src, dst, skipNames = new Set()) => {
  mkdirSync(dst, { recursive: true })
  for (const name of readdirSync(src)) {
    if (skipNames.has(name)) continue
    const from = path.join(src, name)
    const to = path.join(dst, name)
    if (statSync(from).isDirectory()) cpSync(from, to, { recursive: true })
    else cpSync(from, to)
  }
}
// python.exe / pythonw.exe / python314.dll / DLLs / Lib(除 site-packages) 等
copier(info.prefix, outRoot, SKIP_TOP)
const libSrc = path.join(info.prefix, 'Lib')
if (existsSync(libSrc)) copier(libSrc, path.join(outRoot, 'Lib'), new Set(['site-packages']))
const spDst = path.join(outRoot, 'Lib', 'site-packages')
mkdirSync(spDst, { recursive: true })

// 2) 白名单包（可能来自 prefix 的 site-packages，也可能来自用户 site）
const candidates = [
  path.join(info.prefix, 'Lib', 'site-packages'),
  path.join(process.env.APPDATA || '', 'Python', `Python${info.version.split('.')[0]}${info.version.split('.')[1]}`, 'site-packages'),
]
const picked = []
for (const pkg of MODULES) {
  const origin = info.origin[pkg]
  if (!origin) { console.log(`  (跳过 ${pkg}：未安装)`); continue }
  const root = candidates.find((c) => c && path.resolve(origin).startsWith(path.resolve(c)))
  const srcDir = root ? path.join(root, pkg) : null
  if (!srcDir || !existsSync(srcDir)) {
    if (existsSync(origin)) { cpSync(origin, path.join(spDst, path.basename(origin))); picked.push(`${pkg} (单文件)`) }
    continue
  }
  cpSync(srcDir, path.join(spDst, pkg), { recursive: true })
  picked.push(`${pkg} → ${MB(dirSize(srcDir))}`)
}
// numpy/Pillow 的随包 DLL 目录
for (const lib of LIB_DIRS) {
  const owner = lib.split('.')[0].toLowerCase()
  const origin = info.origin[owner === 'pillow' ? 'PIL' : owner]
  if (!origin) continue
  const root = candidates.find((c) => c && path.resolve(origin).startsWith(path.resolve(c)))
  const srcDir = root ? path.join(root, lib) : null
  if (srcDir && existsSync(srcDir)) {
    cpSync(srcDir, path.join(spDst, lib), { recursive: true })
    picked.push(`${lib} → ${MB(dirSize(srcDir))}`)
  }
}
console.log('已搬运：\n  ' + picked.join('\n  '))

// 3) 记下来源，便于之后核对
writeFileSync(path.join(outRoot, 'BUNDLED_FROM.txt'), [
  `source python: ${info.exe}`,
  `version: ${info.version}`,
  `bundled at: ${new Date().toISOString()}`,
  `packages: ${PACKAGES.join(', ')}`,
  '',
].join('\n'), 'utf8')

// 4) 自检：用搬过来的解释器 import，并禁用用户 site 保证"只用包内依赖"
const verify = spawnSync(path.join(outRoot, 'python.exe'), ['-c',
  'import numpy,PIL,cv2,sys;print("OK",numpy.__version__,PIL.__version__,cv2.__version__);print(sys.prefix)',
], { encoding: 'utf8', env: { ...process.env, PYTHONNOUSERSITE: '1', PYTHONPATH: '' } })
console.log('--- 自检 ---')
console.log((verify.stdout || '').trim() || (verify.stderr || '').trim().slice(-600))
console.log(`bundle 大小: ${MB(dirSize(outRoot))}  → ${outRoot}`)
process.exit(verify.status === 0 ? 0 : 1)
