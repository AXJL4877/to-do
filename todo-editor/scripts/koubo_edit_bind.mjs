/**
 * 海绵宝宝口播 · 唯一绑定入口（规范见 examples/extensions/spongebob-koubo/EDIT_WORKFLOW.md）
 *
 * 用法:
 *   TODO_DATA_DIR=... node scripts/koubo_edit_bind.mjs <productionId>
 *
 * 做：校验工件 → bindFilm（TTS→分层→bgm_plan 三段）→ 自检开场满幅 / BGM≠口播
 * 不做：从 TEMP 覆盖；不把 sourceFilm 默认铺进时间轴（入轨由 syncProduction 渐进展开）
 */
import { readFileSync, existsSync, copyFileSync, mkdirSync, statSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { bindFilm } from '../server/production/sourceWorkflow.mjs'
import { resolveFfmpeg } from '../server/animBuild.mjs'
import { loadProduction, saveProduction } from '../server/production/doc.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

const data = process.env.TODO_DATA_DIR || path.join(process.env.APPDATA || '', 'todo-editor', 'data')
const id = process.argv[2]
if (!id) {
  console.error('usage: node scripts/koubo_edit_bind.mjs <productionId>')
  process.exit(2)
}

const outDir = path.join(data, 'ai-generated')
const kouboWork = path.join(outDir, `${id}_koubo`)
const renderOut = path.join(kouboWork, '04_动画渲染', 'output')
const film = path.join(renderOut, '成片.mp4')
const bare = path.join(renderOut, '成片_无BGM前.mp4')
const bed = path.join(renderOut, 'bgm_bed.wav')
const manifestPath = path.join(renderOut, 'layers_manifest.json')
const timingPath = path.join(kouboWork, '01_口播试听', 'timing.json')

function fail(msg) {
  console.error(JSON.stringify({ ok: false, id, error: msg }))
  process.exit(1)
}

for (const [label, p] of [
  ['成片', film],
  ['成片_无BGM前', bare],
  ['bgm_bed', bed],
  ['layers_manifest', manifestPath],
  ['timing', timingPath],
]) {
  if (!existsSync(p)) fail(`缺少工件 ${label}: ${p}`)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const boards = [...(manifest.boards || [])].sort((a, b) => (a.startMs || 0) - (b.startMs || 0))
if (!boards.length) fail('layers_manifest.boards 为空')
if ((boards[0].startMs || 0) > 80) fail('分层未从 0 起铺')
for (let i = 1; i < boards.length; i++) {
  if ((boards[i].startMs || 0) - (boards[i - 1].endMs || 0) > 80) fail(`镜间空隙过大 @${i}`)
}

const intro = boards[0].elements?.find((e) => /红字|intro/i.test(String(e.label || e.id || '')))
if (!intro) fail('开场板缺少开场红字')
const crop = intro.crop || []
if (!(crop[2] >= 1800 && crop[3] >= 1000)) fail(`开场红字必须满幅 crop，当前 ${crop.join(',')}`)
if ((intro.enter || 'cut') !== 'cut') fail(`开场 enter 必须为 cut，当前 ${intro.enter}`)

const layerDir = path.join(renderOut, manifest.dir || 'layers')
const introHold = path.join(layerDir, intro.hold)
if (!existsSync(introHold)) fail(`缺少开场 hold ${intro.hold}`)

// 像素：角不透明黑 + 足够红字（用 Pillow 经 python，避免再引依赖）
const py = spawnSync(
  process.env.TODO_PYTHON || 'python',
  [
    '-c',
    `
import sys, json
from PIL import Image
import numpy as np
im = np.array(Image.open(sys.argv[1]).convert("RGBA"))
corner = im[10, 10].tolist()
red = int(((im[:,:,0] > 150) & (im[:,:,1] < 100) & (im[:,:,3] > 200)).sum())
print(json.dumps({"shape": list(im.shape), "corner": corner, "red": red}))
`,
    introHold,
  ],
  { encoding: 'utf8', windowsHide: true },
)
if (py.status !== 0) fail(`开场像素检查失败: ${(py.stderr || py.stdout || '').slice(0, 400)}`)
const pix = JSON.parse((py.stdout || '').trim().split('\n').pop())
if (pix.corner[3] < 250) fail(`开场角像素必须不透明，corner=${pix.corner}`)
if (pix.red < 100000) fail(`开场红像素过少 red=${pix.red}（可能仍是透明精灵）`)

// BGM ≠ 口播：抽 bare 音与 bed 相关度
const ff = resolveFfmpeg()
const tmpWav = path.join(outDir, `${id}_bare_probe.wav`)
const ext = spawnSync(
  ff,
  ['-y', '-i', bare, '-vn', '-ac', '1', '-acodec', 'pcm_s16le', tmpWav],
  { encoding: 'utf8', windowsHide: true },
)
if (ext.status !== 0 || !existsSync(tmpWav)) fail('无法从成片_无BGM前抽口播探针')
const corrPy = spawnSync(
  process.env.TODO_PYTHON || 'python',
  [
    '-c',
    `
import sys, json, wave, numpy as np
def load(p):
  with wave.open(p,"rb") as w:
    ch=w.getnchannels(); d=np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32)
  if ch>1: d=d.reshape(-1,ch).mean(1)
  return d
a,b = load(sys.argv[1]), load(sys.argv[2])
n=min(len(a),len(b)); a,b=a[:n],b[:n]
an=(a-a.mean())/(a.std()+1e-9); bn=(b-b.mean())/(b.std()+1e-9)
print(json.dumps({"corr": float(np.mean(an*bn)), "bed_rms": float(np.sqrt(np.mean(b*b))), "voice_rms": float(np.sqrt(np.mean(a*a)))}))
`,
    tmpWav,
    bed,
  ],
  { encoding: 'utf8', windowsHide: true },
)
if (corrPy.status !== 0) fail(`BGM 相关度检查失败: ${(corrPy.stderr || '').slice(0, 400)}`)
const audio = JSON.parse((corrPy.stdout || '').trim().split('\n').pop())
if (Math.abs(audio.corr) >= 0.2) {
  fail(`bgm_bed 与口播过于相似 corr=${audio.corr}（禁止口播复制当 BGM）`)
}

const timing = JSON.parse(readFileSync(timingPath, 'utf8'))
const probe = spawnSync(ff, ['-hide_banner', '-i', film], { encoding: 'utf8', windowsHide: true })
const text = `${probe.stderr || ''}\n${probe.stdout || ''}`
const d = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
const size = text.match(/(\d{3,5})x(\d{3,5})/)
if (!d) fail('成片 probe 失败')
const probed = {
  duration: Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]),
  width: size ? Number(size[1]) : 1920,
  height: size ? Number(size[2]) : 1080,
}

const doc = loadProduction(id)
const skillPath = path.join(data, 'skills', 'studio.spongebob-koubo', 'skill.json')
if (!existsSync(skillPath)) fail(`未安装技能 studio.spongebob-koubo @ ${skillPath}`)
const skill = JSON.parse(readFileSync(skillPath, 'utf8'))
doc.skillVersion = skill.version
const seg = doc.segments[0]
if (!seg) fail('production 无 segments[0]')
seg.boards = []
bindFilm(
  { doc, outDir, pack: skill, entry: { dir: path.join(data, 'skills', 'studio.spongebob-koubo'), pack: skill } },
  seg,
  { timing, film, ...probed, work: kouboWork },
)
if (!doc.sourceLayers?.bound) fail(`分层未绑定: ${JSON.stringify(doc.sourceLayers)}`)
if (!doc.sourceBgmPlan?.segments?.length && !doc.sourceBgm?.file) fail('未写入 sourceBgmPlan / sourceBgm')
doc.skillVersion = skill.version
doc.status = { running: false, pct: 100, phase: '完成', failed: [], error: null, stopAfter: null }
saveProduction(doc)

const els = seg.boards.flatMap((b) => b.render?.result?.elements || [])
const introEl = els.find((e) => /红字|intro/i.test(String(e.label || '')))
const report = {
  ok: true,
  id,
  workflow: 'EDIT_WORKFLOW.md',
  progressive: ['tts', 'layers-by-shot', 'bgm-intro-mid-outro'],
  layout: seg.boards[0]?.render?.result?.layout,
  boards: seg.boards.length,
  elements: els.length,
  introCrop: introEl?.crop,
  enters: els.map((e) => e.enter),
  sourceBgmPlan: doc.sourceBgmPlan,
  sourceBgm: doc.sourceBgm,
  voice: seg.voice?.audio,
  audioCorr: audio.corr,
  introPixels: pix,
  next: [
    '打开该成片并确保 autoTimeline',
    '或 node scripts/trigger-live-accept-koubo.mjs ' + id,
    '顺序：口播 → 开场红字/逐镜元素 → BGM intro/mid/outro',
  ],
}

// 镜像到仓库 .data（Vite 同源）
const repoData = path.resolve(here, '..', '.data')
try {
  mkdirSync(path.join(repoData, 'productions'), { recursive: true })
  mkdirSync(path.join(repoData, 'ai-generated'), { recursive: true })
  copyFileSync(path.join(data, 'productions', `${id}.json`), path.join(repoData, 'productions', `${id}.json`))
  for (const name of readdirSync(outDir)) {
    if (name.startsWith(`${id}_`) && !name.endsWith('_koubo')) {
      const src = path.join(outDir, name)
      if (statSync(src).isFile()) copyFileSync(src, path.join(repoData, 'ai-generated', name))
    }
  }
} catch (e) {
  report.mirrorWarning = String(e)
}

console.log(JSON.stringify(report, null, 2))
