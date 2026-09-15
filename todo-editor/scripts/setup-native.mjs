// 项目内便携 Windows x64 工具链；优先 curl 断点/镜像，避免 Node fetch 大文件超时。
import { mkdir, access, rename, rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const tools = resolve(root, '.native-tools')
if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('自动安装仅支持 Windows x64；其他平台请设置 CXX、FFMPEG_SDK 后运行 native:build。')
}
await mkdir(tools, { recursive: true })

function curlDownload(url, target) {
  console.log(`下载 ${url}`)
  const r = spawnSync('curl.exe', [
    '-L', '--retry', '10', '--retry-all-errors', '--retry-delay', '2',
    '--connect-timeout', '30', '-C', '-', '-o', target, url,
  ], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`curl 下载失败: ${url}`)
}

async function ensure(url, name) {
  const target = resolve(tools, name)
  try {
    await access(target)
    return target
  } catch {
    /* download */
  }
  const partial = `${target}.partial`
  curlDownload(url, partial)
  await rename(partial, target)
  return target
}

async function findSdk() {
  const names = await readdir(tools)
  for (const n of names) {
    if (!n.startsWith('ffmpeg-') || n.endsWith('.zip')) continue
    const p = resolve(tools, n)
    if (existsSync(resolve(p, 'include/libavformat/avformat.h'))) return p
  }
  return ''
}

const gccArchive = await ensure(
  'https://github.com/skeeto/w64devkit/releases/download/v2.10.0/w64devkit-x64-2.10.0.7z.exe',
  'w64devkit.7z.exe',
)
if (!existsSync(resolve(tools, 'w64devkit/bin/g++.exe'))) {
  execFileSync(gccArchive, ['-y', `-o${tools}`], { stdio: 'inherit', timeout: 180000 })
}

if (!(await findSdk())) {
  const sdkZip = resolve(tools, 'ffmpeg-sdk.zip')
  const mirrors = [
    'https://ghfast.top/https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-win64-lgpl-shared-8.1.zip',
    'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-win64-lgpl-shared-8.1.zip',
  ]
  let ok = false
  for (const url of mirrors) {
    try {
      if (existsSync(sdkZip)) await rm(sdkZip, { force: true })
      curlDownload(url, sdkZip)
      ok = true
      break
    } catch (e) {
      console.warn(String(e))
    }
  }
  if (!ok) throw new Error('FFmpeg SDK 下载失败')
  const quote = (s) => `'${s.replaceAll("'", "''")}'`
  execFileSync('powershell.exe', [
    '-NoProfile', '-Command',
    `Expand-Archive -LiteralPath ${quote(sdkZip)} -DestinationPath ${quote(tools)} -Force`,
  ], { stdio: 'inherit', timeout: 180000 })
}

if (!(await findSdk())) throw new Error('FFmpeg SDK 解压后仍找不到 include/libavformat/avformat.h')
console.log('便携工具链已就绪；运行 npm run native:build。')
