const { app, BrowserWindow } = require('electron')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { PNG } = require('pngjs')
const { prepareTextLayers } = require('../electron/chalkTextExport.cjs')
const { exportSequence } = require('../electron/exportSequence.cjs')
const root = path.resolve(__dirname, '..')
const out = path.join(root, 'native/test-output/dynamic-text')
app.setPath('userData', path.join(out, 'export-profile'))
app.commandLine.appendSwitch('force-device-scale-factor', '1')
const ffmpeg = path.join(root, 'native/bin/ffmpeg.exe')
function pixels(file, time) {
  const r = spawnSync(ffmpeg, ['-v', 'error', '-ss', String(time), '-i', file, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'], { windowsHide: true, maxBuffer: 16e6 })
  assert.equal(r.status, 0, r.stderr.toString())
  return PNG.sync.read(r.stdout).data
}
function visible(d) { let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n }
app.whenReady().then(async () => {
  let win, prepared
  try {
    const fixtures = JSON.parse(fs.readFileSync(path.join(out, 'export-fixtures.json'), 'utf8'))
    assert.equal(fixtures.length, 6)
    win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
    await win.loadFile(path.join(root, 'dist/chalk-render.html'))
    await win.webContents.executeJavaScript('window.loadTextFonts(["Microsoft YaHei"])')
    const fullFixtures = JSON.parse(fs.readFileSync(path.join(out, 'full-export-fixtures.json'), 'utf8'))
    for (const f of [...fixtures, ...fullFixtures]) {
      const png = await win.webContents.executeJavaScript(`window.renderChalkFrame(...${JSON.stringify([f.text, {}, f.duration, f.w, f.h, f.time])})`)
      const actual = PNG.sync.read(Buffer.from(png, 'base64')).data
      const expected = PNG.sync.read(Buffer.from(f.png, 'base64')).data
      if (!actual.equals(expected)) { fs.writeFileSync(path.join(out,'mismatch-actual.png'),Buffer.from(png,'base64')); fs.writeFileSync(path.join(out,'mismatch-expected.png'),Buffer.from(f.png,'base64')); console.log('mismatch',f.text.fancy.dynamic.presetId,f.time,f.text.fancy.dynamic.composition?.background, actual.reduce((n,v,i)=>n+(v!==expected[i]),0)); }
      assert.ok(actual.equals(expected), `preview/export pixel mismatch: ${f.text.fancy.dynamic.presetId}`)
    }
    console.log('PASS legacy and full composition: built hidden renderer matches preview pixels exactly')
    const seq = { settings: { width: 640, height: 360, fps: 12 }, tracks: [{ id: 'title', kind: 'subtitle' }],
      clips: fixtures.map((f, i) => ({ id: `d${i}`, trackId: 'title', kind: 'text', start: i * 1.5, duration: 1.5,
        inPoint: 0, outPoint: 1.5, opacity: 1, text: f.text, keyframes: {} })), workIn: 0, workOut: 9 }
    prepared = await prepareTextLayers(seq, { ffmpeg })
    for (let i = 0; i < 6; i++) {
      const clip = prepared.sequence.clips[i]
      assert.equal(clip.kind, 'video', 'dynamic text must use animated export')
      const d = pixels(clip.mediaPath, 0.75)
      const expected = PNG.sync.read(Buffer.from(fixtures[i].png, 'base64')).data
      assert.ok(d.equals(expected), `encoded alpha MOV differs: ${fixtures[i].text.fancy.dynamic.presetId}`)
      assert.ok(visible(d) > 100 && d[3] === 0, 'alpha export blank or opaque')
    }
    console.log('PASS all six presets: lossless animated MOV with transparent alpha')
    const result = await exportSequence(seq, path.join(out, 'dynamic-acceptance.mp4'), { nativeBin: path.join(root, 'native/bin'), preferJs: true })
    assert.ok(result.ok, result.error)
    for (let i = 0; i < 6; i++) {
      const d = pixels(result.path, i * 1.5 + 0.75)
      let light = 0; for (let k = 0; k < d.length; k += 4) if (d[k] > 100 || d[k + 1] > 100 || d[k + 2] > 100) light++
      assert.ok(light > 100, `final composition lost preset ${i}`)
    }
    console.log('PASS final 9-second MP4: all six dynamic titles visible')
    const productionSequence = path.join(root, 'native/test-output/dynamic-production/sequence.json')
    if (fs.existsSync(productionSequence)) {
      const narrated = JSON.parse(fs.readFileSync(productionSequence, 'utf8'))
      const movie = await exportSequence(narrated, path.join(root, 'native/test-output/dynamic-production/narrated-acceptance.mp4'), { nativeBin: path.join(root, 'native/bin') })
      assert.ok(movie.ok, movie.error)
      const probe = spawnSync(path.join(root, 'native/bin/ffprobe.exe'), ['-v', 'error', '-show_streams', '-of', 'json', movie.path])
      const streams = JSON.parse(probe.stdout.toString()).streams
      assert.ok(streams.some(s => s.codec_type === 'audio'), 'narrated video lost voice')
      assert.ok(streams.some(s => s.codec_type === 'video'), 'narrated video lost picture')
      for (const c of narrated.clips.filter(c => c.text?.fancy?.dynamic)) {
        const d = pixels(movie.path, c.start + c.duration * 0.6)
        let light = 0; for (let k = 0; k < d.length; k += 4) if (d[k] > 100 || d[k + 1] > 100 || d[k + 2] > 100) light++
        assert.ok(light > 20, `narrated scene blank: ${c.text.content}`)
      }
      console.log('PASS narrated production MP4: audio stream and every timed text scene present')
    }
    fs.writeFileSync(path.join(out, 'export-results.json'), JSON.stringify({ ok: true, presets: 6, exactPixels: true, result }, null, 2))
    prepared.cleanup(); prepared = null; win.destroy(); win = null; app.exit(0)
  } catch (e) { console.error(e); prepared?.cleanup(); win?.destroy(); app.exit(1) }
})
