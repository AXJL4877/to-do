/**
 * 打开 TO DO 桌面版供人工查验。
 *
 * 为什么要有这个脚本（而不是直接 npm run electron:dev）：
 *   1. 本机环境带着 ELECTRON_RUN_AS_NODE=1（打包版给子进程用的），主进程必须清掉，
 *      否则 electron.exe 只当 node 跑，永远不开窗；
 *   2. 本机 electron.exe 不加 --no-sandbox 会在建窗前以 0x80000003 静默退出；
 *   3. main.cjs 里 `isDev = !app.isPackaged`，非打包运行一定要有 Vite 在服务 src/，
 *      所以这里自己起 Vite（端口让系统分配，和 dev-electron.mjs 同一套）。
 *
 * 用法: node scripts/open-todo-app.mjs [--no-sandbox|--disable-gpu|--probe] [-- <更多 electron 参数>]
 *   --probe   启动 20 秒后报告存活情况并退出（排查启动问题）
 */
import electronFromPackage from 'electron'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
const probe = argv.includes('--probe')
const disableGpu = argv.includes('--disable-gpu')
const sandboxFlag = !argv.includes('--no-sandbox-off')
const extra = argv.filter((a) => !['--probe', '--disable-gpu', '--no-sandbox-off', '--no-outside-python'].includes(a) && !a.startsWith('--debug-port'))

/**
 * 调试端口：Chromium 开关必须放在 app 路径【之前】，放后面会被 electron 当成应用参数丢掉。
 * 用法: node scripts/open-todo-app.mjs --debug-port 9222
 * 开了之后就能用 DevTools 协议直读渲染进程实时状态（http://127.0.0.1:9222/json/list）。
 */
const debugPortIdx = argv.indexOf('--debug-port')
const debugPort = debugPortIdx >= 0 ? Number(argv[debugPortIdx + 1] || 0) : Number(process.env.TODO_DEBUG_PORT || 0)
const chromiumFlags = debugPort ? [`--remote-debugging-port=${debugPort}`, '--remote-allow-origins=*'] : []

/**
 * 用哪个 electron 跑：必须是【工作区之外】的那一份。
 *
 * 为什么：受限环境下，「二进制住在工作区里」的进程只能写工作区内的路径。
 * repo 里的 node_modules/electron/dist/electron.exe 正住在工作区里，用它启动 APP，
 * APP 就写不了用户的工程文件（D:\Desktop\...）——表现为「保存失败」一直弹，
 * 因为成片轮询每 2 秒会 flushProject 一次。
 * 把同一份运行时复制到工作区外再启动，APP 就有正常的文件访问能力。
 */
function resolveElectron() {
  const fromEnv = String(process.env.TODO_ELECTRON || '').trim()
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  const outside = process.env.TODO_ELECTRON_DIR || 'C:\\todo-electron-runtime'
  const outsideExe = path.join(outside, 'electron.exe')
  const inRepo = electronFromPackage
  if (path.resolve(inRepo).startsWith(path.resolve(root))) {
    // 包里带来的那份在工作区内 → 复制到工作区外
    if (!existsSync(outsideExe)) {
      try {
        console.log(`[open-todo-app] 把 electron 运行时复制到工作区外：${outside}（只为拿到文件访问能力）`)
        cpSync(path.dirname(inRepo), outside, { recursive: true })
      } catch (e) {
        console.warn(`[open-todo-app] 复制失败，仍用工作区内那份（APP 可能存不了工作区外的工程）：${e.message}`)
        return inRepo
      }
    }
    return existsSync(outsideExe) ? outsideExe : inRepo
  }
  return inRepo
}
const electron = resolveElectron()

function allocatePort() {
  return new Promise((resolve, reject) => {
    const probeSrv = net.createServer()
    probeSrv.once('error', reject)
    probeSrv.listen(0, '127.0.0.1', () => {
      const addr = probeSrv.address()
      probeSrv.close((err) => err ? reject(err) : resolve(addr && typeof addr === 'object' ? addr.port : 0))
    })
  })
}

const port = await allocatePort()
const vite = await createServer({ root, server: { host: '127.0.0.1', port, strictPort: true } })
await vite.listen()
const addr = vite.httpServer?.address()
const url = `http://127.0.0.1:${addr && typeof addr === 'object' ? addr.port : port}`
console.log(`Vite 就绪 ${url}`)

const env = { ...process.env, VITE_DEV_SERVER_URL: url }
delete env.ELECTRON_RUN_AS_NODE

/**
 * Python 同理：包内 runtime/python 也在工作区里，被限制只能写工作区。
 * 从 APP 里跑扩展管线时，工作目录在用户的工程目录下（工作区之外），
 * 所以这里（按需）把同一份运行时放到工作区外，并用 TODO_PYTHON 指过去。
 * APP 本身仍然自带 Python（自足），这只是在受限环境下的等价入口。
 */
function resolveOutsidePython() {
  const explicit = String(process.env.TODO_PYTHON || '').trim()
  if (explicit && existsSync(explicit)) return { exe: explicit, staged: false }
  const inRepo = path.join(root, 'runtime', 'python', 'python.exe')
  if (!existsSync(inRepo)) return { exe: '', staged: false }
  const outsideDir = process.env.TODO_PYTHON_DIR || 'C:\\todo-python-runtime'
  const outside = path.join(outsideDir, 'python.exe')
  if (existsSync(outside)) return { exe: outside, staged: true }
  try {
    console.log(`[open-todo-app] 把 Python 运行时复制到工作区外：${outsideDir}`)
    cpSync(path.join(root, 'runtime', 'python'), outsideDir, { recursive: true })
    return { exe: existsSync(outside) ? outside : '', staged: true }
  } catch (e) {
    console.warn(`[open-todo-app] 复制 Python 失败：${e.message}`)
    return { exe: '', staged: false }
  }
}
if (!argv.includes('--no-outside-python')) {
  const py = resolveOutsidePython()
  if (py.exe) {
    env.TODO_PYTHON = py.exe
    console.log(`[open-todo-app] TODO_PYTHON=${py.exe}${py.staged ? '（工作区外副本）' : ''}`)
  }
}

/**
 * ffmpeg / ffprobe 同理，而且更隐蔽。
 *
 * server/animBuild.resolveFfmpeg() 的顺序是：FFMPEG → TODO_NATIVE_BIN → **工作区里的
 * native/bin/ffmpeg.exe** → WinGet。受限环境下工作区里那份只能写工作区，而包内管线
 * （扩展把成片/中间产物写到用户的 AppData 或工程目录）在工作区外，ffmpeg 一启动就写不出文件，
 * Python 侧只看到 `BrokenPipeError: [Errno 32] Broken pipe` —— **完全看不出是 ffmpeg 的问题**。
 * 这个坑扩展自己的 workflow/TOOLS.md 里就记着。
 *
 * 所以这里把同一份 ffmpeg 复制到工作区外，并用 FFMPEG/FFPROBE 指过去。
 * 一并复制同目录的 DLL（native/bin 那份是共享库构建，缺 DLL 起不来）。
 */
function resolveOutsideFfmpeg() {
  const explicit = String(process.env.TODO_FFMPEG_DIR || '').trim()
  const inRepo = path.join(root, 'native', 'bin')
  if (!existsSync(path.join(inRepo, 'ffmpeg.exe'))) return null
  const outsideDir = explicit || 'C:\\todo-ffmpeg-runtime'
  const outside = path.join(outsideDir, 'ffmpeg.exe')
  if (existsSync(outside)) return { dir: outsideDir, staged: true }
  try {
    console.log(`[open-todo-app] 把 ffmpeg/ffprobe 复制到工作区外：${outsideDir}`)
    mkdirSync(outsideDir, { recursive: true })
    // 只搬 ffmpeg/ffprobe 与它们依赖的同目录 DLL：native/bin 里还有宿主自己的原生引擎，
    // 那些不需要外部副本，搬过去只会让人以为它们也在这里生效。
    for (const f of readdirSync(inRepo)) {
      if (/^ff(mpeg|probe)(-hw)?\.exe$/i.test(f) || /\.dll$/i.test(f)) {
        cpSync(path.join(inRepo, f), path.join(outsideDir, f))
      }
    }
    return existsSync(outside) ? { dir: outsideDir, staged: true } : null
  } catch (e) {
    console.warn(`[open-todo-app] 复制 ffmpeg 失败：${e.message}`)
    return null
  }
}
if (!argv.includes('--no-outside-ffmpeg')) {
  const ff = resolveOutsideFfmpeg()
  if (ff) {
    env.FFMPEG = path.join(ff.dir, 'ffmpeg.exe')
    env.FFPROBE = path.join(ff.dir, 'ffprobe.exe')
    console.log(`[open-todo-app] FFMPEG=${env.FFMPEG}${ff.staged ? '（工作区外副本）' : ''}`)
  }
}

const args = [...chromiumFlags, ...(sandboxFlag ? ['--no-sandbox'] : []), ...(disableGpu ? ['--disable-gpu'] : []), '.', ...extra]
const logs = path.join(process.env.APPDATA || '', 'todo-editor', 'logs')
mkdirSync(logs, { recursive: true })
const crash = path.join(logs, 'crash.log')
const before = existsSync(crash) ? readFileSync(crash, 'utf8').length : 0
const logFile = path.join(logs, 'open-app.log')
appendFileSync(logFile, `\n=== ${new Date().toISOString()} ${url} args=${args.join(' ')} ===\n`)

const child = spawn(electron, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false })
let out = ''
const keep = (d) => { const s = String(d); out = (out + s).slice(-8000); appendFileSync(logFile, s) }
child.stdout.on('data', keep)
child.stderr.on('data', keep)
console.log(`Electron pid=${child.pid}  日志 ${logFile}`)

async function shutdown(code) {
  try { child.kill() } catch { /* */ }
  try { await vite.close() } catch { /* */ }
  process.exit(code ?? 0)
}

if (probe) {
  setTimeout(async () => {
    const alive = child.exitCode == null
    console.log('20 秒后仍存活:', alive, 'exitCode=', child.exitCode)
    console.log('--- 输出尾部 ---\n' + out.slice(-1500))
    const now = existsSync(crash) ? readFileSync(crash, 'utf8') : ''
    if (now.length > before) console.log('--- 新增 crash.log ---\n' + now.slice(before))
    await shutdown(alive ? 0 : 1)
  }, 20000)
}
child.on('exit', (code) => { if (!probe) void shutdown(code ?? 0) })
