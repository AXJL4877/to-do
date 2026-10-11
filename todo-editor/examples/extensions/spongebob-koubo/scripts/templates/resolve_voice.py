"""解析口播音色。优先读工作区 / 包内 voice.json，不依赖作者机器路径。"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def _mishi() -> Path | None:
    raw = os.environ.get("MISHI_ROOT") or ""
    p = Path(raw).expanduser() if raw else None
    return p if p and p.is_dir() else None


def _env_get(name: str, default: str = "") -> str:
    root = _mishi()
    if not root:
        return default
    sys.path.insert(0, str(root))
    try:
        from media.env import get
        return get(name, default=default)
    except Exception:
        return default


def pacing(tts_dir: Path | None = None) -> tuple[int, float]:
    tts_dir = tts_dir or Path(__file__).resolve().parent
    cfg: dict = {}
    for name in ("voice.json", "voice.local.json"):
        path = tts_dir / name
        if path.is_file():
            cfg.update(json.loads(path.read_text(encoding="utf-8")))
    return int(cfg.get("speech_rate") or 0), float(cfg.get("max_pause") or 0)


def resolve(tts_dir: Path | None = None) -> tuple[str, str]:
    tts_dir = tts_dir or Path(__file__).resolve().parent
    cfg: dict = {}
    for name in ("voice.json", "voice.local.json"):
        path = tts_dir / name
        if path.is_file():
            cfg.update(json.loads(path.read_text(encoding="utf-8")))

    mode = (cfg.get("mode") or "clone").strip().lower()
    speaker = (cfg.get("speaker") or "").strip()
    resource_id = (cfg.get("resource_id") or "").strip()

    if mode in ("clone", "icl", "复刻", "克隆"):
        resource_id = resource_id or _env_get("VOLC_SPEECH_CLONE_RESOURCE_ID", "seed-icl-2.0")
        speaker = speaker or _env_get("VOLC_SPEECH_CLONE_SPEAKER") or _env_get("VOLC_SPEECH_SPEAKER")
    else:
        resource_id = resource_id or _env_get("VOLC_SPEECH_RESOURCE_ID", "seed-tts-2.0")
        speaker = speaker or _env_get("VOLC_SPEECH_SPEAKER", "zh_female_mizai_uranus_bigtts")

    if not speaker:
        raise RuntimeError("未配置 speaker（voice.json 或密匙音色）")
    if not resource_id:
        raise RuntimeError("未配置 resource_id")
    return speaker, resource_id
