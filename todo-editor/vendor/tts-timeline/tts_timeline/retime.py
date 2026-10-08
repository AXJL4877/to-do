"""按真实音频校正 timing：时长取 wav 实长；火山流式字幕常把最后一句压扁到结尾一瞬，按实际人声结束处重铺。"""
from __future__ import annotations

import array
import math
import sys
import wave
from pathlib import Path
from typing import Any

# 每字低于这个时长视为被压扁（正常语速约 0.15~0.25s/字）
CRUSHED_SEC_PER_CHAR = 0.07
# 人声结束判定：20ms 帧 RMS 低于 -40 dBFS 视为静音
SILENCE_DBFS = -40.0
FRAME_SEC = 0.02
PUNCT = set("，。、；：！？,.;:!?…—\"'“”‘’（）()《》【】 \n")


def audio_speech_span(wav_path: Path | str) -> tuple[float, float]:
    """(音频总时长, 最后一帧人声结束时间)。只认 16-bit PCM，其它格式返回 (时长, 时长)。"""
    with wave.open(str(wav_path), "rb") as w:
        rate, ch, width, n = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()
        dur = n / rate if rate else 0.0
        if width != 2 or not n:
            return dur, dur
        pcm = array.array("h", w.readframes(n))
    if sys.byteorder == "big":
        pcm.byteswap()
    hop = max(1, int(rate * FRAME_SEC)) * ch
    floor = 32768 * 10 ** (SILENCE_DBFS / 20)
    for i in range((len(pcm) - 1) // hop * hop, -1, -hop):
        seg = pcm[i:i + hop]
        if seg and math.sqrt(sum(s * s for s in seg) / len(seg)) >= floor:
            return dur, min(dur, (i + len(seg)) / ch / rate)
    return dur, dur


def _crushed(chars: list[dict[str, Any]]) -> bool:
    spoken = [c for c in chars if c["text"] not in PUNCT]
    if not spoken:
        return False
    return (spoken[-1]["end"] - spoken[0]["start"]) / len(spoken) < CRUSHED_SEC_PER_CHAR


def retime(timing: dict[str, Any], wav_path: Path | str) -> dict[str, Any]:
    """原地改 timing（chars / phrases / sentences / duration），返回 timing。多次调用结果不变。"""
    dur, speech_end = audio_speech_span(wav_path)
    chars = timing.get("chars") or []
    phrases = timing.get("phrases") or []
    if dur > 0:
        timing["duration"] = round(dur, 4)
    if not chars or not phrases:
        return timing
    by_id = {c["id"]: c for c in chars}
    # 从末尾往前找连续被压扁的短语，整段按实际人声结束重铺
    k = len(phrases)
    while k > 0 and _crushed([by_id[i] for i in phrases[k - 1]["char_ids"] if i in by_id]):
        k -= 1
    tail_ids = [i for p in phrases[k:] for i in p["char_ids"] if i in by_id]
    if tail_ids:
        seg = [by_id[i] for i in tail_ids]
        t0 = seg[0]["start"]
        t1 = max(speech_end, seg[-1]["end"])
        if t1 - t0 > 0.05:
            # 字占 1 份，句内标点当 0.6 份停顿；句末标点挂在人声结束之后
            last_punct = seg[-1]["text"] in PUNCT
            body = seg[:-1] if last_punct else seg
            weights = [0.6 if c["text"] in PUNCT else 1.0 for c in body]
            total = sum(weights) or 1.0
            t = t0
            for c, w in zip(body, weights):
                c["start"] = round(t, 4)
                t += (t1 - t0) * w / total
                c["end"] = round(t, 4)
            if last_punct:
                seg[-1]["start"] = round(t1, 4)
                seg[-1]["end"] = round(max(t1, min(dur, t1 + 0.15)), 4)
            for c in seg:
                c["retimed"] = True
    _sync_hierarchy(timing, by_id)
    return timing


def _sync_hierarchy(timing: dict[str, Any], by_id: dict[int, dict[str, Any]]) -> None:
    """扁平 chars 改过后，同步嵌套的 sentences→phrases→chars 与扁平 phrases 的起止。"""
    for p in timing.get("phrases") or []:
        ids = [i for i in p.get("char_ids") or [] if i in by_id]
        if ids:
            p["start"], p["end"] = by_id[ids[0]]["start"], by_id[ids[-1]]["end"]
    for s in timing.get("sentences") or []:
        for p in s.get("phrases") or []:
            for c in p.get("chars") or []:
                src = by_id.get(c.get("id"))
                if src:
                    c.update(start=src["start"], end=src["end"], **({"retimed": True} if src.get("retimed") else {}))
            if p.get("chars"):
                p["start"], p["end"] = p["chars"][0]["start"], p["chars"][-1]["end"]
        if s.get("phrases"):
            s["start"], s["end"] = s["phrases"][0]["start"], s["phrases"][-1]["end"]
