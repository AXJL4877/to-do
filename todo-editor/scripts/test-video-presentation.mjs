// One hidden Electron process; actual Chromium video decoding and Canvas pixels.
import { build } from 'esbuild'
import electron from 'electron'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const out = resolve(root, 'native/test-output/video-presentation')
mkdirSync(out, { recursive: true })
  const bundle = await build({ entryPoints: [resolve(root, 'tests/video-presentation.browser.ts')], bundle: true,
    write: false, format: 'iife', define: { TEST_VIDEO_URL: JSON.stringify(pathToFileURL(resolve(root, 'tests/media/intra.mp4')).href) } })
  writeFileSync(resolve(out, 'index.html'), '<!doctype html><title>Preview cache regression</title>')
  writeFileSync(resolve(out, 'bundle.js'), bundle.outputFiles[0].text)
  writeFileSync(resolve(out, 'run.cjs'), `
const {app, BrowserWindow} = require('electron');
const {readFileSync, writeFileSync} = require('node:fs');
app.setPath('userData', ${JSON.stringify(resolve(out, 'profile'))});
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.whenReady().then(async () => {
try {
  const win = new BrowserWindow({show:false, webPreferences:{backgroundThrottling:false}});
  await win.loadFile(${JSON.stringify(resolve(out, 'index.html'))});
  const result = await Promise.race([
    win.webContents.executeJavaScript(readFileSync(${JSON.stringify(resolve(out, 'bundle.js'))}, 'utf8') + '\\nwindow.videoPresentationTests'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('test timeout (60s)')), 60000)),
  ]);
  writeFileSync(${JSON.stringify(resolve(out, 'results.json'))}, JSON.stringify(result, null, 2));
  if (result.pixelFailure) {
    for (const key of ['actual', 'expected']) writeFileSync(${JSON.stringify(out)} + '/' + key + '.png', Buffer.from(result.pixelFailure[key].split(',')[1], 'base64'));
    delete result.pixelFailure.actual; delete result.pixelFailure.expected;
  }
  console.log(JSON.stringify(result, null, 2));
  app.exit(result.failed ? 1 : 0);
} catch (error) {
  console.error(error); app.exit(1);
}});
`)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [resolve(out, 'run.cjs')], { env, stdio: 'inherit', windowsHide: true })
const watchdog = setTimeout(() => { child.kill(); process.exitCode = 1 }, 75000)
child.on('exit', code => { clearTimeout(watchdog); process.exitCode = code ?? 1 })

