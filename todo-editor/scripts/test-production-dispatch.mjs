/**
 * 成片管线分流回归测试（零 AI 调用、零费用、可重复）
 *
 * 守的是什么：executeSkillJob 必须把 `pipeline: 'production'` 的任务交给
 * executeProductionJob。曾经分流表漏掉这一支，成片任务掉进 executeElementsJob，
 * 而它的 req.prompt 对成片永远是 undefined：
 *     TypeError: Cannot read properties of undefined (reading 'slice')
 * 任务 58ms 失败、阶段停在「待生成」。
 *
 * 怎么做到不花钱：用一个最小技能包，它的 preserveSource 指向一个桩脚本，
 * 桩脚本按 todo-skill-render/1 协议写出"分层清单 + 一个元素 + 一层视频 + hold"。
 * 于是 runProduction 会走完整的成套流程（分段/分镜/生图/渲染/字幕/底板）——
 * 因为 preserveSource 会短路掉宿主那几层——真正跑到入轨那一步。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\//, ''), '..')

/**
 * 夹具根目录必须放在**工作区内**：包内管线会派生 Python 子进程，
 * 而沙箱环境里子进程只能写工作区（%TEMP% 会拿到 WinError 5）。
 * 可用 TODO_DISPATCH_TMP 覆盖。
 */
const TMP_ROOT = process.env.TODO_DISPATCH_TMP || path.join(REPO, 'native', 'test-output')
function rmrf(p) { try { rmSync(p, { recursive: true, force: true }) } catch { /* 忽略 */ } }

mkdirSync(TMP_ROOT, { recursive: true })
const root = mkdtempSync(path.join(TMP_ROOT, 'dispatch-check-'))
const dataDir = path.join(root, 'data')
const packDir = path.join(dataDir, 'skills', 'test.stub-koubo')
const workDir = path.join(root, 'work')
for (const d of [packDir, workDir, path.join(dataDir, 'ai-generated')]) mkdirSync(d, { recursive: true })

// ── 最小技能包：只声明 production + preserveSource，不带任何 AI 参数依赖 ──
writeFileSync(path.join(packDir, 'skill.json'), JSON.stringify({
  spec: 'todo-skill-pack/1',
  id: 'test.stub-koubo',
  name: '桩成片',
  version: '1.0.0',
  author: 'test',
  description: '分流回归测试用的最小成片包（preserveSource 指向桩脚本）',
  pipeline: 'production',
  input: { label: '口播', maxLength: 2000 },
  output: { mime: 'video/webm', codec: 'vp9' },
  params: [],
  planner: { maxElements: 1, system: '测试用占位提示词，长度需要超过二十个字符才能通过技能包校验。' },
  assets: {
    models: ['gpt-image-2'], resolution: '1K',
    template: 'test {{role}} must depict {{draw}} for the dispatch regression check',
    roles: { hero: 'h', support: 's', accent: 'a' }, avoid: [],
  },
  preserveSource: { entry: 'stub_workflow.py', args: ['--all'], timeoutSec: 600 },
  // production 管线即使走 preserveSource 也要求声明 runtime（与海绵宝宝包同一条规则）
  runtime: { type: 'python', entry: 'render.py', timeoutSec: 600 },
}, null, 2))

// 桩包还需要一个协议入口文件存在（校验器会检查 runtime.entry 指向的文件）
writeFileSync(path.join(packDir, 'render.py'), `import sys
print("@progress {\\"phase\\": \\"render\\", \\"pct\\": 1}")
print("@result {\\"scene\\": {\\"id\\": \\"b1\\", \\"startMs\\": 0, \\"endMs\\": 1000, \\"elements\\": []}}")
`)

// ── 桩脚本：按宿主协议产出分层清单 + 成片 + 时间戳（不调任何外部服务）──
writeFileSync(path.join(packDir, 'stub_workflow.py'), `import json, os, shutil, subprocess, wave
from pathlib import Path

work = Path(os.environ["KOUBO_WORK"])
out = work / "04_动画渲染" / "output"
layers = out / "layers"
tts = work / "01_口播试听"
for d in (layers, tts, out):
    d.mkdir(parents=True, exist_ok=True)

# 1) 配音：宿主要求 timing.audio_path 真实存在
voice = tts / "audio.wav"
with wave.open(str(voice), "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
    w.writeframes(b"\\x00\\x00" * 16000)          # 1 秒静音

(timing := {
    "duration": 2.0,
    "audio_path": str(voice),
    "sentences": [{
        "text": "桩口播第一句。",
        "start": 0.0, "end": 2.0,
        "phrases": [{"text": "桩口播", "start": 0.0, "end": 1.0},
                    {"text": "第一句。", "start": 1.0, "end": 2.0}],
    }],
})
(tts / "timing.json").write_text(json.dumps(timing, ensure_ascii=False), encoding="utf-8")

# 2) 分层：一个元素，带视频 / hold / 元素级音效
(layers / "e1.webm").write_bytes(b"WEBM")
(layers / "e1_hold.png").write_bytes(b"PNG")
(layers / "e1_sfx.wav").write_bytes(b"WAV" * 64)
(out / "layers_manifest.json").write_text(json.dumps({
    "fps": 30, "width": 320, "height": 180, "dir": "layers",
    "boards": [{
        "startMs": 0, "endMs": 2000,
        "elements": [{
            "id": "e1", "label": "桩元素", "role": "hero",
            "video": "e1.webm", "hold": "e1_hold.png", "sfx": "e1_sfx.wav",
            "crop": [0, 0, 320, 180], "startMs": 0, "durationMs": 1000,
            "frames": 30, "enter": "fade",
        }],
    }],
}, ensure_ascii=False), encoding="utf-8")

# 3) 成片：宿主会 probe 它
film = out / "成片.mp4"
subprocess.run([os.environ["FFMPEG"], "-y", "-v", "error", "-f", "lavfi",
                "-i", "color=c=blue:s=320x180:d=2", "-pix_fmt", "yuv420p", str(film)], check=True)

# 4) 收尾产物：宿主按 <outDir>/<名字> 找它们
aid = os.environ["TODO_STUB_ID"]
shutil.copyfile(voice, Path(os.environ["TODO_STUB_OUT"]) / f"{aid}_voice.wav")
shutil.copyfile(tts / "timing.json", Path(os.environ["TODO_STUB_OUT"]) / f"{aid}_timing.json")
print("stub workflow done", flush=True)
`)

process.env.TODO_DATA_DIR = dataDir
process.env.KOUBO_WORK = workDir
const { executeSkillJob } = await import(`file://${path.join(REPO, 'server', 'skillJobs.mjs').replace(/\\/g, '/')}`)
const { createProduction, productionJobParams, productionEntry } = await import(`file://${path.join(REPO, 'server', 'production', 'job.mjs').replace(/\\/g, '/')}`)
const { scanSkillPacks, USER_SKILL_DIR } = await import(`file://${path.join(REPO, 'server', 'skillPacks.mjs').replace(/\\/g, '/')}`)

// 先确认桩包真的被扫到了（扫描器会静默跳过校验失败的包，不查就会得到"未找到技能包"）
const scan = scanSkillPacks()
if (!scan.packs.has('test.stub-koubo')) {
  console.log('USER_SKILL_DIR =', USER_SKILL_DIR)
  console.log('桩包未被识别，扫描错误：', JSON.stringify(scan.errors, null, 2))
  process.exit(1)
}

// 1) 建文档并入队（用宿主自己的函数，保证 params 形状真实）
const doc = createProduction({ skillId: 'test.stub-koubo', script: '这是一段用于分流回归测试的桩口播文案。' })
doc.params = { ...doc.params, sourceWork: workDir }
const entry = productionEntry('test.stub-koubo')
const params = productionJobParams(doc, entry, { force: true })
const job = { id: 's_dispatch_test', kind: 'skill', params }

console.log('pipeline =', params.skill.pipeline)
console.log('request.productionId =', params.request.productionId)
if (!params.request.productionId) { console.log('× 入队参数里没有 productionId'); process.exit(1) }

// 2) 走分流：这里就是修复点
let phase = ''
// 桩脚本要按 <outDir>/<docId>_voice.wav 这类名字收尾，把这两个信息经环境变量交给它
process.env.TODO_STUB_ID = doc.id
process.env.TODO_STUB_OUT = path.join(dataDir, 'ai-generated')
const result = await executeSkillJob(job, {
  outDir: path.join(dataDir, 'ai-generated'),
  config: {},
  phase: (s) => { phase = s },
  saveParams: () => {},
  withRetry: (fn) => fn(),
})

console.log('phase =', phase)
console.log('result.production ?', Boolean(result?.production))
console.log('result.phase =', result?.phase)

// 3) 断言：走到了成片执行器（而不是元素执行器）
const problems = []
if (result?.spec !== 'todo-skill-output/1') problems.push(`返回清单 spec 不对：${result?.spec}`)
if (!result?.production) problems.push('没有 production 摘要 → 说明没走成片执行器')
if (result?.phase !== '完成') problems.push(`阶段不是「完成」：${result?.phase}`)

// 桩脚本产出的分层必须真的被绑定入轨
const { loadProduction } = await import(`file://${path.join(REPO, 'server', 'production', 'doc.mjs').replace(/\\/g, '/')}`)
const saved = loadProduction(doc.id)
const els = saved.segments.flatMap((s) => s.boards.flatMap((b) => b.render?.result?.elements || []))
console.log('绑定元素数 =', els.length)
if (!els.length) problems.push('分层没有入轨（elements 为空）')
const sfx = els.filter((e) => e.sfx)
console.log('带 sfx 元素 =', sfx.length)
if (!sfx.length) problems.push('元素级音效没有进产物（sfx 丢失）')

// 关键回归断言：绝不能出现当初那个 TypeError
if (String(saved.status?.error || '').includes("reading 'slice'")) {
  problems.push('仍出现 undefined.slice → 分流没有生效')
}

console.log(`\n${problems.length ? '× ' + problems.length + ' 个问题' : '✓ 成片管线分流正确，成片流程跑通并入轨'}`)
for (const p of problems) console.log('   -', p)
if (problems.length) {
  console.log(`夹具保留以便排查：${root}`)
} else {
  rmrf(root)   // 成功即清理；失败保留现场
}
process.exit(problems.length ? 1 : 0)
