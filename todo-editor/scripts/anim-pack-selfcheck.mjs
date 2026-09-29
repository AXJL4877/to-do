import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.TODO_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'todo-anim-'))

const {
  BUILTIN_ANIM_DIR, USER_ANIM_DIR, characterPrompt, compileAnimById, listAnimPacks, spritePrompt, validateAnimPack,
} = await import('../server/animPacks.mjs')
const {
  composeContinuationRef, contentBox, normalizeFrames, playOrder, resolveFfmpeg, sliceGrid, sliceSprite, writeAnimation,
} = await import('../server/animBuild.mjs')
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

// 2. 编译：5×5 精灵图 / 25 帧 / 1:1 / 透明锁纯白底
const plan = compileAnimById(DOODLE, { inputs: { character: '圆脑袋{{x}}小人', action: '拿杯子喝水', background: 'paper' } })
assert(plan.frames === 25 && plan.grid.cols === 5 && plan.grid.rows === 5, '精灵图 5×5 = 25 帧')
assert(plan.aspectRatio === '1:1' && plan.fps === 12, '精灵图 1:1、默认 12fps')
assert(plan.cutout?.method === 'keyWhite' && plan.meta.inputs.background === 'white', '透明通道锁纯白底')
assert(plan.basePrompt.includes('圆脑袋x小人') && !/\{\{|\}\}/.test(plan.basePrompt), '输入去花括号且无残留占位符')
assert(plan.beats.length === 5 && plan.beats.every((b) => b === ''), '分镜按行补齐')
const sp = spritePrompt(plan)
assert(sp.includes('5×5 grid of 25') && sp.includes('row 5 (frames 21-25): the motion completes'), '精灵图提示词含网格与分行分镜')
assert(!sp.includes('seamless loop'), '单次播放不要求无缝循环')

const cyc = compileAnimById(DOODLE, { inputs: need, alpha: false, beats: ['伸手', '', '仰头喝'], fps: 24, repeat: 3 })
assert(cyc.cutout === null && cyc.beats[0] === '伸手' && cyc.beats[4] === '', '可关透明、分镜按行对齐')
const cp = spritePrompt(cyc, { hasRef: true })
assert(cp.includes('row 1 (frames 1-5): 伸手') && cp.includes('seamless loop') && cp.includes('reference image'), '循环 + 参考图提示')
assert(spritePrompt(compileAnimById(DOODLE, { inputs: need, loop: 'pingpong' })).includes('played in reverse'), '往返提示')

// 3. 越界拒绝
throws(() => compileAnimById(DOODLE, { inputs: { character: 'a' } }), /动作/, '缺必填')
throws(() => compileAnimById(DOODLE, { inputs: need, fps: 60 }), /帧率/, '非法帧率')
throws(() => compileAnimById(DOODLE, { inputs: need, loop: 'bounce' }), /循环方式/, '非法循环')
throws(() => compileAnimById(DOODLE, { inputs: need, repeat: 11 }), /重复次数/, '重复超限')
throws(() => compileAnimById(DOODLE, { inputs: need, resolution: '1K' }), /分辨率/, '非法分辨率')
throws(() => compileAnimById(DOODLE, { inputs: need, beats: Array(6).fill('x') }), /分镜最多 5/, '分镜超行数')
throws(() => compileAnimById(DOODLE, { inputs: need, beats: ['x'.repeat(81)] }), /最多 80/, '分镜超长')
throws(() => compileAnimById(DOODLE, { inputs: { ...need, prompt: 'x' } }), /没有输入项/, '未声明输入')
throws(() => compileAnimById(DOODLE, { inputs: need, alpha: 'yes' }), /布尔/, 'alpha 类型')
throws(() => compileAnimById('nobody.none', { inputs: need }), /未找到/, '未知动画包')

// 3b. 长镜头分段：每段一张精灵图，衔接帧去重；续段提示词接上一段末帧；角色设定图提示词
{
  const seg = compileAnimById(DOODLE, { inputs: need, segments: ['放下杯子', '挥手告别'], beats: ['伸手'] })
  assert(seg.segments.length === 3 && seg.totalFrames === 25 + 2 * 24 && seg.meta.frames === 73 && seg.meta.sheets === 3, '3 段 = 73 帧')
  assert(seg.segmentPrompts[1].includes('放下杯子') && !seg.segmentPrompts[1].includes('喝水') && seg.basePrompt.includes('喝水'), '每段替换动作')
  const p0 = spritePrompt(seg, { hasRef: true, segment: 0 })
  const p1 = spritePrompt(seg, { hasRef: true, segment: 1, continuation: true })
  const p2 = spritePrompt(seg, { hasRef: true, segment: 2, continuation: true })
  assert(p0.includes('row 1 (frames 1-5): 伸手') && /part 1 of 3/.test(p0), '第 1 段带分镜且标注分段')
  assert(!p1.includes('伸手') && /left/i.test(p1) && /right/i.test(p1) && p1.includes('放下杯子'), '续段参照左角色右末帧')
  assert(/part 3 of 3/.test(p2) && p2.includes('挥手告别'), '最后一段')
  const chp = characterPrompt(seg)
  assert(chp.includes('圆脑袋小人') && /white/i.test(chp), '角色设定图提示词')
  throws(() => compileAnimById(DOODLE, { inputs: need, segments: ['a', 'b', 'c', 'd'] }), /段/, '分段超限')
  throws(() => compileAnimById(DOODLE, { inputs: need, segments: [' '] }), /段/, '空分段')
  throws(() => compileAnimById(DOODLE, { inputs: need, segments: 'x' }), /数组/, '分段类型')

  const ch = { width: 40, height: 80, data: Buffer.alloc(40 * 80 * 4, 0) }
  for (let i = 0; i < ch.data.length; i += 4) { ch.data[i] = 200; ch.data[i + 3] = 255 }
  const last = { width: 100, height: 100, data: Buffer.alloc(100 * 100 * 4, 30) }
  for (let i = 3; i < last.data.length; i += 4) last.data[i] = 255
  const ref = composeContinuationRef(ch, last, 200)
  assert(ref.height === 200 && ref.width > 100 + 200, `拼接参照图尺寸: ${ref.width}×${ref.height}`)
  const px = (x, y) => ref.data[(y * ref.width + x) * 4]
  assert(px(10, 100) === 200 && px(ref.width - 10, 100) === 30, '左角色右末帧')
}

// 3c. AI 导演：提示词含包约束；LLM 输出按白名单清洗且能通过编译
{
  const { buildDirectorMessages, sanitizeDirection } = await import('../server/animDirector.mjs')
  const [sys] = buildDirectorMessages(pub, '小人跳绳')
  assert(sys.content.includes('"character"') && sys.content.includes('1~4 段') && sys.content.includes('marker(马克笔)'), '导演提示词含输入与段数约束')
  const d = sanitizeDirection({
    title: '一个非常非常非常长的动画标题超过十二字', character: '戴{{帽}}子的小人'.padEnd(120, '啊'),
    segments: ['起床伸懒腰', '刷牙', '背包出门', '关门', '第五段应被丢弃'], beats: ['a', 'b'],
    line: 'oil', color: 'full', fps: 60, loop: 'bounce', repeat: 99, alpha: 'yes', notes: 'n',
  }, pub)
  const v = d.values
  assert(d.title.length === 12 && v.inputs.character.length === 80 && !/[{}]/.test(v.inputs.character), '文本截断、去花括号')
  assert(v.inputs.action === '起床伸懒腰' && v.segments.length === 3 && v.segments[2] === '关门', '首段进 action，其余进 segments，超出丢弃')
  assert(v.inputs.line === 'marker' && v.inputs.color === 'full', '非法选项回落默认')
  assert(v.fps === 12 && v.loop === 'forward' && v.repeat === 10 && v.alpha === true && v.beats.length === 5 && v.beats[2] === '', '播放参数夹紧、分镜补齐')
  const cp2 = compileAnimById(DOODLE, { inputs: v.inputs, segments: v.segments, beats: v.beats, fps: v.fps, loop: v.loop, repeat: v.repeat, alpha: v.alpha })
  assert(cp2.segments.length === 4, '清洗结果可直接编译')
  throws(() => sanitizeDirection({ character: 'x', segments: [] }, pub), /动作/, '无动作')
  throws(() => sanitizeDirection('text', pub), /对象/, '非对象')
}

// 4. 非法包
const clone = () => JSON.parse(JSON.stringify(doodleRaw))
for (const [mutate, pattern] of [
  [(p) => { p.spec = 'todo-style-pack/1' }, /spec/],
  [(p) => { p.script = 1 }, /不允许的字段 "script"/],
  [(p) => { p.outputs = ['image'] }, /outputs/],
  [(p) => { p.spec = 'todo-anim-pack/1' }, /spec/],
  [(p) => { p.sprite.grid = 3 }, /sprite.grid/],
  [(p) => { p.sprite.modes = ['sheet'] }, /不允许的字段 "modes"/],
  [(p) => { p.sprite.align = 'center' }, /sprite.align/],
  [(p) => { p.image.aspectRatios = ['1:1'] }, /不允许的字段 "aspectRatios"/],
  [(p) => { p.playback.fps = [0] }, /playback.fps/],
  [(p) => { p.playback.maxRepeat = 99 }, /maxRepeat/],
  [(p) => { p.cutout.trim = true }, /不允许的字段 "trim"/],
  [(p) => { p.prompt.template += ' {{mood}}' }, /\{\{mood\}\}/],
  [(p) => { p.previews = ['../anim.json'] }, /包内相对路径/],
  [(p) => { p.sprite.maxSegments = 9 }, /maxSegments/],
  [(p) => { delete p.sprite.segmentInput }, /segmentInput/],
  [(p) => { p.sprite.segmentInput = 'background' }, /segmentInput/],
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

  // 5b. 精灵图自适应切格：5×5 不均匀网格（格宽 90~115），每格一个黑块，等分会切到块
  {
    const widths = [90, 115, 95, 110, 90]
    const S = 500
    const img = { width: S, height: S, data: Buffer.alloc(S * S * 4, 255) }
    const starts = widths.map((_, i) => widths.slice(0, i).reduce((a, b) => a + b, 0))
    for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) {
      const bw = widths[c] - 16, bh = widths[r] - 16
      for (let y = starts[r] + 8; y < starts[r] + 8 + bh; y++) for (let x = starts[c] + 8; x < starts[c] + 8 + bw; x++) {
        const i = (y * S + x) * 4
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 0
      }
    }
    const sp5 = sliceSprite(img, 5, 5)
    assert(sp5.length === 25, '切成 25 帧')
    const whole = sp5.every((cell) => {
      const b = contentBox(cell, false)
      return b && b.x0 > 0 && b.y0 > 0 && b.x1 < cell.width - 1 && b.y1 < cell.height - 1
    })
    assert(whole, '每格内容完整（未被切线切断）')
    assert(sp5[1].width > sp5[0].width + 15, `切线跟随实际格间空白: ${sp5.slice(0, 5).map((c) => c.width)}`)
    const even = sliceGrid(img, 5, 5, 0)
    assert(even.some((cell) => { const b = contentBox(cell, false); return b && (b.x0 === 0 || b.x1 === cell.width - 1) }), '对照：等分会切断')
    const norm = normalizeFrames(sp5, { cutout: { method: 'keyWhite', threshold: 0.1 }, align: 'baseline' })
    assert(norm.every((f) => f.width === norm[0].width && f.height === norm[0].height), '不等大格统一尺寸')
  }

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
  kind: 'anim', animId: DOODLE, prompt: 'realistic photo', animInputs: need, alpha: true,
})
assert(enq.ok && enq.job.kind === 'anim' && enq.job.id.startsWith('a_'), `动画入队失败: ${enq.error}`)
assert(!enq.job.prompt.includes('realistic photo') && enq.job.params.anim.frames === 25 && enq.job.params.size === '1:1', '提示词只来自动画包、25 帧 1:1')
const early = await roundtrip('GET', `/api/ai-jobs/${enq.job.id}/output`)
assert(!early.ok && early.code === 409, '未完成任务拿回应返回 409')
const bad = await roundtrip('POST', '/api/ai-jobs', { kind: 'anim', animId: DOODLE, animInputs: { character: 'x' } })
assert(!bad.ok && /动作/.test(bad.error), '入队校验必填')
const segEnq = await roundtrip('POST', '/api/ai-jobs', { kind: 'anim', animId: DOODLE, animInputs: need, segments: ['挥手'] })
assert(segEnq.ok && segEnq.job.params.anim.frames === 49 && segEnq.job.params.anim.sheets === 2, `分段入队: ${segEnq.error}`)
const badFrom = await roundtrip('POST', '/api/ai-jobs', { kind: 'anim', animId: DOODLE, animInputs: need, characterFrom: '../x' })
assert(!badFrom.ok && /characterFrom/.test(badFrom.error), '沿用角色 id 校验')
const { AI_OUT } = await import('../server/aiJobs.mjs')
mkdirSync(AI_OUT, { recursive: true })
writeFileSync(path.join(AI_OUT, `${enq.job.id}_char.png`), Buffer.from('png'))
const reuse = await roundtrip('POST', '/api/ai-jobs', { kind: 'anim', animId: DOODLE, animInputs: need, characterFrom: enq.job.id })
assert(reuse.ok && reuse.job.params.characterFrom === enq.job.id, `沿用角色入队: ${reuse.error}`)
const missing = await roundtrip('POST', '/api/ai-jobs', { kind: 'anim', animId: DOODLE, animInputs: need, characterFrom: 'a_none' })
assert(!missing.ok && /找不到/.test(missing.error), '沿用不存在的角色')

console.log('anim-pack self-check ok')
process.exit(0)
