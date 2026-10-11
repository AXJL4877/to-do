"""Assemble self-contained workflow/ into this extension (no author machine paths)."""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

EXT = Path(__file__).resolve().parents[1]
OUT = EXT / "workflow"
SRC_KOUBO = Path(r"d:\Desktop\手绘风格\trial\koubo")
SRC_KIT = Path(r"d:\Desktop\手绘风格\kit")
SRC_AMEZUMI = Path(r"d:\Desktop\TTF\AmezumiGothic.ttf")

# 源码树里这些文件带作者机路径，组装后用包内便携模板覆盖
PORTABLE_OVERLAYS = {
    "paths.py": "templates/paths.py",
    "01_口播试听/run_tts.py": "templates/run_tts.py",
    "01_口播试听/resolve_voice.py": "templates/resolve_voice.py",
    "04_动画渲染/render_koubo.py": "templates/render_koubo.py",
}

KOUBO_FILES = [
    "run_pipeline.py",
    "cleanup.py",
    "accept_run.py",
    "richness.py",
    "bgm_policy.py",
    "01_口播试听/run_tts.py",
    "01_口播试听/resolve_voice.py",
    "01_口播试听/voice.json",
    "02_镜头设计/run_design.py",
    "02_镜头设计/design.py",
    "02_镜头设计/llm_briefs.py",
    "02_镜头设计/shot_kinds.py",
    "02_镜头设计/enrich_kinds.py",
    "02_镜头设计/entrance_recipes.py",
    "02_镜头设计/freeze_briefs.py",
    "02_镜头设计/remap_cuts.py",
    "03_素材生成/run_assets.py",
    "03_素材生成/gen_from_brief.py",
    "04_动画渲染/render_koubo.py",
    "04_动画渲染/mix_bgm.py",
    "accept_gates/__init__.py",
    "accept_gates/common.py",
    "accept_gates/run_all.py",
    "accept_gates/g1_shot_diversity.py",
    "accept_gates/g2_asset_efficiency.py",
    "accept_gates/g3_bgm_prescribed.py",
    "accept_gates/g4_pipeline_timing.py",
    "accept_gates/g5_dialogue_order.py",
    "accept_gates/g6_auto_retry.py",
    "accept_gates/g7_shutdown_armed.py",
    "accept_gates/g8_layout_text.py",
]

BGM = [
    "跨越大洋的飞机 - Holding Court.mp3",
    "眠舸 - 精卫（降调）.mp3",
    "TRA$H - Memories.mp3",
]

KIT_PY = list((SRC_KIT / "kit").glob("*.py"))


def copy_file(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    print("+", dst.relative_to(EXT), f"({src.stat().st_size // 1024} KB)")


def main() -> int:
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    for rel in KOUBO_FILES:
        src = SRC_KOUBO / rel
        if not src.is_file():
            print("MISSING", src)
            return 1
        copy_file(src, OUT / rel)

    for name in BGM:
        src = SRC_KOUBO / "ref_bgm" / name
        if not src.is_file():
            print("MISSING", src)
            return 1
        copy_file(src, OUT / "ref_bgm" / name)

    for src in KIT_PY:
        copy_file(src, OUT / "kit" / "kit" / src.name)
    copy_file(SRC_KIT / "fonts" / "FZCuHeiSongS-B-GB.ttf", OUT / "kit" / "fonts" / "FZCuHeiSongS-B-GB.ttf")
    if SRC_AMEZUMI.is_file():
        copy_file(SRC_AMEZUMI, OUT / "kit" / "fonts" / "AmezumiGothic.ttf")
    copy_file(
        SRC_KIT / "assets" / "backgrounds" / "plate_beach.jpg",
        OUT / "kit" / "assets" / "backgrounds" / "plate_beach.jpg",
    )
    copy_file(
        SRC_KIT / "assets" / "fx" / "bubble_wipe.mp4",
        OUT / "kit" / "assets" / "fx" / "bubble_wipe.mp4",
    )

    # 便携覆盖（paths / TTS / resolve_voice / render_koubo）
    for rel, tpl in PORTABLE_OVERLAYS.items():
        src = EXT / "scripts" / tpl
        if not src.is_file():
            print("MISSING template", src)
            return 1
        copy_file(src, OUT / rel)

    for d in (
        OUT / "01_口播试听" / "logs",
        OUT / "03_素材生成" / "cast",
        OUT / "03_素材生成" / "elements",
        OUT / "03_素材生成" / "props",
        OUT / "03_素材生成" / "prompts",
        OUT / "03_素材生成" / "logs",
        OUT / "04_动画渲染" / "output" / "preview",
        OUT / "kit" / "assets" / "raw",
        OUT / "kit" / "assets" / "cut",
        OUT / "02_镜头设计" / "logs",
    ):
        d.mkdir(parents=True, exist_ok=True)
        (d / ".gitkeep").write_text("", encoding="utf-8")

    total = sum(p.stat().st_size for p in OUT.rglob("*") if p.is_file())
    print(f"assembled {total / 1024 / 1024:.1f} MB -> {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
