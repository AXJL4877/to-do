import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { SkillsPanel } from '../src/components/SkillsPanel'
import { SkillStudio } from '../src/components/SkillStudio'
import type { SkillPack, SkillPlan } from '../src/lib/aiSkills'
let reads = 0
const pack: SkillPack = { id:'test', name:'test', version:'1', author:'', description:'', tags:[], previews:[], input:{label:'prompt',maxLength:20000}, output:{mime:'video/mp4',codec:'h264'}, params:[],quick:[],pipeline:'elements',planner:{maxElements:100,countParam:null} }
const plan: SkillPlan = {title:'test',notes:'',elements:Array.from({length:100},(_,i)=>({label:`E${i}`,get draw(){reads++;return 'draw'},role:'hero' as const,weight:1}))}
let submitted = ''
function Harness(){ const [prompt,setPrompt]=useState('initial'); const [p,setPlan]=useState<SkillPlan|null>(plan); const [params,setParams]=useState({}); return <SkillStudio pack={pack} prompt={prompt} setPrompt={setPrompt} plan={p} setPlan={setPlan} params={params} setParams={setParams} autoTimeline={true} setAutoTimeline={()=>{}} onSubmit={async()=>{submitted=prompt;return false}} onClose={()=>{}}/> }
const host=document.createElement('div');document.body.append(host);const root=createRoot(host);flushSync(()=>root.render(<Harness/>));
const input=document.querySelector('[data-testid="skill-studio-prompt"]') as HTMLTextAreaElement
const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!
reads=0;const started=performance.now();
for(let i=0;i<30;i++){setter.call(input,`中文输入 ${i}`);flushSync(()=>input.dispatchEvent(new Event('input',{bubbles:true})))}
const elapsed=performance.now()-started;const promptReads=reads

const draw = document.querySelector('[data-testid="skill-element-draw-0"]') as HTMLTextAreaElement
setter.call(draw, ''); flushSync(() => draw.dispatchEvent(new Event('input', {bubbles:true})))
const invalidDisabled = (document.querySelector('[data-testid="skill-studio-submit"]') as HTMLButtonElement).disabled
setter.call(draw, 'new drawing'); flushSync(() => draw.dispatchEvent(new Event('input', {bubbles:true})))
const editWorks = draw.value === 'new drawing' && !(document.querySelector('[data-testid="skill-studio-submit"]') as HTMLButtonElement).disabled
flushSync(() => (document.querySelector('[data-testid="skill-element-del-0"]') as HTMLButtonElement).click())
const removeWorks = document.querySelectorAll('.skill-element').length === 99
flushSync(()=>(document.querySelector('[data-testid="skill-studio-submit"]') as HTMLButtonElement).click())
root.unmount()
;(window as any).skillInputTests = (async () => {
  let jobReads = 0
  const jobs = Array.from({length:40}, (_,i) => ({id:`job${i}`,kind:'skill',status:'queued',get prompt(){jobReads++; return 'job'},params:{skill:{id:'test',pipeline:'elements'}}}))
  window.fetch = (async (url: unknown) => ({json:async()=>String(url).includes('ai-skills')?{ok:true,skills:[pack]}:{ok:true,items:jobs}})) as typeof fetch
  const panelRoot=createRoot(host);flushSync(()=>panelRoot.render(<SkillsPanel/>))
  for(let i=0;i<10&&!document.querySelector('[data-testid="skill-pick-test"]');i++) await new Promise(resolve=>setTimeout(resolve,10))
  flushSync(()=>(document.querySelector('[data-testid="skill-pick-test"]') as HTMLButtonElement).click())
  const promptInput=document.querySelector('[data-testid="skill-prompt"]') as HTMLTextAreaElement
  jobReads=0
  for(let i=0;i<30;i++){setter.call(promptInput,`中文 ${i}`);flushSync(()=>promptInput.dispatchEvent(new Event('input',{bubbles:true})))}
  const jobsReadDuringTyping=jobReads
  flushSync(()=>(document.querySelector('[data-testid="skill-more"]') as HTMLButtonElement).click())
  const sharedDraft=(document.querySelector('[data-testid="skill-studio-prompt"]') as HTMLTextAreaElement).value==='中文 29'
  panelRoot.unmount()
  return {failed:promptReads>0||submitted!=='中文输入 29'||!invalidDisabled||!editWorks||!removeWorks||jobsReadDuringTyping>0||!sharedDraft,promptReads,elapsedMs:elapsed,submitted,invalidDisabled,editWorks,removeWorks,jobsReadDuringTyping,sharedDraft}
})()
