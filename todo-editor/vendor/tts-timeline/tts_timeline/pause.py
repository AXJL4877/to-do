"""把过长的静音停顿压到 keep 秒，并同步平移 timing（chars / words / phrases / sentences）。"""
from __future__ import annotations

import wave
from pathlib import Path
from typing import Any

import numpy as np

from tts_timeline.retime import PUNCT, SILENCE_DBFS, _sync_hierarchy

FRAME_SEC = 0.01


def _silent_runs(pcm: np.ndarray, rate: int) -> list[tuple[float, float]]:
    hop = max(1, int(rate * FRAME_SEC))
    n = len(pcm) // hop
    if not n:
        return []
    rms = np.sqrt(np.mean(pcm[: n * hop].reshape(n, hop).astype(np.float64) ** 2, axis=1))
    quiet = rms < 32768 * 10 ** (SILENCE_DBFS / 20)
    runs, start = [], None
    for i, q in enumerate(quiet):
        if q and start is None:
            start = i
        elif not q and start is not None:
            runs.append((start * FRAME_SEC, i * FRAME_SEC))
            start = None
    # 首尾静音不算句间停顿
    return [r for r in runs if r[0] > 0]


def _frame_db(wav_path: Path | str) -> np.ndarray:
    with wave.open(str(wav_path), "rb") as w:
        rate, n = w.getframerate(), w.getnframes()
        pcm = np.frombuffer(w.readframes(n), dtype="<i2").astype(np.float64)
    hop = max(1, int(rate * FRAME_SEC))
    m = len(pcm) // hop
    rms = np.sqrt(np.mean(pcm[: m * hop].reshape(m, hop) ** 2, axis=1))
    return 20 * np.log10(rms / 32768 + 1e-9)


def snap_sentence_edges(
    timing: dict[str, Any], wav_path: Path | str, *, reach: float = 0.8, gap_frames: int = 3
) -> int:
    """火山句首/句尾时间戳常偏 0.05–0.8s：句首吸附到真实人声起点，句尾吸附到人声结束。返回改动处数。

    连续 gap_frames 帧静音才算停，字间单帧能量凹陷不截断。
    """
    db = _frame_db(wav_path)
    quiet = db < SILENCE_DBFS
    # loud[i]：从 i 起（向前/向后）不足 gap_frames 帧连续静音
    run = np.convolve(quiet.astype(int), np.ones(gap_frames, dtype=int), "same")
    loud = run < gap_frames
    by_id = {c["id"]: c for c in timing.get("chars") or []}
    sents = timing.get("sentences") or []
    reach_f = int(reach / FRAME_SEC)
    moved = 0
    for k, s in enumerate(sents):
        ids = [c["id"] for p in s.get("phrases") or [] for c in p.get("chars") or [] if c["id"] in by_id]
        spoken = [by_id[i] for i in ids if by_id[i]["text"] not in PUNCT]
        if not spoken:
            continue
        first, last = spoken[0], spoken[-1]
        lo = sents[k - 1]["end"] if k else 0.0
        hi = sents[k + 1]["start"] if k + 1 < len(sents) else len(db) * FRAME_SEC

        # 句首：起点前若仍有人声，往前退到静音为止
        f = int(first["start"] / FRAME_SEC)
        g = f
        while g > 0 and f - g < reach_f and g * FRAME_SEC > lo and loud[g - 1]:
            g -= 1
        if g < f:
            first["start"] = round(g * FRAME_SEC, 4)
            moved += 1

        # 句尾：终点后若仍有人声，往后推到静音为止
        e = int(last["end"] / FRAME_SEC)
        h = e
        while h < len(loud) and h - e < reach_f and (h + 1) * FRAME_SEC < hi and loud[h]:
            h += 1
        if h > e:
            last["end"] = round(h * FRAME_SEC, 4)
            for c in (by_id[i] for i in ids[ids.index(last["id"]) + 1:]):
                c["start"] = max(c["start"], last["end"])
                c["end"] = max(c["end"], c["start"])
            moved += 1
    _sync_hierarchy(timing, by_id)
    return moved


def compress_pauses(
    timing: dict[str, Any], wav_path: Path | str, *, max_pause: float, keep: float | None = None
) -> list[tuple[float, float]]:
    """静音段 > max_pause 时从中间裁到 keep（默认 = max_pause），原地改 wav 与 timing。返回裁掉的 (起点, 长度)。"""
    keep = max_pause if keep is None else keep
    with wave.open(str(wav_path), "rb") as w:
        params = w.getparams()
        raw = w.readframes(params.nframes)
    if params.sampwidth != 2 or params.nchannels != 1:
        return []
    pcm = np.frombuffer(raw, dtype="<i2")
    rate = params.framerate

    cuts: list[tuple[float, float]] = []
    for a, b in _silent_runs(pcm, rate):
        if b - a > max_pause:
            cut_len = (b - a) - keep
            cuts.append((a + keep / 2, cut_len))
    if not cuts:
        return []

    keep_mask = np.ones(len(pcm), dtype=bool)
    for t0, d in cuts:
        keep_mask[int(t0 * rate): int((t0 + d) * rate)] = False
    out = pcm[keep_mask]
    with wave.open(str(wav_path), "wb") as w:
        w.setparams(params)
        w.writeframes(out.astype("<i2").tobytes())

    def shift(t: float) -> float:
        s = 0.0
        for t0, d in cuts:
            if t >= t0 + d:
                s += d
            elif t > t0:
                s += t - t0
        return round(t - s, 4)

    for item in (timing.get("chars") or []) + (timing.get("words") or []):
        item["start"], item["end"] = shift(item["start"]), shift(item["end"])
    _sync_hierarchy(timing, {c["id"]: c for c in timing.get("chars") or []})
    timing["duration"] = round(len(out) / rate, 4)
    return [(round(t0, 3), round(d, 3)) for t0, d in cuts]
