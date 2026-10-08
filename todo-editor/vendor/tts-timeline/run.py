#!/usr/bin/env python3
"""固定管线唯一 CLI。外部项目禁止另写 TTS 脚本，只调本入口。

合成（产物进本模块 outputs/<作业>/）：
  python d:\\video_Tools\\TTS_timeline\\run.py synth --text-file script.md --out d:\\video_Tools\\TTS_timeline\\outputs\\<作业>
  python d:\\video_Tools\\TTS_timeline\\run.py clean
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tts_timeline.cleanup import wipe_outputs  # noqa: E402
from tts_timeline.pipeline import synthesize  # noqa: E402


def _emit(obj: dict) -> int:
    print(json.dumps(obj, ensure_ascii=False))
    return 0 if obj.get("ok") else 1


def cmd_synth(ns: argparse.Namespace) -> int:
    if ns.text_file:
        text = Path(ns.text_file).read_text(encoding="utf-8")
    else:
        text = ns.text or ""
    try:
        result = synthesize(
            text,
            out_dir=ns.out,
            speaker=ns.speaker,
            resource_id=ns.resource_id,
            sample_rate=ns.sample_rate,
            allow_local=bool(ns.allow_local),
            auto_clean=bool(ns.auto_clean),
            speech_rate=ns.speech_rate,
            max_pause=ns.max_pause,
        )
        return _emit(result)
    except Exception as e:
        return _emit({"ok": False, "mode": "tts_timeline", "error": str(e)})


def cmd_clean(_: argparse.Namespace) -> int:
    try:
        return _emit(wipe_outputs())
    except Exception as e:
        return _emit({"ok": False, "mode": "clean", "error": str(e)})


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)

    if argv and argv[0] not in ("synth", "clean", "-h", "--help"):
        argv = ["synth", *argv]

    p = argparse.ArgumentParser(
        description="TTS_timeline：synth → 本模块 outputs/<作业>/audio.wav + timing.json",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("synth", help="合成：本模块 outputs/<作业>/ 写出 audio.wav + timing.json")
    g = s.add_mutually_exclusive_group(required=True)
    g.add_argument("--text", help="旁白原文")
    g.add_argument("--text-file", help="从文件读旁白（UTF-8）")
    s.add_argument(
        "--out",
        required=True,
        help="本模块输出目录，须在 outputs/ 下，如 outputs/马太效应",
    )
    s.add_argument("--speaker", default=None)
    s.add_argument("--resource-id", default=None)
    s.add_argument("--sample-rate", type=int, default=24000)
    s.add_argument("--speech-rate", type=int, default=None,
                   help="语速 -50..100（0 原速，100 两倍速）")
    s.add_argument("--max-pause", type=float, default=None,
                   help="静音停顿上限（秒），超出部分裁掉并平移时间戳")
    s.add_argument(
        "--allow-local",
        action="store_true",
        help="兼容旧参数（已忽略；--out 必须在本模块 outputs/）",
    )
    s.add_argument(
        "--auto-clean",
        action="store_true",
        help="成功后 wipe outputs/ 其它目录（默认关）",
    )
    s.add_argument(
        "--no-clean",
        action="store_true",
        help="兼容旧参数（默认已不 wipe）",
    )
    s.set_defaults(func=cmd_synth)

    c = sub.add_parser("clean", help="清空本仓库 outputs/")
    c.set_defaults(func=cmd_clean)

    ns = p.parse_args(argv)
    return int(ns.func(ns))


if __name__ == "__main__":
    raise SystemExit(main())
