"""自清：开跑前清场；可选收尾只留成片+报告。

保留：口播稿/音色、ref_bgm、固定 cast/richness 样板（非 ch_s*/pr_s*）、管线脚本。
删除：本片镜头图、密匙 stage、设计缓存、渲染中间件、生图日志、__pycache__。
"""
from __future__ import annotations

import argparse
import shutil
from pathlib import Path

import paths

SHOT_PREFIXES = ("ch_s", "pr_s", "ch_fallback_", "koubo_ch_s", "koubo_pr_s")


def _is_shot_asset(name: str) -> bool:
    stem = Path(name).stem
    return any(stem.startswith(p) for p in SHOT_PREFIXES)


def _rm_tree(path: Path) -> int:
    if not path.exists():
        return 0
    if path.is_file():
        path.unlink(missing_ok=True)
        return 1
    n = sum(1 for _ in path.rglob("*") if _.is_file())
    shutil.rmtree(path, ignore_errors=True)
    return n


def _rm_glob(folder: Path, pattern: str) -> int:
    if not folder.is_dir():
        return 0
    n = 0
    for p in folder.glob(pattern):
        if p.is_file():
            p.unlink(missing_ok=True)
            n += 1
        elif p.is_dir():
            n += _rm_tree(p)
    return n


def _rm_shot_files(folder: Path) -> int:
    if not folder.is_dir():
        return 0
    n = 0
    for p in list(folder.iterdir()):
        if p.is_file() and _is_shot_asset(p.name):
            p.unlink(missing_ok=True)
            n += 1
    return n


def _wipe_dir_contents(folder: Path, *, keep_names: set[str] | None = None) -> int:
    """清空目录内容，保留目录本身；keep_names 为直接子项名。"""
    if not folder.is_dir():
        folder.mkdir(parents=True, exist_ok=True)
        return 0
    keep = keep_names or set()
    n = 0
    for p in list(folder.iterdir()):
        if p.name in keep:
            continue
        n += _rm_tree(p)
    return n


def clean_theme(
    *,
    wipe_design: bool = True,
    wipe_render: bool = True,
    wipe_tts_audio: bool = False,
    keep_final: bool = False,
) -> dict:
    paths.ensure()
    report: dict[str, int | str] = {}

    cut = paths.KIT_ASSETS / "cut"
    raw = paths.KIT_ASSETS / "raw"
    report["cut"] = _rm_shot_files(cut)
    # raw 常积压密匙下载原图：镜头相关全清；目录过大则整清
    report["raw_shot"] = _rm_shot_files(raw)
    if raw.is_dir():
        leftovers = [p for p in raw.iterdir() if p.is_file()]
        # 非镜头前缀的临时图也清（避免 200+ 张堆积）
        n = 0
        for p in leftovers:
            if p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}:
                p.unlink(missing_ok=True)
                n += 1
        report["raw_images"] = n

    report["elements"] = _rm_shot_files(paths.ELEMENTS)
    report["props"] = _rm_shot_files(paths.PROPS)
    report["prompts"] = _rm_glob(paths.PROMPTS, "ch_s*") + _rm_glob(paths.PROMPTS, "pr_s*")

    # 密匙 ASCII stage：整目录清空（只是中转）
    stage = Path(__import__("os").environ.get("KOUBO_WORK", ".")) / "_asset_stage"
    report["stage"] = _wipe_dir_contents(stage)

    if wipe_design:
        for name in (
            "shots_design.json",
            "plan.json",
            "assets_brief.json",
            "bgm_plan.json",
            "briefs_active.json",
            "briefs_locked.json",
            "timing_sync.json",
            "镜头表.md",
            "素材需求.md",
            "排版预览.md",
        ):
            p = paths.DESIGN / name
            if p.is_file():
                p.unlink(missing_ok=True)
                report[f"design:{name}"] = 1
        report["design_preview"] = _rm_tree(paths.DESIGN / "preview")
        report["design_logs"] = _wipe_dir_contents(paths.DESIGN / "logs")

    if wipe_render:
        out = paths.RENDER_OUT
        keep = {"成片.mp4"} if keep_final else set()
        # 先尽量删已知中间件，再扫一遍
        report["preview_frames"] = _rm_glob(paths.PREVIEW, "*")
        for sub in (
            "_bgm_mix",
            "_wipe_sfx",
            "card_flash",
            "_black_check",
            "_black_check2",
            "_kelly_check",
            "_bgm_probe",
            "gold40_check",
            "qa",
            "qa2",
            "sync_check",
            "accept_gates",
            "preview",
        ):
            d = out / sub
            if d.is_dir():
                report[f"render_dir:{sub}"] = _rm_tree(d)
        n = 0
        for p in list(out.iterdir()) if out.is_dir() else []:
            if p.name in keep:
                continue
            if p.is_file():
                try:
                    p.unlink(missing_ok=True)
                    n += 1
                except PermissionError:
                    # 正在被写的运行日志（如 Tee 输出）跳过，不让清场卡死管线
                    print(f"cleanup skip locked {p.name}", flush=True)
        report["render_files"] = n
        (out / "preview").mkdir(parents=True, exist_ok=True)

    # 生图日志（含 poll/submit）整清
    report["asset_logs"] = _wipe_dir_contents(paths.ASSETS_LOGS)

    # TTS：可选清音频（换稿必清）；默认保留以利断点续跑
    if wipe_tts_audio:
        for name in ("audio.wav", "timing.json", "timing_raw.json"):
            p = paths.TTS / name
            if p.is_file():
                p.unlink(missing_ok=True)
                report[f"tts:{name}"] = 1
        report["tts_logs"] = _wipe_dir_contents(paths.TTS_LOGS)

    # 各阶段 __pycache__
    n_py = 0
    for d in paths.ROOT.rglob("__pycache__"):
        n_py += _rm_tree(d)
    report["pycache"] = n_py

    return report


def tidy_after_success() -> dict:
    """验收通过后：丢掉 stage/raw/preview/中间音视频，保留成片与验收 JSON。"""
    paths.ensure()
    report: dict[str, int | str] = {}
    stage = Path(__import__("os").environ.get("KOUBO_WORK", ".")) / "_asset_stage"
    report["stage"] = _wipe_dir_contents(stage)
    raw = paths.KIT_ASSETS / "raw"
    report["raw"] = _wipe_dir_contents(raw) if raw.is_dir() else 0
    report["preview"] = _wipe_dir_contents(paths.PREVIEW)
    out = paths.RENDER_OUT
    keep = {
        "成片.mp4",
        "accept_report.json",
        "pipeline_timing.json",
        "layout_check.json",
        "accept_gates",
    }
    n = 0
    if out.is_dir():
        for p in list(out.iterdir()):
            if p.name in keep:
                continue
            if p.name.startswith("_") or p.suffix.lower() in {
                ".wav",
                ".jpg",
                ".png",
                ".txt",
                ".log",
            }:
                n += _rm_tree(p)
            elif p.name in ("silent.mp4", "mix.wav", "sfx.wav") or p.name.startswith("成片_"):
                n += _rm_tree(p)
    report["render_temps"] = n
    report["asset_logs"] = _wipe_dir_contents(paths.ASSETS_LOGS)
    return report


def main():
    ap = argparse.ArgumentParser(description="口播管线自清")
    ap.add_argument("--keep-design", action="store_true")
    ap.add_argument("--keep-render", action="store_true")
    ap.add_argument("--wipe-tts", action="store_true", help="连 audio/timing 一起清")
    ap.add_argument("--keep-final", action="store_true", help="保留成片.mp4")
    ap.add_argument("--tidy", action="store_true", help="验收后瘦身（留成片+报告）")
    args = ap.parse_args()
    if args.tidy:
        rep = tidy_after_success()
    else:
        rep = clean_theme(
            wipe_design=not args.keep_design,
            wipe_render=not args.keep_render,
            wipe_tts_audio=args.wipe_tts,
            keep_final=args.keep_final,
        )
    print("cleaned", rep)


if __name__ == "__main__":
    main()
