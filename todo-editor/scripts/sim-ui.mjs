/**
 * sim-ui.mjs — 用 CDP 驱动 TO DO 界面（模拟真人点击/输入），每步留下截图。
 *
 * 为什么不用 puppeteer/playwright：本仓库没装，而 Electron 本身就是 Chromium，
 * 直接用 DevTools 协议就够（Runtime.evaluate + Page.captureScreenshot）。
 *
 * 用法：
 *   node scripts/sim-ui.mjs <步骤名> [参数...]
 *
 * 步骤：
 *   shot <名字>                     只截图
 *   newproject <项目名>             起屏点「新建项目」→ 填名 → 确定
 *   openskill                       打开素材库的「拓展」标签
 *   type <文本文件>                 把文本填进拓展的「口播文案」输入框（触发 React 事件）
 *   setparam <参数id> <值>          改一个参数（select/number/text）
 *   generate                        点「一键成片」开始生成
 *   watch <秒数>                    每 N 秒记录一次阶段/进度并截图
 *   report                          打印成片文档摘要 + 音效/层产物校验
 *   state                           打印当前界面可点元素（排查用）
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const PORT = process.env.TODO_DEBUG_PORT || '9222'
const SHOT_DIR = 'native/test-output/sim'
mkdirSync(SHOT_DIR, { recursive: true })

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = targets.find((t) => t.type === 'page')
if (!page) { console.error('没有可连页面，应用是不是没用 --debug-port 启动？'); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
let msgId = 0
const pending = new Map()
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++msgId
  pending.set(id, { res, rej })
  ws.send(JSON.stringify({ id, method, params }))
})
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
  }
})
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })

/** 在渲染进程里求值（支持 await） */
async function evalJs(body) {
  const r = await send('Runtime.evaluate', {
    expression: `(async () => { ${body} })()`,
    awaitPromise: true, returnByValue: true, userGesture: true,
  })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails).slice(0, 400))
  return r.result?.value
}

/** 截图（先等两帧，避免拍到布局未稳的中间态） */
async function shot(name) {
  await evalJs('await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
  const s = await send('Page.captureScreenshot', { format: 'png' })
  const file = path.join(SHOT_DIR, `${name}.png`)
  writeFileSync(file, Buffer.from(s.data, 'base64'))
  console.log(`  📷 ${file}`)
  return file
}

/** 注入到页面的通用小工具：真实事件派发（React 受控组件必须这样填值） */
const HELPERS = `
window.__sim = window.__sim || {
  // testid 里可能有 '.'（如 studio.spongebob-koubo），CSS 选择器必须加引号
  byTid(t){ const e=document.querySelector('[data-testid="'+t+'"]'); if(!e) throw new Error('找不到 [data-testid='+t+']'); return e },
  click(t){ const e=this.byTid(t); e.scrollIntoView({block:'center'}); e.click(); return e },
  setValue(el, v){
    const proto = el.tagName==='TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  },
  fill(t, v){ const e=this.byTid(t); this.setValue(e, v); return e },
  sleep(ms){ return new Promise(r=>setTimeout(r,ms)) },
  text(){ return document.body.innerText.slice(0, 400) },
};
`

const [step, ...args] = process.argv.slice(2)
console.log(`▶ ${step}${args.length ? ' ' + args.join(' ') : ''}`)

switch (step) {
  case 'shot':
    await shot(args[0] || 'shot')
    break

  case 'newproject': {
    const name = args[0]
    await evalJs(`${HELPERS}; window.__sim.click('start-new'); await window.__sim.sleep(500);`)
    await evalJs(`${HELPERS}; window.__sim.fill('newproj-name', ${JSON.stringify(name)}); await window.__sim.sleep(200);`)
    await shot('02-newproject-form')
    await evalJs(`${HELPERS}; window.__sim.click('newproj-submit');`)
    // 项目创建要写盘 + 加载，给足时间
    await evalJs(`await new Promise(r=>setTimeout(r, 4000))`)
    const st = await evalJs(`return { hasStart: !!document.querySelector('[data-testid=start-screen]'), testids: [...document.querySelectorAll('[data-testid]')].map(e=>e.dataset.testid).slice(0,60) }`)
    console.log(`  起屏还在? ${st.hasStart}`)
    console.log(`  可见 testid: ${st.testids.join(', ')}`)
    await shot('03-workspace')
    break
  }

  case 'openskill': {
    // 素材库左侧竖排标签里找「拓展」
    const r = await evalJs(`${HELPERS};
      const tabs = [...document.querySelectorAll('[data-testid^=lib-tab-]')];
      const info = tabs.map(t=>({tid:t.dataset.testid, text:(t.innerText||'').trim()}));
      const hit = tabs.find(t=>/拓展|技能|skill/i.test(t.innerText||'') || /skill/.test(t.dataset.testid));
      if (hit) { hit.click(); await window.__sim.sleep(800); }
      return { tabs: info, clicked: hit ? hit.dataset.testid : null };
    `)
    console.log(`  标签: ${r.tabs.map((t) => `${t.tid}(${t.text})`).join(' | ')}`)
    console.log(`  点了: ${r.clicked}`)
    await shot('04-skills-panel')
    break
  }

  case 'pick': {
    // 点开某个技能卡片（testid 里的点要用引号包住）
    const tid = args[0]
    const r = await evalJs(`${HELPERS};
      window.__sim.click(${JSON.stringify(tid)});
      await window.__sim.sleep(900);
      const tas = [...document.querySelectorAll('textarea,input')].filter(e=>e.offsetParent!==null);
      return { inputs: tas.map(e=>({tag:e.tagName, tid:e.dataset?.testid||'', ph:e.placeholder||'', len:String(e.value||'').length})),
               buttons: [...document.querySelectorAll('button')].filter(b=>b.offsetParent!==null).map(b=>({t:(b.innerText||'').trim().slice(0,16),tid:b.dataset.testid||''})).filter(x=>x.t).slice(0,20) };
    `)
    console.log(`  输入框: ${r.inputs.map((i) => `<${i.tag}> tid=${i.tid} ph="${i.ph}" len=${i.len}`).join(' | ') || '（无）'}`)
    console.log(`  按钮: ${r.buttons.map((b) => b.t).join(' / ')}`)
    await shot('05-skill-opened')
    break
  }

  case 'type': {
    const file = args[0]
    const text = readFileSync(file, 'utf8')
    const r = await evalJs(`${HELPERS};
      // 拓展面板里的口播输入框：优先找 textarea，其次大 input
      const cands = [...document.querySelectorAll('textarea, input[type=text], input:not([type])')]
        .filter(e => e.offsetParent !== null);
      const target = cands.sort((a,b)=> (b.clientHeight*b.clientWidth) - (a.clientHeight*a.clientWidth))[0];
      if (!target) throw new Error('找不到可输入的文本框');
      window.__sim.setValue(target, ${JSON.stringify(text)});
      await window.__sim.sleep(300);
      return { tag: target.tagName, tid: target.dataset?.testid||'', ph: target.placeholder||'', len: target.value.length };
    `)
    console.log(`  填入 ${r.len} 字 → <${r.tag}> testid=${r.tid} placeholder="${r.ph}"`)
    await shot('05-text-entered')
    break
  }

  case 'setparam': {
    const [pid, value] = args
    const r = await evalJs(`${HELPERS};
      const sel = document.querySelector('[data-testid="param-'+${JSON.stringify(pid)}+'"]') ||
                  document.querySelector('[data-param="'+${JSON.stringify(pid)}+'"]') ||
                  [...document.querySelectorAll('select,input')].find(e=>e.name===${JSON.stringify(pid)} || e.id===${JSON.stringify(pid)});
      if (!sel) return { found: false };
      window.__sim.setValue(sel, ${JSON.stringify(value)});
      await window.__sim.sleep(300);
      return { found: true, tag: sel.tagName, val: sel.value };
    `)
    console.log(r.found ? `  已设 ${pid} = ${r.val}` : `  ! 没找到参数 ${pid} 的控件`)
    break
  }

  case 'generate': {
    const r = await evalJs(`${HELPERS};
      const btns = [...document.querySelectorAll('button')].filter(b=>b.offsetParent!==null);
      const hit = btns.find(b=>/一键成片|开始生成|生成|发起/.test(b.innerText||''));
      if (!hit) return { clicked:null, candidates: btns.map(b=>(b.innerText||'').trim().slice(0,18)).filter(Boolean).slice(0,25) };
      hit.scrollIntoView({block:'center'}); hit.click();
      await window.__sim.sleep(1200);
      return { clicked: (hit.innerText||'').trim() };
    `)
    console.log(r.clicked ? `  点了「${r.clicked}」` : `  ! 没找到生成按钮。候选：${(r.candidates||[]).join(' / ')}`)
    await shot('06-generate-clicked')
    break
  }

  case 'watch': {
    const total = Number(args[0] || 60)
    const gap = Number(args[1] || 5)
    const rounds = Math.max(1, Math.floor(total / gap))
    for (let i = 1; i <= rounds; i++) {
      await evalJs(`await new Promise(r=>setTimeout(r, ${gap * 1000}))`)
      // 从界面文本里抓阶段/进度
      const s = await evalJs(`${HELPERS};
        const t = document.body.innerText;
        const m = t.match(/(待生成|已排队|配音|分镜|生图|渲染|字幕|底板|入轨|完成|停止|失败)[^\\n]{0,40}/g);
        const pct = t.match(/(\\d{1,3})%/g);
        return { marks: m ? [...new Set(m)].slice(0,6) : [], pct: pct ? pct.slice(0,4) : [] };
      `)
      console.log(`  [${i * gap}s] ${s.marks.join(' | ')}${s.pct.length ? '  进度 ' + s.pct.join(',') : ''}`)
      await shot(`07-progress-${String(i * gap).padStart(3, '0')}s`)
    }
    break
  }

  case 'state': {
    const r = await evalJs(`${HELPERS};
      return {
        testids: [...document.querySelectorAll('[data-testid]')].map(e=>e.dataset.testid).slice(0,80),
        buttons: [...document.querySelectorAll('button')].filter(b=>b.offsetParent!==null).map(b=>({t:(b.innerText||'').trim().slice(0,20), tid:b.dataset.testid||''})).slice(0,30),
      };
    `)
    console.log(JSON.stringify(r, null, 1))
    break
  }

  case 'report': {
    const r = await evalJs(`${HELPERS}; return { text: document.body.innerText.slice(0, 2500) }`)
    console.log(r.text)
    break
  }

  default:
    console.error(`未知步骤 ${step}`)
    process.exitCode = 2
}

ws.close()
