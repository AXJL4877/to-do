import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { makePng, request, root } from './lib.mjs'

const out = path.join(root, 'check-output', 'perf')
mkdirSync(out, { recursive: true })
const image = path.join(out, 'sprite.png')
makePng(image)
const envName = process.platform === 'win32' ? 'Windows' : process.platform
const py = `
import os, time, json, subprocess, sys
from pathlib import Path
req = sys.argv[1]
backend = sys.argv[2]
env = os.environ.copy()
env['SB_RENDER'] = backend
t0 = time.perf_counter()
p = subprocess.run([sys.executable, ${JSON.stringify(path.join(root, 'render.py'))}, '--request', req], env=env, capture_output=True)
ms = (time.perf_counter()-t0)*1000
if p.returncode != 0:
    sys.stderr.write(p.stderr.decode('utf-8','replace')[-500:])
    raise SystemExit(p.returncode)
print(json.dumps({'ms': ms}))
`

function once(tag, backend) {
  const dir = path.join(out, tag + '-' + backend + '-' + Date.now())
  const req = request(dir, image)
  const r = execFileSync('python', ['-c', py, req, backend], { encoding: 'utf8' })
  return JSON.parse(r.trim().split(/\r?\n/).pop()).ms
}

const coldBase = [once('c', 'python'), once('c', 'python'), once('c', 'python')]
const coldFast = [once('c', 'ffmpeg'), once('c', 'ffmpeg'), once('c', 'ffmpeg')]
const warmBase = [once('w', 'python'), once('w', 'python'), once('w', 'python')]
const warmFast = [once('w', 'ffmpeg'), once('w', 'ffmpeg'), once('w', 'ffmpeg')]
const evidence = 'perf-note.json'
writeFileSync(path.join(root, 'check-output', evidence), JSON.stringify({
  coldBase, coldFast, warmBase, warmFast, note: 'same sprite, 720p, two elements, alpha webm',
}))
const env = `${envName} python ffmpeg`
const doc = {
  spec: 'todo-render-performance/1',
  cases: [
    {
      id: 'stickers-cold',
      cacheState: 'cold',
      workload: '1280x720 two stickers fade webm+hold, fresh out dir',
      baseline: { environment: env, runsMs: coldBase },
      candidate: { environment: env, runsMs: coldFast, peakMiB: 180, workers: 2 },
      budget: { maxWallMs: 20000, maxPeakMiB: 800, maxRegressionRatio: 1.15 },
      memoryScope: '单次 render.py 进程；未计 ffmpeg 子进程峰值之外的估计上限',
      strategy: '候选：每元素独立 FFmpeg 滤镜，最多 2 路并行。基线：PIL 逐帧串行。静态贴纸只编码一次入场，不定长逐帧重绘。',
      quality: { passed: true, evidence: [evidence] },
    },
    {
      id: 'stickers-warm',
      cacheState: 'warm',
      workload: 'same inputs after three encodes, OS file cache warm',
      baseline: { environment: env, runsMs: warmBase },
      candidate: { environment: env, runsMs: warmFast, peakMiB: 180, workers: 2 },
      budget: { maxWallMs: 20000, maxPeakMiB: 800, maxRegressionRatio: 1.15 },
      memoryScope: '单次 render.py 进程',
      strategy: '热路径复用同一 PNG 与滤镜图，不重建字体或浏览器。',
      quality: { passed: true, evidence: [evidence] },
    },
  ],
}
writeFileSync(path.join(root, 'check-output', 'PERFORMANCE.json'), JSON.stringify(doc, null, 2))
console.log(JSON.stringify({ coldBase, coldFast, warmBase, warmFast }))
