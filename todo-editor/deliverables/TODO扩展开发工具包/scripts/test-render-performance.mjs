import assert from 'node:assert/strict'
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
const temp=mkdtempSync(path.join(tmpdir(),'todo-perf-gate-')),file=path.join(temp,'PERFORMANCE.json')
try {
  writeFileSync(path.join(temp,'quality.json'),JSON.stringify({fixture:true}))
  const sample={id:'test-cold',cacheState:'cold',workload:'synthetic unit fixture, not actual benchmark',baseline:{environment:'unit',runsMs:[100,105,95]},candidate:{environment:'unit',runsMs:[60,65,55],peakMiB:20,workers:2},budget:{maxWallMs:90,maxPeakMiB:30,maxRegressionRatio:1.05},memoryScope:'unit fixture',strategy:'unit fixture',quality:{passed:true,evidence:['quality.json']}}
  const original={spec:'todo-render-performance/1',cases:[sample,{...structuredClone(sample),id:'test-warm',cacheState:'warm'}]}
  const run=r=>{writeFileSync(file,JSON.stringify(r));const p=spawnSync(process.execPath,['scripts/check-render-performance.mjs',file],{encoding:'utf8',windowsHide:true,timeout:10000});assert(!p.error);return p}
  assert.equal(run(original).status,0)
  for(const mutate of [r=>{r.cases[0].candidate.runsMs=[150,160,170]},r=>{r.cases[0].candidate.peakMiB=40},r=>{r.cases[0].quality.passed=false},r=>{r.cases[0].candidate.environment='another-machine'},r=>{r.cases[0].candidate.runsMs=[60]},r=>{r.cases[0].quality.evidence=['missing.json']},r=>{r.cases.pop()},r=>{r.cases[0].budget.maxRegressionRatio=.5}]){
    const r=structuredClone(original);mutate(r);assert.equal(run(r).status,1,'invalid performance report must fail')
  }
  console.log('PASS performance gate: valid medians; blocks slow/memory/quality/environment/sample/evidence/cache-state/regression failures (synthetic unit fixtures)')
}finally{rmSync(temp,{recursive:true,force:true})}
