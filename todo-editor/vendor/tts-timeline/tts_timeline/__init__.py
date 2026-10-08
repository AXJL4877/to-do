"""TTS + 多级时间戳管线。

硬锁产物（业务 --out 目录）：
  audio.wav
  timing.json   # sentences / phrases / chars

本仓库不备份业务产物；成功后自动清理 outputs/。
"""
from __future__ import annotations

from tts_timeline.pipeline import synthesize

__version__ = "0.2.0"
__all__ = ["synthesize", "__version__"]
