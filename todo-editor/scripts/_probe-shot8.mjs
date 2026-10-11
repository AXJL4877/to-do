// 查清：shot8 的层为什么绑错语序 —— 看层字段、timing 的 phrases、brief 的锚点
import { readFileSync } from 'node:fs'
import path from 'node:path'

const pack = path.join(process.env.APPDATA || '', 'todo-editor', 'data', 'skills', 'studio.spongebob-koubo', 'workflow')
const read = (p) => JSON.parse(readFileSync(path.join(pack, p), 'utf8'))

const plan = read('02_镜头设计/plan.json')
const timing = read('01_口播试听/timing.json')
const brief = read('02_镜头设计/briefs_locked.json')

const shot = plan.shots[8]
console.log('=== plan.shots[8] 的层 ===')
for (const l of shot.layers || []) {
  console.log(`  name=${String(l.name).slice(0, 28)}`)
  console.log(`     slot=${l._slot} role=${l.role} enter_at=${l.enter_at}`)
  console.log(`     phrase_match=${JSON.stringify(l.phrase_match ?? null)}`)
  console.log(`     _phrase=${JSON.stringify(l._phrase ?? null)}`)
  console.log(`     _why=${JSON.stringify(String(l._why ?? '').slice(0, 70))}`)
  console.log(`     所有键: ${Object.keys(l).join(',')}`)
}

const sent = (timing.sentences || []).find((x) => /穷人存钱/.test(String(x.text)))
console.log('\n=== timing 里该句 ===')
console.log(`  text=${sent?.text}`)
console.log(`  键: ${Object.keys(sent || {}).join(',')}`)
for (const [i, p] of (sent?.phrases || []).entries()) {
  console.log(`  phrase${i} [${Number(p.start).toFixed(2)}-${Number(p.end).toFixed(2)}] ${JSON.stringify(String(p.text || '').slice(0, 28))}`)
}

console.log('\n=== brief 里该镜的资产锚点 ===')
const shots = brief.shots || brief.briefs || []
const b8 = Array.isArray(shots) ? shots[8] : null
console.log(`  brief.shots[8] 键: ${b8 ? Object.keys(b8).join(',') : '(没有)'}`)
for (const a of (b8?.assets || [])) {
  console.log(`  asset name=${String(a.name || a.id).slice(0, 26)} slot=${a.slot} zone=${a.zone}`)
  console.log(`     phrase_match=${JSON.stringify(a.phrase_match ?? null)} phrase=${JSON.stringify(a.phrase ?? null)}`)
  console.log(`     键: ${Object.keys(a).join(',')}`)
}
