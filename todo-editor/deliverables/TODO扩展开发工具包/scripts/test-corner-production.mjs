import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
const temp=mkdtempSync(path.join(tmpdir(),'todo-corner-'))
process.env.TODO_DATA_DIR=path.join(temp,'data')
try {
  const {buildExtensionPack,installExtensionPack}=await import('../server/extensionPacks.mjs')
  const {getSkillEntry,resolveSkillParams}=await import('../server/skillPacks.mjs')
  const source=path.resolve('examples/extensions/corner-chain')
  installExtensionPack(buildExtensionPack(source))
  const entry=getSkillEntry('studio.corner-chain')
  const {createProduction}=await import('../server/production/job.mjs')
  const {runProduction,publicView}=await import('../server/production/runner.mjs')
  const {dynamicRenderHash}=await import('../server/production/dynamicText.mjs')
  const doc=createProduction({skillId:entry.pack.id,script:'文字从这里开始。在句尾转过九十度。放大进入下一句。再一次冲击画面。\n---\n新段落也继续轮换。不重复相同的开场。'})
  const outDir=path.join(temp,'output');mkdirSync(outDir)
  let calls=0
  const services={
    synth:async(text,opts)=>{calls++; const wav=Buffer.alloc(44+16000*8*2);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);writeFileSync(opts.audioFile,wav);writeFileSync(opts.timingFile,JSON.stringify({duration:8,sentences:[{text,start:0,end:8}]}))},
    chat:async()=>{throw new Error('offline fallback')},image:async()=>{throw new Error('pure text must not request images')},render:async()=>{throw new Error('host text renderer required')},
  }
  await runProduction(doc,{entry,outDir,services,phase:()=>{}})
  const boards=doc.segments.flatMap(s=>s.boards)
  assert(boards.length>=4)
  assert(boards.every(b=>b.render.result.dynamicText.fancy.dynamic.composition.corner),'specialized chain descriptor must be generated')
  assert.equal(boards[0].render.result.dynamicText.fancy.dynamic.presetId,'dynamic-corner-chain')
  assert(doc.segments.length>=2,'fixture exercises multiple paragraphs')
  assert.equal(doc.segments[1].boards[0].render.result.dynamicText.fancy.dynamic.composition.corner.sceneBase,doc.segments[0].boards.length,'new paragraphs continue motion recipes instead of resetting')
  const hash=boards[0].render.hash
  doc.params=resolveSkillParams(entry.pack,{...doc.params,easing:'expo',font:'KaiTi'})
  await runProduction(doc,{entry,outDir,services,phase:()=>{}})
  assert.notEqual(boards[0].render.hash,hash);assert.equal(calls,doc.segments.length,'visual changes must reuse TTS')
  assert.equal(boards[0].render.result.dynamicText.fontFamily,'KaiTi')
  assert.equal(boards[0].render.result.dynamicText.fancy.dynamic.composition.corner.easing,'expo')
  const seg=doc.segments[0], before=dynamicRenderHash({doc,pack:entry.pack},seg,boards[0])
  boards[1].elements[0].label='相邻文字改动'
  assert.notEqual(dynamicRenderHash({doc,pack:entry.pack},seg,boards[0]),before,'neighbor words change chain geometry and invalidate prior renders')
  const fixture=path.resolve('native/test-output/corner-chain');mkdirSync(fixture,{recursive:true})
  writeFileSync(path.join(fixture,'production.json'),JSON.stringify(publicView(doc,entry,outDir)))
  assert.equal(JSON.parse(readFileSync(path.join(fixture,'production.json'))).skillId,'studio.corner-chain')
  console.log('PASS manual-install pack: timed editable chain text, offline TTS pipeline, font/easing updates, neighbor cache invalidation, no images')
} finally {rmSync(temp,{recursive:true,force:true})}
