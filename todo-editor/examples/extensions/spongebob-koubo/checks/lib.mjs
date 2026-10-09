import { mkdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'path'
import { fileURLToPath } from 'node:url'

export const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

export function png(file) {
  // 32x32 opaque red square, valid PNG
  const { execFileSync } = awaitable()
  execFileSync('python', ['-c', `
from PIL import Image
Image.new('RGBA',(64,80),(220,40,40,255)).save(r'''${file}''')
`], { stdio: 'inherit' })
}

function awaitable() {
  return { execFileSync: spawnSync }
}

export function makePng(file) {
  const r = spawnSync('python', ['-c', `from PIL import Image\nImage.new('RGBA',(64,80),(220,40,40,255)).save(${JSON.stringify(file)})`], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || 'png failed')
}

export function request(outDir, image, extra = {}) {
  mkdirSync(outDir, { recursive: true })
  const body = {
    spec: 'todo-skill-render/1',
    jobId: 'sb_test',
    mode: 'scene-clips',
    outDir,
    ffmpeg: 'ffmpeg',
    params: { size: '1280x720', fps: '30', enter: 'fade', drawSpeed: 1, ...extra },
    scene: {
      id: 'b1', startMs: 0, endMs: 4000,
      elements: [
        { id: 'hero', label: '海绵', role: 'hero', weight: 1.5, image, atMs: 200, windowEndMs: 3000 },
        { id: 'prop', label: '钩子', role: 'support', weight: 1, image, atMs: 800, windowEndMs: 3600 },
      ],
    },
    outputs: { prefix: 'sbtest' },
  }
  const file = path.join(outDir, 'request.json')
  writeFileSync(file, JSON.stringify(body))
  return file
}

export function render(req, env = {}) {
  const r = spawnSync('python', [path.join(root, 'render.py'), '--request', req], {
    encoding: 'utf8', env: { ...process.env, ...env }, cwd: root,
  })
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || 'render failed')
  const line = r.stdout.split(/\r?\n/).filter((s) => s.startsWith('@result ')).pop()
  if (!line) throw new Error('missing @result')
  return JSON.parse(line.slice(8))
}
