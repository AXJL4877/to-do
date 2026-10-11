/**
 * 海绵宝宝口播 · 预览黑屏回归门（离线、可重复）
 *
 * 守的是这条因果链（曾经导致扩展入轨后预览整段黑屏）：
 *   满幅 H.264 近黑转场 → 素材必须带 chromaKey=nearblack
 *   → 丢了标记就被当成不透明黑层盖满画面 → 预览黑屏。
 *
 * 步骤：
 *   1. 用 ffmpeg 合成最小素材（亮底板 PNG + 近黑满幅转场 MP4）
 *   2. 合成一份成片文档（底板 cut + 转场 play/nearblack），用宿主 store 真入轨
 *   3. 三态取样：新导入 / 抹掉 chromaKey（老工程）/ 再对账（修复）
 *   4. 断言：新导入与修复后必须亮，抹掉时必须黑（证明门真的能抓到）
 *
 * 用法: node scripts/test-spongebob-preview-black.mjs
 */
import { build } from 'esbuild'
import electron from 'electron'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const out = resolve(root, 'native/test-output/spongebob-preview-black')
// 素材按宿主约定放在 <base>/ai-generated/ 下
const mediaBase = join(out, 'media')
const media = join(mediaBase, 'ai-generated')
mkdirSync(media, { recursive: true })

function ffmpeg(args) {
  const r = spawnSync(process.env.FFMPEG || 'ffmpeg', args, { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`ffmpeg 失败: ${(r.stderr || '').trim().slice(-300)}`)
}

// 1. 最小素材：亮底板 + 近黑满幅转场（中间留一小块白，模拟泡泡）+ 静音配音
ffmpeg(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x2f6fb0:s=320x180:d=1', '-frames:v', '1', join(media, 'plate.png')])
ffmpeg([
  '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=1',
  '-vf', 'drawbox=x=140:y=80:w=40:h=20:color=white@1.0:t=fill,format=yuv420p',
  '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', join(media, 'wipe.mp4'),
])
ffmpeg(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '8', join(media, 'voice.wav')])

// 2. 用扩展自己的编码函数产出「入场片 / 满幅转场」，把解码契约一起锁住
const pack = resolve(root, 'examples/extensions/spongebob-koubo')
const fixtureScript = resolve(root, 'native/test-output/make_preview_fixtures.py')
const py = spawnSync(process.env.PYTHON || 'python', [fixtureScript, media], {
  env: { ...process.env, KOUBO_PACK: pack }, encoding: 'utf8',
})
if (py.status !== 0) {
  console.error('扩展编码夹具失败:', (py.stdout || '') + (py.stderr || ''))
  process.exit(1)
}
for (const f of ['sprite.webm', 'sprite_src.png', 'wipe.webm', 'wipe_sfx.wav']) {
  if (!existsSync(join(media, f))) {
    console.error('缺少扩展编码产物', f, py.stdout)
    process.exit(1)
  }
}

const prod = {
  spec: 'todo-production/1',
  id: 'p_preview_black_gate',
  skillId: 'studio.spongebob-koubo',
  title: '预览黑屏门',
  titleLocked: false,
  createdAt: 0,
  rev: 1,
  updatedAt: 0,
  script: '预览黑屏门。',
  cast: [],
  outline: null,
  status: null,
  lock: null,
  queuedJobId: null,
  runningJobId: null,
  params: { size: '1920x1080', hand: 'none', subtitles: 'off', plate: 'none', tail: 0, fps: '30' },
  plate: null,
  hand: null,
  sourceLayers: { available: true, bound: true, boards: 1, elements: 2, note: 'gate' },
  segments: [{
    id: 'g1',
    title: '门',
    text: '预览黑屏门。',
    voice: {
      hash: 'vh1', audio: 'voice.wav', audioUrl: '/ai-generated/voice.wav', timing: 't.json',
      duration: 8, speaker: null, phrases: [{ text: '预览黑屏门。', start: 0, end: 8, sentence: 0 }],
    },
    plan: { hash: 'ph1', voiceHash: 'vh1', source: 'user', notes: '' },
    subtitles: { hash: 'sh1', params: {}, cues: [] },
    dirty: { voice: false, plan: false, subtitles: false },
    boards: [
      {
        // 板 A：危险路径——满幅 H.264 近黑转场，全靠素材带 chromaKey
        id: 'b1',
        start: 0,
        dirty: false,
        elements: [],
        render: {
          hash: 'rh1',
          result: {
            fps: 30, width: 1920, height: 1080, startMs: 0, endMs: 3000, layout: 'source-layers',
            elements: [
              {
                id: 'e_plate', label: '底板', role: 'plate', video: '/ai-generated/plate.png',
                hold: '/ai-generated/plate.png', crop: [0, 0, 1920, 1080],
                startMs: 0, durationMs: 3000, frames: 8, enter: 'cut', tip: [],
              },
              {
                id: 'e_nearblack', label: '近黑转场', role: 'accent', video: '/ai-generated/wipe.mp4',
                hold: '/ai-generated/plate.png', crop: [0, 0, 1920, 1080],
                startMs: 0, durationMs: 2000, frames: 30, enter: 'play', chromaKey: 'nearblack', tip: [],
              },
            ],
          },
        },
      },
      {
        // 板 B：扩展自己编码的入场片（fade）+ 满幅转场（play，真 alpha）
        id: 'b2',
        start: 0,
        dirty: false,
        elements: [],
        render: {
          hash: 'rh2',
          result: {
            fps: 30, width: 1920, height: 1080, startMs: 3000, endMs: 8000, layout: 'source-layers',
            elements: [
              {
                id: 'e_plate2', label: '底板', role: 'plate', video: '/ai-generated/plate.png',
                hold: '/ai-generated/plate.png', crop: [0, 0, 1920, 1080],
                startMs: 3000, durationMs: 5000, frames: 8, enter: 'cut', tip: [],
              },
              {
                id: 'e_sprite', label: '角色', role: 'hero', video: '/ai-generated/sprite.webm',
                hold: '/ai-generated/sprite_src.png', crop: [860, 420, 200, 200],
                startMs: 3000, durationMs: 5000, frames: 8, enter: 'fade', tip: [],
              },
              {
                id: 'e_wipe_vp9', label: '泡泡转场', role: 'accent', video: '/ai-generated/wipe.webm',
                hold: '/ai-generated/wipe_hold.png', crop: [0, 0, 1920, 1080],
                startMs: 5000, durationMs: 1000, frames: 30, enter: 'play',
                sfx: '/ai-generated/wipe_sfx.wav', tip: [],
              },
            ],
          },
        },
      },
    ],
  }],
}

const bundle = await build({
  entryPoints: [resolve(root, 'tests/koubo-preview-black.browser.ts')],
  bundle: true,
  write: false,
  format: 'iife',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
})
writeFileSync(join(out, 'bundle.js'), bundle.outputFiles[0].text)

const b64 = Buffer.from(JSON.stringify(prod), 'utf8').toString('base64')

writeFileSync(join(out, 'run.cjs'), `
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const out = ${JSON.stringify(out)}
const mediaRoot = ${JSON.stringify(media.replace(/\\\\/g, '/'))}
app.setPath('userData', path.join(out, 'profile'))
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 640, height: 400,
    webPreferences: { backgroundThrottling: false, webSecurity: false, offscreen: false },
  })
  await win.loadFile(path.join(out, 'index.html'))
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    console.log('[renderer]', level, message, sourceId ? sourceId + ':' + line : '')
  })
  await win.webContents.executeJavaScript(\`
    window.todoDesktop = {
      isDesktop: true, platform: 'win32',
      getAiBaseUrl: () => ${JSON.stringify(mediaBase.replace(/\\/g, '/'))},
      aiBaseUrl: () => ${JSON.stringify(mediaBase.replace(/\\/g, '/'))},
      getPaths: async () => ({ root: ${JSON.stringify(mediaBase.replace(/\\/g, '/'))}, projects: '', cache: '', exports: '' }),
    };
    window.kouboPreviewGateFixture = JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0))
    ));
  \`)
  await win.webContents.executeJavaScript(readFileSync(path.join(out, 'bundle.js'), 'utf8'))
  const result = await win.webContents.executeJavaScript(\`
    (async () => {
      for (let i = 0; i < 300; i++) {
        if (window.kouboPreviewGateResult) return window.kouboPreviewGateResult
        await new Promise(r => setTimeout(r, 100))
      }
      return { failed: true, results: [{ name: 'timeout', ok: false, error: 'kouboPreviewGateResult missing' }] }
    })()
  \`)
  for (const k of ['entrance', 'vp9WipeFrame', 'fresh', 'broken', 'repaired']) {
    const f = result[k]
    if (!f || !f.dataUrl) continue
    writeFileSync(path.join(out, 'frame_' + k + '.png'), Buffer.from(f.dataUrl.slice(f.dataUrl.indexOf(',') + 1), 'base64'))
    delete f.dataUrl
  }
  writeFileSync(path.join(out, 'preview-black.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
  app.exit(result.failed ? 1 : 0)
})
`)

writeFileSync(join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Koubo Preview Black Gate</title>
<style>html,body{margin:0;background:#111;color:#eee;font:13px/1.4 sans-serif}</style><div id="meta"></div>`)

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, ['--no-sandbox', '--disable-gpu', join(out, 'run.cjs')], {
  env, stdio: 'inherit', windowsHide: true,
})
const watchdog = setTimeout(() => { child.kill(); process.exitCode = 1 }, 180000)
child.on('exit', (code) => {
  clearTimeout(watchdog)
  // Electron 偶发非 0 退出不影响结论：以报告里的 failed 为准
  const report = join(out, 'preview-black.json')
  try {
    const r = JSON.parse(readFileSync(report, 'utf8'))
    process.exitCode = r.failed ? 1 : 0
  } catch {
    process.exitCode = code ?? 1
  }
})
