/**
 * 一次完整的「人类操作」演示，全部通过 CDP 真实点击完成：
 *   1. 打开拓展面板、选中海绵宝宝口播
 *   2. 入轨位置切到「接到末尾」（避开默认「从播放头」在 0 秒新开轨堆叠）
 *   3. 把文案填进输入框（模拟粘贴）
 *   4. 点「一键成片」
 * 随后采样时间轴，看 TTS 是不是**提前**入轨（本轮验证目标）。
 *
 * 用法: node scripts/demo-ui-generate.mjs <文案文件> [--no-generate] [--port 9222]
 */
import { readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const portIdx = argv.indexOf('--port')
const PORT = portIdx >= 0 ? argv[portIdx + 1] : (process.env.TODO_DEBUG_PORT || '9222')
const doGenerate = !argv.includes('--no-generate')
const textFile = argv.find((a) => !a.startsWith('--') && a !== PORT)
if (!textFile) { console.error('用法: node scripts/demo-ui-generate.mjs <文案文件> [--no-generate]'); process.exit(2) }
const text = readFileSync(textFile, 'utf8').trim()

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = targets.find((t) => t.type === 'page')
if (!page) { console.error('没有可用的 page 目标'); process.exit(2) }
console.log(`CDP 目标: ${page.title}`)

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
let msgId = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id); pending.delete(m.id)
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
  }
})
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++msgId; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params }))
})

/** 在页面里跑一段 async 表达式，返回 JSON 可序列化的值 */
async function evalPage(expr) {
  const r = await send('Runtime.evaluate', {
    expression: `(async () => { ${expr} })()`,
    awaitPromise: true, returnByValue: true,
  })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'page error')
  return r.result.value
}

const step = async (name, expr) => {
  const v = await evalPage(expr)
  console.log(`▶ ${name}${v !== undefined ? `  →  ${typeof v === 'string' ? v : JSON.stringify(v)}` : ''}`)
  return v
}

await send('Runtime.enable')

await step('1) 打开拓展面板 + 选海绵宝宝', `
  document.querySelector('[data-testid=lib-tab-skill]').click();
  await new Promise(r => setTimeout(r, 1800));
  const hit = document.querySelector("[data-testid='skill-pick-studio.spongebob-koubo']");
  if (!hit) return '找不到海绵宝宝入口';
  hit.click();
  await new Promise(r => setTimeout(r, 2200));
  return '已进入拓展面板';
`)

await step('2) 入轨位置切到「接到末尾」', `
  const end = document.querySelector("[data-testid='skill-placement-end']");
  if (!end) return '没有该按钮（可能没勾自动入轨）';
  end.click();
  await new Promise(r => setTimeout(r, 900));
  return '当前选中 = ' + [...document.querySelectorAll("[data-testid^='skill-placement-']")]
    .filter(e => e.className.includes('active')).map(e => e.dataset.testid).join(',');
`)

await step('3) 填入文案', `
  const ta = document.querySelector('[data-testid=skill-prompt]');
  if (!ta) return '没有输入框';
  const v = ${JSON.stringify(text)};
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, v);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 1200));
  return '已填入 ' + String(ta.value || '').length + ' 字';
`)

if (!doGenerate) { console.log('\n（--no-generate：没点生成）'); ws.close(); process.exit(0) }

await step('4) 点「一键成片」', `
  const btn = [...document.querySelectorAll('button')].find(b => (b.innerText || '').trim() === '一键成片');
  if (!btn) return '找不到按钮';
  btn.click();
  await new Promise(r => setTimeout(r, 1500));
  return '已点击';
`)

console.log('\n=== 采样时间轴（重点：配音是否在成片之前就进来）===')
const t0 = Date.now()
let prev = ''
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 4000))
  let s
  try {
    s = await evalPage(`
      const st = window.__TODO__.getState(); const q = st.seq();
      const names = q.clips.map(c => c.name || '').filter(Boolean);
      return { clips: q.clips.length, tracks: q.tracks.length,
               hasVoice: names.some(n => n.includes('配音')),
               hasBgm: names.some(n => n.includes('BGM')) };
    `)
  } catch { continue }
  const el = Math.round((Date.now() - t0) / 1000)
  const line = `clips=${String(s.clips).padStart(3)} tracks=${s.tracks} 配音=${s.hasVoice ? '✅' : '—'} BGM=${s.hasBgm ? '✅' : '—'}`
  if (line !== prev) { console.log(`[${String(el).padStart(4)}s] ${line}`); prev = line }
  if (s.hasVoice) {
    console.log(`\n★ 配音在第 ${el} 秒进入时间轴（成片通常要 6-10 分钟）`)
    break
  }
  if (i === 89) console.log('\n（90 次采样结束，配音仍未入轨）')
}
ws.close()
