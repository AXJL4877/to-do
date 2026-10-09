"""Real Python -> VP9 encoder benchmark with fixed offline scene requests."""
from __future__ import annotations
import concurrent.futures, hashlib, json, os, statistics, subprocess, sys, time
from pathlib import Path
import cv2
import numpy as np
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'native/test-output/chalk-pipeline';OUT.mkdir(parents=True,exist_ok=True)
FFMPEG=ROOT/'native/bin/ffmpeg.exe'
image=np.zeros((240,320,3),np.uint8)
cv2.rectangle(image,(30,30),(270,200),(238,230,215),6)
cv2.circle(image,(150,110),50,(235,210,160),5)
cv2.line(image,(40,180),(260,45),(228,235,240),4)
source=OUT/'input.png';cv2.imencode('.png',image)[1].tofile(str(source))

def job(folder,index,full):
    output=folder/f'scene-{index}';output.mkdir(parents=True,exist_ok=True)
    req={'spec':'todo-skill-render/1','mode':'scene-clips','jobId':'offline','outDir':str(output),'ffmpeg':str(FFMPEG),
      'resources':{'encoderThreads':2,'nativeThreads':1},'params':{'size':'1280x720','fps':12,'layout':'grid','enter':'draw','quality':'standard','fill':'wipe','handSize':.25},
      'scene':{'id':f'b{index}','startMs':0,'endMs':4000,'elements':[{'id':f'e{k}','image':str(source),'role':'support','weight':1,'label':'fixed','atMs':k*1600,'windowEndMs':(k+1)*1600} for k in range(2)]},'outputs':{'prefix':f'fixed-{index}','hand':f'hand-{index}.png'}}
    file=output/'request.json';file.write_text(json.dumps(req),encoding='utf8')
    env={**os.environ,'OMP_NUM_THREADS':'1','OPENBLAS_NUM_THREADS':'1','MKL_NUM_THREADS':'1'}
    if full:env['TODO_CHALK_FULL_CANVAS']='1'
    else:env.pop('TODO_CHALK_FULL_CANVAS',None)
    p=subprocess.run([sys.executable,str(ROOT/'server/skills/chalk-hand/render.py'),'--request',str(file)],env=env,capture_output=True,text=True,encoding='utf8',timeout=120)
    assert p.returncode==0,p.stderr+p.stdout
    result=json.loads(next(line[8:] for line in p.stdout.splitlines() if line.startswith('@result ')))
    (output/'result.json').write_text(json.dumps(result),encoding='utf8')
    return output,result

def fingerprint(output,result):
    signatures=[]
    for e in result['scene']['elements']:
        p=subprocess.run([str(FFMPEG),'-v','error','-c:v','libvpx-vp9','-i',str(output/e['video']),'-f','rawvideo','-pix_fmt','bgra','-'],capture_output=True,timeout=30)
        assert p.returncode==0,p.stderr
        w,h=e['crop'][2:];assert len(p.stdout)==e['frames']*w*h*4
        frames=np.frombuffer(p.stdout,dtype=np.uint8).reshape(-1,h,w,4)
        assert frames[-1,:,:,3].max()>100 and frames[-1,0,0,3]==0,'alpha missing'
        hold=cv2.imdecode(np.fromfile(str(output/e['hold']),dtype=np.uint8),cv2.IMREAD_UNCHANGED)
        assert hold.shape==(h,w,4)
        signatures.append({'id':e['id'],'crop':e['crop'],'startMs':e['startMs'],'durationMs':e['durationMs'],'frames':e['frames'],'tip':e['tip'],'pixels':hashlib.sha256(p.stdout).hexdigest(),'hold':hashlib.sha256(hold.tobytes()).hexdigest()})
    return signatures

records=[];reference=None
for name,workers,full in [('full-serial',1,True),('local-serial',1,False),('local-parallel',2,False)]:
    runs=[]
    for repetition in range(3):
        folder=OUT/f'{name}-{repetition}'
        start=time.perf_counter()
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            results=list(pool.map(lambda i:job(folder,i,full),range(2)))
        elapsed=(time.perf_counter()-start)*1000;runs.append(elapsed)
        signatures=[fingerprint(*r) for r in results]
        if reference is None:reference=signatures
        assert signatures==reference,f'pipeline output drift in {name}'
        print(json.dumps({'stage':name,'run':repetition,'ms':elapsed,'pixelsEqual':True}),flush=True)
    records.append({'name':name,'workers':workers,'runsMs':runs,'medianMs':statistics.median(runs)})
report={'ok':True,'workload':'two 1280x720 scenes, two draw elements each, 12fps, fixed CPU library/VP9 threads; process initialization and rendering/encoding/hold included; decoded validation excluded from timing','coldProcesses':True,'quality':'all decoded BGRA pixels, holds, crops, timestamps and tips equal','records':records}
report['localSpeedup']=records[0]['medianMs']/records[1]['medianMs'];report['parallelSpeedup']=records[1]['medianMs']/records[2]['medianMs']
assert records[1]['medianMs']<records[0]['medianMs'],'local render must improve representative workload'
(OUT/'benchmark.json').write_text(json.dumps(report,indent=2),encoding='utf8')
print(json.dumps(report),flush=True)
