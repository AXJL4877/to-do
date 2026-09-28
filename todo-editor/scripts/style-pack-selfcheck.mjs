import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.TODO_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'todo-style-'))

const {
  BUILTIN_STYLE_DIR, USER_STYLE_DIR, compileStyleById, compileStyleJob, listStylePacks, validateStylePack,
} = await import('../server/stylePacks.mjs')
const { decodeImage, encodePng, keyWhite, trimTransparent } = await import('../server/imageCutout.mjs')
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
  const out = {
    statusCode: 0, body: '', setHeader() {}, end(s = '') { this.body = String(s) },
  }
  await handleAiHttp({ method, url, async *[Symbol.asyncIterator]() { yield* chunks } }, out)
  return JSON.parse(out.body || '{}')
}

async function rawGet(url) {
  const out = {
    statusCode: 0, type: '', size: 0,
    setHeader(k, v) { if (k === 'Content-Type') this.type = v },
    end(b = '') { this.size = b.length },
  }
  await handleAiHttp({ method: 'GET', url, async *[Symbol.asyncIterator]() {} }, out)
  return out
}

const PAPERCUT = 'builtin.papercut-cn'
const papercutDir = path.join(BUILTIN_STYLE_DIR, 'papercut-cn')
const papercutRaw = JSON.parse(readFileSync(path.join(papercutDir, 'style.json'), 'utf8'))

// 1. 内置包合法并可列出
const listed = listStylePacks()
assert(listed.errors.length === 0, `内置风格包校验失败: ${JSON.stringify(listed.errors)}`)
const pc = listed.styles.find((s) => s.id === PAPERCUT)
assert(pc, '列表中应有剪纸风格')
assert(!('prompt' in pc), '公开描述不应暴露模板')

// 2. 编译
const ok = compileStyleById(PAPERCUT, { inputs: { subject: '  一条锦鲤 {{palette}} ' } })
assert(ok.prompt.includes('一条锦鲤 palette'), '文本输入应去掉花括号并规整空白')
assert(!/\{\{|\}\}/.test(ok.prompt), '最终提示词不应残留占位符')
assert(ok.prompt.includes('vermilion red'), '默认纸色应为中国红')
assert(ok.prompt.includes('Avoid:'), '应拼接 avoid 列表')
assert(ok.size === '1:1' && ok.quality === '1K' && ok.model === 'gpt-image-2', '默认参数取自风格包')
assert(ok.meta.id === PAPERCUT && ok.meta.summary === '一条锦鲤 palette', 'meta 记录风格与摘要')

const black = compileStyleById(PAPERCUT, { inputs: { subject: '福娃', palette: 'black', layout: 'round' }, aspectRatio: '9:16' })
assert(black.prompt.includes('black paper') && black.prompt.includes('circular medallion'), 'select 片段替换')
assert(black.size === '9:16', '允许的画幅')

// 2b. 透明底：默认开启，锁定纯白底；关闭时尊重用户选择
assert(ok.cutout && ok.cutout.method === 'keyWhite' && ok.meta.cutout === true, '剪纸默认透明底')
const cutRice = compileStyleById(PAPERCUT, { inputs: { subject: '鱼', background: 'rice' }, cutout: true })
assert(cutRice.meta.inputs.background === 'white' && cutRice.prompt.includes('pure flat white'), '透明底强制纯白底')
const fullRice = compileStyleById(PAPERCUT, { inputs: { subject: '鱼', background: 'rice' }, cutout: false })
assert(fullRice.cutout === null && fullRice.meta.inputs.background === 'rice', '保留背景时可选宣纸底')
throws(() => compileStyleById(PAPERCUT, { inputs: { subject: '鱼' }, cutout: 'yes' }), /布尔/, 'cutout 类型')
{
  const noCut = JSON.parse(JSON.stringify(papercutRaw))
  delete noCut.cutout
  throws(() => compileStyleJob({ pack: noCut, dir: papercutDir }, { inputs: { subject: '鱼' }, cutout: true }), /不支持透明底/, '无 cutout 的包')
  assert(compileStyleJob({ pack: noCut, dir: papercutDir }, { inputs: { subject: '鱼' } }).cutout === null, '无 cutout 的包默认不抠')
}

// 2c. 抠像算法
{
  const px = (r, g, b) => [r, g, b, 255]
  const img = { width: 4, height: 1, data: Buffer.from([...px(255, 255, 255), ...px(250, 252, 251), ...px(220, 0, 0), ...px(237, 127, 127)]) }
  keyWhite(img, 0.08)
  const d = img.data
  assert(d[3] === 0 && d[7] === 0, '白色与近白噪点 → 透明')
  assert(d[8] === 220 && d[9] === 0 && d[11] === 255, '纯色纸保持不透明原色')
  assert(d[12] > 215 && d[13] < 5 && d[15] > 100 && d[15] < 160, '半混合边缘反混合出纸色 + 半透明')
  const big = { width: 10, height: 10, data: Buffer.alloc(400) }
  big.data[(5 * 10 + 5) * 4 + 3] = 255
  const t = trimTransparent(big, 0)
  assert(t.width === 1 && t.height === 1, '裁到内容包围盒')
  const round = decodeImage(encodePng(img))
  assert(round.width === 4 && round.data[8] === 220, 'PNG 编解码往返')
  throws(() => decodeImage(Buffer.from('RIFF0000WEBP')), /不支持的图片格式/, '拒绝未知格式')
}

// 2d. 蜡笔手绘：默认 16:9 满纸留白、不抠图；透明底时锁纯白底
{
  const CRAYON = 'builtin.crayon-doodle'
  assert(listed.styles.some((s) => s.id === CRAYON), '列表中应有蜡笔手绘风格')
  const c = compileStyleById(CRAYON, { inputs: { subject: '一只小猫' } })
  assert(c.prompt.includes('一只小猫') && c.prompt.includes('crayon') && c.prompt.includes('white drawing paper'), '蜡笔默认模板')
  assert(c.size === '16:9' && c.cutout === null, '蜡笔默认 16:9、保留背景')
  const cut = compileStyleById(CRAYON, { inputs: { subject: '猫', background: 'filled' }, cutout: true })
  assert(cut.cutout?.method === 'keyWhite' && cut.meta.inputs.background === 'white', '蜡笔透明底锁纯白底')
  const pencil = compileStyleById(CRAYON, { inputs: { subject: '马', palette: 'pencil', detail: 'doodle' } })
  assert(pencil.prompt.includes('graphite pencil') && pencil.prompt.includes('very few strokes'), '蜡笔 select 片段替换')
}

// 3. 越界输入一律拒绝
throws(() => compileStyleById(PAPERCUT, { inputs: {} }), /画面主体/, '缺必填')
throws(() => compileStyleById(PAPERCUT, { inputs: { subject: 'x'.repeat(121) } }), /最多 120/, '超长')
throws(() => compileStyleById(PAPERCUT, { inputs: { subject: 'a', palette: 'blue' } }), /不支持选项/, '非法选项')
throws(() => compileStyleById(PAPERCUT, { inputs: { subject: 'a', prompt: 'photo' } }), /没有输入项/, '未声明输入')
throws(() => compileStyleById(PAPERCUT, { inputs: { subject: 'a' }, aspectRatio: '2:3' }), /画幅/, '非法画幅')
throws(() => compileStyleById(PAPERCUT, { inputs: { subject: 'a' }, resolution: '4K' }), /分辨率/, '非法分辨率')
throws(() => compileStyleById(PAPERCUT, { inputs: { subject: 'a' }, model: 'sd-xl' }), /模型/, '非法模型')
throws(() => compileStyleById('nobody.none', { inputs: {} }), /未找到/, '未知风格')

// 4. 不合规的包无法通过校验
const clone = () => JSON.parse(JSON.stringify(papercutRaw))
const bad = [
  [(p) => { p.spec = 'todo-style-pack/0' }, /spec/],
  [(p) => { p.script = 'alert(1)' }, /不允许的字段 "script"/],
  [(p) => { p.prompt.template += ' {{mood}}' }, /\{\{mood\}\} 未在 inputs/],
  [(p) => { p.prompt.template = p.prompt.template.replace('{{background}}', '') }, /"background" 未在模板/],
  [(p) => { p.inputs[0].required = false }, /必填的 text/],
  [(p) => { p.inputs[1].default = 'nope' }, /default/],
  [(p) => { p.inputs[1].options[0].prompt = 'x {{subject}}' }, /不允许占位符/],
  [(p) => { p.inputs.push({ id: 'js', type: 'code', label: 'x' }) }, /只支持 text/],
  [(p) => { p.outputs = ['video'] }, /outputs/],
  [(p) => { p.image.aspectRatios = ['5:4'] }, /aspectRatios/],
  [(p) => { p.image.defaultResolution = '4K' }, /defaultResolution/],
  [(p) => { p.references = { images: ['../../secret.png'] } }, /包内相对路径/],
  [(p) => { p.references = { images: ['refs/missing.png'] } }, /文件不存在/],
  [(p) => { p.previews = ['previews/nope.png'] }, /previews\[0\].*文件不存在/],
  [(p) => { p.previews = ['../style.json'] }, /包内相对路径/],
  [(p) => { p.previews = ['style.json'] }, /仅支持/],
  [(p) => { p.tags = ['这是一个特别特别长的标签名字'] }, /12 字/],
  [(p) => { p.cutout.method = 'rembg' }, /cutout.method/],
  [(p) => { p.cutout.threshold = 0.9 }, /cutout.threshold/],
  [(p) => { p.cutout.lockInputs = { subject: 'x' } }, /只能锁定.*select/],
  [(p) => { p.cutout.lockInputs = { background: 'green' } }, /不是合法选项/],
  [(p) => { p.cutout.script = 'x' }, /不允许的字段 "script"/],
  [(p) => { p.id = 'Papercut' }, /id/],
  [(p) => { p.version = '1.0' }, /version/],
]
for (const [mutate, pattern] of bad) {
  const p = clone()
  mutate(p)
  throws(() => validateStylePack(p, papercutDir), pattern, `非法包 ${pattern}`)
}

// 5. 用户目录里的坏包被隔离，不影响其它风格
const brokenDir = path.join(USER_STYLE_DIR, 'broken')
mkdirSync(brokenDir, { recursive: true })
writeFileSync(path.join(brokenDir, 'style.json'), JSON.stringify({ ...clone(), id: 'user.broken', hack: 1 }))
const withBroken = listStylePacks()
assert(withBroken.errors.length === 1 && /hack/.test(withBroken.errors[0].error), '坏包应进入 errors')
assert(withBroken.styles.some((s) => s.id === PAPERCUT), '坏包不影响内置包')

// 6. HTTP：列表 + 入队时忽略自由提示词
const api = await roundtrip('GET', '/api/ai-styles')
assert(api.ok && api.styles.some((s) => s.id === PAPERCUT), 'GET /api/ai-styles')
const pcApi = api.styles.find((s) => s.id === PAPERCUT)
assert(pcApi.previews.length === 4 && pcApi.tags.length > 0, '公开描述带预览图和标签')
const img = await rawGet(pcApi.previews[0])
assert(img.statusCode === 200 && img.type === 'image/png' && img.size > 1000, '预览图可访问')
assert((await rawGet(`/api/ai-styles/${PAPERCUT}/previews/99`)).statusCode === 404, '越界下标 404')
assert((await rawGet('/api/ai-styles/nobody.none/previews/0')).statusCode === 404, '未知风格 404')
const enq = await roundtrip('POST', '/api/ai-jobs', {
  styleId: PAPERCUT, prompt: 'a realistic photo', model: 'gpt-image-2',
  styleInputs: { subject: '老虎', palette: 'redGold' }, size: '16:9', quality: '2K',
})
assert(enq.ok, `风格任务入队失败: ${enq.error}`)
assert(!enq.job.prompt.includes('realistic photo') && enq.job.prompt.includes('老虎'), '提示词只来自风格包')
assert(enq.job.params.style.id === PAPERCUT && enq.job.params.size === '16:9', '任务记录风格信息')
const rej = await roundtrip('POST', '/api/ai-jobs', { styleId: PAPERCUT, kind: 'video', styleInputs: { subject: '虎' } })
assert(!rej.ok && /只支持生图/.test(rej.error), '风格包拒绝生视频')

console.log('style-pack self-check ok')
process.exit(0)
