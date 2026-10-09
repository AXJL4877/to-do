import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
const temp=mkdtempSync(path.join(tmpdir(),'todo-check-regression-')),source=path.join(temp,'pack'),report=path.join(temp,'report.json'),output=path.join(temp,'release.todoext')
try {
  cpSync(path.resolve('examples/extensions/paper-titles'),source,{recursive:true})
  writeFileSync(path.join(source,'README.md'),'unit fixture');writeFileSync(path.join(source,'MIGRATION.md'),'unit fixture')
  const check={id:'fixture',cwd:'installed',argv:['node','-e',"require('fs').writeFileSync('evidence.txt',process.env.TODO_EXTENSION_DIR)"],mode:'mock',covers:['runtime','timeline','editing','cache','export'],timeoutMs:10000,artifacts:['evidence.txt']}
  const config={spec:'todo-extension-check/1',origin:'new',checks:[check]}
  const save=()=>writeFileSync(path.join(source,'extension.check.json'),JSON.stringify(config))
  const run=()=>{const result=spawnSync(process.execPath,['scripts/check-extension.mjs',source,'--report',report,'--output',output],{cwd:path.resolve('.'),encoding:'utf8',windowsHide:true,timeout:30000});assert(!result.error,String(result.error));return {code:result.status,report:JSON.parse(readFileSync(report,'utf8'))}}
  save();let r=run();assert.equal(r.code,0);assert(r.report.ok&&existsSync(output));assert(r.report.limitations.length);assert(r.report.checks.find(c=>c.id==='isolated-install').ok)
  const previous=readFileSync(output)
  check.argv=['node','-e',"console.error('intentional failure');process.exit(7)"];save();r=run();assert.equal(r.code,1);assert(!r.report.ok&&r.report.output===null);assert(readFileSync(output).equals(previous),'failed check must not publish or overwrite a release')
  check.argv=['node','-e','process.exit(0)'];save();r=run();assert.equal(r.code,1);assert(r.report.checks.some(c=>!c.ok&&c.error.includes('缺少测试产物')),'exit 0 alone must not pass without artifacts')
  check.argv=['node','-e',"const fs=require('fs');fs.writeFileSync('evidence.txt','old');fs.utimesSync('evidence.txt',new Date(0),new Date(0))"];save();r=run();assert.equal(r.code,1);assert(r.report.checks.some(c=>c.error?.includes('旧文件')),'stale artifacts must not prove the current test')
  check.covers=['runtime'];save();r=run();assert.equal(r.code,1);assert(r.report.checks.some(c=>c.error?.includes('缺少必测能力')))
  check.covers=['runtime','timeline','editing','cache','export'];check.timeoutMs=200;check.argv=['node','-e','setTimeout(()=>{},10000)'];save();r=run();assert.equal(r.code,1);assert(r.report.checks.some(c=>c.error?.includes('timedOut')))
  check.timeoutMs=10000;check.argv=['node','-e',"const fs=require('fs');fs.writeFileSync('evidence.txt','ok');fs.appendFileSync(process.env.TODO_EXTENSION_SOURCE+'/README.md','changed')"];save();r=run();assert.equal(r.code,1);assert(r.report.checks.some(c=>c.id==='source-stability'&&!c.ok),'source mutations during tests require another full run')
  config.origin='migration';save();r=run();assert.equal(r.code,1);assert(r.report.checks.some(c=>c.error?.includes('baseline')))
  check.covers.push('baseline');save();r=run();assert.equal(r.code,1);assert(r.report.checks.some(c=>c.error?.includes('performance')),'migrated workflows must include performance checks')
  console.log('PASS extension check gate: isolated install, passing release, failure blocks output, missing/stale evidence, missing coverage, timeout, source mutation, migration baseline')
}finally{rmSync(temp,{recursive:true,force:true})}
