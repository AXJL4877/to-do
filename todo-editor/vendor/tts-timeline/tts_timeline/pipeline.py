"""唯一入口：文案 → 本模块 outputs/<作业>/ 下的 audio.wav + timing.json。

硬锁：
- 产物只写到本模块 outputs/<作业>/
- 成功后不删除同级其它作业；clean 才清空 outputs/
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

from tts_timeline.cleanup import require_module_out
from tts_timeline.sanitize import sanitize_for_speech
from tts_timeline.pause import compress_pauses, snap_sentence_edges
from tts_timeline.retime import retime
from tts_timeline.timing import build_hierarchy
from tts_timeline.wavfix import fix_wav_header


def _mishi_root() -> Path:
    """优先 MISHI_ROOT；其次同级 vendor/mishi；最后兼容本机桌面密匙。"""
    env = (os.environ.get("MISHI_ROOT") or "").strip()
    if env:
        return Path(env)
    # …/vendor/tts-timeline/tts_timeline/pipeline.py → …/vendor/mishi
    sibling = Path(__file__).resolve().parents[2] / "mishi"
    if (sibling / "run.py").is_file() or (sibling / "media").is_dir():
        return sibling
    desktop = Path(r"d:\Desktop\密匙")
    if (desktop / "run.py").is_file():
        return desktop
    return sibling


def _ensure_mishi() -> None:
    root = str(_mishi_root())
    if root not in sys.path:
        sys.path.insert(0, root)


def synthesize(
    text: str,
    *,
    out_dir: Path | str,
    speaker: str | None = None,
    resource_id: str | None = None,
    sample_rate: int = 24000,
    audio_name: str = "audio.wav",
    timing_name: str = "timing.json",
    allow_local: bool = False,
    auto_clean: bool = False,
    speech_rate: int | None = None,
    max_pause: float | None = None,
) -> dict[str, Any]:
    """调用密匙 Seed TTS 2.0，强制写出 audio.wav + timing.json。

    out_dir：必须在本模块 outputs/ 下。
    allow_local / auto_clean：保留兼容参数；成功默认不 wipe 同级作业。
    """
    del allow_local  # 兼容旧 CLI；产物必须落本模块 outputs/
    _ensure_mishi()
    from media.tts import synthesize as mishi_tts  # noqa: WPS433

    cleaned = sanitize_for_speech(text)
    spoken = cleaned["spoken"]
    if not spoken:
        raise RuntimeError("empty TTS text after sanitize（原文可能只剩特殊符号）")

    out_dir = require_module_out(out_dir)
    audio_path = out_dir / audio_name
    timing_path = out_dir / timing_name

    raw = mishi_tts(
        spoken,
        out=audio_path,
        speaker=speaker,
        resource_id=resource_id,
        format="wav",
        sample_rate=sample_rate,
        enable_subtitle=True,
        disable_markdown_filter=True,
        speech_rate=speech_rate,
    )
    if not raw.get("ok"):
        raise RuntimeError(raw.get("error") or "tts failed")

    # 火山流式 WAV 常带 0xFFFFFFFF 长度，下游 wave/ffmpeg 会读崩
    fix_wav_header(audio_path)

    hierarchy = build_hierarchy(
        text=spoken,
        sentences_raw=raw.get("sentences_raw") or [],
        words=raw.get("words") or [],
    )
    if not hierarchy["chars"] and not hierarchy["sentences"]:
        raise RuntimeError(
            "TTS 未返回字幕时间戳（enable_subtitle）。"
            "请确认 resource_id 为 seed-tts-2.0 / seed-icl-2.0，且语种为中/英。"
        )

    # 时长取 wav 实长；被压扁的尾句按实际人声结束重铺
    retime(hierarchy, audio_path)
    cuts = compress_pauses(hierarchy, audio_path, max_pause=max_pause) if max_pause else []
    snaps = snap_sentence_edges(hierarchy, audio_path)

    payload: dict[str, Any] = {
        "version": 1,
        "text": spoken,
        "text_original": cleaned["original"],
        "text_sanitized": cleaned["changed"],
        "audio": audio_name,
        "audio_path": str(audio_path.resolve()),
        "duration": hierarchy["duration"],
        "sample_rate": sample_rate,
        "speaker": raw.get("speaker"),
        "resource_id": raw.get("resource_id"),
        "speech_rate": speech_rate or 0,
        "max_pause": max_pause or 0,
        "pause_cuts": cuts,
        "edge_snaps": snaps,
        "source": "volcengine.enable_subtitle",
        "sentences": hierarchy["sentences"],
        "phrases": hierarchy["phrases"],
        "chars": hierarchy["chars"],
        "words": raw.get("words") or [],
    }
    timing_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    return {
        "ok": True,
        "mode": "tts_timeline",
        "dir": str(out_dir),
        "audio": str(audio_path.resolve()),
        "timing": str(timing_path.resolve()),
        "duration": payload["duration"],
        "text_sanitized": cleaned["changed"],
        "counts": {
            "sentences": len(payload["sentences"]),
            "phrases": len(payload["phrases"]),
            "chars": len(payload["chars"]),
            "words": len(payload["words"]),
        },
        "speaker": payload.get("speaker"),
        "cleaned": None if not auto_clean else {"ok": True, "mode": "skipped_sibling_jobs"},
    }
