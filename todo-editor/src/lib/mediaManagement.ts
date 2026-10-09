import type { MediaItem, Sequence } from '../types'

/** Canonical generated-output identity survives copying an asset into a project. */
export function generatedMediaName(value?: string): string | null {
  if (!value) return null
  const match=/(?:^|\/)ai-generated\/([^/?#]+)(?:[?#].*)?$/.exec(value.replace(/\\/g,'/'))
  if(!match)return null
  try{const name=decodeURIComponent(match[1]);return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,239}$/.test(name)&&!name.includes('..')?name:null}catch{return null}
}
export const generatedNameOf=(m:Pick<MediaItem,'url'|'aiUrl'>)=>generatedMediaName(m.aiUrl)||generatedMediaName(m.url)
export function isRemovedGenerated(url:string,removed?:string[]){const name=generatedMediaName(url);return !!name&&!!removed?.includes(name)}

export function mediaUsage(media:MediaItem[],sequences:Sequence[]) {
  const counts=new Map(media.map(m=>[m.id,0]))
  const byName=new Map<string,string[]>()
  for(const m of media){const name=generatedNameOf(m);if(name)byName.set(name,[...(byName.get(name)||[]),m.id])}
  for(const seq of sequences)for(const c of seq.clips){
    const ids=new Set<string>()
    if(c.mediaId)ids.add(c.mediaId)
    const hand=c.meta?.source?.chalk?.hand
    if(hand?.mediaId)ids.add(hand.mediaId)
    for(const id of byName.get(generatedMediaName(hand?.url)||'')||[])ids.add(id)
    for(const id of ids)counts.set(id,(counts.get(id)||0)+1)
  }
  return counts
}

/** Files known to current project, all sequences, undo and other local drafts. */
export function retainedGeneratedFiles(value:unknown):string[]{
  const names=new Set<string>(),seen=new WeakSet<object>()
  const walk=(v:unknown)=>{
    if(typeof v==='string'){const name=generatedMediaName(v);if(name)names.add(name);return}
    if(!v||typeof v!=='object'||seen.has(v))return
    seen.add(v)
    if(Array.isArray(v)){for(const item of v)walk(item);return}
    for(const [key,item]of Object.entries(v))if(key!=='removedGeneratedMedia')walk(item)
  }
  walk(value);return [...names]
}

export function removeMediaReferences(sequences:Sequence[],ids:Set<string>,names=new Set<string>()) {
  return sequences.map(seq=>{
    const removed=new Set(seq.clips.filter(c=>!!c.mediaId&&ids.has(c.mediaId)).map(c=>c.id))
    return {...seq,clips:seq.clips.filter(c=>!removed.has(c.id)).map(c=>{
      let next=c
      if(c.linkedId&&removed.has(c.linkedId))next={...next,linkedId:undefined}
      const hand=c.meta?.source?.chalk?.hand
      if(hand&&((hand.mediaId&&ids.has(hand.mediaId))||names.has(generatedMediaName(hand.url)||'')))next={...next,meta:{...c.meta!,source:{...c.meta!.source!,chalk:undefined}}}
      return next
    })}
  })
}

export function restoreMediaSnapshot(current:MediaItem[],snapshot:MediaItem[],scope:string[]){
  const affected=new Set(scope),live=new Map(current.filter(m=>!affected.has(m.id)).map(m=>[m.id,m]))
  const restored=new Map(snapshot.filter(m=>affected.has(m.id)).map(m=>[m.id,m]))
  const result:MediaItem[]=[]
  for(const m of snapshot){const keep=restored.get(m.id)||live.get(m.id);if(keep){result.push(keep);live.delete(m.id)}}
  return [...result,...live.values()]
}
export function restoreRemovedGenerated(current:string[],snapshot:string[],scope:string[]){
  const affected=new Set(scope)
  return [...new Set([...current.filter(n=>!affected.has(n)),...snapshot.filter(n=>affected.has(n))])]
}

/** Batch deletion is scoped: background auto-imports after it remain intact. */
export function restoreMediaClipSnapshot(current:Sequence[],snapshot:Sequence[],scope:Record<string,string[]>){
  return current.map(seq=>{
    const affected=new Set(scope[seq.id]||[]),before=snapshot.find(s=>s.id===seq.id)
    if(!affected.size||!before)return seq
    const live=new Map(seq.clips.filter(c=>!affected.has(c.id)).map(c=>[c.id,c]))
    const restored=new Map(before.clips.filter(c=>affected.has(c.id)).map(c=>[c.id,c]))
    const clips:Sequence['clips']=[]
    for(const c of before.clips){const keep=restored.get(c.id)||live.get(c.id);if(keep){clips.push(keep);live.delete(c.id)}}
    clips.push(...live.values())
    const missingTracks=before.tracks.filter(t=>clips.some(c=>c.trackId===t.id)&&!seq.tracks.some(x=>x.id===t.id))
    return {...seq,clips,tracks:[...seq.tracks,...missingTracks],workOut:Math.max(seq.workOut,...clips.map(c=>c.start+c.duration))}
  })
}
