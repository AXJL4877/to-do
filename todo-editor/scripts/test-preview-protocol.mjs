/**
 * B2 protocol test — no Electron. Uses spike-host HWND + todo-preview-engine.exe.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const bin = resolve(root, 'native/bin')
const engine = resolve(bin, 'todo-preview-engine.exe')
const host = resolve(bin, 'spike-host.exe')

function need(p, label) {
  if (!existsSync(p)) throw new Error(`缺少 ${label}: ${p}`)
}
need(engine, 'todo-preview-engine')
need(host, 'spike-host')

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function startHost() {
  const p = spawn(host, [], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false, cwd: bin })
  return new Promise((resolveP, reject) => {
    let buf = ''
    const t = setTimeout(() => reject(new Error('spike-host hwnd timeout')), 5000)
    p.stdout.on('data', (d) => {
      buf += d.toString()
      const m = buf.match(/(\d+)/)
      if (m) {
        clearTimeout(t)
        resolveP({ proc: p, hwnd: m[1] })
      }
    })
    p.on('error', reject)
  })
}

function startEngine() {
  const p = spawn(engine, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    cwd: bin,
    env: { ...process.env, TODO_PARENT_PID: String(process.pid) },
  })
  let buf = ''
  const listeners = new Set()
  p.stdout.setEncoding('utf8')
  p.stdout.on('data', (chunk) => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '')
      buf = buf.slice(nl + 1)
      if (!line) continue
      try {
        const ev = JSON.parse(line)
        for (const fn of listeners) fn(ev)
      } catch { /* */ }
    }
  })
  p.stderr.on('data', (d) => process.stderr.write(`[engine] ${d}`))

  return {
    proc: p,
    send(obj) {
      p.stdin.write(`${JSON.stringify(obj)}\n`)
    },
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    waitEvent(pred, ms = 5000) {
      return new Promise((resolveP, reject) => {
        const t = setTimeout(() => {
          off()
          reject(new Error('waitEvent timeout'))
        }, ms)
        const off = this.onEvent((ev) => {
          if (pred(ev)) {
            clearTimeout(t)
            off()
            resolveP(ev)
          }
        })
      })
    },
  }
}

async function main() {
  const { proc: hostProc, hwnd } = await startHost()
  console.log('host hwnd=', hwnd)
  const eng = startEngine()

  // init
  eng.send({ cmd: 'init', id: 1, hwnd: Number(hwnd), fps: 30, budgetMB: 256, adapterLuid: null })
  const ready = await eng.waitEvent((e) => e.ev === 'ready')
  console.log('ready', ready.adapter, ready.luid)

  // unknown cmd
  eng.send({ cmd: 'nope', id: 2 })
  await eng.waitEvent((e) => e.ev === 'error' && e.code === 'unknown_cmd' && e.id === 2)

  // bad json
  eng.proc.stdin.write('not-json\n')
  await eng.waitEvent((e) => e.ev === 'error' && e.code === 'bad_json')

  // init twice
  eng.send({ cmd: 'init', id: 3, hwnd: Number(hwnd), fps: 30 })
  await eng.waitEvent((e) => e.ev === 'error' && e.code === 'init_twice')

  // oversize line: stream past 16MB without newline → engine rejects
  {
    const chunk = 'x'.repeat(1024 * 1024)
    eng.proc.stdin.write('{"cmd":"stats","pad":"')
    for (let i = 0; i < 17; i++) eng.proc.stdin.write(chunk)
    eng.proc.stdin.write('"}\n')
    await eng.waitEvent((e) => e.ev === 'error' && e.code === 'line_too_long', 20000)
    console.log('line_too_long ok')
  }

  // rect + visible
  eng.send({ cmd: 'rect', id: 10, x: 100, y: 100, w: 320, h: 180 })
  await eng.waitEvent((e) => e.ev === 'ack' && e.id === 10)
  eng.send({ cmd: 'visible', id: 11, on: true })
  await eng.waitEvent((e) => e.ev === 'ack' && e.id === 11)

  // 1000 seeks
  const seekN = 1000
  for (let i = 0; i < seekN; i++) {
    eng.send({ cmd: 'seek', frame: i % 300 })
  }
  await sleep(200)
  eng.send({ cmd: 'stats', id: 20 })
  const st = await eng.waitEvent((e) => e.ev === 'stats')
  const seekTotalUs = st.data?.seekTotalUs ?? Infinity
  console.log('seekTotalUs=', seekTotalUs, 'seekCount=', st.data?.seekCount)
  if (!(seekTotalUs < 5000)) {
    throw new Error(`seekTotalUs ${seekTotalUs} >= 5000`)
  }
  if ((st.data?.seekCount ?? 0) < seekN) {
    console.warn('seekCount lower than sent (ok if coalesced); got', st.data?.seekCount)
  }

  // play 30s accuracy
  eng.send({ cmd: 'seek', frame: 0 })
  await eng.waitEvent((e) => e.ev === 'playhead' && e.frame === 0)
  eng.send({ cmd: 'play' })
  const t0 = performance.now()
  await sleep(30000)
  eng.send({ cmd: 'pause' })
  const ph = await eng.waitEvent((e) => e.ev === 'playhead' && e.playing === false)
  const elapsed = (performance.now() - t0) / 1000
  const expect = Math.floor(elapsed * 30 + 1e-6)
  const err = Math.abs((ph.frame ?? 0) - expect)
  console.log('play30s frame=', ph.frame, 'expect≈', expect, 'err=', err)
  if (err >= 1) throw new Error(`playhead error ${err} >= 1 frame`)

  // stdin close → exit within 1s
  eng.proc.stdin.end()
  const exited = await new Promise((resolveP) => {
    const t = setTimeout(() => resolveP(false), 1000)
    eng.proc.on('exit', () => {
      clearTimeout(t)
      resolveP(true)
    })
  })
  if (!exited) throw new Error('engine did not exit within 1s after stdin close')
  console.log('stdin-close exit ok')

  try { hostProc.kill() } catch { /* */ }
  console.log('preview:test 通过')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
