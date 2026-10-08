"""sanitize 纯逻辑测试（不花钱）。"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tts_timeline.sanitize import sanitize_for_speech


def test_stars_and_markdown():
    cases = [
        ("**重点来了**", "重点来了"),
        ("这是*强调*内容", "这是强调内容"),
        ("残留*号不要读", "残留号不要读"),
        ("价格#标签 `code`", "价格标签 code"),
        ("你好，世界。", "你好，世界。"),
        ("全角＊星号＊", "全角星号"),
    ]
    for raw, expect in cases:
        got = sanitize_for_speech(raw)["spoken"]
        assert got == expect, (raw, got, expect)
    print("ok", len(cases), "cases")


if __name__ == "__main__":
    test_stars_and_markdown()
