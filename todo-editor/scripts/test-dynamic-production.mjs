import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
process.env.TODO_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'todo-dynamic-production-'))
const { getSkillEntry, resolveSkillParams, validateSkillPack } = await import('../server/skillPacks.mjs')
const { createProduction } = await import('../server/production/job.mjs')
const { runProduction, publicView } = await import('../server/production/runner.mjs')
const { dynamicRenderHash, timedTextScenes } = await import('../server/production/dynamicText.mjs')
assert.equal(timedTextScenes([{ text: '零时长标点，', start: 0, end: 0 }, { text: '保留全部文字😀。', start: 0, end: 2 }], 2).map(s => s.content).join(''), '零时长标点，保留全部文字😀。')
const entry = getSkillEntry('builtin.dynamic-text')
assert.equal(entry.pack.pipeline, 'production')
assert.throws(() => validateSkillPack({ ...entry.pack, runtime: { type: 'text', engine: 'arbitrary' } }, entry.dir))
const outDir = path.join(process.env.TODO_DATA_DIR, 'ai-generated'); mkdirSync(outDir)
const script = '把灵感写下来，让文字跟着声音动起来。今天我们尝试动态排版，自动生成一段口播视频。'
const doc = createProduction({ skillId: entry.pack.id, script, params: { split: 'length', subtitles: 'off' } })
let synthCalls = 0
const services = {
  synth: async (text, o) => {
    synthCalls++
    const wav = Buffer.alloc(44 + 16000 * 8 * 2)
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
    wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
    wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40)
    for (let i = 44; i < wav.length; i += 2) wav.writeInt16LE(Math.round(1800 * Math.sin((i - 44) / 2 * Math.PI * 440 / 16000)), i)
    writeFileSync(o.audioFile, wav)
    writeFileSync(o.timingFile, JSON.stringify({ duration: 8, sentences: [{ text, start: 0, end: 8 }] }))
  },
  chat: async () => { throw new Error('offline fallback') },
  image: async () => { throw new Error('dynamic text must never request images') },
  render: async () => { throw new Error('dynamic text must use the editable host renderer') },
}
await runProduction(doc, { entry, outDir, services, phase: () => {} })
assert.equal(doc.status.failed.length, 0)
assert.ok(doc.segments.every(s => s.boards.length && s.boards.every(b => b.render.result.dynamicText)))
const view = publicView(doc, entry, outDir)
assert.ok(view.segments.every(s => !s.dirty.voice && !s.dirty.plan && s.boards.every(b => !b.dirty)))
const boards = doc.segments.flatMap(s => s.boards)
assert.equal(boards.map(b => b.elements[0].label).join(''), script)
assert.equal(boards[0].render.result.startMs, 0)
assert.equal(boards.at(-1).render.result.endMs, 8000)
assert.ok(new Set(boards.map(b => b.render.result.dynamicText.fancy.dynamic.presetId)).size > 1)
await runProduction(doc, { entry, outDir, services, phase: () => {} })
assert.equal(synthCalls, 1, 'rerun must reuse unchanged voice')
const before = boards[0].render.hash
doc.params = resolveSkillParams(entry.pack, { ...doc.params, motion: 0.2 })
await runProduction(doc, { entry, outDir, services, phase: () => {} })
assert.notEqual(boards[0].render.hash, before)
assert.equal(boards[0].render.result.dynamicText.fancy.dynamic.motion, 0.2)
assert.equal(synthCalls, 1, 'visual edits must not resynthesize voice')
const ctx = { doc, pack: entry.pack }
const lastSeg = doc.segments.at(-1); const lastBoard = lastSeg.boards.at(-1)
const lastHash = dynamicRenderHash(ctx, lastSeg, lastBoard)
doc.segments.push({ id: 'later', boards: [] })
assert.notEqual(dynamicRenderHash(ctx, lastSeg, lastBoard), lastHash, 'last-scene identity must invalidate tail')
doc.segments.pop()
doc.segments.unshift({ id: 'earlier', boards: [{}] })
assert.notEqual(dynamicRenderHash(ctx, lastSeg, lastBoard), lastHash, 'preceding scenes must invalidate automatic effect ordering')
doc.segments.shift()
const fixtures = path.resolve('native/test-output/dynamic-production'); mkdirSync(fixtures, { recursive: true })
const saved = publicView(doc, entry, outDir)
for (const seg of saved.segments) {
  const audio = path.join(fixtures, seg.voice.audio); copyFileSync(path.join(outDir, seg.voice.audio), audio)
  seg.voice.audioUrl = audio.replaceAll('\\', '/')
}
writeFileSync(path.join(fixtures, 'production.json'), JSON.stringify(saved))
console.log('PASS dynamic production: real manifest, timed text, automatic effects, no image calls, persistence and incremental rerun')
