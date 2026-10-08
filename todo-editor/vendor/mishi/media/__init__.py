"""密匙公开 API — 其它项目只从此包导入，勿依赖内部子模块细节。

Usage:
  import sys
  sys.path.insert(0, r"d:\\Desktop\\密匙")
  from media import (
      ROOT,
      generate_image, wait_image,
      generate_video, wait_video,
      synthesize_speech, analyze_vision, generate_chat, host_upload,
  )
"""
from __future__ import annotations

from pathlib import Path

from media.chat import generate as generate_chat
from media.host import upload as host_upload
from media.image import generate as generate_image
from media.image import wait as wait_image
from media.tts import synthesize as synthesize_speech
from media.video import generate as generate_video
from media.video import wait as wait_video
from media.vision import analyze as analyze_vision

ROOT = Path(__file__).resolve().parent.parent

__all__ = [
    "ROOT",
    "generate_image",
    "wait_image",
    "generate_video",
    "wait_video",
    "synthesize_speech",
    "analyze_vision",
    "generate_chat",
    "host_upload",
]
