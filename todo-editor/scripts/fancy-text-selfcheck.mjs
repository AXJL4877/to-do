/**
 * AI 花字服务端自检：LLM 输出清洗 / JSON 提取 / 纹理提示词。不联网。
 * 用法：npm run fancy:check
 */
import assert from 'node:assert/strict'
import { sanitizeFancyStyle, extractJson, texturePrompt, buildFancyMessages } from '../server/fancyTextAi.mjs'

let n = 0
const ok = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`) }

console.log('fancy-text selfcheck')

ok('extractJson 兼容 ```json 包裹与前后废话', () => {
  const j = extractJson('好的，给你：\n```json\n{"name":"鎏金","fill":["#FFD700"]}\n```\n希望喜欢')
  assert.equal(j.name, '鎏金')
  assert.throws(() => extractJson('没有 JSON'), /JSON/)
})

ok('sanitize 夹紧越界值、丢弃非法颜色和描边', () => {
  const s = sanitizeFancyStyle({
    name: '一个非常非常非常长的样式名字啊啊',
    font: 'NotInstalled',
    fontWeight: 1234,
    fill: ['#FFD700', 'red; background:url(x)', '#A06C10', '#111', '#222', '#333'],
    fillAngle: 999,
    strokes: [{ color: '#000', width: 99 }, { color: 'bad', width: 3 }, { color: '#fff', width: 0 }],
    shadow: { color: 'rgba(0,0,0,0.5)', blur: 100, x: -100, y: 5 },
    extrude: { color: '#400', depth: 0 },
    glow: { color: 'javascript:alert(1)', blur: 20 },
    gloss: 5,
  }, ['Microsoft YaHei'])
  assert.equal(s.name.length, 12)
  assert.equal(s.font, null)
  assert.equal(s.fancy.fontWeight, 900)
  assert.deepEqual(s.fancy.fill, ['#FFD700', '#A06C10', '#111', '#222'])
  assert.equal(s.fancy.fillAngle, 360)
  assert.deepEqual(s.fancy.strokes, [{ color: '#000', width: 16 }])
  assert.deepEqual(s.fancy.shadow, { color: 'rgba(0,0,0,0.5)', blur: 40, x: -30, y: 5 })
  assert.equal(s.fancy.extrude, undefined)
  assert.equal(s.fancy.glow, undefined)
  assert.equal(s.fancy.gloss, 1)
})

ok('sanitize 字体只接受白名单、空 fill 兜底白色', () => {
  const s = sanitizeFancyStyle({ font: 'KaiTi', fill: [], textureIdea: '金箔' }, ['KaiTi'])
  assert.equal(s.font, 'KaiTi')
  assert.deepEqual(s.fancy.fill, ['#FFFFFF'])
  assert.equal(s.textureIdea, '金箔')
  assert.equal(s.name, 'AI 花字')
  assert.throws(() => sanitizeFancyStyle('nope'), /对象/)
})

ok('buildFancyMessages 带上字体白名单与文字', () => {
  const [sys, user] = buildFancyMessages({ prompt: '国潮', text: '山河无恙', fonts: ['KaiTi'] })
  assert.match(sys.content, /"KaiTi"/)
  assert.match(user.content, /山河无恙/)
  assert.match(user.content, /国潮/)
})

ok('texturePrompt 去掉花括号、拒绝空描述', () => {
  const p = texturePrompt('金箔{{x}}')
  assert.match(p, /金箔x/)
  assert.match(p, /[Ss]eamless tileable/)
  assert.throws(() => texturePrompt('  '), /纹理/)
})

console.log(`fancy-text selfcheck: ${n} passed`)
