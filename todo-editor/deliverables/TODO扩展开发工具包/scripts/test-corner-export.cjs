const {app,BrowserWindow}=require('electron')
const {readFileSync,mkdirSync}=require('node:fs')
const {spawnSync}=require('node:child_process')
const path=require('node:path'), assert=require('node:assert/strict')
const {PNG}=require('pngjs')
const {exportSequence}=require('../electron/exportSequence.cjs')
const root=path.resolve(__dirname,'..'),out=path.join(root,'native/test-output/corner-chain')
app.setPath('userData',path.join(out,'export-profile'))
app.whenReady().then(async()=>{
  let win
  try {
    const fixtures=JSON.parse(readFileSync(path.join(out,'fixtures.json'),'utf8'))
    win=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}})
    await win.loadFile(path.join(root,'dist/chalk-render.html'))
    await win.webContents.executeJavaScript('window.loadTextFonts(["Microsoft YaHei"])')
    for(const f of fixtures){
      const png=await win.webContents.executeJavaScript('window.renderChalkFrame(...'+JSON.stringify([f.text,{},2,f.w,f.h,f.time])+')')
      assert(PNG.sync.read(Buffer.from(png,'base64')).data.equals(PNG.sync.read(Buffer.from(f.png,'base64')).data),'preview/export pixels must match')
    }
    const first=fixtures[0].text,comp=first.fancy.dynamic.composition
    const duration=comp.scenes.at(-1).end
    const text={...first,content:comp.scenes[0].content,fancy:{...first.fancy,dynamic:{...first.fancy.dynamic,duration,composition:{...comp,offset:0}}}}
    const seq={settings:{width:640,height:360,fps:24},tracks:[{id:'text',kind:'subtitle'}],clips:[{id:'corner-demo',trackId:'text',kind:'text',start:0,duration,inPoint:0,outPoint:duration,opacity:1,text,keyframes:{}}],workIn:0,workOut:duration}
    mkdirSync(path.join(root,'deliverables'),{recursive:true})
    const result=await exportSequence(seq,path.join(root,'deliverables/corner-chain-preview.mp4'),{nativeBin:path.join(root,'native/bin'),preferJs:true})
    assert(result.ok,result.error)
    const ffmpeg=path.join(root,'native/bin/ffmpeg.exe')
    for(const time of comp.scenes.map(s=>(s.start+s.end)/2)){
      const r=spawnSync(ffmpeg,['-v','error','-ss',String(time),'-i',result.path,'-frames:v','1','-f','image2pipe','-vcodec','png','-'],{windowsHide:true,maxBuffer:16e6})
      assert.equal(r.status,0,r.stderr.toString())
      const d=PNG.sync.read(r.stdout).data;let visible=0
      for(let i=0;i<d.length;i+=4)if(d[i]>160)visible++
      assert(visible>100,'each exported sentence must be visible')
    }
    console.log(JSON.stringify({ok:true,exactPreviewPixels:true,exportedSentences:comp.scenes.length,file:result.path}))
    win.destroy();app.exit(0)
  }catch(e){console.error(e);win?.destroy();app.exit(1)}
})
