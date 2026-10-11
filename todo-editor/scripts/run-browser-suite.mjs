/**
 * 复用仓库自带 Electron runner，但补上本机必需的两个参数。
 *
 * 背景：仓库里的 test-*.mjs 直接 spawn(electron, [run.cjs])，没带 --no-sandbox / --disable-gpu；
 * 在本机环境下 Electron 会在建窗之前以 0x80000003 退出且不打印任何东西（看起来"测试没输出"）。
 * 用法: node scripts/run-browser-suite.mjs <runner.cjs 路径>
 */
import electron from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const runner = resolve(process.argv[2] || '')
if (!existsSync(runner)) {
  console.error('missing runner:', runner)
  process.exit(1)
}
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, ['--no-sandbox', '--disable-gpu', runner], {
  env, stdio: 'inherit', windowsHide: true,
})
const watchdog = setTimeout(() => { child.kill(); process.exitCode = 1 }, Number(process.env.RUN_TIMEOUT_MS) || 240000)
child.on('exit', (code) => { clearTimeout(watchdog); process.exitCode = code ?? 1 })
