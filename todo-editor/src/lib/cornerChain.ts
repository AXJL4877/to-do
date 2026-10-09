import type { DynamicText, TextStyle } from '../types'
type Scene = { content: string; start: number; end: number }
type Node = { index: number; content: string; x: number; y: number; angle: number; width: number; size: number }
export function cornerBounds(n: Node) {
  const c=Math.cos(n.angle),s=Math.sin(n.angle),pad=n.size*.8
  const points=[[0,-pad],[n.width,-pad],[n.width,pad],[0,pad]].map(([x,y])=>({x:n.x+c*x-s*y,y:n.y+s*x+c*y}))
  return {left:Math.min(...points.map(p=>p.x)),right:Math.max(...points.map(p=>p.x)),top:Math.min(...points.map(p=>p.y)),bottom:Math.max(...points.map(p=>p.y))}
}
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n))
const recipes = [
  {name:'重击急停',variant:'slam',move:[.08,.52],turn:[.2,.7],zoom:[.3,.76],reveal:.35,bend:0,roll:.06,punch:.22,accent:'burst'},
  {name:'沿角追字',variant:'type',move:[0,.8],turn:[.05,.5],zoom:[.48,.98],reveal:.12,bend:.2,roll:0,punch:0,accent:'bracket'},
  {name:'甩镜弹入',variant:'pop',move:[.25,.62],turn:[.08,.4],zoom:[.18,.7],reveal:.32,bend:-.34,roll:.12,punch:.1,accent:'streak'},
  {name:'轮廓纵深',variant:'echo',move:[0,.65],turn:[.38,.88],zoom:[0,.88],reveal:.08,bend:.16,roll:-.08,punch:.08,accent:'ring'},
  {name:'折页揭幕',variant:'mask',move:[.1,.76],turn:[.25,.84],zoom:[.48,.98],reveal:.15,bend:-.12,roll:0,punch:0,accent:'wipe'},
  {name:'阶梯推进',variant:'ribbon',move:[.05,.85],turn:[.18,.7],zoom:[.08,.92],reveal:.22,bend:.26,roll:.04,punch:.08,accent:'steps'},
  {name:'失焦穿越',variant:'focus',move:[0,.78],turn:[.08,.88],zoom:[.1,.94],reveal:.1,bend:0,roll:-.1,punch:.16,accent:'ring'},
  {name:'中轴炸开',variant:'pop',move:[.28,.64],turn:[.24,.65],zoom:[.38,.8],reveal:.4,bend:-.24,roll:.1,punch:.24,accent:'burst'},
] as const
export function cornerRecipe(index:number, base=0) { return recipes[((index+base)%recipes.length+recipes.length)%recipes.length] }
export function cornerCamera(progress:number,index:number,strength:number,easing:string,base=0) {
  const r=cornerRecipe(index,base), p=clamp(progress,0,1)
  const phase=(range:readonly number[])=>cornerEase(clamp((p-range[0])/(range[1]-range[0]),0,1),easing)
  const envelope=Math.sin(p*Math.PI)*(1-p)*strength
  return {move:p+(phase(r.move)-p)*strength,turn:p+(phase(r.turn)-p)*strength,zoom:p+(phase(r.zoom)-p)*strength,bend:r.bend*envelope,roll:r.roll*envelope,punch:r.punch*envelope}
}
/** Separate the travel, impact and reveal beats so glyph motion remains visible
 * after the camera arrives. All envelopes settle exactly at the cut boundary. */
export function cornerBeats(progress: number, strength: number, easing: string) {
  const p=clamp(progress,0,1), travel=clamp((p-.16)/.66,0,1)
  const hit=clamp((p-.48)/.52,0,1)
  return {
    travel:cornerEase(travel,easing),
    anticipation:Math.sin(Math.PI*clamp(p/.2,0,1))*.1*strength,
    impact:p>.48?Math.sin(hit*Math.PI*5)*Math.pow(1-hit,2)*strength:0,
    flash:p>.48?Math.pow(1-clamp((p-.48)/.14,0,1),2)*strength:0,
    reveal:clamp((p-.38)/.62,0,1),
  }
}
export function cornerEase(value: number, easing: string) {
  const p = clamp(value,0,1)
  if (p === 0 || p === 1) return p
  if (easing === 'back') { const t=p-1; return 1 + 2.70158*t*t*t + 1.70158*t*t }
  if (easing === 'expo') return 1 - Math.pow(2,-10*p)
  return 1 - Math.exp(-7*p)*(Math.cos(10*p)+.25*Math.sin(10*p))
}
const familyCss = (family: string) => `"${family.replace(/["\\\r\n]/g,'')}", "Microsoft YaHei", sans-serif`
function angles(count: number, cfg: DynamicText) {
  const out=[0], mode=cfg.composition!.corner!.direction
  for(let i=1;i<count;i++) {
    const turn=mode==='clockwise'?1:mode==='alternate'?(i%2?1:-1):((Math.imul(i+cfg.seed,1103515245)>>>12)&1?1:-1)
    out.push(out[i-1]+turn*Math.PI/2)
  }
  return out
}
/** Local coordinates are rebased to the current sentence. No exponentially
 * shrinking world coordinates, even for thousands of spoken sentences. */
export function buildCornerLayout(ctx: CanvasRenderingContext2D, scenes: Scene[], index: number, family: string, weight: number, cfg: DynamicText): Node[] {
  const rotations=angles(index+1,cfg), first=Math.max(0,index-cfg.composition!.corner!.trail)
  const nodes:Node[]=[]
  ctx.font=`${weight} 80px ${familyCss(family)}`
  const widths=scenes.slice(first,index+1).map(s=>Math.max(24,ctx.measureText(s.content).width))
  const sizes=widths.map(()=>80)
  for(let i=sizes.length-2;i>=0;i--)sizes[i]=Math.max(sizes[i+1]/.58,sizes[i+1]*widths[i+1]/widths[i]/.58)
  for(let i=first;i<=index;i++) {
    const size=sizes[i-first], width=widths[i-first]*size/80
    nodes.push({index:i,content:scenes[i].content,x:0,y:0,angle:rotations[i],width,size})
  }
  for(let i=1;i<nodes.length;i++) {
    const previous=nodes[i-1], n=nodes[i], sign=Math.sign(n.angle-previous.angle)
    const gap=Math.min(previous.size,n.size)*.16, c=Math.cos(previous.angle), s=Math.sin(previous.angle)
    // Align outer glyph corners, leaving room for thick strokes and spring
    // overshoot. Intersecting centre baselines would overlap the last glyph.
    n.x=previous.x+c*(previous.width+n.size*.8+gap)-s*sign*(previous.size*.8+gap)
    n.y=previous.y+s*(previous.width+n.size*.8+gap)+c*sign*(previous.size*.8+gap)
    for(let pass=0;pass<16;pass++) {
      const b=cornerBounds(n), hit=nodes.slice(0,i).find(old=>{const a=cornerBounds(old);return b.left<a.right && b.right>a.left && b.top<a.bottom && b.bottom>a.top})
      if(!hit)break
      const a=cornerBounds(hit), dx=Math.cos(n.angle),dy=Math.sin(n.angle)
      const travel=Math.abs(dx)>.5?(dx>0?a.right-b.left:b.right-a.left):(dy>0?a.bottom-b.top:b.bottom-a.top)
      n.x+=dx*(travel+gap);n.y+=dy*(travel+gap)
    }
  }
  const anchor=nodes.at(-1)!; const ax=anchor.x,ay=anchor.y
  for(const n of nodes){n.x-=ax;n.y-=ay}
  return nodes
}

let surface: HTMLCanvasElement | undefined
export function drawCornerChain(ctx: CanvasRenderingContext2D, text: TextStyle, cfg: DynamicText, w: number, h: number, time: number, fontSize: number) {
  surface ??= document.createElement('canvas')
  if(surface.width!==w || surface.height!==h){surface.width=w;surface.height=h}
  const x=surface.getContext('2d',{willReadFrequently:true})!
  x.setTransform(1,0,0,1,0,0);x.clearRect(0,0,w,h)
  x.save();x.translate(w/2,h/2);paintCornerChain(x,text,cfg,w,h,time,fontSize);x.restore()
  ctx.drawImage(surface,-w/2,-h/2)
}

function paintCornerChain(ctx: CanvasRenderingContext2D, text: TextStyle, cfg: DynamicText, w: number, h: number, time: number, fontSize: number) {
  const comp=cfg.composition!, opt=comp.corner!
  const scenes=comp.scenes.map(s=>comp.offset>=s.start-.001 && comp.offset<s.end?{...s,content:text.content}:s)
  const t=clamp(comp.offset+time,0,scenes.at(-1)!.end)
  let index=scenes.findIndex(s=>t>=s.start && t<s.end); if(index<0)index=t<scenes[0].start?0:scenes.length-1
  const scene=scenes[index], local=Math.max(0,t-scene.start), span=scene.end-scene.start
  const weight=text.fancy?.fontWeight??900
  const nodes=buildCornerLayout(ctx,scenes,index,text.fontFamily,weight,cfg), current=nodes.at(-1)!, previous=nodes.at(-2)
  const transition=Math.min(opt.transition,span*.72), progress=clamp(local/Math.max(.05,transition),0,1)
  const strength=cfg.motion, beats=cornerBeats(progress,strength,opt.easing)
  const recipe=cornerRecipe(index,opt.sceneBase), camera=cornerCamera(progress,index,strength,opt.easing,opt.sceneBase)
  const center=(n:Node)=>({x:n.x+Math.cos(n.angle)*n.width/2,y:n.y+Math.sin(n.angle)*n.width/2})
  const fit=(n:Node)=>Math.min(w*.8/Math.max(n.width,1),h*.23/n.size)*opt.zoom
  const target=center(current), from=previous?center(previous):target
  const zoomTo=fit(current), zoomFrom=previous?fit(previous):zoomTo*.72
  const zoom=Math.exp(Math.log(zoomFrom)+(Math.log(zoomTo)-Math.log(zoomFrom))*camera.zoom+camera.punch)
  const rotation=(previous?previous.angle+(current.angle-previous.angle)*camera.turn:0)+camera.roll
  const dx=target.x-from.x,dy=target.y-from.y
  const cx=from.x+dx*camera.move-dy*camera.bend, cy=from.y+dy*camera.move+dx*camera.bend
  const variant=opt.variant==='mix'?recipe.variant:opt.variant
  const impact=beats.impact*(recipe.accent==='burst'?1:.25)
  const revealTime=Math.max(0,local-transition*recipe.reveal), revealDuration=Math.max(.06,transition*(1-recipe.reveal))
  const reveal=clamp(revealTime/revealDuration,0,1)
  ctx.save()
  ctx.beginPath();ctx.rect(-w/2,-h/2,w,h);ctx.clip()
  const size=clamp(fontSize/96,.05,4);ctx.scale(size,size)
  if(comp.background!=='transparent') {ctx.fillStyle=opt.backgroundColor;ctx.fillRect(-w/size/2,-h/size/2,w/size,h/size)}
  // A short radial burst supplies a readable impact cue even at small previews.
  if(progress>0 && progress<1 && strength>0){
    ctx.save();ctx.strokeStyle=cfg.accent;ctx.fillStyle=cfg.accent;ctx.globalAlpha=Math.sin(progress*Math.PI)*.35*strength;ctx.lineWidth=1.5/size
    const radius=Math.min(w,h)*(.18+progress*.32)/size, sw=w/size,sh=h/size
    if(recipe.accent==='burst')for(let i=0;i<12;i++){const a=i*Math.PI/6+index*.3;ctx.beginPath();ctx.moveTo(Math.cos(a)*radius,Math.sin(a)*radius);ctx.lineTo(Math.cos(a)*(radius+sw*.18),Math.sin(a)*(radius+sw*.18));ctx.stroke()}
    else if(recipe.accent==='ring'){ctx.beginPath();ctx.arc(0,0,radius,0,Math.PI*2);ctx.stroke();ctx.beginPath();ctx.arc(0,0,radius*.75,0,Math.PI*2);ctx.stroke()}
    else if(recipe.accent==='streak')for(let i=0;i<7;i++){const y=(i-3)*sh*.12;ctx.fillRect(-sw*.5+progress*sw,y,sw*.22*(1-progress),2/size)}
    else if(recipe.accent==='wipe'){ctx.globalAlpha*=.3;ctx.fillRect(-sw/2+progress*sw,-sh/2,sw*.12,sh)}
    else if(recipe.accent==='steps')for(let i=0;i<5;i++)ctx.fillRect(-sw*.4+i*sw*.18,sh*.3,sw*.12,3/size)
    else {ctx.strokeRect(-sw*.43,-sh*.27,sw*.86,sh*.54)}
    ctx.restore()
  }
  ctx.translate(Math.sin(local*73)*impact*w*.028,Math.cos(local*59)*impact*h*.022)
  ctx.scale(zoom,zoom);ctx.rotate(-rotation);ctx.translate(-cx,-cy)
  ctx.textBaseline='middle';ctx.textAlign='left'
  const foreground=text.fancy?.fill[0]||text.color||'#ffffff'
  for(const n of nodes) {
    const active=n.index===index
    ctx.save();ctx.translate(n.x,n.y);ctx.rotate(n.angle)
    if(active){ctx.beginPath();ctx.rect(0,-n.size*.8,n.width,n.size*1.6);ctx.clip()}
    ctx.font=`${weight} ${n.size}px ${familyCss(text.fontFamily)}`
    ctx.fillStyle=active?foreground:cfg.accent
    ctx.globalAlpha*=active?clamp(revealTime/.055,0,1):Math.max(.12,.58-(index-n.index)*.12)
    if(active && variant==='slam'){
      const punch=Math.sin(reveal*Math.PI)*Math.pow(1-reveal,1.5)*strength
      ctx.translate(n.width/2,0);ctx.scale(1-punch*.5,1+punch*.7+impact*.12);ctx.translate(-n.width/2,0)
    }
    if(active && variant==='focus' && reveal<1)ctx.filter=`blur(${Math.max(0,(1-reveal)*12*strength/zoom)}px)`
    if(active && variant==='echo' && reveal<1) {
      ctx.save();ctx.lineWidth=n.size*.012;ctx.strokeStyle=cfg.accent
      for(let e=4;e>=1;e--){ctx.globalAlpha=.28/e;ctx.strokeText(n.content,-(1-reveal)*n.size*e*.55,(1-reveal)*n.size*e*.12)}
      ctx.restore()
    }
    if(active && ['ribbon','pop','type','mask'].includes(variant)) {
      const chars=Array.from(n.content), step=Math.min(Math.max(.012,opt.stagger),revealDuration*.48/Math.max(1,chars.length-1))
      let x=0, caret=0
      for(const [i,char] of chars.entries()) {
        const order=recipe.name==='中轴炸开'?Math.abs(i-(chars.length-1)/2):i
        const delay=variant==='type'?i*revealDuration*.7/Math.max(1,chars.length):order*step
        const p=clamp((revealTime-delay)/Math.max(.04,revealDuration*.52),0,1), e=cornerEase(p,opt.easing)
        if(variant==='type' && revealTime<delay+.015){x+=ctx.measureText(char).width;continue}
        ctx.save();ctx.globalAlpha*=variant==='type'?1:clamp(p*5,0,1)
        if(variant==='mask'){ctx.beginPath();ctx.rect(x-n.size*.08,-n.size*.75,ctx.measureText(char).width+n.size*.16,n.size*1.5);ctx.clip()}
        ctx.translate(x,variant==='type'?0:(1-e)*n.size*.65*strength)
        if(variant==='pop'){ctx.translate(ctx.measureText(char).width/2,0);const scale=Math.max(.05,1-(1-e)*strength);ctx.scale(scale,scale);ctx.translate(-ctx.measureText(char).width/2,0)}
        else if(variant==='ribbon')ctx.scale(1,1+(1-e)*.6*strength)
        else if(variant==='mask')ctx.translate(0,(1-p)*(1-p)*n.size*.85)
        ctx.fillText(char,0,0);ctx.restore()
        caret=x+ctx.measureText(char).width
        x+=ctx.measureText(char).width
      }
      if(variant==='type' && progress<.94 && Math.floor(local*6)%2===0){ctx.save();ctx.globalAlpha=.7;ctx.fillText('▍',Math.min(caret,n.width),0);ctx.restore()}
    } else ctx.fillText(n.content,0,0)
    ctx.restore()
  }
  ctx.restore()
}
