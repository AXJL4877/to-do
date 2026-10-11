"""包内口播管线路径：代码在扩展包，产物写到 KOUBO_WORK（宿主 outDir）。"""
from __future__ import annotations

import os
import shutil
from pathlib import Path

CODE = Path(os.environ.get("KOUBO_CODE") or Path(__file__).resolve().parent)
WORK = Path(os.environ.get("KOUBO_WORK") or CODE)
ROOT = WORK  # 兼容旧脚本里的 paths.ROOT

TTS = WORK / "01_口播试听"
DESIGN = WORK / "02_镜头设计"
ASSETS = WORK / "03_素材生成"
RENDER = WORK / "04_动画渲染"

REF_BGM = CODE / "ref_bgm"
KIT_CODE = CODE / "kit"
KIT_ASSETS = Path(os.environ["KOUBO_KIT_ASSETS"]) if os.environ.get("KOUBO_KIT_ASSETS") else (WORK / "kit_assets")

TTS_SCRIPT = TTS / "口播.txt"
TTS_AUDIO = TTS / "audio.wav"
TTS_TIMING = TTS / "timing.json"
TTS_LOGS = TTS / "logs"

DESIGN_PLAN = DESIGN / "plan.json"
DESIGN_SHOTS = DESIGN / "shots_design.json"
DESIGN_REVIEW = DESIGN / "镜头表.md"

CAST = ASSETS / "cast"
ELEMENTS = ASSETS / "elements"
PROPS = ASSETS / "props"
PROMPTS = ASSETS / "prompts"
ASSETS_LOGS = ASSETS / "logs"

RENDER_OUT = RENDER / "output"
PREVIEW = RENDER_OUT / "preview"
OUTPUT_VIDEO = RENDER_OUT / "成片.mp4"


def _seed_kit_assets() -> None:
    """把包内静态海滩/泡泡拷到可写 kit_assets，cut/raw 也写这里。"""
    KIT_ASSETS.mkdir(parents=True, exist_ok=True)
    mapping = [
        (CODE / "kit" / "assets" / "backgrounds" / "plate_beach.jpg", KIT_ASSETS / "backgrounds" / "plate_beach.jpg"),
        (CODE / "kit" / "assets" / "fx" / "bubble_wipe.mp4", KIT_ASSETS / "fx" / "bubble_wipe.mp4"),
    ]
    for src, dst in mapping:
        if not src.is_file():
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        if not dst.exists() or src.stat().st_mtime > dst.stat().st_mtime:
            shutil.copy2(src, dst)
    for name in ("raw", "cut"):
        (KIT_ASSETS / name).mkdir(parents=True, exist_ok=True)


def ensure():
    _seed_kit_assets()
    # 包内 voice.json 拷到工作区（可被宿主覆盖）
    src_voice = CODE / "01_口播试听" / "voice.json"
    TTS.mkdir(parents=True, exist_ok=True)
    if src_voice.is_file() and not (TTS / "voice.json").is_file():
        shutil.copy2(src_voice, TTS / "voice.json")
    for d in (
        TTS,
        TTS_LOGS,
        DESIGN,
        CAST,
        ELEMENTS,
        PROPS,
        PROMPTS,
        ASSETS_LOGS,
        RENDER,
        RENDER_OUT,
        PREVIEW,
    ):
        d.mkdir(parents=True, exist_ok=True)
