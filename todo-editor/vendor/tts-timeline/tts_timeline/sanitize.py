"""口播文本清洗：避免 *、markdown 等被 TTS 读成「星星」之类。"""
from __future__ import annotations

import re
from typing import Any

# **粗体** / *斜体* / __粗体__ / _斜体_（成对优先剥掉标记，保留正文）
_RE_MD_BOLD = re.compile(r"\*\*(.+?)\*\*")
_RE_MD_BOLD2 = re.compile(r"__(.+?)__")
_RE_MD_ITALIC = re.compile(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)")
_RE_MD_ITALIC2 = re.compile(r"(?<!_)_(?!_)(.+?)(?<!_)_(?!_)")
_RE_MD_CODE = re.compile(r"`([^`]+)`")
_RE_MD_LINK = re.compile(r"\!?\[([^\]]*)\]\([^)]*\)")
_RE_MD_HEADING = re.compile(r"(?m)^#{1,6}\s+")
# 残留会被读出的标记（含全角）
_RE_NOISE = re.compile(
    r"[*_`~|#<>\\{}"
    r"＊＿｀～｜＃＜＞＼｛｝"
    r"\u200b\u200c\u200d\ufeff"  # 零宽
    r"]+"
)
_RE_MULTI_SPACE = re.compile(r"[ \t\u3000]+")
_RE_MULTI_NL = re.compile(r"\n{3,}")


def sanitize_for_speech(text: str) -> dict[str, Any]:
    """返回 {original, spoken, changed}。spoken 送给 TTS / 时间轴。"""
    original = text or ""
    s = original

    s = _RE_MD_LINK.sub(r"\1", s)
    s = _RE_MD_BOLD.sub(r"\1", s)
    s = _RE_MD_BOLD2.sub(r"\1", s)
    s = _RE_MD_ITALIC.sub(r"\1", s)
    s = _RE_MD_ITALIC2.sub(r"\1", s)
    s = _RE_MD_CODE.sub(r"\1", s)
    s = _RE_MD_HEADING.sub("", s)
    s = _RE_NOISE.sub("", s)
    s = _RE_MULTI_SPACE.sub(" ", s)
    s = _RE_MULTI_NL.sub("\n\n", s)
    s = s.strip()

    return {
        "original": original.strip(),
        "spoken": s,
        "changed": s != original.strip(),
    }
