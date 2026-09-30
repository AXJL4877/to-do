import * as video from '../src/lib/videoCache'
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
async function until(fn: () => boolean) {
  const end = performance.now() + 5000
  while (!fn() && performance.now() < end) await sleep(10)
  check(fn(), 'video did not settle')
}
const media: any = { id: 'm', kind: 'video', url: TEST_VIDEO_URL }
const results: any[] = []
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }) }
  catch (error) { results.push({ name, ok: false, error: String(error) }) }
  finally { video.setVideoSeekQuiet(false); video.releaseVideoDecode() }
}
async function setup(id: string) {
  video.videoFrameAt(media, 0.2, 30, id)
  const v = videos[videos.length - 1]
  await until(() => v.readyState >= 2 && !v.seeking)
  video.videoFrameAt(media, 0.2, 30, id)
  await until(() => !v.seeking)
  video.videoFrameAt(media, 0.2, 30, id)
  video.setVideoSeekQuiet(true)
  video.videoFrameAt(media, 0.2, 30, id)
  return v
}
;(window as any).videoPresentationTests = (async () => {
  await test('cache-to-live seek retains the recent decoded image, not the initial seek snapshot', async () => {
    const id = 'resume'
    const v = await setup(id)
    await until(() => v.currentTime >= 0.5)
    video.videoFrameAt(media, v.currentTime, 30, id)
    const lastShown = video.shownVideoTime(id)!
    video.holdVideoDecode()
    video.releaseVideoDecode()
    video.resetFrameSampleStability()
    video.videoFrameAt(media, 2, 30, id)
    check(video.frameSampleUnstable(), 'resume seek was considered stable')
    check((video.shownVideoTime(id) ?? -1) >= lastShown - 1 / 30,
      `image jumped backward from ${lastShown} to ${video.shownVideoTime(id)}`)
  })
  await test('seek lead is withheld until the playhead reaches it', async () => {
    const id = 'lead'
    const v = await setup(id)
    video.videoFrameAt(media, 2, 30, id)
    await until(() => !v.seeking)
    const lead = v.currentTime
    check(lead > 2 + 1 / 30, 'fixture did not produce a seek lead')
    video.resetFrameSampleStability()
    video.videoFrameAt(media, 2, 30, id)
    check(video.frameSampleUnstable(), `future image ${lead} was accepted for time 2`)
    check((video.shownVideoTime(id) ?? 0) <= 2 + 1 / 30, 'future seek image was presented')
    video.resetFrameSampleStability()
    video.videoFrameAt(media, lead, 30, id)
    check(!video.frameSampleUnstable(), 'aligned decoded image was not released')
  })
  return { results, failed: results.filter(r => !r.ok).length }
})()
