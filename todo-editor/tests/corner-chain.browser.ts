import { drawDynamicText, normalizeDynamicText } from '../src/lib/dynamicText'
import { buildCornerLayout, cornerBounds, cornerEase, cornerBeats, cornerRecipe, cornerCamera } from '../src/lib/cornerChain'
import { defaultText } from '../src/types'
;(window as any).cornerTests = (async () => {
  const assert = (ok: unknown, label: string) => { if (!ok) throw new Error(label) }
  const scenes = ['重击让画面醒来', '沿着句尾追逐文字', '甩镜让每个字弹起', '轮廓穿过不同层次', '像折页一样揭开', '节奏一阶一阶推进', '失焦之后穿越转角', '从中间向两端炸开'].map((content, i) => ({ content, start: i * 2, end: (i + 1) * 2 }))
  const corner = { direction: 'alternate', easing: 'spring', variant: 'mix', zoom: 1, transition: 1.05, stagger: .018, trail: 3, backgroundColor: '#101010' }
  const cfg: any = { version: 2, engine: 'jizura', presetId: 'dynamic-corner-chain', duration: 2, motion: .85, seed: 42, accent: '#bbbbbb', composition: { scenes, offset: 2, corner, style: 'noir', mood: 'graphic', background: 'style', unify: true, parts: {}, fx: { decor: 0, chroma: 0, glitch: 0, texture: 0, bgSwitch: 0 } } }
  const text = { ...defaultText(), content: scenes[1].content, fontSize:96, fontFamily: 'Microsoft YaHei', fancy: { fontWeight: 900, fill: ['#ffffff'], fillAngle: 90, strokes: [], dynamic: cfg } }
  const normalized = normalizeDynamicText(cfg)!
  assert(normalized?.composition?.corner?.easing === 'spring', 'corner config survives normalization')
  const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360
  const ctx = canvas.getContext('2d')!
  const layout = buildCornerLayout(ctx, scenes, 1, text.fontFamily, 900, normalized)
  const previous = layout.find(n => n.index === 0)!, current = layout.find(n => n.index === 1)!
  assert(Math.abs(Math.abs(current.angle - previous.angle) - Math.PI / 2) < 1e-8, 'successive baselines rotate exactly 90 degrees')
  const a=cornerBounds(previous), b=cornerBounds(current)
  assert(a.right <= b.left && a.bottom <= b.top, 'outer glyph corners align with a nonoverlapping gap')
  for(const direction of ['clockwise','alternate','mixed'])for(let index=1;index<30;index++){
    const config={...normalized,composition:{...normalized.composition!,corner:{...normalized.composition!.corner!,direction:direction as any}}}
    const nodes=buildCornerLayout(ctx,Array.from({length:30},(_,i)=>({content:scenes[i%5].content,start:i,end:i+1})),index,text.fontFamily,900,config)
    for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++){
      const a=cornerBounds(nodes[i]),b=cornerBounds(nodes[j]);assert(!(a.left<b.right && a.right>b.left && a.top<b.bottom && a.bottom>b.top),'no history/current sentence boxes overlap')
    }
  }
  assert(cornerEase(0, 'spring') === 0 && cornerEase(1, 'spring') === 1 && cornerEase(.45, 'spring') > 1, 'spring settles and overshoots')
  const early=cornerBeats(.1,1,'spring'), hit=cornerBeats(.53,1,'spring'), end=cornerBeats(1,1,'spring')
  assert(early.anticipation>0 && early.reveal===0 && hit.flash>0 && Math.abs(hit.impact)>.2,'anticipation, impact and delayed reveal have distinct beats')
  assert(end.travel===1 && end.impact===0 && end.flash===0 && end.reveal===1,'impact envelopes settle at sentence boundary')
  assert(cornerBeats(.53,0,'spring').impact===0 && cornerBeats(.53,0,'spring').flash===0,'motion zero disables impact accents')
  assert(new Set(Array.from({length:8},(_,i)=>cornerRecipe(i).name)).size===8,'eight consecutive scenes use different complete recipes')
  const paths=Array.from({length:8},(_,i)=>JSON.stringify([.2,.4,.6,.8].map(p=>cornerCamera(p,i,1,'spring'))))
  assert(new Set(paths).size===8,'all eight recipes have distinct camera trajectories')
  assert(cornerRecipe(0,3).name===cornerRecipe(3).name,'paragraph scene base continues the recipe sequence')
  for(let i=0;i<8;i++){
    const a=cornerCamera(0,i,1,'spring'),b=cornerCamera(1,i,1,'spring')
    assert(a.move===0&&a.turn===0&&a.zoom===0&&b.move===1&&b.turn===1&&b.zoom===1&&Math.abs(b.bend)<1e-12&&Math.abs(b.roll)<1e-12,'all recipes preserve cut boundary camera endpoints')
  }
  const shortLong=buildCornerLayout(ctx,[{content:'短句',start:0,end:2},{content:'下一句很长也必须向前放大',start:2,end:4}],1,text.fontFamily,900,normalized)
  const fit=(n:typeof current)=>Math.min(1080*.8/n.width,1920*.23/n.size)
  assert(fit(shortLong[1])>fit(shortLong[0]),'short to long sentence still zooms in')
  let previousPng = '', changes = 0
  const fixtures: any[] = []
  for (const time of [0, .15, .4, .8, 1.6]) {
    ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0,0,640,360); ctx.translate(320,180)
    assert(drawDynamicText(ctx, text, 640, 360, time, 2), 'native renderer supports chain')
    const png = canvas.toDataURL(); if (png !== previousPng) changes++; previousPng = png
    const first = png; ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0,0,640,360); ctx.translate(320,180); drawDynamicText(ctx,text,640,360,time,2)
    assert(first === canvas.toDataURL(), 'deterministic frame')
    if (time === .4) fixtures.push({ text, time, w:640, h:360, png:png.split(',')[1] })
  }
  assert(changes >= 4, 'zoom/rotation/reveal produces rich motion')
  const late = buildCornerLayout(ctx, Array.from({length:1000},(_,i)=>({content:'长文测试',start:i,end:i+1})), 999, text.fontFamily,900,normalized)
  assert(late.every(n => [n.x,n.y,n.width,n.size].every(Number.isFinite)), 'long text chain does not underflow')
  const signatures=[]
  for(let sceneBase=0;sceneBase<8;sceneBase++){
    const sample={...text,content:'相同文字检验动效',fancy:{...text.fancy,dynamic:{...cfg,composition:{...cfg.composition,scenes:[{content:'相同文字检验动效',start:0,end:2}],offset:0,corner:{...corner,sceneBase}}}}}
    const frames=[]
    for(const time of [.2,.45,.7]){ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,640,360);ctx.translate(320,180);drawDynamicText(ctx,sample,640,360,time,2);frames.push(canvas.toDataURL())}
    signatures.push(frames.join('|'))
  }
  assert(new Set(signatures).size===8,'identical sentence content renders eight visibly distinct motion sequences')
  const gallery=document.createElement('canvas');gallery.width=2560;gallery.height=720
  const gx=gallery.getContext('2d')!
  for(const [j,globalTime] of [.55,2.55,4.55,6.55,8.55,10.55,12.55,14.55].entries()) {
    const index=Math.floor(globalTime/2), sample={...text,content:scenes[index].content,fancy:{...text.fancy,dynamic:{...cfg,composition:{...cfg.composition,offset:index*2}}}}
    ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,640,360);ctx.translate(320,180);drawDynamicText(ctx,sample,640,360,globalTime-index*2,2)
    gx.drawImage(canvas,(j%4)*640,Math.floor(j/4)*360)
  }
  return { ok:true, checks:7, fixtures, gallery:gallery.toDataURL() }
})()
