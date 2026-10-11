"""验证 run_pipeline 的部分阶段护栏（不跑生成、不花钱）。

背景：对已出过成片的目录单独跑 `--design`，会重新冻结设计并覆盖
pipeline_timing.json，使"设计文档"与"磁盘上那批 cut/成片"不再对应，且不可逆
（实测踩到：g1/g5 开始报空层，各阶段耗时全丢）。护栏要么拦住，要么显式放行。
"""
import argparse
import importlib.util
import os
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
CODE = Path(os.environ["KOUBO_CODE"])
spec = importlib.util.spec_from_file_location("rp", CODE / "run_pipeline.py")
rp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rp)

work = rp.paths.WORK
has_final = (rp.paths.RENDER / "output" / "成片.mp4").is_file() or \
            (rp.paths.RENDER / "output" / "layers_manifest.json").is_file()
has_design = (rp.paths.DESIGN / "briefs_locked.json").is_file() or \
             (rp.paths.DESIGN / "plan.json").is_file()
print(f"KOUBO_WORK     = {work}")
print(f"有终态产物      = {has_final}")
print(f"有已冻结设计    = {has_design}\n")


def mk(**kw):
    d = dict(all=False, clean=False, tts=False, design=False, assets=False,
             render=False, bgm=False, accept=False, allow_partial=False)
    d.update(kw)
    return argparse.Namespace(**d)


cases = [
    ("--all（正常生成）", mk(all=True, design=True, assets=True), True),
    ("--design 单独跑", mk(design=True), False),
    ("--render 单独跑", mk(render=True), False),
    ("--assets 单独跑", mk(assets=True), False),
    ("--design --allow-partial", mk(design=True, allow_partial=True), True),
    ("无阶段参数（默认 render+bgm）", mk(), True),
]

bad = 0
for name, ns, want_allow in cases:
    try:
        rp._guard_partial_run(ns)
        allowed = True
    except SystemExit:
        allowed = False
    ok = allowed == want_allow
    if not ok:
        bad += 1
    print(f"{'✓' if ok else '✗'} {'通过' if allowed else '拒绝'}  {name}"
          f"   (期望 {'通过' if want_allow else '拒绝'})")

print()
if not (has_final and has_design):
    print("! 该工作目录没有终态产物或没有已冻结设计 → 护栏本就不该拦，用例 2/3/4 的期望需重估")
if bad:
    print(f"× {bad}/{len(cases)} 个用例不符合预期")
    sys.exit(1)
print(f"✓ {len(cases)}/{len(cases)} 通过：部分阶段会被拦，--all 与显式 --allow-partial 不受影响")
