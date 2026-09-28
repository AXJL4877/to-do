import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.TODO_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'todo-anim-'))

const {
  BUILTIN_ANIM_DIR, USER_ANIM_DIR, compileAnimById, framePrompt, listAnimPacks, sheetPrompt, validateAnimPack,
} = await import('../server/animPacks.mjs')
const { contentBox, normalizeFrames, playOrder, resolveFfmpeg, sliceGrid, writeAnimation } = await import('../server/animBuild.mjs')
const { handleAiHttp } = await import('../server/aiHttp.mjs')

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

function throws(fn, pattern, msg) {
  try {
    fn()
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e)
    assert(pattern.test(m), `${msg}: 错误信息不符 → ${m}`)
    return
  }
  throw new Error(`${msg}: 应当抛错`)
}

async function roundtrip(method, url, body) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))]
  const out = { statusCode: 0, body: '', setHeader() {}, end(s = '') { this.body = String(s) } }
  await handleAiHttp({ method, url, async *[Symbol.asyncIterator]() { yield* chunks } }, out)
  return { code: out.statusCode, ...JSON.parse(out.body || '{}') }
}

const DOODLE = 'builtin.doodle-figure'
const doodleDir = path.join(BUILTIN_ANIM_DIR, 'doodle-figure')
const doodleRaw = JSON.parse(readFileSync(path.join(doodleDir, 'anim.json'), 'utf8'))
const need = { character: '圆脑袋小人', action: '喝水' }

// 1. 内置包合法、公开描述不含模板
const listed = listAnimPacks()
assert(listed.errors.length === 0, `内置动画包校验失败: ${JSON.stringify(listed.errors)}`)
const pub = listed.anims.find((a) => a.id === DOODLE)
assert(pub && !('prompt' in pub) && pub.cutout?.default === true, '列表中应有手绘小人且不暴露模板')

// 2. 编译：默认拼图 6 帧 / 3×2 / 透明锁纯白底
const plan = compileAnimById(DOODLE, { inputs: { character: '圆脑袋{{x}}小人', action: '拿杯子喝水', background: 'paper' } })
assert(plan.mode === 'sheet' && plan.frames === 6 && plan.grid.cols === 3 && plan.grid.rows === 2, '默认拼图 3×2')
assert(plan.aspectRatio === '3:2', '拼图画幅由网格决定')
assert(plan.cutout?.method === 'keyWhite' && plan.meta.inputs.background === 'white', '透明通道锁纯白底')
assert(plan.basePrompt.includes('圆脑袋x小人') && !/\{\{|\}\}/.test(plan.basePrompt), '输入去花括号且无残留占位符')
assert(plan.beats.length === 6 && plan.beats.every((b) => b === ''), '分镜补齐到帧数')
const sp = sheetPrompt(plan)
assert(sp.includes('3 columns and 2 rows') && sp.includes('cell 6: the ending pose'), '拼图提示词含网格与自动分镜')

const seq = compileAnimById(DOODLE, {
  inputs: need, mode: 'sequence', frames: 4, aspectRatio: '9:16', alpha: false, beats: ['伸手', '', '仰头喝'],
  fps: 12, loop: 'pingpong', repeat: 3,
})
assert(seq.grid === null && seq.aspectRatio === '9:16' && seq.cutout === null, '逐帧模式用用户画幅、可关透明')
assert(seq.beats[0] === '伸手' && seq.beats[3] === '', '分镜按位对齐')
assert(framePrompt(seq, 0, { fromRef: false }).includes('Pose: 伸手'), '首帧文生图')
assert(framePrompt(seq, 2, { fromRef: true }).startsWith('Redraw the exact same character'), '后续帧参考首帧重绘')
assert(framePrompt(seq, 1, { fromRef: true }).includes('33% through'), '空分镜按进度补中间姿势')

// 3. 越界拒绝
throws(() => compileAnimById(DOODLE, { inputs: { character: 'a' } }), /动作/, '缺必填')
throws(() => compileAnimById(DOODLE, { inputs: need, frames: 5 }), /关键帧数/, '非法帧数')
throws(() => compileAnimById(DOODLE, { inputs: need, fps: 60 }), /帧率/, '非法帧率')
throws(() => compileAnimById(DOODLE, { inputs: need, loop: 'bounce' }), /循环方式/, '非法循环')
throws(() => compileAnimById(DOODLE, { inputs: need, repeat: 11 }), /重复次数/, '重复超限')
throws(() => compileAnimById(DOODLE, { inputs: need, mode: 'sequence', aspectRatio: '2:3' }), /画幅/, '非法画幅')
throws(() => compileAnimById(DOODLE, { inputs: need, beats: Array(7).fill('x') }), /分镜最多 6/, '分镜超帧数')
throws(() => compileAnimById(DOODLE, { inputs: need, beats: ['x'.repeat(81)] }), /最多 80/, '分镜超长')
throws(() => compileAnimById(DOODLE, { inputs: { ...need, prompt: 'x' } }), /没有输入项/, '未声明输入')
throws(() => compileAnimById(DOODLE, { inputs: need, alpha: 'yes' }), /布尔/, 'alpha 类型')
throws(() => compileAnimById('nobody.none', { inputs: need }), /未找到/, '未知动画包')

// 4. 非法包
const clone = () => JSON.parse(JSON.stringify(doodleRaw))
for (const [mutate, pattern] of [
  [(p) => { p.spec = 'todo-style-pack/1' }, /spec/],
  [(p) => { p.script = 1 }, /不允许的字段 "script"/],
  [(p) => { p.outputs = ['image'] }, /outputs/],
  [(p) => { p.keyframes.counts = [5] }, /keyframes.counts/],
  [(p) => { p.keyframes.defaultMode = 'video' }, /defaultMode/],
  [(p) => { p.keyframes.align = 'center' }, /keyframes.align/],
  [(p) => { p.playback.fps = [0] }, /playback.fps/],
  [(p) => { p.playback.maxRepeat = 99 }, /maxRepeat/],
  [(p) => { p.cutout.trim = true }, /不允许的字段 "trim"/],
  [(p) => { p.prompt.template += ' {{mood}}' }, /\{\{mood\}\}/],
  [(p) => { p.previews = ['../anim.json'] }, /包内相对路径/],
]) {
  const p = clone()
  mutate(p)
  throws(() => validateAnimPack(p, doodleDir), pattern, `非法包 ${pattern}`)
}
mkdirSync(path.join(USER_ANIM_DIR, 'broken'), { recursive: true })
writeFileSync(path.join(USER_ANIM_DIR, 'broken', 'anim.json'), JSON.stringify({ ...clone(), id: 'user.broken', hack: 1 }))
const withBroken = listAnimPacks()
assert(withBroken.errors.length === 1 && withBroken.anims.some((a) => a.id === DOODLE), '坏包隔离')

// 5. 切格 + 抠像 + 地平线对齐 + 统一裁边：3×2 白底拼图，每格一个高度不同、底边不齐的红块
{
  const W = 300, H = 200
  const sheet = { width: W, height: H, data: Buffer.alloc(W * H * 4, 255) }
  const rect = (x0, y0, w, h) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
      const i = (y * W + x) * 4
      sheet.data[i] = 220; sheet.data[i + 1] = 20; sheet.data[i + 2] = 20
    }
  }
  for (let c = 0; c < 6; c++) {
    const cx = (c % 3) * 100, cy = Math.floor(c / 3) * 100
    rect(cx + 40, cy + 30 + c * 3, 20, 40 - c * 2)
  }
  const cells = sliceGrid(sheet, 3, 2)
  assert(cells.length === 6 && cells[0].width === 94 && cells[0].height === 94, '切格 + 内缩')
  const frames = normalizeFrames(cells, { cutout: { method: 'keyWhite', threshold: 0.1 }, align: 'baseline' })
  const bottoms = frames.map((f) => contentBox(f, true).y1)
  assert(new Set(bottoms).size === 1, `底边应对齐: ${bottoms}`)
  assert(frames.every((f) => f.width === frames[0].width && f.height === frames[0].height), '统一尺寸')
  assert(frames[0].width % 2 === 0 && frames[0].height % 2 === 0 && frames[0].width < 94, '统一裁边且偶数宽高')
  assert(frames[0].data[3] === 0, '白底变透明')
  const opaque = normalizeFrames(cells, { cutout: null, align: 'none' })
  assert(opaque[0].width === 94 && opaque[0].data[3] === 255, '不透明模式保留整格')

  assert(playOrder(4, 'pingpong', 2).join('') === '012321012321', '往返 + 重复顺序')
  assert(playOrder(3, 'forward', 1).join('') === '012', '顺序播放')

  // 6. 真实 ffmpeg 合成
  const out = mkdtempSync(path.join(tmpdir(), 'todo-anim-out-'))
  const a = await writeAnimation(frames, { outDir: out, id: 'selftest', fps: 6, loop: 'pingpong', repeat: 1, alpha: true })
  assert(a.video === 'selftest.webm' && a.frames.length === 6 && a.playFrames === 10, '透明动画产物')
  assert(Math.abs(a.duration - 10 / 6) < 1e-9, '时长 = 播放帧数 / fps')
  const probe = execFileSync(resolveFfmpeg().replace(/ffmpeg(\.exe)?$/i, (m) => m.replace('ffmpeg', 'ffprobe')), [
    '-v', 'error', '-show_entries', 'stream=codec_name,width,height:stream_tags=alpha_mode', '-of', 'json', path.join(out, a.video),
  ], { encoding: 'utf8' })
  const st = JSON.parse(probe).streams[0]
  assert(st.codec_name === 'vp9' && st.width === a.width, `WebM 应为 VP9: ${probe}`)
  assert(String(st.tags?.alpha_mode ?? st.tags?.ALPHA_MODE) === '1', `WebM 应带透明通道: ${probe}`)
  const m = await writeAnimation(opaque, { outDir: out, id: 'selftest2', fps: 8, loop: 'forward', repeat: 2, alpha: false })
  assert(m.video === 'selftest2.mp4' && existsSync(path.join(out, m.video)) && m.playFrames === 12, '不透明 MP4 产物')
}

// 7. HTTP：列表 / 入队 / 未完成时拿回返回 409
const api = await roundtrip('GET', '/api/ai-anims')
assert(api.ok && api.anims.some((a) => a.id === DOODLE), 'GET /api/ai-anims')
const enq = await roundtrip('POST', '/api/ai-jobs', {
  kind: 'anim', animId: DOODLE, prompt: 'realistic photo', animInputs: need, frames: 4, alpha: true,
})
assert(enq.ok && enq.job.kind === 'anim' && enq.job.id.startsWith('a_'), `动画入队失败: ${enq.error}`)
assert(!enq.job.prompt.includes('realistic photo') && enq.job.params.anim.frames === 4, '提示词只来自动画包')
const early = await roundtrip('GET', `/api/ai-jobs/${enq.job.id}/output`)
assert(!early.ok && early.code === 409, '未完成任务拿回应返回 409')
const bad = await roundtrip('POST', '/api/ai-jobs', { kind: 'anim', animId: DOODLE, animInputs: { character: 'x' } })
assert(!bad.ok && /动作/.test(bad.error), '入队校验必填')

console.log('anim-pack self-check ok')
process.exit(0)
