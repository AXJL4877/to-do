/** ffmpeg 代理转码入口：720p h264 → cache/proxies，验证文件存在 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { makeProxy } from '../electron/makeProxy.cjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const out = resolve(root, 'native/test-output')
const proxies = resolve(out, 'proxies')
mkdirSync(proxies, { recursive: true })

const ffmpeg = process.env.FFMPEG
  || resolve(process.env.LOCALAPPDATA || '', 'Microsoft/WinGet/Links/ffmpeg.exe')
if (!existsSync(ffmpeg)) throw new Error('找不到 ffmpeg')

const src = resolve(out, 'proxy_src_1080.mp4')
function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr || r.stdout}`)
}

run(ffmpeg, [
  '-y', '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=25',
  '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src,
])

const r1 = await makeProxy({ filePath: src, outDir: proxies, height: 720 })
if (!r1.ok || !r1.proxyPath || !existsSync(r1.proxyPath)) {
  throw new Error(`makeProxy 失败: ${JSON.stringify(r1)}`)
}
if (statSync(r1.proxyPath).size < 1024) throw new Error('代理文件过小')

const r2 = await makeProxy({ filePath: src, outDir: proxies, height: 720 })
if (!r2.ok || !r2.cached) throw new Error(`缓存命中失败: ${JSON.stringify(r2)}`)

const r480 = await makeProxy({ filePath: src, outDir: proxies, height: 480 })
if (!r480.ok || !existsSync(r480.proxyPath)) {
  throw new Error(`480p 代理失败: ${JSON.stringify(r480)}`)
}

const report = {
  ok: true,
  proxy720: r1.proxyPath,
  cached: r2.cached,
  proxy480: r480.proxyPath,
  size720: statSync(r1.proxyPath).size,
  at: new Date().toISOString(),
}
writeFileSync(resolve(out, 'proxy-test-report.json'), JSON.stringify(report, null, 2))
console.log('proxy:test 通过', report.proxy720)
