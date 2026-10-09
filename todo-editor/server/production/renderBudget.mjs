import os from 'node:os'

/** Only the audited blackboard renderer is process-isolated and safe to
 * overlap. Keep other extensions serial until their resource contract exists. */
export function chalkRenderBudget(pack,params,{cpu=os.availableParallelism(),freeBytes=os.freemem(),requested=Number(process.env.TODO_RENDER_CONCURRENCY)||2}={}) {
  if(pack.id!=='builtin.chalk-hand')return {workers:1}
  const [w,h]=String(params.size||'1920x1080').split('x').map(Number)
  const pixels=(Number.isFinite(w)&&w>0&&w<=7680&&Number.isFinite(h)&&h>0&&h<=7680)?w*h:1920*1080
  const bytesPerWorker=128*1024**2+pixels*192
  const memoryCap=Math.max(1,Math.floor((freeBytes-1024**3)/bytesPerWorker))
  const cpuCap=Math.max(1,Math.floor(cpu/2))
  const workers=Math.max(1,Math.min(4,Math.floor(requested)||1,cpuCap,memoryCap))
  return {workers,encoderThreads:Math.max(1,Math.min(4,Math.floor(cpu/workers))),nativeThreads:1,bytesPerWorker}
}
