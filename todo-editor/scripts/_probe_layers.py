"""探针：为什么清单里没有角色图层。直接跑导出器用的 _settled_boxes 看它返回什么。"""
import json
import os
import pathlib
import sys

pack = pathlib.Path(os.environ['APPDATA']) / 'todo-editor/data/skills/studio.spongebob-koubo/workflow'
sys.path.insert(0, str(pack / 'kit'))
sys.path.insert(0, str(pack / '02_镜头设计'))

from kit import layers_export as LE  # noqa: E402

plan = json.loads((pack / '02_镜头设计' / 'plan.json').read_text(encoding='utf-8'))
shot = next((s for s in plan['shots'] if len(s.get('layers') or []) >= 2), None)
print('shot mode=%s visual=%s 层数=%d' % (shot.get('mode'), shot.get('_visual'), len(shot.get('layers') or [])))
for L in (shot.get('layers') or []):
    print('  layer name=%s zone=%s enter_at=%s ground=%s fx=%s idle=%s' % (
        L.get('name'), L.get('zone'), L.get('enter_at'), L.get('ground'), L.get('fx'), L.get('idle')))

try:
    drawn = LE._settled_boxes(shot['layers'])
    print('_settled_boxes 返回 %d 项' % len(drawn))
    for d in drawn[:8]:
        print('   name=%s settled=%s box=%s' % (
            d.get('name'), d.get('settled'),
            (tuple(round(v) for v in d['box']) if d.get('box') else None)))
except Exception as e:
    import traceback
    print('_settled_boxes 抛异常:', type(e).__name__, e)
    traceback.print_exc()

# 素材解析：库认不认这个名字
try:
    from kit import assets as A
    A.build(force=False, verbose=False)
    for L in (shot.get('layers') or [])[:3]:
        nm = L.get('name')
        found = list((pack / 'kit' / 'assets').rglob(f'{nm}*')) + list((pack / 'kit_assets').rglob(f'{nm}*'))
        print('  素材查找 %s → %d 个候选: %s' % (nm, len(found), [str(p.relative_to(pack)) for p in found[:2]]))
except Exception as e:
    print('assets 检查失败:', e)
