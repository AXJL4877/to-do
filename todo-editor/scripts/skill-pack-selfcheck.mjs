/**
 * 技能包自检：协议校验 / 参数编译 / 规划清洗 / 渲染端协议行 / HTTP 路由。
 * 加 --render 再跑离线端到端（不调用任何云端接口），约 2 分钟：
 *   黑板手绘：合成粉笔元素图 + 手写规划；配音：预置 wav + 逐字时间戳（不调 TTS）；字幕：按该时间戳切条 + 透明底烧录。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.TODO_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'todo-skill-'))
const RENDER = process.argv.includes('--render')

const {
  BUILTIN_SKILL_DIR, assetAspect, assetPrompt, buildPlannerMessages, compileSkillById, fallbackPlan,
  getSkillEntry, listSkillPacks, resolveSkillParams, sanitizePlan, skillAlpha, validateSkillPack, cleanScript,
} = await import('../server/skillPacks.mjs')
const { elementImageName, executeSkillJob, parseRenderLine, subtitleNames, ttsNames, ttsVoice } = await import('../server/skillJobs.mjs')
const { parseSynthStdout } = await import('../server/ttsTimeline.mjs')
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
  const out = { statusCode: 0, body: '', headers: {}, setHeader(k, v) { this.headers[k] = v }, end(s = '') { this.body = s } }
  await handleAiHttp({ method, url, async *[Symbol.asyncIterator]() { yield* chunks } }, out)
  return out
}

const CHALK = 'builtin.chalk-hand'
const VOICE = 'builtin.voice-subtitle'
const TTS = 'builtin.tts-voice'
const chalkDir = path.join(BUILTIN_SKILL_DIR, 'chalk-hand')
const voiceDir = path.join(BUILTIN_SKILL_DIR, 'voice-subtitle')
const ttsDir = path.join(BUILTIN_SKILL_DIR, 'tts-voice')
const raw = () => JSON.parse(readFileSync(path.join(chalkDir, 'skill.json'), 'utf8'))
const rawVoice = () => JSON.parse(readFileSync(path.join(voiceDir, 'skill.json'), 'utf8'))
const rawTts = () => JSON.parse(readFileSync(path.join(ttsDir, 'skill.json'), 'utf8'))

// 1. 内置包合法；公开描述不泄露规划提示词 / 素材模板 / 选项片段
const listed = listSkillPacks()
assert(listed.errors.length === 0, `内置技能包校验失败: ${JSON.stringify(listed.errors)}`)
const pub = listed.skills.find((s) => s.id === CHALK)
assert(pub, '列表中应有黑板手绘')
const pubText = JSON.stringify(pub)
assert(!pubText.includes('"system"') && !pubText.includes('template') && !pubText.includes('"prompt":'), '公开描述不应含提示词')
assert(pub.output.mime === 'video/webm' && pub.previews.length >= 1, '输出 webm 且有预览图')
assert(pub.pipeline === 'elements' && pub.planner?.maxElements === 6, '黑板手绘走 elements 管线')
const pubVoice = listed.skills.find((s) => s.id === VOICE)
assert(pubVoice?.pipeline === 'subtitle' && pubVoice.planner === null && pubVoice.assets === null, '字幕走 subtitle 管线、无规划器 / 素材')
const pubTts = listed.skills.find((s) => s.id === TTS)
assert(pubTts?.pipeline === 'tts' && pubTts.output.mime === 'audio/wav' && pubTts.params.map((p) => p.id).join() === 'voice,cloneId', '配音走 tts 管线、输出 wav、可选音色')

// 2. 包校验：拒绝未知字段、错误规范、越界 when、危险入口
const bad = (patch, pattern, msg) => throws(() => validateSkillPack({ ...raw(), ...patch }, chalkDir), pattern, msg)
bad({ extra: 1 }, /extra/, '未知字段')
bad({ spec: 'todo-skill-pack/2' }, /spec/, '规范版本')
bad({ runtime: { type: 'python', entry: '../x.py', timeoutSec: 60 } }, /runtime\.entry/, '入口越出包目录')
bad({ output: { mime: 'video/mp4', codec: 'vp9' } }, /output\.mime/, '只支持 webm')
{
  const r = raw()
  r.params.find((p) => p.id === 'tone').when = { background: ['nope'] }
  throws(() => validateSkillPack(r, chalkDir), /when\.background/, 'when 取值非法')
  const r2 = raw()
  r2.assets.template = r2.assets.template.replace('{{draw}}', '{{secret}}')
  throws(() => validateSkillPack(r2, chalkDir), /占位符/, '模板占位符白名单')
}
bad({ pipeline: 'magic' }, /pipeline/, '未知管线')
throws(() => validateSkillPack({ ...rawVoice(), planner: raw().planner }, voiceDir), /planner/, 'subtitle 管线不许带规划器')
throws(() => validateSkillPack({ ...rawTts(), input: { label: '文案', maxLength: 9000 } }, ttsDir), /1~5000/, 'tts 文案上限')
throws(() => validateSkillPack({ ...rawTts(), runtime: rawVoice().runtime }, ttsDir), /不带渲染端/, 'tts 管线不带渲染端')
throws(() => validateSkillPack({ ...rawTts(), output: { mime: 'video/webm', codec: 'vp9' } }, ttsDir), /audio\/wav/, 'tts 只出 wav')
throws(() => validateSkillPack({ ...rawVoice(), output: { mime: 'audio/wav', codec: 'pcm' } }, voiceDir), /video\/webm/, 'subtitle 只出 webm')
throws(() => validateSkillPack({ ...raw(), input: { label: '描述', maxLength: 3000 } }, chalkDir), /1~1000/, 'elements 描述上限不变')

// 3. 参数：默认 / 吸附步长 / 拒绝未知与越界
const { pack } = getSkillEntry(CHALK)
const defaults = resolveSkillParams(pack, {})
assert(defaults.background === 'board' && defaults.duration === 8 && defaults.elements === 0, '默认参数')
assert(resolveSkillParams(pack, { duration: 8.26 }).duration === 8.5, '时长按 step 吸附')
assert(resolveSkillParams(pack, { fps: 24 }).fps === '24', '数字形式的选项值按字符串匹配')
throws(() => resolveSkillParams(pack, { foo: 1 }), /没有参数 "foo"/, '未知参数')
throws(() => resolveSkillParams(pack, { duration: 99 }), /时长/, '越界')
throws(() => resolveSkillParams(pack, { background: 'green' }), /不支持选项/, '非法选项')
assert(skillAlpha(pack, { ...defaults, background: 'transparent' }) && !skillAlpha(pack, defaults), '透明背景才带 alpha')

// 3b. 配音音色：咪仔默认；克隆音必须填合法的 S_ 音色 ID；隐藏时不校验
{
  const { pack: tts } = getSkillEntry(TTS)
  const d = resolveSkillParams(tts, {})
  assert(d.voice === 'mizai' && d.cloneId === '', '默认咪仔')
  assert(resolveSkillParams(tts, { voice: 'mizai', cloneId: 'bad id' }).voice === 'mizai', '咪仔时不校验克隆 ID')
  throws(() => resolveSkillParams(tts, { voice: 'clone' }), /格式不对/, '克隆音缺 ID')
  throws(() => resolveSkillParams(tts, { voice: 'clone', cloneId: 'abc' }), /格式不对/, '克隆 ID 格式')
  assert(resolveSkillParams(tts, { voice: 'clone', cloneId: '  S_demo123  ' }).cloneId === 'S_demo123', '克隆 ID 去空白')
  throws(() => resolveSkillParams(tts, { cloneId: 5 }), /./, '文本参数必须是字符串')
  const bt = (patch, pattern, msg) => {
    const r = rawTts()
    Object.assign(r.params.find((p) => p.id === 'cloneId'), patch)
    throws(() => validateSkillPack(r, ttsDir), pattern, msg)
  }
  bt({ pattern: '([' }, /pattern/, '文本参数正则非法')
  bt({ maxLength: 999 }, /maxLength/, '文本参数长度上限')
  assert(JSON.stringify(ttsVoice({ voice: 'mizai' })) === JSON.stringify({ speaker: 'zh_female_mizai_uranus_bigtts', resourceId: 'seed-tts-2.0' }), '咪仔音色映射')
  assert(JSON.stringify(ttsVoice({ voice: 'clone', cloneId: 'S_demo123' })) === JSON.stringify({ speaker: 'S_demo123', resourceId: 'seed-icl-2.0' }), '克隆音映射')
  compileSkillById(TTS, { prompt: '你好世界', params: { voice: 'clone', cloneId: 'S_demo123' } })
}

// 4. 规划清洗：截断、补默认角色 / 权重、数量限制
const plan = sanitizePlan({
  title: '复利的力量是时间给的',
  elements: [
    { label: '一棵越长越大的树长长长长', draw: 'a tree growing', weight: 9 },
    { label: '', draw: 'coins stacking', role: 'bogus' },
    { label: '空', draw: '   ' },
  ],
}, pack)
assert(plan.title.length <= 12 && plan.elements.length === 2, '标题截断、空元素丢弃')
assert(plan.elements[0].role === 'hero' && plan.elements[0].weight === 3 && plan.elements[0].label.length === 12, '首元素 hero、权重封顶')
assert(plan.elements[1].role === 'support' && plan.elements[1].weight === 1 && plan.elements[1].label === '元素 2', '补默认角色与名称')
throws(() => sanitizePlan({ elements: [] }, pack), /没有可用/, '空规划')
throws(() => sanitizePlan({ elements: Array(9).fill({ draw: 'x' }) }, pack, { strict: true }), /最多 6/, '严格模式数量上限')
assert(sanitizePlan({ elements: Array(9).fill({ draw: 'x' }) }, pack, { count: 3 }).elements.length === 3, '按元素数截断')
assert(fallbackPlan(pack, '讲一下复利').elements.length === 1, '兜底规划')

// 5. 编译请求
const job = compileSkillById(CHALK, { prompt: '  复利 {{x}} 的力量 ', params: { background: 'transparent', elements: 2 }, plan: { elements: [{ draw: 'a' }, { draw: 'b' }] } })
assert(job.prompt === '复利 x 的力量' && job.alpha && job.meta.alpha && job.meta.pipeline === 'elements', '提示词清洗 + 透明标记')
throws(() => compileSkillById(CHALK, { prompt: '复利', params: { elements: 3 }, plan: { elements: [{ draw: 'a' }] } }), /与「元素数」3 不符/, '规划数量须与元素数一致')
throws(() => compileSkillById(CHALK, { prompt: '' }), /请填写/, '空提示词')
throws(() => compileSkillById(CHALK, { prompt: 'x'.repeat(401) }), /最多 400/, '提示词长度')
throws(() => compileSkillById('nobody.nothing', { prompt: 'x' }), /未找到技能包/, '未知技能')

// 6. 规划器提示词 / 素材提示词 / 画幅
const msgs = buildPlannerMessages(pack, '复利', { ...defaults, elements: 3 })
assert(msgs[0].content.includes('恰好 3 个') && msgs[1].content === '复利', '规划器按元素数约束')
const ap = assetPrompt(pack, { label: '树', draw: 'a big tree', role: 'hero' }, { ...defaults, palette: 'mono' })
assert(ap.includes('a big tree') && !/\{\{|\}\}/.test(ap) && /Avoid:/.test(ap), '素材提示词无残留占位符')
assert(ap !== assetPrompt(pack, { label: '树', draw: 'a big tree', role: 'hero' }, defaults), '配色选项影响素材提示词')
assert(assetAspect({ size: '1080x1920' }, 1) === '9:16' && assetAspect({ size: '1080x1920' }, 3) === '1:1', '画幅')

// 6b. 配音 / 字幕：文案清洗 / 编译 / 参数 / TTS 输出解析
assert(cleanScript('  第一段 {x}\r\n\r\n\r\n第二段\t 内容  ') === '第一段 {x}\n\n第二段 内容', '文案保留分段、压空白、不删花括号')
{
  const t = compileSkillById(TTS, { prompt: '复利是时间的朋友。\n慢慢变富。' })
  assert(!t.alpha && t.meta.pipeline === 'tts' && t.plan === null && t.prompt.includes('\n'), '配音保留分段、无规划')
  assert(compileSkillById(TTS, { prompt: 'x'.repeat(5000) }).prompt.length === 5000, '文案 5000 字内可入队')
  throws(() => compileSkillById(TTS, { prompt: 'x'.repeat(5001) }), /最多 5000/, '文案上限')
  throws(() => compileSkillById(TTS, { prompt: '。。！' }), /没有可朗读/, '纯标点文案')
  throws(() => compileSkillById(TTS, { prompt: '你好', params: { fontPx: 64 } }), /没有参数/, '配音不收字幕参数')
  const v = compileSkillById(VOICE, { prompt: '复利是时间的朋友。', params: { fontPx: 65, font: 'kaiti' } })
  assert(v.alpha && v.meta.pipeline === 'subtitle' && v.plan === null, '字幕恒为透明底、无规划')
  assert(v.params.size === '1920x1080' && v.params.maxChars === 18 && v.params.fontPx === 66 && v.params.bottomPct === 6 && v.params.font === 'kaiti', '字幕默认参数 / 字号按步长吸附')
  throws(() => compileSkillById(VOICE, { prompt: '你好', params: { bottomPct: 95 } }), /距底/, '距底越界')
  throws(() => compileSkillById(VOICE, { prompt: '你好', params: { fontSize: 'l' } }), /没有参数/, '旧档位参数不再入队')
  throws(() => compileSkillById(VOICE, { prompt: '你好', plan: { elements: [{ draw: 'a' }] } }), /不接受元素规划/, 'subtitle 管线拒绝 plan')
  throws(() => compileSkillById(VOICE, { prompt: '你好', params: { maxChars: 50 } }), /每条字数/, '每条字数越界')
  assert(ttsNames('s_a').audio === 's_a_voice.wav' && subtitleNames('s_a').subtitles === 's_a_subtitles.json', '配音 / 字幕文件命名')
  assert(parseSynthStdout('warn\n{"ok":true,"audio":"a.wav","duration":2}').duration === 2, 'TTS stdout 取最后一行 JSON')
  assert(parseSynthStdout('Traceback boom').ok === false, 'TTS 非 JSON 输出视为失败')
}

// 7. 渲染端协议行
assert(parseRenderLine('@progress {"phase":"编码","pct":0.5}')?.data.pct === 0.5, '@progress')
assert(parseRenderLine('@result {"video":"a.webm"}')?.tag === 'result', '@result')
assert(parseRenderLine('普通日志') === null && parseRenderLine('@progress {bad') === null, '非协议行 / 坏 JSON 忽略')
assert(elementImageName('s_x', 0) === 's_x_el1.png', '元素图命名')

// 8. HTTP
{
  const list = await roundtrip('GET', '/api/ai-skills')
  const body = JSON.parse(list.body)
  assert(list.statusCode === 200 && body.skills.some((s) => s.id === CHALK), 'GET /api/ai-skills')
  const prev = await roundtrip('GET', `/api/ai-skills/${CHALK}/previews/0`)
  assert(prev.statusCode === 200 && Buffer.isBuffer(prev.body), '预览图路由')
  const noPrompt = JSON.parse((await roundtrip('POST', '/api/ai-skill-plan', { skillId: CHALK, prompt: ' ' })).body)
  assert(!noPrompt.ok && /请填写/.test(noPrompt.error), '规划接口校验提示词')
  const badJob = JSON.parse((await roundtrip('POST', '/api/ai-jobs', { kind: 'skill', skillId: CHALK, prompt: 'x', params: { size: '1x1' } })).body)
  assert(!badJob.ok && /不支持选项/.test(badJob.error), '入队前校验参数')
  const voicePrev = await roundtrip('GET', `/api/ai-skills/${VOICE}/previews/0`)
  assert(voicePrev.statusCode === 200 && Buffer.isBuffer(voicePrev.body), '口播字幕预览图路由')
  const voicePlan = JSON.parse((await roundtrip('POST', '/api/ai-skill-plan', { skillId: VOICE, prompt: '你好' })).body)
  assert(!voicePlan.ok && /不需要规划/.test(voicePlan.error), '字幕不走规划接口')
  const noSource = JSON.parse((await roundtrip('POST', '/api/ai-jobs', { kind: 'skill', skillId: VOICE, sourceJobId: 's_missing', params: {} })).body)
  assert(!noSource.ok && /没有配音文案和时间戳/.test(noSource.error), '字幕必须指定已完成的配音或素材文件')
  const asrJob = (sourceMedia) => roundtrip('POST', '/api/ai-jobs', { kind: 'skill', skillId: VOICE, sourceJobId: 's_missing', sourceMedia, params: {} }).then((r) => JSON.parse(r.body))
  const noPath = await asrJob({ url: 'blob:http://x/1', name: 'a.wav' })
  assert(!noPath.ok && /没有本地文件/.test(noPath.error), '语音识别：浏览器素材没有本地路径')
  const badExt = await asrJob({ url: 'file:///x', path: path.resolve('package.json') })
  assert(!badExt.ok && /不支持的音视频格式/.test(badExt.error), '语音识别：只认音视频扩展名')
  const gone = await asrJob({ url: 'file:///x', path: path.resolve('no-such-audio.wav') })
  assert(!gone.ok && /找不到素材文件/.test(gone.error), '语音识别：文件不存在')
}

// 9. 离线端到端
if (RENDER) {
  const { encodePng } = await import('../server/imageCutout.mjs')
  const { writeFileSync } = await import('node:fs')
  const out = mkdtempSync(path.join(tmpdir(), 'todo-skill-out-'))
  const chalkImage = (draw) => {
    const W = 512
    const data = Buffer.alloc(W * W * 4)
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        const [r, g, b] = draw(x - W / 2, y - W / 2)
        const i = (y * W + x) * 4
        data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255
      }
    }
    return encodePng({ width: W, height: W, data })
  }
  const ring = (x, y) => (Math.abs(Math.hypot(x, y) - 150) < 9 ? [235, 235, 230] : Math.hypot(x, y) < 60 ? [240, 190, 60] : [0, 0, 0])
  const box = (x, y) => {
    const edge = Math.max(Math.abs(x), Math.abs(y))
    return Math.abs(edge - 140) < 8 ? [230, 230, 225] : Math.abs(x - y) < 6 && edge < 140 ? [90, 170, 230] : [0, 0, 0]
  }
  const { resolveFfmpeg } = await import('../server/animBuild.mjs')
  const { execFileSync, spawnSync } = await import('node:child_process')
  const ffmpeg = resolveFfmpeg()
  for (const pass of [{ background: 'board' }, { background: 'transparent', tone: 'ink' }]) {
    const id = `s_selfcheck_${pass.background}`
    writeFileSync(path.join(out, elementImageName(id, 0)), chalkImage(ring))
    writeFileSync(path.join(out, elementImageName(id, 1)), chalkImage(box))
    const c = compileSkillById(CHALK, {
      prompt: '自检：太阳和盒子',
      params: { ...pass, duration: 3, hold: 0.5, quality: 'draft' },
      plan: { title: '自检', elements: [{ label: '太阳', draw: 'sun', weight: 1.5 }, { label: '盒子', draw: 'box' }] },
    })
    const phases = []
    const t0 = Date.now()
    const o = await executeSkillJob({ id, params: { request: { skillId: CHALK, prompt: c.prompt, params: c.params, plan: c.plan } } }, {
      outDir: out, config: {}, phase: (s) => phases.push(s), saveParams() {}, withRetry: (fn) => fn(),
    })
    const video = path.join(out, path.basename(o.video))
    assert(o.spec === 'todo-skill-output/1' && existsSync(video) && statSync(video).size > 10_000, `${pass.background}: 输出 webm`)
    assert(o.alpha === (pass.background === 'transparent'), `${pass.background}: alpha 标记`)
    assert(o.elements.length === 2 && o.elements[0].startMs < o.elements[1].startMs, `${pass.background}: 元素按序书写`)
    assert(o.width === 1280 && o.height === 720 && Math.abs(o.duration - 3) < 0.2, `${pass.background}: 尺寸 / 时长`)
    assert(!/Audio:/.test(spawnSync(ffmpeg, ['-hide_banner', '-i', video], { encoding: 'utf8' }).stderr), `${pass.background}: 不带音轨`)
    assert(phases.some((p) => /书写渲染（\d+%）/.test(p)), `${pass.background}: 渲染进度回调`)
    assert(existsSync(path.join(out, `${id}.json`)), `${pass.background}: 清单落盘`)
    console.log(`  ${pass.background}: ${o.frames} 帧，${((Date.now() - t0) / 1000).toFixed(1)}s，${(statSync(video).size / 1024).toFixed(0)} KB`)
  }

  // 配音：预置 wav + 逐字时间戳（已存在就不调 TTS）；前半句 0.2~1.4s，后半句 1.8~2.4s
  const text = '复利是时间的朋友。慢慢变富。'
  const ttsId = 's_selfcheck_tts'
  let tts
  {
    const n = ttsNames(ttsId)
    execFileSync(ffmpeg, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=2.5', path.join(out, n.audio)])
    const spans = [[...'复利是时间的朋友。'], [...'慢慢变富。']]
    const chars = [
      ...spans[0].map((ch, i) => ({ text: ch, start: 0.2 + i * (1.2 / spans[0].length), end: 0.2 + (i + 1) * (1.2 / spans[0].length) })),
      ...spans[1].map((ch, i) => ({ text: ch, start: 1.8 + i * (0.6 / spans[1].length), end: 1.8 + (i + 1) * (0.6 / spans[1].length) })),
    ]
    writeFileSync(path.join(out, n.timing), JSON.stringify({ text, duration: 2.5, speaker: 'selfcheck', chars }))
    const c = compileSkillById(TTS, { prompt: text })
    tts = await executeSkillJob({ id: ttsId, params: { request: { skillId: TTS, prompt: c.prompt, params: c.params, plan: null } } }, {
      outDir: out, config: {}, phase() {}, saveParams() {}, withRetry: (fn) => fn(),
    })
    assert(tts.audio.endsWith('_voice.wav') && tts.duration === 2.5 && tts.narration.timing.endsWith('_timing.json') && !tts.video, 'tts: 只出配音 + 时间戳')
    assert(existsSync(path.join(out, `${ttsId}.json`)), 'tts: 清单落盘')
  }

  // 字幕：取上面的配音，时间来自逐字时间戳（不跑 ASR），透明底、不带音轨
  {
    const id = 's_selfcheck_subtitle'
    const c = compileSkillById(VOICE, { prompt: text, params: { size: '1280x720', maxChars: 10 } })
    const source = { jobId: ttsId, text, audio: tts.narration.audio, timing: tts.narration.timing, duration: tts.duration }
    const phases = []
    const t0 = Date.now()
    const o = await executeSkillJob({ id, params: { request: { skillId: VOICE, prompt: c.prompt, params: c.params, plan: null, source } } }, {
      outDir: out, config: {}, phase: (s) => phases.push(s), saveParams() {}, withRetry: (fn) => fn(),
    })
    const video = path.join(out, path.basename(o.video))
    const probe = spawnSync(ffmpeg, ['-hide_banner', '-i', video], { encoding: 'utf8' }).stderr
    const cues = o.subtitles.cues
    assert(o.alpha && o.width === 1280 && o.height === 720 && Math.abs(o.duration - 2.5) < 0.05, `subtitle: 透明底 + 尺寸 + 时长跟配音 → ${o.duration}`)
    assert(!/Audio:/.test(probe) && /alpha_mode\s*:\s*1/i.test(probe), `subtitle: webm 带 alpha、不带音轨：${probe.slice(-300)}`)
    assert(cues.map((q) => q.text).join('').replace(/\s/g, '') === '复利是时间的朋友慢慢变富', 'subtitle: 字幕正文只用文案')
    assert(cues.length === 2 && Math.abs(cues[0].start - 0.2) < 0.05 && Math.abs(cues[1].start - 1.8) < 0.1, `subtitle: 起点对上逐字时间戳 → ${JSON.stringify(cues)}`)
    assert(cues.every((q, i, a) => q.start < q.end && (i === 0 || a[i - 1].end <= q.start + 1e-3)), 'subtitle: 时间递增不重叠')
    assert(o.source.jobId === ttsId && existsSync(path.join(out, path.basename(o.subtitles.ass))), 'subtitle: 清单含来源配音与 ASS')
    assert(existsSync(path.join(out, path.basename(o.still))) && !existsSync(path.join(out, `${id}_work`)), 'subtitle: 静帧落盘、中间目录已清')
    assert(phases.some((p) => /编码（\d+%）/.test(p)), 'subtitle: 渲染进度回调')
    console.log(`  subtitle: ${cues.length} 条字幕，${((Date.now() - t0) / 1000).toFixed(1)}s，${(statSync(video).size / 1024).toFixed(0)} KB`)
  }
  // 1 个字的短文案也不能越界（burn-subtitles 尾锚曾在不足 10 字时 IndexError）
  {
    const id = 's_selfcheck_short'
    const n = ttsNames(id)
    execFileSync(ffmpeg, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=1', path.join(out, n.audio)])
    writeFileSync(path.join(out, n.timing), JSON.stringify({ text: '你是谁', duration: 1, chars: [...'你是谁。'].map((ch, i) => ({ text: ch, start: 0.3 + i * 0.15, end: 0.45 + i * 0.15 })) }))
    const c = compileSkillById(VOICE, { prompt: '你是谁', params: { size: '1280x720', font: 'xingkai', fontPx: 80, bottomPct: 40 } })
    const source = { jobId: id, text: '你是谁', audio: `/ai-generated/${n.audio}`, timing: `/ai-generated/${n.timing}`, duration: 1 }
    const o = await executeSkillJob({ id: `${id}_sub`, params: { request: { skillId: VOICE, prompt: c.prompt, params: c.params, plan: null, source } } }, {
      outDir: out, config: {}, phase() {}, saveParams() {}, withRetry: (fn) => fn(),
    })
    assert(o.subtitles.cues.length === 1 && o.subtitles.cues[0].text === '你是谁', 'subtitle: 短文案一条字幕')
    const ass = readFileSync(path.join(out, subtitleNames(`${id}_sub`).ass), 'utf8')
    const style = ass.split(/\r?\n/).find((l) => l.startsWith('Style:')) ?? ''
    // 1280x720：字号 = 720 × 80 / 1080 ≈ 53，距底 = 720 × 40% = 288
    assert(style.includes('STXingkai') && style.includes(',53,') && /,288,/.test(style), `subtitle: 系统字体 / 字号 / 距底写进 ASS → ${style}`)
  }
  // 没有文案：语音识别（需要一段真人声音，设 ASR_SAMPLE=<音视频路径> 才跑；首次要加载 whisper 模型）
  if (process.env.ASR_SAMPLE) {
    const id = 's_selfcheck_asr'
    const file = path.resolve(process.env.ASR_SAMPLE)
    const c = compileSkillById(VOICE, { prompt: '语音识别 · 自检', params: { size: '1280x720' } })
    const source = { mode: 'asr', jobId: null, text: '', audio: 'file:///selfcheck', file, name: path.basename(file), duration: null }
    const phases = []
    const t0 = Date.now()
    const o = await executeSkillJob({ id, params: { request: { skillId: VOICE, prompt: c.prompt, params: c.params, plan: null, source } } }, {
      outDir: out, config: {}, phase: (s) => phases.push(s), saveParams() {}, withRetry: (fn) => fn(),
    })
    const cues = o.subtitles.cues
    assert(o.source.mode === 'asr' && o.transcript.length > 0 && cues.length > 0, `asr: 识别出文字 → ${o.transcript}`)
    assert(cues.every((q, i, a) => q.start < q.end && (i === 0 || a[i - 1].end <= q.start + 1e-3)), 'asr: 时间递增不重叠')
    assert(phases.some((p) => /语音识别（\d+%）/.test(p)), 'asr: 识别进度回调')
    console.log(`  asr: ${cues.length} 条字幕「${o.transcript}」，${((Date.now() - t0) / 1000).toFixed(1)}s`)
  }
  rmSync(out, { recursive: true, force: true })
}

console.log(`skill-pack selfcheck ok${RENDER ? '（含离线渲染）' : ''}`)
