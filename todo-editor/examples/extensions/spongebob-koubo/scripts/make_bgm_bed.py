"""从已有 koubo 工作区按 bgm_plan 生成 bgm_bed.wav（无口播）。"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

work = Path(os.environ.get("KOUBO_WORK") or sys.argv[1])
wf = Path(__file__).resolve().parents[1] / "workflow"
sys.path[:0] = [str(wf), str(wf / "kit"), str(wf / "04_动画渲染")]
os.environ.setdefault("KOUBO_WORK", str(work))
os.environ.setdefault("KOUBO_CODE", str(wf))

import paths  # noqa: E402
from mix_bgm import load_plan, mix  # noqa: E402

paths.ensure()
bare = paths.RENDER_OUT / "成片_无BGM前.mp4"
out = paths.OUTPUT_VIDEO
if not bare.is_file() and out.is_file():
    bare.write_bytes(out.read_bytes())
plan = load_plan()
mix(bare if bare.is_file() else None, plan=plan, out=out)
print("bgm_bed", (paths.RENDER_OUT / "bgm_bed.wav").is_file())
