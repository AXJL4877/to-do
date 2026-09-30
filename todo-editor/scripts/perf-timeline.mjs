// 时间轴 / 预览性能基准：Electron 里渲染时间轴 + 节目监视器，灌入大量片段后计时缩放、滚动、拖播放头、重绘
// 用法：node scripts/perf-timeline.mjs [jobs=10] [--layout-only] [--trace]
// 先 npm run build 生成样式。隐藏窗口 RAF 会限频；交互预算看同步 commit/layout 分项。
import { build } from 'esbuild'
import electron from 'electron'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const jobs = Number(process.argv[2] || 10)
const root = fileURLToPath(new URL('../', import.meta.url))
const out = resolve(root, 'native/test-output/perf-timeline')
mkdirSync(out, { recursive: true })
const bundle = await build({ entryPoints: [resolve(root, 'tests/perf.browser.tsx')], bundle: true,
  write: false, format: 'iife', jsx: 'automatic', loader: { '.svg': 'dataurl', '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' } })
const assets = resolve(root, 'dist/assets')
const css = readdirSync(assets).filter(f => f.endsWith('.css')).map(f => readFileSync(resolve(assets, f), 'utf8')).join('\n')
writeFileSync(resolve(out, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Timeline perf</title><style>${css}</style><body style="margin:0">`)
writeFileSync(resolve(out, 'bundle.js'), bundle.outputFiles[0].text)
writeFileSync(resolve(out, 'run.cjs'), `
const {app, BrowserWindow, contentTracing} = require('electron');
const {readFileSync, writeFileSync} = require('node:fs');
app.setPath('userData', ${JSON.stringify(resolve(out, 'profile'))});
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({show:false, width:1700, height:1000, webPreferences:{backgroundThrottling:false}});
    await win.loadFile(${JSON.stringify(resolve(out, 'index.html'))}, { search: 'jobs=${jobs}&layoutOnly=${process.argv.includes('--layout-only') ? '1' : '0'}' });
    if (${process.argv.includes('--trace')}) await contentTracing.startRecording({included_categories:['devtools.timeline','blink.user_timing']});
    await win.webContents.executeJavaScript(readFileSync(${JSON.stringify(resolve(out, 'bundle.js'))}, 'utf8') + '\\nwindow.perfDone');
    if (${process.argv.includes('--trace')}) await contentTracing.stopRecording(${JSON.stringify(resolve(out, 'trace.json'))});
    const result = await win.webContents.executeJavaScript('window.perfResult');
    if (${process.argv.includes('--screenshot')}) writeFileSync(${JSON.stringify(resolve(out, 'timeline.png'))}, (await win.webContents.capturePage()).toPNG());
    console.log(JSON.stringify(result, null, 2));
    app.exit(result && !result.error ? 0 : 1);
  } catch (e) { console.error(e); app.exit(1); }
});
`)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [resolve(out, 'run.cjs')], { env, stdio: 'inherit', windowsHide: true })
const watchdog = setTimeout(() => { child.kill(); process.exitCode = 1 }, 180000)
child.on('exit', (code) => { clearTimeout(watchdog); process.exitCode = code ?? 1 })
