import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { unzipSync } from 'fflate'

const repo=path.resolve(fileURLToPath(new URL('../',import.meta.url)))
const args=process.argv.slice(2), source=path.resolve(args[0]||'.')
const option=name=>{const i=args.indexOf(name);return i<0?null:args[i+1]}
const positionalReport=args[1]&&!args[1].startsWith('--')?args[1]:null
const positionalOutput=positionalReport&&args[2]&&!args[2].startsWith('--')?args[2]:null
const reportPath=path.resolve(option('--report')||positionalReport||path.join(repo,'native/test-output/extension-check',path.basename(source)+'.json'))
const destination=option('--output')||positionalOutput
const output=destination?path.resolve(destination):null
const report={spec:'todo-extension-check-report/1',source,startedAt:new Date().toISOString(),ok:false,checks:[],limitations:[],output:null}
const sha=data=>createHash('sha256').update(data).digest('hex')
const hostDigest=()=>{
  const digest=createHash('sha256')
  const walk=(relative)=>{
    const absolute=path.join(repo,relative)
    if(!existsSync(absolute))return
    const stat=statSync(absolute)
    if(stat.isDirectory())for(const name of readdirSync(absolute).sort())walk(path.join(relative,name))
    else if(stat.isFile())digest.update(relative).update('\0').update(sha(readFileSync(absolute))).update('\0')
  }
  for(const relative of ['src','server','electron','shared','scripts','tests','package.json','package-lock.json','tsconfig.json','vite.config.ts'])walk(relative)
  return digest.digest('hex')
}
const outside=p=>{const rel=path.relative(source,p);if(!rel||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel)))throw new Error('报告和输出包须位于扩展源码目录之外')}
const record=(id,ok,detail)=>{report.checks.push({id,ok,...detail});console.log(`${ok?'PASS':'FAIL'} ${id}${detail.error?': '+detail.error:''}`)}
const temp=mkdtempSync(path.join(tmpdir(),'todo-extension-check-'))
// Set before importing the registries: never install into the developer's .data.
process.env.TODO_DATA_DIR=path.join(temp,'data')
let failed=false
try {
  outside(reportPath);if(output)outside(output)
  const {buildExtensionPack,installExtensionPack}=await import('../server/extensionPacks.mjs')
  const bytes=buildExtensionPack(source)
  const files=unzipSync(bytes), envelope=JSON.parse(Buffer.from(files['extension.json']).toString())
  const manifest=JSON.parse(Buffer.from(files[envelope.manifest]).toString())
  report.extension={id:manifest.id,version:manifest.version,kind:envelope.kind}
  report.hostDigest=hostDigest()
  const sourceDigest=sha(Buffer.from(JSON.stringify(envelope.files)))
  record('format',true,{bytes:bytes.length,sourceDigest})
  const first=installExtensionPack(bytes), second=installExtensionPack(bytes)
  if(second.action!=='unchanged')throw new Error('同版本重复安装没有保持幂等')
  const installed=path.join(process.env.TODO_DATA_DIR,{skill:'skills',style:'styles',animation:'anims'}[envelope.kind],first.id)
  if(!existsSync(path.join(installed,envelope.manifest)))throw new Error('隔离安装后缺少 manifest')
  record('isolated-install',true,{action:first.action,reinstall:second.action})
  const config=JSON.parse(readFileSync(path.join(source,'extension.check.json'),'utf8'))
  if(config.spec!=='todo-extension-check/1'||!['new','migration'].includes(config.origin)||!Array.isArray(config.checks)||!config.checks.length)throw new Error('缺少有效的 extension.check.json（spec/origin/checks）')
  for(const name of ['README.md','MIGRATION.md'])if(!existsSync(path.join(source,name)))throw new Error(`缺少 ${name}`)
  const required=envelope.kind==='skill'?['runtime','timeline','editing','cache','export']:['runtime','editing','export']
  if(config.origin==='migration')required.push('baseline','performance')
  const covered=new Set(),ids=new Set()
  for(const c of config.checks){
    if(!/^[a-z0-9-]+$/.test(c.id||'')||ids.has(c.id)||!Array.isArray(c.argv)||!c.argv.length||c.argv.some(v=>typeof v!=='string'||!v)||!['repo','installed'].includes(c.cwd)||!Array.isArray(c.covers)||c.covers.some(v=>!['runtime','timeline','editing','cache','export','baseline','performance','host'].includes(v))||!['offline','mock','network'].includes(c.mode)||!Number.isInteger(c.timeoutMs)||c.timeoutMs<100||c.timeoutMs>600000)throw new Error(`测试清单不合法：${c.id||'未命名'}（argv/cwd/covers/mode/timeoutMs）`)
    if(!Array.isArray(c.artifacts)||c.artifacts.some(v=>typeof v!=='string'||!v||path.isAbsolute(v)||v.split(/[\\/]/).includes('..')))throw new Error(`测试 ${c.id} 的 artifacts 须为工作目录内的相对路径`)
    if(c.covers.some(v=>['runtime','export','baseline','performance'].includes(v))&&!c.artifacts.length)throw new Error(`测试 ${c.id} 必须留下实际产物证据`)
    ids.add(c.id);c.covers.forEach(v=>covered.add(v))
  }
  const missing=required.filter(v=>!covered.has(v))
  if(missing.length)throw new Error('缺少必测能力：'+missing.join(', '))
  record('acceptance-plan',true,{required,checks:ids.size})
  for(const c of config.checks){
    const cwd=c.cwd==='repo'?repo:installed
    const env={...process.env,TODO_EXTENSION_SOURCE:source,TODO_EXTENSION_DIR:installed,TODO_EXTENSION_REPORT_DIR:path.dirname(reportPath)}
    delete env.ELECTRON_RUN_AS_NODE
    const started=Date.now()
    try {
      if(c.mode==='network'&&!args.includes('--allow-network'))throw new Error('网络测试未运行；需作者已授权后显式使用 --allow-network，未运行不能计为通过')
      if(c.mode==='mock')report.limitations.push(`${c.id} 使用 mock，不能证明真实服务输出质量`)
      const result=await new Promise(resolve=>{
        const child=spawn(c.argv[0]==='node'?process.execPath:c.argv[0],c.argv.slice(1),{cwd,env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']})
        let log='',timedOut=false
        const append=data=>{log=(log+data.toString()).slice(-30000)}
        child.stdout.on('data',append);child.stderr.on('data',append)
        const timer=setTimeout(()=>{timedOut=true;if(process.platform==='win32'&&child.pid)spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else child.kill('SIGKILL')},c.timeoutMs)
        child.on('error',error=>{clearTimeout(timer);resolve({code:null,error:String(error),log})})
        child.on('close',code=>{clearTimeout(timer);resolve({code,timedOut,log})})
      })
      if(result.code!==0||result.timedOut||result.error)throw new Error(JSON.stringify(result))
      const artifacts=c.artifacts.map(relative=>{
        const file=path.resolve(cwd,relative)
        if(!existsSync(file))throw new Error('缺少测试产物：'+relative)
        if(statSync(file).mtimeMs<started-2000)throw new Error('产物为旧文件，本次测试必须重新写出证据：'+relative)
        const data=readFileSync(file);if(!data.length)throw new Error('测试产物为空：'+relative)
        const saved=c.cwd==='installed'?path.join(path.dirname(reportPath),path.basename(reportPath,'.json')+'-artifacts',c.id,relative):file
        if(saved!==file){mkdirSync(path.dirname(saved),{recursive:true});writeFileSync(saved,data)}
        return {path:saved,bytes:data.length,sha256:sha(data)}
      })
      record(c.id,true,{covers:c.covers,mode:c.mode,argv:c.argv,durationMs:Date.now()-started,artifacts,log:result.log})
    }catch(error){failed=true;record(c.id,false,{covers:c.covers,mode:c.mode,durationMs:Date.now()-started,error:String(error)})}
  }
  const finalBytes=buildExtensionPack(source),finalFiles=unzipSync(finalBytes),finalEnvelope=JSON.parse(Buffer.from(finalFiles['extension.json']).toString())
  if(sha(Buffer.from(JSON.stringify(finalEnvelope.files)))!==sourceDigest){failed=true;record('source-stability',false,{error:'测试期间发行源码变化，请在最终代码上重新自检'})}
  else record('source-stability',true,{sourceDigest})
  if(hostDigest()!==report.hostDigest){failed=true;record('host-stability',false,{error:'测试期间宿主/测试源码变化，请在最终代码上重新自检'})}
  else record('host-stability',true,{hostDigest:report.hostDigest})
  if(!failed){
    report.ok=true
    if(output){mkdirSync(path.dirname(output),{recursive:true});writeFileSync(output,finalBytes);report.output={path:output,bytes:finalBytes.length,sha256:sha(finalBytes)}}
  }
}catch(error){failed=true;record('preflight',false,{error:String(error)})}
finally {
  report.finishedAt=new Date().toISOString()
  // Never remove or overwrite an earlier release on failure. Report binds the
  // current source and exact successful package; an old file is not new success.
  if(failed){report.ok=false;process.exitCode=1}
  try{outside(reportPath);mkdirSync(path.dirname(reportPath),{recursive:true});writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');console.log(`报告：${reportPath}`)}catch(error){console.error(String(error));process.exitCode=1}
  rmSync(temp,{recursive:true,force:true})
}
