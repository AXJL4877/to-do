import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { useApp } from '../src/store'
import { MediaLibrary } from '../src/components/MediaLibrary'
import { CreativeProgress } from '../src/components/CreativeProgress'
import { syncProduction } from '../src/lib/productionTimeline'
import { setChalkHand } from '../src/lib/chalkHand'
import { StrictMode } from 'react'
import { defaultTransform, defaultColor, defaultAudio, type Clip } from '../src/types'
const results: {name:string;ok:boolean;error?:string}[]=[]
function check(value:unknown,message:string){if(!value)throw new Error(message)}
async function test(name:string,fn:()=>unknown|Promise<unknown>){try{await fn();results.push({name,ok:true})}catch(e){results.push({name,ok:false,error:String(e)})}}
async function waitFor(fn:()=>boolean){const end=Date.now()+1500;while(!fn()&&Date.now()<end){await new Promise(r=>setTimeout(r,25));flushSync(()=>{})}}
const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
const image='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><rect width="100" height="60" fill="%23ddd"/></svg>'
function seed(){
  useApp.getState().newProject('媒体管理回归')
  const [a,b,c]=useApp.getState().importMedia([{name:'生成图',url:'/ai-generated/p_old_hold.png',kind:'image',duration:2},{name:'原文件',url:image,path:'C:/external/keep.png',kind:'image',duration:2},{name:'另一张图',url:image,kind:'image',duration:2}],{silent:true})
  const state=useApp.getState(),seq=state.seq()
  const clip=(id:string,mediaId:string):Clip=>({id,mediaId,trackId:seq.tracks[0].id,name:id,start:0,duration:2,inPoint:0,outPoint:2,enabled:true,speed:1,reverse:false,speedKeyframes:[],transform:defaultTransform(),color:defaultColor(),audio:defaultAudio(),effects:[],blend:'normal',keyframes:{}})
  useApp.setState({sequences:[{...seq,clips:[clip('ca',a),clip('cb',b)]},{...seq,id:'other-seq',clips:[clip('ca2',a)]}],history:[],future:[],libraryTab:'media',started:true})
  return {a,b,c}
}
async function run(){
  await test('batch removal removes references in every sequence and preserves external sources',()=>{
    const {a,b}=seed();const st=useApp.getState()
    check(typeof st.removeMediaBatch==='function','batch API is missing');st.removeMediaBatch([a])
    check(!useApp.getState().media.some(m=>m.id===a),'media remains')
    check(useApp.getState().sequences.every(s=>s.clips.every(c=>c.mediaId!==a)),'dangling media in another sequence')
    check(useApp.getState().media.find(m=>m.id===b)?.path==='C:/external/keep.png','external source changed')
    check(useApp.getState().settings.removedGeneratedMedia?.includes('p_old_hold.png'),'auto reimport suppression absent')
  })
  await test('one undo restores media and clips; redo removes both again',()=>{
    const {a}=seed();useApp.getState().removeMediaBatch([a]);useApp.getState().undo()
    check(useApp.getState().media.some(m=>m.id===a)&&useApp.getState().sequences[1].clips.some(c=>c.mediaId===a),'undo lost media or clips')
    check(!useApp.getState().settings.removedGeneratedMedia?.includes('p_old_hold.png'),'undo left suppression')
    useApp.getState().redo();check(!useApp.getState().media.some(m=>m.id===a),'redo did not remove media')
  })
  await test('undo and redo preserve imports added after batch deletion',()=>{
    const {a}=seed();useApp.getState().removeMediaBatch([a])
    const [later]=useApp.getState().importMedia([{name:'后来导入',url:image,kind:'image',duration:2}],{silent:true})
    const current=useApp.getState();useApp.setState({sequences:current.sequences.map(s=>s.id===current.activeSeqId?{...s,clips:[...s.clips,{...s.clips[0],id:'later-quiet',mediaId:later,start:5}]}:s)})
    useApp.getState().undo();check(useApp.getState().media.some(m=>m.id===a)&&useApp.getState().media.some(m=>m.id===later),'undo erased a later import')
    check(useApp.getState().seq().clips.some(c=>c.id==='later-quiet'),'undo erased a later automatic clip')
    useApp.getState().redo();check(!useApp.getState().media.some(m=>m.id===a)&&useApp.getState().media.some(m=>m.id===later),'redo erased a later import')
    check(useApp.getState().seq().clips.some(c=>c.id==='later-quiet'),'redo erased a later automatic clip')
  })
  await test('regenerated drawing does not reimport a removed chalk hand',()=>{
    const {a,b}=seed();useApp.getState().removeMediaBatch([a])
    const st=useApp.getState();useApp.setState({sequences:st.sequences.map(s=>({...s,clips:s.clips.map(c=>c.mediaId===b?{...c,meta:{...c.meta,source:{type:'ai',chalk:{on:false,tip:[[0,0,0],[1,1,1]],frame:{width:100,height:60},hand:{url:'/ai-generated/p_old_hold.png',width:20,height:20,tipX:5,tipY:5}}}}} as Clip:c)}))})
    setChalkHand(['cb'],true,{history:false})
    check(!useApp.getState().media.some(m=>m.url==='/ai-generated/p_old_hold.png'),'removed chalk hand reimported')
  })
  await test('redo removes later references to the deleted media and next undo restores them',()=>{
    const {a}=seed();useApp.getState().removeMediaBatch([a]);useApp.getState().undo()
    const st=useApp.getState();useApp.setState({sequences:st.sequences.map(s=>s.id===st.activeSeqId?{...s,clips:[...s.clips,{...s.clips[0],id:'later-same-media',mediaId:a,start:5}]}:s)})
    useApp.getState().redo()
    check(useApp.getState().sequences.every(s=>s.clips.every(c=>c.mediaId!==a)),'redo left a new dangling reference')
    useApp.getState().undo()
    check(useApp.getState().media.some(m=>m.id===a)&&useApp.getState().seq().clips.some(c=>c.id==='later-same-media'),'next undo did not restore later reference')
  })
  await test('selection uses ctrl/shift, select all and a concrete removal preview',()=>{
    seed();flushSync(()=>root.render(<div style={{width:420,height:650}}><MediaLibrary /></div>))
    const items=host.querySelectorAll<HTMLElement>('[data-testid^="media-item-"]')
    flushSync(()=>items[0].dispatchEvent(new MouseEvent('click',{bubbles:true})))
    flushSync(()=>items[1].dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true})))
    check(host.querySelector('[data-testid="media-selection-count"]')?.textContent?.includes('2'),'ctrl multi-select failed')
    flushSync(()=>items[0].dispatchEvent(new MouseEvent('click',{bubbles:true})))
    flushSync(()=>items[2].dispatchEvent(new MouseEvent('click',{bubbles:true,shiftKey:true})))
    check(host.querySelector('[data-testid="media-selection-count"]')?.textContent?.includes('3'),'shift range selection failed')
    flushSync(()=>host.querySelector<HTMLButtonElement>('[data-testid="media-select-all"]')!.click())
    check(host.querySelector('[data-testid="media-selection-count"]')?.textContent?.includes('3'),'select all failed')
    flushSync(()=>host.querySelector<HTMLButtonElement>('[data-testid="media-batch-remove"]')!.click())
    check(document.querySelector('[role="dialog"]')?.textContent?.includes('3 个素材'),'removal preview absent')
    flushSync(()=>document.querySelector<HTMLButtonElement>('[data-testid="media-confirm-remove"]')!.click())
    check(useApp.getState().media.length===0&&useApp.getState().sequences.every(s=>!s.clips.length),'batch UI did not remove')
  })
  await test('known zero progress remains empty and does not loop across percentage',()=>{
    flushSync(()=>root.render(<CreativeProgress theme="chalk" percent={0} label="AI 分段" />))
    const progress=host.querySelector('[role="progressbar"]')!,fill=host.querySelector<HTMLElement>('.cp-sketch-fill')!
    check(progress.getAttribute('aria-valuenow')==='0','zero progress inaccessible')
    check(fill&&fill.style.width==='0%','zero progress has a fake fill')
    check(getComputedStyle(fill).animationName==='none','known progress keeps looping')
  })
  await test('production polling cannot restore an explicitly removed generated asset',()=>{
    const {a}=seed();useApp.getState().removeMediaBatch([a])
    const state=useApp.getState(),p={id:'p_poll_removed',title:'测试',params:{size:'1920x1080',subtitles:'off',plate:'none'},segments:[{id:'g1',title:'段落',voice:{hash:'new-hash',audioUrl:'/ai-generated/p_old_hold.png',duration:2},boards:[]}]}
    useApp.setState({settings:{...state.settings,aiProductions:{[p.id]:{t0:0,auto:true,placed:{},createdAt:Date.now()}}}})
    syncProduction(p as any)
    check(!useApp.getState().media.some(m=>m.url==='/ai-generated/p_old_hold.png'),'poll restored removed file')
    check(!useApp.getState().seq().clips.some(c=>c.meta?.source?.jobId===p.id),'poll restored removed voice clip')
  })
  await test('cleanup shows a preview, retains known files and reports backend failures',async()=>{
    seed();flushSync(()=>root.render(<StrictMode><div style={{width:420,height:650}}><MediaLibrary /></div></StrictMode>))
    const saved=window.fetch;let execute=0;const requests:any[]=[]
    window.fetch=async(input,init)=>{
      const body=JSON.parse(String(init?.body));requests.push(body)
      if(String(input).endsWith('/preview'))return new Response(JSON.stringify({ok:true,token:'preview-token',candidates:[{name:'old.png',bytes:2048}],blocked:[{name:'p_old_hold.png',reason:'仍被成片引用'}],totalBytes:2048}))
      execute++;return new Response(JSON.stringify({ok:true,deleted:[],blocked:[],failed:[{name:'old.png',error:'文件被占用'}],freedBytes:0}))
    }
    try{
      flushSync(()=>host.querySelector<HTMLButtonElement>('[data-testid="media-scan-generated"]')!.click())
      const dialog=document.querySelector('[role="dialog"]')!
      flushSync(()=>[...dialog.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='扫描')!.click())
      await waitFor(()=>!!dialog.textContent?.includes('old.png'))
      check(execute===0&&dialog.textContent?.includes('old.png'),`preview deleted files or missing names: ${dialog.textContent}, requests=${requests.length}`)
      check(requests[0].retainedFiles.includes('p_old_hold.png'),'current project reference not retained')
      flushSync(()=>document.querySelector<HTMLButtonElement>('[data-testid="media-confirm-cleanup"]')!.click())
      await waitFor(()=>!!dialog.textContent?.includes('文件被占用'))
      check(execute===1&&dialog.textContent?.includes('文件被占用'),'cleanup failure silently reported as success')
      await waitFor(()=>!dialog.querySelector<HTMLButtonElement>('[aria-label="关闭"]')?.disabled)
      flushSync(()=>dialog.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click())
      check(!document.querySelector('[role="dialog"]'),'cleanup did not finish before close')
    }finally{window.fetch=saved}
  })
  await test('historical generation records can be removed in bulk without deleting project media',async()=>{
    seed();flushSync(()=>root.render(<div style={{width:420,height:650}}><MediaLibrary /></div>))
    const saved=window.fetch,deleted:string[]=[]
    window.fetch=async(input,init)=>{
      const url=String(input)
      if(init?.method==='DELETE'){deleted.push(url);return new Response(JSON.stringify({ok:true}))}
      return new Response(JSON.stringify({ok:true,items:url.includes('ai-productions')?[{id:'p_history_test',title:'旧成片'}]:[{id:'ai_history_test',prompt:'旧生成图',status:'imported'}]}))
    }
    try{
      flushSync(()=>host.querySelector<HTMLButtonElement>('[data-testid="media-scan-generated"]')!.click())
      const button=document.querySelector<HTMLButtonElement>('[data-testid="media-manage-records"]')
      check(button,'historical record manager is missing');flushSync(()=>button!.click())
      await waitFor(()=>document.querySelectorAll('[data-testid="media-generation-record"]').length===2)
      flushSync(()=>document.querySelector<HTMLButtonElement>('[data-testid="media-record-select-all"]')!.click())
      flushSync(()=>document.querySelector<HTMLButtonElement>('[data-testid="media-record-remove"]')!.click())
      check(deleted.length===0,'record deletion bypassed confirmation')
      flushSync(()=>document.querySelector<HTMLButtonElement>('[data-testid="media-record-confirm"]')!.click())
      await waitFor(()=>deleted.length===2)
      check(deleted.length===2&&useApp.getState().media.length===3,'bulk record cleanup deleted media or missed records')
      check(deleted.every(url=>url.endsWith('?terminalOnly=1')),'record deletion did not request a fresh terminal-state guard')
      await waitFor(()=>!!document.querySelector('[role="dialog"]')?.textContent?.includes('已删除 2 条生成记录'))
      flushSync(()=>document.querySelector<HTMLButtonElement>('[role="dialog"] [aria-label="关闭"]')!.click())
      check(!document.querySelector('[role="dialog"]'),'record manager still busy after successful completion')
    }finally{window.fetch=saved}
  })
  await test('discarding undo requires its own confirmation and then rescans',async()=>{
    const {a}=seed();useApp.setState({media:useApp.getState().media.map(m=>m.id===a?{...m,url:'/ai-generated/p_unique_clear_hold.png'}:m)})
    useApp.getState().removeMediaBatch([a]);flushSync(()=>root.render(<div style={{width:420,height:650}}><MediaLibrary /></div>))
    const saved=window.fetch,requests:any[]=[]
    window.fetch=async(_input,init)=>{const body=JSON.parse(String(init?.body));requests.push(body);const retained=body.retainedFiles.includes('p_unique_clear_hold.png');return new Response(JSON.stringify({ok:true,token:'t',candidates:retained?[]:[{name:'p_unique_clear_hold.png',bytes:10}],blocked:retained?[{name:'p_unique_clear_hold.png',reason:'撤销记录仍引用'}]:[],totalBytes:retained?0:10}))}
    try{
      flushSync(()=>host.querySelector<HTMLButtonElement>('[data-testid="media-scan-generated"]')!.click())
      const dialog=document.querySelector('[role="dialog"]')!
      flushSync(()=>[...dialog.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='扫描')!.click())
      await waitFor(()=>!!dialog.textContent?.includes('撤销记录仍引用'))
      check(requests[0].retainedFiles.includes('p_unique_clear_hold.png'),'undo file was not protected')
      flushSync(()=>[...dialog.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.startsWith('清空撤销记录并重新扫描'))!.click())
      check(useApp.getState().history.length>0,'undo was discarded without confirmation')
      flushSync(()=>[...dialog.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='确认清空并重新扫描')!.click())
      await waitFor(()=>requests.length===2&&!!dialog.textContent?.includes('1 个可清理文件'))
      check(!useApp.getState().history.length&&!requests[1].retainedFiles.includes('p_unique_clear_hold.png'),'confirmed discard did not release undo reference')
      check(useApp.getState().media.length===2&&useApp.getState().seq().clips.length===1,'discard changed project media/clips')
      await waitFor(()=>!dialog.querySelector<HTMLButtonElement>('[aria-label="关闭"]')?.disabled)
      flushSync(()=>dialog.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click())
      check(!document.querySelector('[role="dialog"]'),'discard scan remained busy')
    }finally{window.fetch=saved}
  })
  flushSync(()=>root.render(null));seed();flushSync(()=>root.render(<div style={{width:420,height:760,padding:12,background:'var(--surface-0)',display:'flex',flexDirection:'column',gap:14}}><MediaLibrary /><CreativeProgress theme="chalk" percent={0} label="AI 分段 · 已等待 3s"/><CreativeProgress percent={63} label="渲染元素"/><CreativeProgress percent={null} label="正在连接"/></div>))
  ;(window as any).mediaProgressPreview=()=>flushSync(()=>root.render(<div style={{width:400,padding:24,background:'var(--surface-1)',display:'flex',flexDirection:'column',gap:22}}><CreativeProgress theme="chalk" percent={0} label="AI 分段 · 已等待 3s / 最多 45s"/><CreativeProgress percent={63} label="渲染元素"/><CreativeProgress percent={100} label="完成"/><CreativeProgress percent={null} label="正在连接"/></div>))
  return {failed:results.filter(r=>!r.ok).length,results}
}
;(window as any).mediaManagementTests=run()
