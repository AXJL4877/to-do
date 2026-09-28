import { existsSync, readdirSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const tools = resolve(root, '.native-tools')
const cxx = process.env.CXX || resolve(tools, 'w64devkit/bin/g++.exe')
const cc = process.env.CC || resolve(tools, 'w64devkit/bin/gcc.exe')
const sdk = process.env.FFMPEG_SDK
  || (existsSync(tools)
    ? readdirSync(tools)
      .filter((n) => n.startsWith('ffmpeg-'))
      .map((n) => resolve(tools, n))
      .find((p) => existsSync(resolve(p, 'include/libavformat/avformat.h')))
    : '')

if (!existsSync(cxx)) throw new Error(`找不到 g++：${cxx}。运行 npm run native:setup，或设置 CXX。`)
if (!existsSync(cc)) throw new Error(`找不到 gcc：${cc}。`)
if (!sdk) throw new Error('找不到 FFmpeg 开发 SDK：运行 npm run native:setup 或设置 FFMPEG_SDK。')

const out = resolve(root, 'native/bin')
const include = resolve(root, 'native/engine/include')
const sharedDir = resolve(root, 'native/shared')
const engineSrc = resolve(root, 'native/engine/src/todo_engine.cpp')
const cliSrc = resolve(root, 'native/engine/src/todo_media_cli.cpp')
const exportSrc = resolve(root, 'native/engine/src/todo_export.cpp')
const sharedSrcs = [
  resolve(sharedDir, 'editgraph.cpp'),
  resolve(sharedDir, 'timemap.cpp'),
  resolve(sharedDir, 'keyframes.cpp'),
  resolve(sharedDir, 'layers.cpp'),
]
const legacyProbe = resolve(root, 'native/media_probe.c')
mkdirSync(out, { recursive: true })

const common = [
  '-O2', '-Wall', '-Wextra',
  `-I${include}`,
  `-I${sharedDir}`,
  `-I${resolve(sdk, 'include')}`,
  `-L${resolve(sdk, 'lib')}`,
]

const ffmpegLibs = ['-lavformat', '-lavcodec', '-lavutil', '-lswscale', '-lswresample']

console.log('编译 C++ 媒体引擎…')
execFileSync(cxx, [
  ...common, '-std=c++17', '-municode',
  engineSrc, cliSrc, exportSrc, ...sharedSrcs,
  ...ffmpegLibs, '-lwinmm', '-ld3d11', '-ldxgi', '-ld3dcompiler', '-lgdi32',
  '-o', resolve(out, 'todo-media-engine.exe'),
], { stdio: 'inherit', timeout: 180000 })

console.log('编译 D3D11 GPU 视图…')
execFileSync(cxx, [
  ...common, '-std=c++17', '-municode',
  engineSrc, resolve(root, 'native/engine/src/todo_gpu_view.cpp'),
  ...ffmpegLibs, '-ld3d11', '-ldxgi', '-lwinmm',
  '-o', resolve(out, 'todo-gpu-view.exe'),
], { stdio: 'inherit', timeout: 180000 })

console.log('编译兼容探测器…')
execFileSync(cc, [
  '-O2', '-Wall', '-std=c11', '-municode',
  `-I${resolve(sdk, 'include')}`,
  legacyProbe,
  `-L${resolve(sdk, 'lib')}`,
  '-lavformat', '-lavutil',
  '-o', resolve(out, 'todo-media-probe.exe'),
], { stdio: 'inherit', timeout: 120000 })

for (const name of readdirSync(resolve(sdk, 'bin'))) {
  if (name.endsWith('.dll')) copyFileSync(resolve(sdk, 'bin', name), resolve(out, name))
}
for (const name of readdirSync(sdk)) {
  if (/license|copying/i.test(name)) copyFileSync(resolve(sdk, name), resolve(out, name))
}

/** Optional: copy host ffmpeg/ffprobe next to engine for packaged export. */
function findHostTool(envKey, exeName) {
  const candidates = [
    process.env[envKey],
    resolve(process.env.LOCALAPPDATA || '', `Microsoft/WinGet/Links/${exeName}`),
  ].filter(Boolean)
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return ''
}
for (const [envKey, exeName] of [['FFMPEG', 'ffmpeg.exe'], ['FFPROBE', 'ffprobe.exe']]) {
  const dest = resolve(out, exeName)
  if (existsSync(dest)) continue
  const src = findHostTool(envKey, exeName)
  if (!src) continue
  try {
    copyFileSync(src, dest)
    console.log(`已复制 ${exeName} → native/bin`)
  } catch (e) {
    console.warn(`跳过复制 ${exeName}:`, e.message || e)
  }
}

writeFileSync(resolve(out, 'ENGINE_BUILD.txt'), [
  `builtAt=${new Date().toISOString()}`,
  `cxx=${cxx}`,
  `sdk=${sdk}`,
  'artifacts=todo-media-engine.exe,todo-media-probe.exe,todo-gpu-view.exe',
  'cli=probe,frame,export,play-smoke,play-session(OPEN/SEEK/READ/AUDIO_CLOCK)',
].join('\n'))

console.log(`原生引擎已输出：${out}（CLI: probe / frame / export / play-smoke / play-session+AUDIO_CLOCK）`)
