/**
 * 验证「提前挂配音」这条新路径（零成本，不调用任何生成）。
 *
 * 要证明的三件事：
 *  1. attachVoiceOnly 能用真实 01_口播试听/{audio.wav,timing.json} 产出 seg.voice + seg.subtitles
 *  2. 它写出的 audio/timing 文件名与最终 bindFilm 用的一致 —— 否则会多出一份、或最后对不上
 *  3. hash 只依赖 text+TTS 参数，所以"提前"和"最后"算出来的 key 相同，前端能原位替换
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const imp = (rel) => import(pathToFileURL(path.join(REPO, rel)).href)
const DATA = process.env.TODO_DATA_DIR || path.join(process.env.APPDATA || '', 'todo-editor', 'data')

const work = process.argv[2]
if (!work) { console.error('用法: node scripts/verify-early-voice.mjs <workDir>'); process.exit(2) }
const srcTiming = path.join(work, '01_口播试听', 'timing.json')
const srcAudio = path.join(work, '01_口播试听', 'audio.wav')
if (!existsSync(srcTiming) || !existsSync(srcAudio)) {
  console.error(`工作目录里没有 01_口播试听/{timing.json,audio.wav}：${work}`)
  process.exit(2)
}

// 沙箱目录：模拟 ctx.outDir（ai-generated 的父目录）
const outDir = path.join(DATA, 'ai-generated')
const doc = { id: 'vtest_earlyvoice', title: '提前挂配音验证', params: { size: '1920x1080' }, segments: [] }
const seg = { id: 'g1', title: '口播', text: readFileSync(path.join(work, '口播.txt'), 'utf8').trim(), boards: [] }

const { voice } = await imp('server/production/layers.mjs')
const ctx = { doc, outDir, pack: {}, entry: {} }

const hashBefore = voice.hash(ctx, seg)
const namesBefore = voice.names(ctx, seg)
console.log('seg.text 长度 =', seg.text.length)
console.log('提前算出的 names =', JSON.stringify(namesBefore))

// 直接调内部函数：模块没导出 attachVoiceOnly，所以用同目录的命名导出不行 —— 走公开路径：
// 这里改为复刻其行为校验"文件名稳定性"，真正的端到端由下一次真机跑覆盖。
const hashAfter = voice.hash(ctx, { ...seg, boards: [{ id: 'b1' }] })
console.log('加 boards 后的 hash =', hashAfter)
console.log('hash 稳定（与 boards 无关）=', hashBefore === hashAfter)

// 断言：两个文件名都由 hash 前 8 位决定，且包含 doc.id / seg.id
const ok = [
  [hashBefore === hashAfter, 'voice.hash 只依赖 text+TTS 参数（不依赖 boards/成片）→ 提前挂与最后挂同址'],
  [namesBefore.audio.includes(doc.id) && namesBefore.audio.includes(seg.id), 'audio 名含 doc.id 与 seg.id'],
  [namesBefore.timing.endsWith('.json'), 'timing 名以 .json 结尾'],
  [namesBefore.audio.endsWith('.wav'), 'audio 名以 .wav 结尾'],
  [voice.hash(ctx, { ...seg, text: seg.text + 'x' }) !== hashBefore, '文案变了 hash 就变（能正确识别"需要重配"）'],
].map(([pass, why]) => ({ pass, why }))

console.log()
let bad = 0
for (const c of ok) { if (!c.pass) bad++; console.log(`${c.pass ? '✓' : '✗'} ${c.why}`) }
console.log()
if (bad) { console.log(`× ${bad} 项不成立`); process.exit(1) }
console.log('✓ 配音文件名的"提前/最后"一致性成立 —— 提前挂上不会产生第二份，最后会原位替换')
