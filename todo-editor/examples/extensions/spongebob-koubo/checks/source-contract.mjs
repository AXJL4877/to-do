import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const skill = JSON.parse(readFileSync(path.join(root, 'skill.json'), 'utf8'))
const src = skill.preserveSource
if (!src || src.entry !== 'workflow/run_pipeline.py' || !src.args?.includes('--all')) {
  throw new Error('skill.json 必须声明包内 preserveSource → workflow/run_pipeline.py --all')
}
if (src.env) throw new Error('自包含包不应再要求 preserveSource.env')
const entry = path.join(root, src.entry)
if (!existsSync(entry)) throw new Error(`缺少 ${src.entry}`)
const must = [
  'workflow/ref_bgm/跨越大洋的飞机 - Holding Court.mp3',
  'workflow/ref_bgm/眠舸 - 精卫（降调）.mp3',
  'workflow/ref_bgm/TRA$H - Memories.mp3',
  'workflow/kit/fonts/AmezumiGothic.ttf',
  'workflow/kit/assets/backgrounds/plate_beach.jpg',
  'workflow/kit/assets/fx/bubble_wipe.mp4',
  'workflow/paths.py',
]
for (const rel of must) {
  if (!existsSync(path.join(root, rel))) throw new Error(`缺少包内资源 ${rel}`)
}
if (String(skill.description).includes('KOUBO_ROOT')) throw new Error('说明仍要求外部 KOUBO_ROOT')
const runTts = readFileSync(path.join(root, 'workflow/01_口播试听/run_tts.py'), 'utf8')
if (!runTts.includes('tts_root / "outputs"') && !runTts.includes("tts_root / 'outputs'")) {
  throw new Error('run_tts.py 必须把 TTS --out 落到 TTS_TIMELINE_ROOT/outputs/<作业>/')
}
if (runTts.includes('paths.TTS / "_tts_out"') || runTts.includes("paths.TTS / '_tts_out'")) {
  throw new Error('run_tts.py 不得把 TTS --out 写到成片工作目录 _tts_out')
}
if (!existsSync(path.join(root, 'workflow/kit/kit/layers_export.py'))) {
  throw new Error('缺少 layers_export.py（E1 可编辑层）')
}
if (!existsSync(path.join(root, 'EDIT_WORKFLOW.md'))) {
  throw new Error('缺少 EDIT_WORKFLOW.md（分层剪辑规范）')
}
if (!existsSync(path.join(root, 'workflow/03_素材生成/generate_images.py'))) {
  throw new Error('缺少 generate_images.py（密匙批调度适配）')
}
const genBrief = readFileSync(path.join(root, 'workflow/03_素材生成/gen_from_brief.py'), 'utf8')
if (genBrief.includes('from media import generate_images')) {
  throw new Error('gen_from_brief 不得依赖密匙不存在的 generate_images')
}
const design = readFileSync(path.join(root, 'workflow/02_镜头设计/design.py'), 'utf8')
if (!design.includes('import paths')) throw new Error('design.py 必须 import paths')
console.log(JSON.stringify({ ok: true, version: skill.version, entry: src.entry }))
