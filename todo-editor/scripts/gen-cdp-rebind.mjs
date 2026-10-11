/**
 * 生成一段 CDP 求值脚本：把某个成片重新绑到当前工程的时间轴（走应用自己的
 * cleanKouboPollution + syncProduction），并保存。
 * 用法: node scripts/gen-cdp-rebind.mjs <成片id> [输出文件]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const id = process.argv[2]
if (!id) { console.error('用法: node scripts/gen-cdp-rebind.mjs <成片id> [输出文件]'); process.exit(1) }
const out = path.resolve(process.argv[3] || 'scripts/cdp-rebind-card.js')
const docPath = path.join(process.env.APPDATA || '', 'todo-editor', 'data', 'productions', `${id}.json`)
const b64 = Buffer.from(readFileSync(docPath, 'utf8'), 'utf8').toString('base64')

const expr = `const b64 = ${JSON.stringify(b64)};
const doc = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
const store = window.__TODO_STORE__ || (await import('/src/store.ts')).useApp;
window.__TODO_STORE__ = store;
const { syncProduction } = await import('/src/lib/productionTimeline.ts');
const { cleanKouboPollution } = await import('/src/lib/liveAcceptKoubo.ts');
const id = doc.id;
const aps = { ...store.getState().settings.aiProductions };
for (const k of Object.keys(aps)) aps[k] = { ...aps[k], auto: k === id };
aps[id] = { ...(aps[id] || {}), t0: 0, auto: true, placed: {}, createdAt: Date.now() };
store.setState({ settings: { ...store.getState().settings, aiProductions: aps } });
const removed = cleanKouboPollution(id);
const changed = syncProduction(doc);
await store.getState().flushProject();
const st = store.getState();
const seq = st.sequences.find((s) => s.id === st.activeSeqId) || st.sequences[0];
const mine = seq.clips.filter((c) => c.meta?.source?.jobId === id);
return JSON.stringify({
  removed, changed, clips: seq.clips.length, tracks: seq.tracks.length, myClips: mine.length,
  cardLayers: mine.filter((c) => /黄卡|card/i.test(String(c.name || ''))).map((c) => c.name + ' @' + c.start.toFixed(2)),
  save: 'ok',
}, null, 2);
`
writeFileSync(out, expr, 'utf8')
console.log(`wrote ${out} (${expr.length} bytes) for production ${id}`)
