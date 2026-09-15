import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
const { createMediaProbe } = createRequire(import.meta.url)('../electron/mediaProbe.cjs')
const root = fileURLToPath(new URL('../', import.meta.url))
const dir = resolve(root, 'native/test-output/过渡 中文 空格')
mkdirSync(dir, { recursive: true })
const links = resolve(process.env.LOCALAPPDATA || '', 'Microsoft/WinGet/Links')
const ffmpeg = process.env.FFMPEG || (existsSync(resolve(links,'ffmpeg.exe')) ? resolve(links,'ffmpeg.exe') : 'ffmpeg')
const ffprobe = process.env.FFPROBE || (existsSync(resolve(links,'ffprobe.exe')) ? resolve(links,'ffprobe.exe') : 'ffprobe')
const missing = resolve(dir, 'not-built.exe')
const probe = createMediaProbe({ nativePath: missing, ffprobePath: ffprobe })
const video = resolve(dir,'合成 视频.mp4')
const audio = resolve(dir,'合成 音频.wav')
function generate(args) { execFileSync(ffmpeg,['-v','error','-y',...args],{timeout:30000,maxBuffer:65536}) }
generate(['-f','lavfi','-i','color=c=blue:s=320x240:r=25','-f','lavfi','-i','sine=frequency=440','-t','2','-c:v','mpeg4','-c:a','aac',video])
generate(['-f','lavfi','-i','sine=frequency=880','-t','1.5',audio])
const v = await probe({filePath:video})
assert.equal(v.ok,true); assert.equal(v.backend,'ffprobe-transition'); assert.equal(v.width,320); assert.equal(v.height,240); assert.equal(v.hasAudio,true); assert.equal(v.frameRate,25); assert.ok(Math.abs(v.duration-2)<0.15)
const defaultProbe = createMediaProbe({nativePath:missing})
assert.equal((await defaultProbe({filePath:video})).ok,true)
const a = await probe({filePath:audio})
assert.equal(a.ok,true); assert.equal(a.hasVideo,false); assert.ok(Math.abs(a.duration-1.5)<0.01)
const bad = resolve(dir,'损坏.mp4'); writeFileSync(bad,'not media')
assert.equal((await probe({filePath:bad})).error.code,'PROBE_FAILED')
assert.equal((await probe({filePath:missing})).error.code,'INVALID_PATH')
assert.equal((await probe({filePath:audio,timeoutMs:0})).error.code,'INVALID_TIMEOUT')
// Real native executable is unavailable: injected runner verifies selection and
// native failure propagation, NOT C runtime execution.
let calls = 0
const native = createMediaProbe({nativePath:ffprobe,ffprobePath:missing,run(exe,args,opts,cb) {
  calls++; assert.equal(exe,ffprobe); assert.equal(args[0],bad); assert.equal(opts.shell,false)
  cb({code:1},JSON.stringify({ok:false,error:{code:'PROBE_FAILED',message:'corrupt'}}))
}})
assert.equal((await native({filePath:bad})).backend,'native-libavformat'); assert.equal(calls,1)
// Exercise actual execFile timeout/output bounds with a controllable process.
for (const [script, expected] of [['setInterval(()=>{},1000)','PROBE_TIMEOUT'], ['process.stdout.write("x".repeat(100000))','OUTPUT_LIMIT']]) {
  const { execFile } = await import('node:child_process')
  const bounded = createMediaProbe({nativePath:missing,run(_exe,_args,opts,cb) { return execFile(process.execPath,['-e',script],opts,cb) }})
  assert.equal((await bounded({filePath:audio,timeoutMs:100})).error.code,expected)
}
console.log('PASS transitional ffprobe real media:',JSON.stringify({video:v,audio:a}))
console.log('PASS corrupt/missing/timeout arguments, native failure no fallback (mock), real process timeout/output cap')
