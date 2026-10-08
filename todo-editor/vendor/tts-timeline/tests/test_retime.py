"""尾句校正测试（合成 wav，不花钱）。"""
from __future__ import annotations

import array
import math
import sys
import tempfile
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tts_timeline.retime import retime
from tts_timeline.timing import build_hierarchy

RATE = 24000


def _wav(path: Path, speech: list[tuple[float, float]], dur: float) -> None:
    pcm = array.array("h", [0] * int(dur * RATE))
    for a, b in speech:
        for i in range(int(a * RATE), int(b * RATE)):
            pcm[i] = int(8000 * math.sin(i / 7))
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm.tobytes())


def _words(items):
    return [{"word": t, "startTime": a, "endTime": b, "confidence": 0.9} for t, a, b in items]


def test_crushed_tail_respread():
    # 火山给的尾句「越轻松。」被压在 1.69~1.84，真实人声到 2.28、音频 2.6s
    raw = [{"text": "越早开始，越轻松。", "words": _words([
        ("越", 0.3, 0.5), ("早", 0.5, 0.7), ("开", 0.7, 0.9), ("始，", 0.9, 1.2),
        ("越", 1.69, 1.72), ("轻", 1.72, 1.78), ("松。", 1.78, 1.84),
    ])}]
    h = build_hierarchy(text="越早开始，越轻松。", sentences_raw=raw, words=None)
    with tempfile.TemporaryDirectory() as d:
        wav = Path(d) / "a.wav"
        _wav(wav, [(0.3, 1.2), (1.7, 2.28)], 2.6)
        retime(h, wav)
        again = retime(h, wav)
    assert abs(h["duration"] - 2.6) < 1e-3
    tail = [c for c in h["chars"] if c.get("retimed")]
    assert [c["text"] for c in tail] == ["越", "轻", "松", "。"]
    assert abs(tail[2]["end"] - 2.28) < 0.03
    assert tail[0]["start"] == 1.69
    # 前半句不动
    assert h["chars"][0]["start"] == 0.3 and h["chars"][3]["end"] < 1.2
    assert h["phrases"][-1]["end"] == tail[-1]["end"]
    assert h["sentences"][0]["phrases"][-1]["chars"][2]["end"] == tail[2]["end"]
    assert again["chars"] == h["chars"]
    print("ok tail", [(c["text"], c["start"], c["end"]) for c in tail])


def test_normal_untouched():
    raw = [{"text": "你好。", "words": _words([("你", 0.1, 0.3), ("好。", 0.3, 0.6)])}]
    h = build_hierarchy(text="你好。", sentences_raw=raw, words=None)
    before = [dict(c) for c in h["chars"]]
    with tempfile.TemporaryDirectory() as d:
        wav = Path(d) / "a.wav"
        _wav(wav, [(0.1, 0.55)], 0.8)
        retime(h, wav)
    assert h["chars"] == before
    assert abs(h["duration"] - 0.8) < 1e-3
    print("ok normal")


if __name__ == "__main__":
    test_crushed_tail_respread()
    test_normal_untouched()
