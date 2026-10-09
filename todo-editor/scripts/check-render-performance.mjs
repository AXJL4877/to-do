import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
const file=path.resolve(process.argv[2]||path.join(process.env.TODO_EXTENSION_DIR||'.','check-output/PERFORMANCE.json'))
const median=values=>{assert(Array.isArray(values)&&values.length>=3,'每组至少测量三次');assert(values.every(v=>Number.isFinite(v)&&v>0),'测量值必须为正数');const a=[...values].sort((x,y)=>x-y),m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2}
try {
  const r=JSON.parse(readFileSync(file,'utf8'));assert.equal(r.spec,'todo-render-performance/1');assert(Array.isArray(r.cases)&&r.cases.length,'缺少场景测量')
  const ids=new Set(),results=[]
  for(const c of r.cases){
    assert(typeof c.id==='string'&&c.id&&!ids.has(c.id),'场景 ID 缺失/重复');ids.add(c.id)
    assert(['cold','warm'].includes(c.cacheState),'须区分 cold/warm');assert(typeof c.workload==='string'&&c.workload,'须描述输入、画质与测量范围')
    assert(typeof c.baseline.environment==='string'&&c.baseline.environment&&c.baseline.environment===c.candidate.environment,'基线/候选环境不同')
    const a=median(c.baseline.runsMs),b=median(c.candidate.runsMs),budget=c.budget
    for(const n of ['maxWallMs','maxPeakMiB','maxRegressionRatio'])assert(Number.isFinite(budget[n])&&budget[n]>0,'预算无效：'+n)
    assert(b<=budget.maxWallMs,`${c.id} 超出时间预算：${b} ms`);assert(b/a<=budget.maxRegressionRatio,`${c.id} 性能回退：${(b/a).toFixed(3)}倍`)
    assert(Number.isFinite(c.candidate.peakMiB)&&c.candidate.peakMiB>0&&c.candidate.peakMiB<=budget.maxPeakMiB,`${c.id} 内存超预算或未测量`)
    assert(typeof c.memoryScope==='string'&&c.memoryScope,'须说明内存测量范围');assert(Number.isInteger(c.candidate.workers)&&c.candidate.workers>=1,'须记录并发数');assert(typeof c.strategy==='string'&&c.strategy,'须说明并行/串行、资源复用策略')
    assert(c.quality?.passed===true,`${c.id} 质量断言未通过`);assert(Array.isArray(c.quality.evidence)&&c.quality.evidence.length,'缺少质量证据')
    for(const relative of c.quality.evidence){assert(typeof relative==='string'&&relative&&!path.isAbsolute(relative)&&!relative.split(/[\\/]/).includes('..'),'证据路径不合法');const f=path.resolve(path.dirname(file),relative);assert(existsSync(f)&&readFileSync(f).length,'证据缺失/为空：'+relative)}
    results.push({id:c.id,cacheState:c.cacheState,baselineMs:a,candidateMs:b,speedup:a/b,peakMiB:c.candidate.peakMiB,workers:c.candidate.workers})
  }
  assert(r.cases.some(c=>c.cacheState==='cold')&&r.cases.some(c=>c.cacheState==='warm'),'需要冷启动和热缓存场景');console.log(JSON.stringify({ok:true,results}))
}catch(error){console.error('FAIL render-performance: '+String(error));process.exitCode=1}
