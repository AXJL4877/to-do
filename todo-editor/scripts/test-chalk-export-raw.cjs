/** 验证花字导出走 RGBA 直推（preload + rawvideo），不再依赖每帧 PNG IPC */
const { app, BrowserWindow } = require('electron')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { prepareTextLayers, fullCompositionKey, buildBakeClip } = require('../electron/chalkTextExport.cjs')

const root = path.resolve(__dirname, '..')
const out = path.join(root, 'native/test-output/dynamic-text')
const ffmpeg = path.join(root, 'native/bin/ffmpeg.exe')
app.setPath('userData', path.join(out, 'raw-export-profile'))
app.commandLine.appendSwitch('force-device-scale-factor', '1')

function dynamicClip(id, start, duration, content, composition) {
  return {
    id, trackId: 'title', kind: 'text', start, duration, inPoint: 0, outPoint: duration, opacity: 1,
    text: {
      content, fontFamily: 'Microsoft YaHei', fontSize: 96, color: '#ffffff',
      animIn: 'none', animOut: 'none',
      fancy: {
        fontWeight: 700, fill: ['#ffffff'], fillAngle: 90, strokes: [],
        dynamic: {
          version: composition ? 2 : 1, engine: 'jizura',
          presetId: composition ? 'dynamic-full' : 'dynamic-pop',
          seed: 42, duration, motion: 0.7, accent: '#ffb454',
          ...(composition ? { composition } : {}),
        },
      },
    },
    keyframes: {},
  }
}

app.whenReady().then(async () => {
  let prepared
  try {
    const scenes = [
      { content: '加速一', start: 0, end: 0.8 },
      { content: '加速二', start: 0.8, end: 1.6 },
      { content: '加速三', start: 1.6, end: 2.4 },
    ]
    const composition = {
      style: 'noir', mood: 'graphic', background: 'transparent', unify: true, parts: {},
      fx: { decor: 0.2, chroma: 0, glitch: 0, texture: 0, bgSwitch: 0 },
      offset: 0, scenes,
    }
    const clips = [
      dynamicClip('a', 0, 0.8, '加速一', { ...composition, offset: 0 }),
      dynamicClip('b', 0.8, 0.8, '加速二', { ...composition, offset: 0.8 }),
      dynamicClip('c', 1.6, 0.8, '加速三', { ...composition, offset: 1.6 }),
      dynamicClip('solo', 3, 0.6, '弹入', null),
    ]
    assert.equal(fullCompositionKey(clips[0]), fullCompositionKey(clips[1]))
    const { bake, t0 } = buildBakeClip(clips.slice(0, 3))
    assert.equal(t0, 0)
    assert.ok(bake.duration >= 2.3)

    const seq = {
      settings: { width: 320, height: 180, fps: 12 },
      tracks: [{ id: 'title', kind: 'subtitle' }],
      clips, workIn: 0, workOut: 4,
    }
    const t0ms = Date.now()
    prepared = await prepareTextLayers(seq, { ffmpeg })
    const ms = Date.now() - t0ms
    const outClips = prepared.sequence.clips
    const a = outClips.find((c) => c.id === 'a')
    const b = outClips.find((c) => c.id === 'b')
    const c = outClips.find((c) => c.id === 'c')
    const solo = outClips.find((c) => c.id === 'solo')
    assert.equal(a.kind, 'video')
    assert.equal(a.mediaPath, b.mediaPath, 'full composition group must share one bake')
    assert.equal(b.mediaPath, c.mediaPath)
    assert.ok(a.inPoint < b.inPoint && b.inPoint < c.inPoint)
    assert.notEqual(solo.mediaPath, a.mediaPath)
    for (const clip of [a, b, c, solo]) {
      assert.ok(fs.existsSync(clip.mediaPath), clip.id)
      const probe = spawnSync(path.join(root, 'native/bin/ffprobe.exe'), [
        '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,pix_fmt', '-of', 'json', clip.mediaPath,
      ], { windowsHide: true })
      assert.equal(probe.status, 0, probe.stderr.toString())
      const stream = JSON.parse(probe.stdout.toString()).streams[0]
      assert.equal(stream.codec_name, 'qtrle')
    }
    // 320x180@12fps × ~3s 合并烘焙应远快于旧「每帧 PNG IPC」路径；给宽上限防 CI 抖动
    assert.ok(ms < 60000, `raw export too slow: ${ms}ms`)
    fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(path.join(out, 'raw-export-results.json'), JSON.stringify({ ok: true, ms, sharedBake: a.mediaPath }, null, 2))
    console.log(`PASS chalk raw export + full bake share (${ms}ms)`)
    prepared.cleanup(); prepared = null
    app.exit(0)
  } catch (e) {
    console.error(e)
    prepared?.cleanup()
    app.exit(1)
  }
})
