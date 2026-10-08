"""timing 聚合纯逻辑测试（不花钱）。"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tts_timeline.timing import build_hierarchy


def test_three_levels():
    sentences_raw = [
        {
            "text": "你好，世界。",
            "words": [
                {"word": "你", "startTime": 0.0, "endTime": 0.1, "confidence": 0.9},
                {"word": "好，", "startTime": 0.1, "endTime": 0.25, "confidence": 0.9},
                {"word": "世", "startTime": 0.3, "endTime": 0.4, "confidence": 0.9},
                {"word": "界。", "startTime": 0.4, "endTime": 0.55, "confidence": 0.9},
            ],
        },
        {
            "text": "今天不错。",
            "words": [
                {"word": "今", "startTime": 0.7, "endTime": 0.8, "confidence": 0.9},
                {"word": "天", "startTime": 0.8, "endTime": 0.9, "confidence": 0.9},
                {"word": "不", "startTime": 0.9, "endTime": 1.0, "confidence": 0.9},
                {"word": "错。", "startTime": 1.0, "endTime": 1.2, "confidence": 0.9},
            ],
        },
    ]
    h = build_hierarchy(text="你好，世界。今天不错。", sentences_raw=sentences_raw, words=None)
    assert len(h["sentences"]) == 2
    assert len(h["phrases"]) >= 3  # 你好， / 世界。 / 今天不错。
    assert len(h["chars"]) >= 8
    assert h["duration"] == 1.2
    assert h["sentences"][0]["phrases"][0]["chars"][0]["text"] == "你"
    print("ok", {k: len(h[k]) for k in ("sentences", "phrases", "chars")})


if __name__ == "__main__":
    test_three_levels()
