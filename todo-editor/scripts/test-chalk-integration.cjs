const { app, BrowserWindow } = require('electron')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { PNG } = require('pngjs')
const { prepareTextLayers } = require('../electron/chalkTextExport.cjs')
const { exportSequence } = require('../electron/exportSequence.cjs')
const root = path.resolve(__dirname, '..')
const out = path.join(root, 'native/test-output/chalk-integration')
fs.mkdirSync(out, { recursive: true })
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.setPath('userData', path.join(out, 'profile'))
const delay = ms => new Promise(r => setTimeout(r, ms))
const ffmpeg = path.join(root, 'native/bin/ffmpeg.exe')
function pixels(file, time) {
  const result = spawnSync(ffmpeg, ['-v', 'error', '-ss', String(time), '-i', file, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'], { windowsHide: true, maxBuffer: 8e6 })
  assert.equal(result.status, 0, result.stderr.toString())
  return PNG.sync.read(result.stdout).data
}
function sum(data, channel) { let n = 0; for (let i = channel; i < data.length; i += 4) n += data[i]; return n }
app.whenReady().then(async () => {
  let win, prepared
  try {
    win = new BrowserWindow({ show: false, width: 1440, height: 960, webPreferences: { backgroundThrottling: false, offscreen: true } })
    await win.loadURL('http://127.0.0.1:5173')
    for (let i = 0; i < 100 && !await win.webContents.executeJavaScript('!!window.__TODO__'); i++) await delay(100)
    await win.webContents.executeJavaScript(`localStorage.clear(); window.__TODO__.getState().setLibraryTab('text')`)
    await delay(300)
    const ui = await win.webContents.executeJavaScript(`(async () => {
      const wait = () => new Promise(r => setTimeout(r, 180));
      const get = id => document.querySelector('[data-testid="' + id + '"]');
      const click = id => { const el = get(id); if (!el) throw new Error('Missing UI control: ' + id); el.click() };
      const check = (v, m) => { if (!v) throw new Error(m) };
      window.__TODO__.setState({ selectedClipIds: [] }); await wait();
      click('fancy-cat-chalk'); await wait();
      const draft = get('fancy-content');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(draft, '今天也要认真生活');
      draft.dispatchEvent(new Event('input', { bubbles: true })); await wait();
      click('preview-focus'); await wait(); click('preview-focus'); await wait();
      check(get('fancy-content').value === '今天也要认真生活', 'preview focus lost unsaved chalk draft');
      check(get('fancy-text-panel'), 'flower text module missing');
      check(!get('fancy-preset-variety'), 'old presets remain');
      click('fancy-preset-chalk-blue'); await wait();
      click('fancy-add'); await wait();
      let s = window.__TODO__.getState(); let c = s.seq().clips.find(c => s.selectedClipIds.includes(c.id));
      check(c.text.fancy.chalk && c.text.fancy.fill[0] === '#8ad4ef', 'chalk title not added');
      const input = get('inspector-x').querySelector('input[type=number]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '0.25');
      input.dispatchEvent(new Event('input', { bubbles: true })); await wait();
      s = window.__TODO__.getState(); c = s.seq().clips.find(c => s.selectedClipIds.includes(c.id));
      check(c.transform.x === 0.25, 'inspector failed to update selected clip');
      s.undo(); await wait();
      s = window.__TODO__.getState(); c = s.seq().clips.find(c => s.selectedClipIds.includes(c.id));
      check(c && c.transform.x === 0, 'undo did not restore transform');
      click('monitor-view-program'); await wait();
      check(window.__TODO__.getState().monitorView === 'program', 'direct view switch failed');
      click('preview-focus'); await wait();
      check(!get('inspector-panel')?.offsetParent && !get('dock-left')?.offsetParent, 'focus mode still obstructed');
      click('preview-focus'); await wait();
      check(get('inspector-panel') && get('dock-left'), 'focus mode lost layout');
      document.querySelector('[aria-label="收起属性栏"]').click(); await wait(); check(!get('inspector-panel'), 'collapse failed');
      click('inspector-toggle'); await wait();
      window.__TODO__.getState().setPlayhead(c.start + 2.5); await wait();
      return { width: document.documentElement.scrollWidth, viewport: innerWidth, text: c.text.content };
    })()`)
    assert.ok(ui.width <= ui.viewport, 'workspace overflows horizontally')
    fs.writeFileSync(path.join(out, 'workspace.png'), (await win.webContents.capturePage()).toPNG())
    win.setSize(1024, 768); await delay(350)
    const narrow = await win.webContents.executeJavaScript(`({ width: document.documentElement.scrollWidth, viewport: innerWidth, center: document.querySelector('[data-testid="monitor-area"]').getBoundingClientRect().width })`)
    assert.ok(narrow.width <= narrow.viewport && narrow.center > 300, 'narrow layout squeezes preview')
    fs.writeFileSync(path.join(out, 'workspace-narrow.png'), (await win.webContents.capturePage()).toPNG())
    console.log('PASS UI: draft retention, add chalk, edit property, undo, view tabs, focus/restore, collapse, narrow layout')
    const sequence = { settings: { width: 640, height: 360, fps: 12 }, tracks: [{ id: 'title', kind: 'subtitle' }], clips: [
      { id: 'title', trackId: 'title', kind: 'text', start: 0, duration: 1.5, inPoint: 0, opacity: 1,
        text: { content: '粉笔', fontFamily: 'KaiTi', fontSize: 240, align: 'center', lineHeight: 1.25, letterSpacing: 0,
          animIn: 'none', animOut: 'none', fancy: { fontWeight: 400, fill: ['#ffffff'], fillAngle: 90, strokes: [], chalk: { duration: 1, grain: 0.55, hand: false } } } },
    ], workIn: 0, workOut: 1.5 }
    prepared = await prepareTextLayers(sequence, { ffmpeg })
    const video = prepared.sequence.clips[0].mediaPath
    assert.equal(sum(pixels(video, 0), 3), 0, 'first frame should be transparent')
    const partial = sum(pixels(video, 0.5), 3), full = sum(pixels(video, 1.25), 3)
    assert.ok(partial > 0 && full > partial * 1.3, 'export writing did not progress')
    const fullPixels = pixels(video, 1.25)
    assert.equal(fullPixels[3], 0, 'export background is not transparent')
    const result = await exportSequence(sequence, path.join(out, 'chalk-export.mp4'), { nativeBin: path.join(root, 'native/bin') })
    assert.ok(result.ok, result.error)
    assert.ok(sum(pixels(result.path, 1.25), 0) > sum(pixels(result.path, 0), 0) + 10000, 'final composition lost chalk')
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ ui, export: result, partial, full }, null, 2))
    console.log('PASS export: transparent animation, progressive writing, final MP4 composition')
    prepared.cleanup(); prepared = null; win.destroy(); win = null; app.exit(0)
  } catch (e) { console.error(e); prepared?.cleanup(); prepared = null; win?.destroy(); win = null; app.exit(1) }
  finally { prepared?.cleanup(); win?.destroy() }
})
