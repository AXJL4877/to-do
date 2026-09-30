import * as preview from '../src/lib/previewCache'
import * as video from '../src/lib/videoCache'
import * as disk from '../src/lib/previewDiskCache'
import { defaultTransform, defaultColor, defaultAudio } from '../src/types'
import { renderProgramFrame } from '../src/lib/monitorDraw'

declare const TEST_VIDEO_URL: string
const videos: HTMLVideoElement[] = []
const create = document.createElement.bind(document)
document.createElement = ((tag: string, options?: ElementCreationOptions) => {
  const el = create(tag, options)
  if (tag === 'video') videos.push(el as HTMLVideoElement)
  return el
}) as typeof document.createElement
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
function check(ok: unknown, message: string) { if (!ok) throw new Error(message) }
async function until(fn: () => boolean, message: string) {
  const end = performance.now() + 5000
  while (!fn() && performance.now() < end) await sleep(20)
  check(fn(), message)
}
const media: any[] = [{ id: 'm', kind: 'video', url: TEST_VIDEO_URL, duration: 10, width: 1920, height: 1080 }]
const clip = (id: string, x: number) => ({ id, mediaId: 'm', trackId: id, start: 0, duration: 5,
  inPoint: 0, outPoint: 5, speed: 1, enabled: true, reverse: false, name: id,
  transform: { ...defaultTransform(), scaleX: 0.45, scaleY: 0.45, x }, color: defaultColor(),
  audio: defaultAudio(), effects: [], keyframes: {}, blend: 'normal' })
const seq: any = { id: 's', clips: [clip('a', -0.5), clip('b', 0.5)], tracks: [
  { id: 'a', kind: 'video' }, { id: 'b', kind: 'video' }] }
const settings: any = { width: 320, height: 180, fps: 30, canvasBg: 'color', canvasColor: '#000000' }
const images = new Map()
const dest = create('canvas')
const cache = preview.createPreviewCache()
const present = (f: number, options = {}) => preview.presentCachedProgramFrame(cache, f, 30, dest,
  seq, media, settings, images, 320, 180, 320, options)
const results: any[] = []
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); results.push({ name, ok: true }) }
  catch (error) { results.push({ name, ok: false, error: String(error) }) }
  finally { preview.cancelPrefetchProgramFrames() }
}

;(window as any).previewTests = (async () => {
  await test('pending multi-layer video must not enter RAM cache', () => {
    present(30)
    check(!cache.frames.has(30), 'unready video was cached')
  })
  await until(() => videos.every(v => !v.seeking && v.readyState >= 2), 'initial videos did not load')
  await test('paused seek cannot reuse a neighboring frame as the requested frame', () => {
    present(30)
    present(31)
    check(!cache.frames.has(31), 'previous frame cached under next frame number')
  })
  await until(() => videos.every(v => !v.seeking && v.readyState >= 2), 'seek did not settle')
  await test('prefetch must not move foreground decoder slots', async () => {
    present(30)
    await until(() => videos.every(v => !v.seeking), 'foreground seek')
    present(30)
    const foreground = videos.slice()
    const before = foreground.map(v => v.currentTime)
    preview.autoCacheProgramFrames({ cache, fromFrame: 90, fps: 30, seq, media, settings, imgCache: images, maxEdge: 320 })
    await sleep(200)
    check(foreground.every((v, i) => v.currentTime === before[i]), 'prefetch changed foreground media time')
  })
  await test('cache hit pauses foreground decoding', async () => {
    video.setVideoSeekQuiet(true)
    present(60)
    await until(() => videos.every(v => !v.seeking), 'play seek')
    present(60)
    await sleep(60)
    const sheet = create('canvas'); sheet.width = 320; sheet.height = 180
    preview.putCachedFrame(cache, 80, sheet)
    present(80, { playing: true })
    check(videos.every(v => v.paused), 'HTMLVideo keeps decoding during cached replay')
    video.setVideoSeekQuiet(false)
  })
  await test('freeze edit invalidates cached content', () => {
    const a = preview.previewFingerprint(seq, settings, 320, 180)
    const changed = { ...seq, clips: seq.clips.map((c: any) => ({ ...c, freeze: 2 })) }
    check(a !== preview.previewFingerprint(changed, settings, 320, 180), 'freeze ignored by fingerprint')
  })
  await test('local visual edits preserve cached frames outside the changed interval', () => {
    const c = preview.createPreviewCache()
    const base = { ...seq, clips: [{ ...seq.clips[0], duration: 2 }, { ...seq.clips[1], start: 3, duration: 2 }] }
    const setup = (s: any) => preview.ensurePreviewFingerprint(c, preview.previewFingerprint(s, settings, 320, 180), 320, 180)
    setup(base)
    for (const f of [15, 75, 105]) preview.putCachedFrame(c, f, dest)
    const untouched = c.frames.get(105)
    setup({ ...base, clips: [{ ...base.clips[0], transform: { ...base.clips[0].transform, x: 0.2 } }, base.clips[1]] })
    check(!c.frames.has(15), 'edited pixels survived')
    check(c.frames.get(105) === untouched && c.frames.has(75), 'unchanged intervals were discarded')
  })
  await test('new blackboard track and audio edits do not discard existing picture cache', () => {
    const c = preview.createPreviewCache()
    const setup = (s: any) => preview.ensurePreviewFingerprint(c, preview.previewFingerprint(s, settings, 320, 180), 320, 180)
    setup(seq); preview.putCachedFrame(c, 30, dest)
    const unchanged = c.frames.get(30)
    const added = { ...seq, tracks: [{ id: 'new', kind: 'video' }, ...seq.tracks, { id: 'sound', kind: 'audio' }],
      clips: [...seq.clips, { ...clip('new', 0), start: 8, duration: 1 }, { ...clip('sound', 0), duration: 20 }] }
    setup(added)
    check(c.frames.get(30) === unchanged, 'adding a later blackboard layer or audio cleared current picture')
  })
  await test('reordering the clip array (save / insert) keeps cached pictures', () => {
    const c = preview.createPreviewCache()
    const setup = (s: any) => preview.ensurePreviewFingerprint(c, preview.previewFingerprint(s, settings, 320, 180), 320, 180)
    setup(seq); preview.putCachedFrame(c, 30, dest)
    const unchanged = c.frames.get(30)
    setup({ ...seq, clips: [...seq.clips].reverse() })
    check(c.frames.get(30) === unchanged, 'clip array order change cleared the cache')
  })
  await test('chalk hand metadata participates in visual cache identity', () => {
    const changed = { ...seq, clips: [{ ...seq.clips[0], meta: { source: { chalk: { on: true, scale: 2, hand: { mediaId: 'hand' }, tip: [[0, 0, 0]] } } } }, seq.clips[1]] }
    check(preview.previewFingerprint(seq, settings, 320, 180) !== preview.previewFingerprint(changed, settings, 320, 180), 'chalk hand changes reused stale pixels')
  })
  await test('leaving cached playback must seek the paused decoder to the current target', async () => {
    video.setVideoSeekQuiet(false)
    video.videoFrameAt(media[0], 1, 30, 'resume-test')
    const resumed = videos[videos.length - 1]
    await until(() => !resumed.seeking && resumed.readyState >= 2, 'resume setup seek')
    video.videoFrameAt(media[0], 1, 30, 'resume-test')
    video.setVideoSeekQuiet(true)
    video.releaseVideoDecode()
    video.videoFrameAt(media[0], 1, 30, 'resume-test')
    await until(() => !resumed.seeking, 'live setup seek')
    video.videoFrameAt(media[0], 1, 30, 'resume-test')
    video.holdVideoDecode()
    video.releaseVideoDecode()
    video.videoFrameAt(media[0], 1.2, 30, 'resume-test')
    check(Math.abs(resumed.currentTime - 1.2) < 1e-4, 'cache miss resumed a six-frame-old decoder')
    video.setVideoSeekQuiet(false)
  })
  await test('cache ranges must not label missing frames as cached', () => {
    const c = preview.createPreviewCache()
    c.frames.set(0, dest); c.frames.set(3, dest)
    check(preview.cachedTimeRanges(c, 30).length === 2, 'cache bar hides uncached gap')
  })
  await test('rotated upper video must preserve the visible lower video', async () => {
    video.setVideoSeekQuiet(false)
    const layers: any = { ...seq, clips: [
      { ...clip('a', 0), transform: { ...defaultTransform(), rotation: 45 } },
      { ...clip('b', 0), transform: defaultTransform() },
    ] }
    const actual = create('canvas')
    renderProgramFrame(actual, layers, media, settings, 1, images, 320, 180, [], undefined, false, undefined, true)
    // 开播时释放的预取槽已无 src，不会再就绪
    await until(() => videos.filter(v => v.getAttribute('src')).every(v => !v.seeking && v.readyState >= 2), 'rotated layers seek')
    renderProgramFrame(actual, layers, media, settings, 1, images, 320, 180, [], undefined, false, undefined, true)
    const lower = create('canvas')
    renderProgramFrame(lower, { ...layers, clips: [layers.clips[1]] }, media, settings, 1, images, 320, 180, [], undefined, false, undefined, true)
    // Top rotated rectangle does not cover the top-right corner; bottom must show there.
    const a = actual.getContext('2d')!.getImageData(300, 5, 10, 10).data
    const b = lower.getContext('2d')!.getImageData(300, 5, 10, 10).data
    check(a.every((value, i) => value === b[i]), 'occlusion incorrectly removed visible lower layer')
  })
  await test('prefetched two-layer pixels match independently sought reference frames', async () => {
    const c = preview.createPreviewCache()
    preview.autoCacheProgramFrames({ cache: c, fromFrame: 90, fps: 30, seq, media, settings,
      imgCache: images, maxEdge: 320 })
    await until(() => c.frames.has(91) && c.frames.has(92), 'prefetch never completed both frames')
    const reference = create('video')
    reference.muted = true; reference.src = TEST_VIDEO_URL
    await until(() => reference.readyState >= 2, 'reference video load')
    for (const f of [91, 92]) {
      reference.currentTime = f / 30
      await until(() => !reference.seeking && reference.readyState >= 2, 'reference seek')
      const sample = create('canvas'); sample.width = 720; sample.height = 405
      sample.getContext('2d')!.drawImage(reference, 0, 0, 720, 405)
      const expected = create('canvas'); expected.width = 320; expected.height = 180
      const ctx = expected.getContext('2d')!
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 320, 180)
      for (const x of [240, 80]) {
        ctx.save(); ctx.translate(x, 90); ctx.scale(0.45, 0.45)
        ctx.filter = 'brightness(1.000) contrast(1.000) saturate(1.000) hue-rotate(0.0deg)'
        ctx.beginPath(); ctx.rect(-160, -90, 320, 180); ctx.clip()
        ctx.drawImage(sample, -160, -90, 320, 180); ctx.restore()
      }
      const a = c.frames.get(f)!.getContext('2d')!.getImageData(0, 0, 320, 180).data
      const b = ctx.getImageData(0, 0, 320, 180).data
      let squared = 0
      for (let i = 0; i < a.length; i++) squared += (a[i] - b[i]) ** 2
      const psnr = 10 * Math.log10(255 ** 2 / (squared / a.length))
      if (psnr < 45) (window as any).pixelFailure = { actual: c.frames.get(f)!.toDataURL(), expected: expected.toDataURL(), times: videos.map(v => v.currentTime), target: reference.currentTime }
      check(psnr >= 45, `frame ${f} PSNR ${psnr} < 45dB`)
    }
    reference.removeAttribute('src'); reference.load()
  })
  await test('invalidated prefetch cannot repopulate the cache and replacement work completes', async () => {
    const c = preview.createPreviewCache()
    const idle = window.requestIdleCallback
    const queued: (() => void)[] = []
    window.requestIdleCallback = ((cb: () => void) => { queued.push(cb); return queued.length }) as typeof idle
    try {
      preview.autoCacheProgramFrames({ cache: c, fromFrame: 60, fps: 30, seq, media, settings,
        imgCache: images, maxEdge: 320 })
      const obsolete = queued.shift()!
      obsolete() // Start a real asynchronous seek, leaving its retry pending.
      const changed = { ...seq, clips: seq.clips.map((clip: any) => ({ ...clip, freeze: 2 })) }
      const fp = preview.previewFingerprint(changed, settings, 320, 180)
      preview.ensurePreviewFingerprint(c, fp, 320, 180)
      obsolete()
      check(c.frames.size === 0, 'cancelled generation populated the replacement cache')
      preview.autoCacheProgramFrames({ cache: c, fromFrame: 90, fps: 30, seq: changed, media, settings,
        imgCache: images, maxEdge: 320 })
      queued.shift()!()
    } finally { window.requestIdleCallback = idle }
    await until(() => c.frames.has(91), 'replacement prefetch did not finish')
    preview.cancelPrefetchProgramFrames()
    check(!c.frames.has(60), 'old seek retry survived invalidation')
  })
  await test('shared cache spills to disk once RAM is full and reads frames back', async () => {
    const shared = preview.getProgramPreviewCache()
    await disk.clearDiskCache()
    shared.maxBytes = 320 * 180 * 4 * 3
    preview.autoCacheProgramFrames({ cache: shared, fromFrame: 0, fps: 30, seq, media, settings,
      imgCache: images, maxEdge: 320 })
    const onDisk = () => [...disk.diskFrames()].filter(f => !shared.frames.has(f))
    await until(() => shared.frames.size === 3 && onDisk().length >= 5, 'frames did not spill to disk')
    preview.cancelPrefetchProgramFrames()
    const f = onDisk()[0]
    check(preview.cachedTimeRanges(shared, 30).some(r => r.start <= f / 30 && f / 30 < r.end), 'disk frame missing from cache bar')
    const bmp = await disk.diskRead(f)
    check(bmp && bmp.width === 320 && bmp.height === 180, 'disk frame did not decode back')
    bmp!.close()
    await disk.clearDiskCache()
  })
  await test('local edits reuse unchanged disk pixels without recomposition', async () => {
    const shared = preview.getProgramPreviewCache()
    const base = { ...seq, clips: [{ ...seq.clips[0], duration: 2, mediaId: undefined, solid: { color: '#112233' } }] }
    const show = (s: any) => preview.presentCachedProgramFrame(shared, 0, 30, dest, s, [], settings, images, 320, 180, 320)
    show(base)
    await disk.diskReady()
    await Promise.all([disk.diskWrite(30, dest), disk.diskWrite(120, dest)])
    check(disk.diskHas(30) && disk.diskHas(120), 'disk fixture missing')
    show({ ...base, clips: [{ ...base.clips[0], solid: { color: '#445566' } }] })
    await disk.diskReady()
    check(!disk.diskHas(30), 'edited disk frame survived')
    check(disk.diskHas(120), 'unchanged disk frame was discarded')
    const bmp = await disk.diskRead(120)
    check(!!bmp, 'retained disk entry has no pixels')
    bmp?.close()
  })
  video.pauseAllVideos()
  return { failed: results.filter(r => !r.ok).length, results, pixelFailure: (window as any).pixelFailure }
})()
