import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
const temp=mkdtempSync(path.join(tmpdir(),'todo-chalk-gates-'))
process.env.TODO_DATA_DIR=path.join(temp,'data')
process.env.TODO_RENDER_CONCURRENCY='2'
try {
  const {chalkRenderBudget}=await import('../server/production/renderBudget.mjs')
  const pack={id:'builtin.chalk-hand'},params={size:'1920x1080'}
  assert.equal(chalkRenderBudget(pack,params,{cpu:8,freeBytes:8*1024**3,requested:4}).workers,4)
  assert.equal(chalkRenderBudget(pack,params,{cpu:2,freeBytes:8*1024**3,requested:4}).workers,1)
  assert.equal(chalkRenderBudget(pack,params,{cpu:8,freeBytes:400*1024**2,requested:4}).workers,1)
  assert.equal(chalkRenderBudget({id:'third.party'},params,{cpu:8,freeBytes:8*1024**3,requested:4}).workers,1,'unreviewed renderers remain serial')
  const {getSkillEntry}=await import('../server/skillPacks.mjs')
  const {createProduction}=await import('../server/production/job.mjs')
  const {runProduction,requestCancel}=await import('../server/production/runner.mjs')
  const entry=getSkillEntry('builtin.chalk-hand'),outDir=path.join(temp,'out');mkdirSync(outDir)
  let active=0,peak=0,renders=0,firstFailure=true,cancel=false
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z0xwAAAAASUVORK5CYII=','base64')
  const services={
    synth:async(text,o)=>{writeFileSync(o.audioFile,'mock');writeFileSync(o.timingFile,JSON.stringify({duration:20,sentences:[{text,start:0,end:20}]}))},
    chat:async()=>{throw new Error('offline fallback')},
    image:async(_request,out)=>{writeFileSync(out,png)},
    render:async(_entry,file)=>{
      const req=JSON.parse(readFileSync(file));active++;peak=Math.max(peak,active);renders++
      try {
        assert.equal(req.resources.encoderThreads>=1,true)
        if(cancel){const slot=active;if(slot===2)requestCancel(doc.id);await new Promise(r=>setTimeout(r,slot===1?20:120))}
        else await new Promise(r=>setTimeout(r,60))
        if(firstFailure){firstFailure=false;throw new Error('intentional single-node failure')}
        const els=req.scene.elements.map((e,i)=>{const video=req.outputs.prefix+'-'+req.scene.id+'-'+i+'.webm',hold=video+'.png';writeFileSync(path.join(outDir,video),'mock');writeFileSync(path.join(outDir,hold),png);return {...e,video,hold,crop:[10,10,100,100],box:[10,10,100,100],startMs:e.atMs,durationMs:500,frames:15,tip:[]}})
        return {fps:30,width:1920,height:1080,scene:{...req.scene,elements:els}}
      }finally{active--}
    },
  }
  const doc=createProduction({skillId:entry.pack.id,script:Array.from({length:4},(_,i)=>`第${i+1}部分。这里说明一个清晰的主题。人物看到变化以后开始行动。另一个对象出现并推动故事。最后表达这个段落的重要结论。`).join('\n---\n'),params:{split:'paragraph',subtitles:'off',plate:'none',variants:1}})
  await assert.rejects(runProduction(doc,{entry,outDir,services,phase:()=>{}}))
  assert(peak===2&&active===0,'independent boards overlap but stay bounded and settle on failure')
  const before=renders
  await runProduction(doc,{entry,outDir,services,phase:()=>{}})
  assert.equal(renders-before,1,'retry renders only failed board')
  await runProduction(doc,{entry,outDir,services,phase:()=>{}});assert.equal(renders-before,1,'unchanged render cache reused')
  // Multiple sibling boards inside ONE segment expose early Promise.all
  // rejection: one active renderer finishes quickly, the other stays active.
  doc.segments[0].boards=doc.segments.flatMap(s=>s.boards)
  doc.segments=[doc.segments[0]]
  doc.params={...doc.params,drawSpeed:2};cancel=true;const atCancel=renders
  await assert.rejects(runProduction(doc,{entry,outDir,services,phase:()=>{}}),/已停止/)
  assert.equal(active,0);assert(renders-atCancel<=2,'cancelled queued boards do not start')
  console.log(JSON.stringify({ok:true,peak,checks:['resource caps','isolated board requests','failure drain','retry/cache','cancel queued']}))
}finally{rmSync(temp,{recursive:true,force:true})}
