import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Trash2, HardDrive } from 'lucide-react'
import { useApp } from '../store'
import { mediaUsage, retainedGeneratedFiles } from '../lib/mediaManagement'
import { aiFetch } from '../lib/aiFetch'
import { forgetProduction } from '../lib/productionTimeline'

type Preview={token:string;candidates:{name:string;bytes:number}[];blocked:{name:string;reason:string}[];totalBytes:number}
type Result={deleted:string[];blocked:{name:string;reason:string}[];failed:{name:string;error:string}[];freedBytes:number}
type GenerationRecord={id:string;kind:'production'|'job';title:string;locked:boolean}
const bytes=(n:number)=>n<1024**2?`${(n/1024).toFixed(1)} KB`:`${(n/1024**2).toFixed(1)} MB`
function retain(){
  const state=useApp.getState()
  const refs:unknown[]=[{media:state.media,sequences:state.sequences,settings:state.settings,history:state.history,future:state.future}]
  for(let i=0;i<localStorage.length;i++){
    const key=localStorage.key(i)
    if(!key?.startsWith('todo-draft-')||key===`todo-draft-${state.projectId}`)continue
    try{refs.push(JSON.parse(localStorage.getItem(key)||'{}'))}catch{throw new Error('有草稿记录无法读取，请先检查该草稿；此次清理未执行')}
  }
  return retainedGeneratedFiles(refs)
}
async function call<T>(action:string,body:object){
  const response=await aiFetch(`/api/ai-media-cleanup/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
  const data=await response.json()
  if(!response.ok||!data.ok)throw new Error(data.error||'清理请求失败')
  return data as T
}

export function MediaCleanupDialog({ids,onClose}:{ids?:string[];onClose:()=>void}){
  const media=useApp(s=>s.media),sequences=useApp(s=>s.sequences)
  const undoCount=useApp(s=>s.history.length+s.future.length)
  const selected=media.filter(m=>ids?.includes(m.id)),usage=mediaUsage(media,sequences)
  const references=selected.reduce((n,m)=>n+(usage.get(m.id)||0),0)
  const [preview,setPreview]=useState<Preview|null>(null),[result,setResult]=useState<Result|null>(null)
  const [busy,setBusy]=useState(false),[error,setError]=useState('')
  const [records,setRecords]=useState<GenerationRecord[]|null>(null),[chosenRecords,setChosenRecords]=useState<string[]>([])
  const [recordConfirm,setRecordConfirm]=useState(false),[recordNotice,setRecordNotice]=useState('')
  const [discardUndo,setDiscardUndo]=useState(false)
  const dialog=useRef<HTMLDivElement>(null),alive=useRef(true)
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;dialog.current?.focus()
    const key=(e:KeyboardEvent)=>{
      if(e.key==='Escape'&&!busy){e.stopPropagation();onClose()}
      if(e.key==='Tab'){
        const nodes=[...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, [tabindex="0"]')||[])]
        if(!nodes.length)return
        if(e.shiftKey&&document.activeElement===nodes[0]){e.preventDefault();nodes.at(-1)?.focus()}
        else if(!e.shiftKey&&document.activeElement===nodes.at(-1)){e.preventDefault();nodes[0].focus()}
      }
    }
    document.addEventListener('keydown',key,true)
    return()=>{document.removeEventListener('keydown',key,true);previous?.focus()}
  },[busy,onClose])
  useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
  async function scan(){
    setBusy(true);setError('');setResult(null)
    try{const value=await call<Preview>('preview',{retainedFiles:retain()});if(alive.current)setPreview(value)}catch(e){if(alive.current)setError(String(e instanceof Error?e.message:e))}finally{if(alive.current)setBusy(false)}
  }
  async function execute(){
    if(!preview)return
    setBusy(true);setError('')
    try{const value=await call<Result>('execute',{token:preview.token,retainedFiles:retain()});if(alive.current){setResult(value);setPreview(null)}}catch(e){if(alive.current)setError(String(e instanceof Error?e.message:e))}finally{if(alive.current)setBusy(false)}
  }
  const recordKey=(r:GenerationRecord)=>`${r.kind}:${r.id}`
  async function loadRecords(){
    setBusy(true);setError('');setRecordConfirm(false)
    try{
      const responses=await Promise.all(['/api/ai-productions','/api/ai-jobs?limit=100'].map(url=>aiFetch(url)))
      const data=await Promise.all(responses.map(async r=>{const body=await r.json();if(!r.ok||!body.ok)throw new Error(body.error||'读取生成记录失败');return body}))
      if(alive.current){
        setRecords([...data[0].items.map((p:{id:string;title:string;runningJobId?:string;queuedJobId?:string})=>({id:p.id,kind:'production' as const,title:p.title||p.id,locked:!!p.runningJobId||!!p.queuedJobId})),...data[1].items.map((j:{id:string;prompt:string;status:string})=>({id:j.id,kind:'job' as const,title:j.prompt||j.id,locked:!['done','error','imported'].includes(j.status)}))]);setChosenRecords([])
      }
    }catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e))}finally{if(alive.current)setBusy(false)}
  }
  async function deleteRecords(){
    const selected=records?.filter(r=>!r.locked&&chosenRecords.includes(recordKey(r)))||[]
    if(!recordConfirm||!selected.length)return
    setBusy(true);setError('');setPreview(null);setResult(null)
    let removed=0;const failures:string[]=[]
    for(const r of selected){
      try{
        const response=await aiFetch(`/api/${r.kind==='production'?'ai-productions':'ai-jobs'}/${encodeURIComponent(r.id)}?terminalOnly=1`,{method:'DELETE'})
        const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'删除记录失败')
        if(r.kind==='production')forgetProduction(r.id)
        removed++
        if(alive.current)setRecords(items=>items?.filter(item=>recordKey(item)!==recordKey(r))||null)
      }catch(e){failures.push(`${r.id}: ${e instanceof Error?e.message:String(e)}`)}
    }
    try{await useApp.getState().flushProject()}catch(e){failures.push(`记录已处理，但工程保存失败：${e instanceof Error?e.message:String(e)}`)}
    if(alive.current){setChosenRecords([]);setRecordConfirm(false);setRecordNotice(`已删除 ${removed} 条生成记录，磁盘文件和工程片段保留；请重新扫描。`);setError(failures.join('；'));setBusy(false)}
  }
  return createPortal(<div className="media-dialog-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget&&!busy)onClose()}}>
    <div className="media-cleanup-dialog" role="dialog" aria-modal="true" aria-labelledby="media-cleanup-title" tabIndex={-1} ref={dialog}>
      <div className="media-dialog-heading"><span id="media-cleanup-title">{ids?'从工程移除素材':'清理历史生成文件'}</span><button className="icon-btn" disabled={busy} onClick={onClose} aria-label="关闭"><X size={15}/></button></div>
      {ids?<>
        <p>将移除 <b>{selected.length} 个素材</b>，同时删除全部序列中的 <b>{references} 处引用</b>。</p>
        <p className="media-dialog-note">可一次撤销。本地原文件和磁盘生成文件保留；已移除的生成素材不会被轮询自动加回。</p>
        <div className="media-cleanup-list">{selected.map(m=><div key={m.id}><span title={m.name}>{m.name}</span><small>{usage.get(m.id)||0} 处引用</small></div>)}</div>
        <div className="media-dialog-actions"><button className="btn btn-ghost" onClick={onClose}>取消</button><button className="btn btn-primary" data-testid="media-confirm-remove" disabled={!selected.length} onClick={()=>{useApp.getState().removeMediaBatch(selected.map(m=>m.id));onClose()}}><Trash2 size={13}/>移除 {selected.length} 个素材</button></div>
      </>:<>
        <p>扫描生成目录中的旧文件，保留生成记录、当前工程、撤销记录及本机草稿正在引用的文件。</p>
        <p className="media-dialog-note">磁盘清理不可撤销。本地导入原文件、工程内的副本不在此次范围内；其他位置单独保存的工程无法自动核查，请先将需要保留的素材导入当前工程。</p>
        {busy?<p role="status">正在{preview?'清理':'检查引用'}…</p>:null}
        {error?<p role="alert" className="media-dialog-error">{error}</p>:null}
        {preview?<>
          <p><b>{preview.candidates.length} 个可清理文件 · {bytes(preview.totalBytes)}</b></p>
          <div className="media-cleanup-list">{preview.candidates.map(f=><div key={f.name}><span title={f.name}>{f.name}</span><small>{bytes(f.bytes)}</small></div>)}</div>
          <details className="media-cleanup-blocked"><summary>{preview.blocked.length} 个文件保留 · 查看原因</summary><div className="media-cleanup-list">{preview.blocked.map(f=><div key={f.name}><span title={f.name}>{f.name}</span><small title={f.reason}>{f.reason}</small></div>)}</div></details>
          <p className="media-dialog-note">已完成任务或成片文档仍引用的产物会保留。若不再需要，可在下方管理生成记录，删除对应记录后重新扫描。</p>
        </>:null}
        {result?<><p role="status">已清理 {result.deleted.length} 个文件，释放 {bytes(result.freedBytes)}；保留 {result.blocked.length} 个，失败 {result.failed.length} 个。</p><div className="media-cleanup-list">{[...result.blocked.map(f=>({name:f.name,message:f.reason})),...result.failed.map(f=>({name:f.name,message:f.error}))].map(f=><div key={f.name}><span>{f.name}</span><small>{f.message}</small></div>)}</div></>:null}
        {undoCount>0&&<div className="media-dialog-note">
          <p>当前 {undoCount} 条撤销/重做记录也会保留素材文件。</p>
          {discardUndo?<><p>清空后将无法撤销当前工程已有操作；其他文件引用仍会保留。</p><button className="btn btn-ghost" disabled={busy} onClick={()=>{useApp.setState({history:[],future:[]});setDiscardUndo(false);setPreview(null);void scan()}}>确认清空并重新扫描</button><button className="btn btn-ghost" disabled={busy} onClick={()=>setDiscardUndo(false)}>保留撤销</button></>:<button className="btn btn-ghost" disabled={busy} onClick={()=>setDiscardUndo(true)}>清空撤销记录并重新扫描…</button>}
        </div>}
        <div className="media-dialog-actions"><button className="btn btn-ghost" disabled={busy} onClick={scan}>扫描{preview||result?'更新':''}</button><button className="btn btn-primary" data-testid="media-confirm-cleanup" disabled={busy||!preview?.candidates.length} onClick={execute}><HardDrive size={13}/>清理 {preview?.candidates.length||0} 个文件</button></div>
        <div className="media-generation-manager">
          <button className="btn btn-ghost" data-testid="media-manage-records" disabled={busy} onClick={loadRecords}>管理生成记录</button>
          {records&&<>
            <p className="media-dialog-note">列出全部成片及最近 100 条任务。删除记录后无法再从生成工作台编辑或重试；工程素材和片段保留。运行中、排队中的记录不可选择。</p>
            <div className="media-manage-actions"><button className="btn btn-ghost" data-testid="media-record-select-all" disabled={busy} onClick={()=>{setChosenRecords(records.filter(r=>!r.locked).map(recordKey));setRecordConfirm(false)}}>全选可删除记录</button><span className="media-dialog-note">已选 {chosenRecords.length} 条</span></div>
            <div className="media-cleanup-list">{records.map(r=><label className="media-generation-record" data-testid="media-generation-record" key={recordKey(r)}><input type="checkbox" checked={chosenRecords.includes(recordKey(r))} disabled={busy||r.locked} onChange={()=>{setChosenRecords(ids=>ids.includes(recordKey(r))?ids.filter(id=>id!==recordKey(r)):[...ids,recordKey(r)]);setRecordConfirm(false)}}/><span title={r.title}>{r.title}</span><small>{r.locked?'进行中':r.kind==='production'?'成片':'任务'}</small></label>)}</div>
            {recordConfirm?<><p>确认删除所选 <b>{chosenRecords.length} 条生成记录</b>？此操作不可撤销，所选项已在上方勾选。</p><button className="btn btn-primary" data-testid="media-record-confirm" disabled={busy} onClick={deleteRecords}>确认删除 {chosenRecords.length} 条记录</button></>:<button className="btn btn-ghost" data-testid="media-record-remove" disabled={busy||!chosenRecords.length} onClick={()=>setRecordConfirm(true)}><Trash2 size={12}/>删除所选生成记录</button>}
          </>}
          {recordNotice&&<p role="status" className="media-dialog-note">{recordNotice}</p>}
        </div>
      </>}
    </div>
  </div>,document.body)
}
