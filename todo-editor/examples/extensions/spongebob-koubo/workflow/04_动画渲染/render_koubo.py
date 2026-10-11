"""按 01 时间轴 + 02 素材合成成片（引擎：包内 kit/render）。"""
from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

KOUBO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(KOUBO))
sys.path.insert(0, str(KOUBO / "kit"))

import paths

paths.ensure()


def _sync_raw():
    raw = paths.KIT_ASSETS / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    for folder in (paths.CAST, paths.ELEMENTS, paths.PROPS):
        for png in folder.glob("*.png"):
            dest = raw / png.name
            if not dest.exists() or png.stat().st_mtime > dest.stat().st_mtime:
                shutil.copy2(png, dest)


def main():
    if not paths.TTS_TIMING.exists() or not paths.TTS_AUDIO.exists():
        raise SystemExit(f"missing TTS: run {paths.TTS / 'run_tts.py'}")

    from kit import assets as A, director, render

    cut = paths.KIT_ASSETS / "cut"
    shot_cuts = list(cut.glob("ch_s*.png")) + list(cut.glob("pr_s*.png")) if cut.is_dir() else []
    if not shot_cuts and not any(paths.CAST.glob("*.png")):
        raise SystemExit("缺少镜头专用素材：请先跑设计与素材生成")

    _sync_raw()
    A.build(force=False, verbose=False)

    timing = json.loads(paths.TTS_TIMING.read_text(encoding="utf-8"))
    timing["audio_path"] = str(paths.TTS_AUDIO)
    sentences = timing.get("sentences") or []
    if not sentences:
        raise SystemExit("timing.json has no sentences")

    _, names = director.inventory()
    if paths.DESIGN_PLAN.is_file():
        plan = json.loads(paths.DESIGN_PLAN.read_text(encoding="utf-8"))
        print("design plan", paths.DESIGN_PLAN, flush=True)
    elif (paths.RENDER_OUT / "plan.json").is_file():
        plan_path = paths.RENDER_OUT / "plan.json"
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
        print("reuse plan", plan_path, flush=True)
    else:
        raise SystemExit(f"缺少镜头设计：{paths.DESIGN_PLAN}")

    paths.PREVIEW.mkdir(parents=True, exist_ok=True)
    for stale in paths.PREVIEW.glob("f_*.jpg"):
        stale.unlink()
    bare = paths.RENDER_OUT / "成片_无BGM前.mp4"
    if bare.is_file():
        bare.unlink()

    preview = os.environ.get("KOUBO_PREVIEW", "").strip().lower() in ("1", "true", "yes")
    if not os.environ.get("KOUBO_FAST"):
        os.environ["KOUBO_FAST"] = "1"

    out = render.render_film(
        timing,
        plan,
        paths.OUTPUT_VIDEO,
        paths.RENDER_OUT,
        preview=preview,
        intro_seconds=0.0,
    )
    print("film", out, flush=True)

    # E1：并行导出可编辑透明层（失败不阻断成片）
    emit = os.environ.get("KOUBO_EMIT_LAYERS", "1").strip().lower() not in ("0", "false", "no")
    if emit:
        try:
            from kit.layers_export import export_editable_layers
            export_editable_layers(timing, plan, paths.RENDER_OUT)
        except Exception as e:
            print("layers_export failed:", e, flush=True)


if __name__ == "__main__":
    main()
