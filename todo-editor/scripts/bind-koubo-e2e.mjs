/** 把已跑通的 koubo 工作区绑进一条成片文档，供 TODO 时间轴验证 E1。 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const work = process.argv[2] || path.join(process.env.TEMP || '/tmp', 'koubo_e2e_short')
const data = process.env.TODO_DATA_DIR || path.join(process.env.APPDATA || '', 'todo-editor', 'data')
process.env.TODO_DATA_DIR = data

const { newProductionId, newSegment, saveProduction } = await import('../server/production/doc.mjs')
const { bindFilm, probeFilm } = await (async () => {
  const mod = await import('../server/production/sourceWorkflow.mjs')
  // probeFilm not exported — inline via ffmpeg in bind path; bindFilm probes outside
  return mod
})()
const { resolveFfmpeg } = await import('../server/animBuild.mjs')
const { spawnSync } = await import('node:child_process')

function probe(file) {
  const ff = resolveFfmpeg()
  const r = spawnSync(ff, ['-hide_banner', '-i', file], { windowsHide: true, encoding: 'utf8' })
  const text = `${r.stderr || ''}\n${r.stdout || ''}`
  const d = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  const size = text.match(/(\d{3,5})x(\d{3,5})/)
  if (!d) throw new Error('probe failed')
  return {
    duration: Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]),
    width: size ? Number(size[1]) : 1920,
    height: size ? Number(size[2]) : 1080,
  }
}

const film = path.join(work, '04_动画渲染', 'output', '成片.mp4')
const timingFile = path.join(work, '01_口播试听', 'timing.json')
const manifest = path.join(work, '04_动画渲染', 'output', 'layers_manifest.json')
if (!existsSync(film) || !existsSync(timingFile) || !existsSync(manifest)) {
  console.error('missing film/timing/manifest in', work)
  process.exit(1)
}

const id = newProductionId()
const outDir = path.join(data, 'ai-generated')
mkdirSync(outDir, { recursive: true })
const kouboWork = path.join(outDir, `${id}_koubo`)
// copy work tree shallow-ish: essential folders
const { cpSync } = await import('node:fs')
cpSync(work, kouboWork, { recursive: true })

const script = readFileSync(path.join(work, '01_口播试听', '口播.txt'), 'utf8')
const doc = {
  spec: 'todo-production/1',
  id,
  skillId: 'studio.spongebob-koubo',
  skillVersion: '1.4.4',
  title: 'E2E分层可编辑验证',
  titleLocked: false,
  createdAt: Date.now(),
  params: {
    voice: 'clone', cloneId: 'S_RksT6Z6g2', split: 'paragraph', size: '1920x1080',
    layout: 'auto', tone: 'ink', enter: 'fade', fps: '30', drawSpeed: 1, quality: 'standard',
  },
  script,
  cast: [],
  outline: { source: 'user', notes: 'e2e bind' },
  counters: { g: 0, b: 0, e: 0, v: 0 },
  lock: null,
  status: { running: false, pct: 100, phase: '完成', failed: [], error: null, stopAfter: null },
  plate: null,
  hand: null,
  segments: [],
  updatedAt: Date.now(),
  rev: 1,
}
doc.segments = [newSegment(doc, { text: script.trim(), title: doc.title })]
const seg = doc.segments[0]
const probed = probe(film)
const timing = JSON.parse(readFileSync(timingFile, 'utf8'))
const skill = JSON.parse(readFileSync(path.join(data, 'skills', 'studio.spongebob-koubo', 'skill.json'), 'utf8'))
const ctx = { doc, outDir, pack: skill, entry: { dir: path.join(data, 'skills', 'studio.spongebob-koubo'), pack: skill } }
bindFilm(ctx, seg, { timing, film, ...probed, work: kouboWork })
doc.sourceRun = { scriptHash: 'e2e' }
saveProduction(doc)

const els = seg.boards.flatMap((b) => b.render?.result?.elements || [])
console.log(JSON.stringify({
  ok: true,
  id,
  boards: seg.boards.length,
  elements: els.length,
  subtitles: seg.subtitles?.cues?.length || 0,
  crops: els.map((e) => ({ id: e.id, label: e.label, crop: e.crop })),
}, null, 2))
