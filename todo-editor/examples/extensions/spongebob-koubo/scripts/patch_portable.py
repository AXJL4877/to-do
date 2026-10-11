"""Rewrite absolute paths inside assembled workflow/ so the pack is portable."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "workflow"


def patch(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    if old not in text:
        raise SystemExit(f"block not found in {path}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    print("patched", path.relative_to(ROOT.parent))


def replace_all(path: Path, old: str, new: str) -> int:
    text = path.read_text(encoding="utf-8")
    n = text.count(old)
    if n:
        path.write_text(text.replace(old, new), encoding="utf-8")
        print(f"patched {path.relative_to(ROOT.parent)} x{n}")
    return n


def main() -> None:
    patch(
        ROOT / "kit" / "kit" / "assets.py",
        'KIT = Path(__file__).resolve().parent.parent\n'
        'ASSETS = KIT / "assets"\n'
        'RAW = ASSETS / "raw"\n'
        'CUT = ASSETS / "cut"\n'
        'BG = ASSETS / "backgrounds"\n'
        'MANIFEST = ASSETS / "manifest.json"\n'
        "\n"
        'IMAGE_RUN = Path(r"d:\\Desktop\\密匙\\run.py")\n',
        "import os\n"
        "KIT = Path(__file__).resolve().parent.parent\n"
        '_ASSETS_ENV = os.environ.get("KOUBO_KIT_ASSETS", "").strip()\n'
        'ASSETS = Path(_ASSETS_ENV) if _ASSETS_ENV else (KIT / "assets")\n'
        'RAW = ASSETS / "raw"\n'
        'CUT = ASSETS / "cut"\n'
        'BG = ASSETS / "backgrounds"\n'
        'MANIFEST = ASSETS / "manifest.json"\n'
        "\n"
        "def _mishi_run():\n"
        '    root = Path(os.environ.get("MISHI_ROOT") or "").expanduser()\n'
        '    cand = root / "run.py"\n'
        "    return cand if cand.is_file() else Path()\n"
        "IMAGE_RUN = _mishi_run()\n",
    )

    patch(
        ROOT / "kit" / "kit" / "llm.py",
        'LLM_RUN = Path(r"d:\\Desktop\\密匙\\run.py")\n'
        'TTS_RUN = Path(r"d:\\video_Tools\\TTS_timeline\\run.py")\n',
        "import os\n"
        "\n"
        "def _tool(env_name: str, leaf: str) -> Path:\n"
        '    root = Path(os.environ.get(env_name) or "").expanduser()\n'
        "    cand = root / leaf\n"
        "    return cand if cand.is_file() else Path()\n"
        "\n"
        'LLM_RUN = _tool("MISHI_ROOT", "run.py")\n'
        'TTS_RUN = _tool("TTS_TIMELINE_ROOT", "run.py")\n',
    )

    patch(
        ROOT / "kit" / "kit" / "typo.py",
        "# Cards keep 思源宋 Heavy；开场红字用用户指定哥特黑体（字怀更开，少黏笔）。\n"
        '_HAN_SERIF = Path(r"C:\\Windows\\Fonts\\Source Han Serif SC Heavy (TrueType).ttf")\n'
        'CARD_FONT = _HAN_SERIF if _HAN_SERIF.exists() else FONTS / "FZCuHeiSongS-B-GB.ttf"\n'
        'SUB_FONT = Path(r"C:\\Windows\\Fonts\\msyhbd.ttc")\n'
        '_TITLE_AMEZUMI = Path(r"d:\\Desktop\\TTF\\AmezumiGothic.ttf")\n'
        "TITLE_FONT = _TITLE_AMEZUMI if _TITLE_AMEZUMI.exists() else CARD_FONT\n",
        "# Cards keep 思源宋 Heavy；开场红字优先包内 AmezumiGothic。\n"
        '_HAN_SERIF = Path(r"C:\\Windows\\Fonts\\Source Han Serif SC Heavy (TrueType).ttf")\n'
        'CARD_FONT = _HAN_SERIF if _HAN_SERIF.exists() else FONTS / "FZCuHeiSongS-B-GB.ttf"\n'
        'SUB_FONT = Path(r"C:\\Windows\\Fonts\\msyhbd.ttc")\n'
        '_TITLE_AMEZUMI = FONTS / "AmezumiGothic.ttf"\n'
        "TITLE_FONT = _TITLE_AMEZUMI if _TITLE_AMEZUMI.exists() else CARD_FONT\n",
    )

    patch(
        ROOT / "kit" / "kit" / "render.py",
        'INTRO_WIPE = Path(__file__).resolve().parents[1] / "assets" / "fx" / "bubble_wipe.mp4"\n',
        "import os as _os\n"
        '_assets = Path(_os.environ["KOUBO_KIT_ASSETS"]) if _os.environ.get("KOUBO_KIT_ASSETS") else (Path(__file__).resolve().parents[1] / "assets")\n'
        'INTRO_WIPE = _assets / "fx" / "bubble_wipe.mp4"\n',
    )

    # mix_bgm: REF_BGM from CODE
    mix = ROOT / "04_动画渲染" / "mix_bgm.py"
    mt = mix.read_text(encoding="utf-8")
    if 'REF_BGM = paths.REF_BGM' not in mt:
        mt2 = mt.replace('REF_BGM = KOUBO / "ref_bgm"\n', 'REF_BGM = paths.REF_BGM\n', 1)
        if mt2 == mt:
            raise SystemExit("mix_bgm REF_BGM block not found")
        mix.write_text(mt2, encoding="utf-8")
        print("patched", mix.relative_to(ROOT.parent))
    else:
        print("skip mix_bgm (already portable)")

    # bgm_policy REF_BGM
    bgm = ROOT / "bgm_policy.py"
    bt = bgm.read_text(encoding="utf-8")
    bt2 = bt.replace(
        'KOUBO = Path(__file__).resolve().parent\nREF_BGM = KOUBO / "ref_bgm"\n',
        'import os\n'
        'KOUBO = Path(os.environ.get("KOUBO_CODE") or Path(__file__).resolve().parent)\n'
        'REF_BGM = KOUBO / "ref_bgm"\n',
        1,
    )
    if bt2 == bt:
        raise SystemExit("bgm_policy REF_BGM block not found")
    bgm.write_text(bt2, encoding="utf-8")
    print("patched", bgm.relative_to(ROOT.parent))

    # gen_from_brief: MISHI_ROOT + kit path
    gen = ROOT / "03_素材生成" / "gen_from_brief.py"
    gt = gen.read_text(encoding="utf-8")
    gt2 = gt
    gt2 = gt2.replace(
        'sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "kit"))\n',
        'sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "kit"))\n',
    )
    gt2 = gt2.replace('sys.path.insert(0, r"d:\\Desktop\\密匙")', 'sys.path.insert(0, __import__("os").environ.get("MISHI_ROOT", ""))')
    gt2 = gt2.replace(
        'MISHI = Path(r"d:\\Desktop\\密匙\\run.py")',
        'MISHI = Path(__import__("os").environ.get("MISHI_ROOT", "")) / "run.py"',
    )
    gen.write_text(gt2, encoding="utf-8")
    print("patched", gen.relative_to(ROOT.parent))

    # cleanup / accept absolute stage
    replace_all(
        ROOT / "cleanup.py",
        'Path(r"d:\\Desktop\\koubo_asset_stage")',
        'Path(__import__("os").environ.get("KOUBO_WORK", ".")) / "_asset_stage"',
    )

    # g2 MISHI batch path
    g2 = ROOT / "accept_gates" / "g2_asset_efficiency.py"
    if g2.is_file():
        g2t = g2.read_text(encoding="utf-8")
        g2t2 = g2t.replace(
            'MISHI_BATCH = Path(r"d:\\Desktop\\密匙\\media\\image_batch.py")',
            'MISHI_BATCH = Path(__import__("os").environ.get("MISHI_ROOT", "")) / "media" / "image_batch.py"',
        )
        g2t2 = g2t2.replace(
            'cut_dir = paths.TRIAL.parent / "kit" / "assets" / "cut"',
            'cut_dir = paths.KIT_ASSETS / "cut"',
        )
        if g2t2 != g2t:
            g2.write_text(g2t2, encoding="utf-8")
            print("patched", g2.relative_to(ROOT.parent))

    # strip leftover Desktop / video_Tools absolute paths (warn)
    for p in ROOT.rglob("*.py"):
        t = p.read_text(encoding="utf-8", errors="replace")
        if re.search(r"d:\\\\Desktop\\\\|d:/Desktop/|d:\\\\video_Tools|d:/video_Tools", t, re.I):
            print("WARN still has abs path:", p.relative_to(ROOT))


if __name__ == "__main__":
    main()
