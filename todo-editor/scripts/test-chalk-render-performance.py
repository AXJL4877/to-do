"""Fixed offline frame baseline: no TTS/image service or final encoder needed."""
from __future__ import annotations
import argparse, contextlib, hashlib, importlib.util, io, json, time
from pathlib import Path
import cv2
import numpy as np

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'native/test-output/chalk-performance'
spec=importlib.util.spec_from_file_location('chalk_perf',ROOT/'server/skills/chalk-hand/render.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class Sink:
    def __init__(self):self.stdin=self;self.frames=[]
    def write(self,data):self.frames.append(data);return len(data)

def fixture(W,H,edge=False):
    image=np.zeros((H,W,3),np.uint8)
    x,y=(4,5) if edge else (W//2-140,H//2-90)
    cv2.rectangle(image,(x+12,y+12),(x+242,y+172),(230,236,240),5)
    cv2.line(image,(x+15,y+155),(x+225,y+22),(190,220,235),5)
    cv2.circle(image,(x+120,y+92),36,(220,210,180),4)
    mask=(image.max(axis=2)>0).astype(np.uint8)*255
    ys,xs=np.where(mask);box=[int(xs.min()),int(ys.min()),int(xs.max()-xs.min()+1),int(ys.max()-ys.min()+1)]
    return image,mask,{'id':'e-fixed','label':'fixed','role':'hero','box':box,'area':int(mask.sum()/255)}

def run(W,H,edge,local):
    folder=OUT/f'{W}-{H}-{edge}';(folder/'masks').mkdir(parents=True,exist_ok=True)
    image,mask,e=fixture(W,H,edge);x,y,w,h=e['box'];m.save_png(folder/'masks/e-fixed.png',mask[y:y+h,x:x+w])
    crop=m.element_crop(e['box'],W,H)
    ann=m.annotation('test',W,H,1300,[e],[(0,1100)],'masks/')
    stage=m.Stage({'background':'transparent','fill':'wipe'},W,H,12)
    sink=Sink();stage.sink=sink;stage.total_frames=16
    started=time.perf_counter()
    if local:
        r=stage.element_renderer(image,ann,folder,crop,budget=16)
    else:
        r=stage.renderer(image,ann,folder,budget=16);r.crop=crop
    r.stamp_hand=False;r.tips=[]
    with contextlib.redirect_stdout(io.StringIO()):stage.run(r,1300,folder)
    elapsed=(time.perf_counter()-started)*1000
    tips=m.tip_path(r.tips,crop,12)
    digest=hashlib.sha256(b''.join(sink.frames)).hexdigest()
    buffers=sum(v.nbytes for v in vars(r).values() if isinstance(v,np.ndarray))
    return {'ms':elapsed,'sha256':digest,'tips':tips,'frames':len(sink.frames),'bufferBytes':buffers,'workSize':[r.out_w,r.out_h]}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--record',action='store_true');args=parser.parse_args()
    OUT.mkdir(parents=True,exist_ok=True)
    cases=[(1280,720,False),(1280,720,True),(720,1280,False)]
    results=[]
    for W,H,edge in cases:
        baseline=run(W,H,edge,False)
        if args.record:results.append({'case':[W,H,edge],'baseline':baseline});continue
        candidate=run(W,H,edge,True)
        assert candidate['frames']==baseline['frames']==16
        assert candidate['sha256']==baseline['sha256'],f'pixel mismatch: {W,H,edge}'
        assert candidate['tips']==baseline['tips'],f'tip coordinates mismatch: {W,H,edge}'
        assert candidate['bufferBytes']<baseline['bufferBytes']*.5,'local buffers must be substantially smaller'
        results.append({'case':[W,H,edge],'baseline':baseline,'candidate':candidate,'speedup':baseline['ms']/candidate['ms']})
    (OUT/('baseline.json' if args.record else 'comparison.json')).write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps({'ok':True,'record':args.record,'results':results},ensure_ascii=False))

if __name__=='__main__':main()
