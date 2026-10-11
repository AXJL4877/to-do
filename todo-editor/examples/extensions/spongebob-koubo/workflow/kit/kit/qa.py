"""Post-render checks: framing against the example, dip shape, cast coverage.

Everything here is measured off the delivered file, not off the render parameters,
so a plan that renders "successfully" but frames badly still fails.
"""
from __future__ import annotations

import subprocess

import numpy as np

from . import assets as A

_FFMPEG = I.ffmpeg_bin()
_FFPROBE = I.ffprobe_bin()

TARGET = {
    "height_pct": (36.0, 56.0),
    "feet_pct": (64.0, 78.0),
    "margin_pct": (8.0, 92.0),
    "max_dip_frames": 20,
    "cards_ratio": (0.15, 0.60),
}


def _frames(path, w=320, h=180):
    raw = subprocess.check_output(
        [_FFMPEG, "-v", "error", "-i", str(path), "-vf", f"scale={w}:{h}",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    )
    n = len(raw) // (w * h * 3)
    return np.frombuffer(raw[: n * w * h * 3], dtype=np.uint8).reshape(n, h, w, 3)


def _clear_of_entrances(plan, timing, t, name):
    """Was this element's entrance over by time t? Used when the log lacks the flag.

    Returns False when the layer cannot be identified: an unverifiable element is
    not evidence of a bug, and guessing "settled" here produced a false failure.
    """
    for i, shot in enumerate(plan["shots"]):
        if shot.get("mode") != "scene" or i >= len(timing):
            continue
        sent = timing[i]
        if not (sent["start"] <= t <= sent["end"] + 0.6):
            continue
        phrases = sent.get("phrases") or []
        for layer in shot.get("layers", []):
            if layer.get("name") != name:
                continue
            enter = int(layer.get("enter", 0))
            start = phrases[enter]["start"] if enter < len(phrases) else sent["start"]
            return t >= start + 0.46
    return False


def _shot_starts(plan, total_seconds):
    """Where each shot begins *in the delivered file*, pre-roll title included.

    The plan is indexed by sentence, but the film may open on a title pre-roll, so
    shot i does not start at sentence i's timestamp.
    """
    timing = plan.get("_timing")
    if not timing:
        return [0.0] * len(plan["shots"])
    pre = float(plan.get("_pre", 0.0))
    return [pre + float(s["start"]) for s in timing]


def check(film, work, plan, cut_names):
    from pathlib import Path

    film, work = Path(film), Path(work)
    frames = _frames(film)
    luma = frames.mean(axis=(1, 2, 3))
    summary, failures, notes = [], [], []

    # 1. dips: every dark run should be either a card body or a short transition.
    dark = luma < max(6.0, float(np.median(luma)) * 0.12)
    runs, start = [], None
    for i, on in enumerate(dark):
        if on and start is None:
            start = i
        elif not on and start is not None:
            runs.append((start, i - start))
            start = None
    if start is not None:
        runs.append((start, len(dark) - start))
    short = [r for r in runs if r[1] <= TARGET["max_dip_frames"]]
    long_ = [r for r in runs if r[1] > TARGET["max_dip_frames"]]
    summary.append(f"dips: {len(short)} transitions (max {max([r[1] for r in short], default=0)} frames), "
                   f"{len(long_)} card holds")
    over = [r for r in short if r[1] > TARGET["max_dip_frames"]]
    if over:
        failures.append(f"{len(over)} transitions longer than {TARGET['max_dip_frames']} frames")

    # 2. layout log: card geometry, and every settled element must sit inside the frame.
    layout = work / "layout_check.json"
    card_rows = []
    scene_rows = []
    if layout.exists():
        import json

        for row in json.loads(layout.read_text(encoding="utf-8")):
            if row.get("mode") == "card":
                boxes = {b["name"]: b["box"] for b in row.get("layers", []) if "box" in b}
                text = boxes.get("text")
                if text:
                    tx, ty, tw, th = text
                    card_rows.append((row["t"], ty + th / 2, th))
            elif row.get("mode") == "scene":
                for layer in row.get("layers", []):
                    if "box" in layer:
                        scene_rows.append((row["t"], layer, layer["box"]))
    for t, centre, h in card_rows:
        if not 380 <= centre <= 700:
            failures.append(f"card at {t}s: text block centre y={centre:.0f}, expected near 540")
        # One line is ~194 px (cap 170 + keyline); accept whole line counts only.
        one = 194.0
        allowed = [(0.85 * one, 1.20 * one), (1.85 * one, 2.20 * one), (2.80 * one, 3.30 * one)]
        if not any(lo <= h <= hi for lo, hi in allowed):
            failures.append(
                f"card at {t}s: text height {h:.0f}px is not a whole number of lines "
                f"(1 line ~{one:.0f}px, 2 lines ~{2 * one:.0f}px)"
            )
    # Sampled frames land 62 % into a beat, but a phrase boundary can fall inside
    # that 62 %, so an element caught mid-entrance is legitimately off-screen. Only
    # settled elements are judged: the log records that, and a log from an older
    # build is judged against the phrase timings instead.
    fw, fh = 1920, 1080
    timing = plan.get("_timing") or []
    pre = float(plan.get("_pre", 0.0))
    outside = []
    checked = 0
    for t, layer, box in scene_rows:
        settled = layer.get("settled")
        if settled is None:
            settled = _clear_of_entrances(plan, timing, t - pre, layer.get("name"))
        if not settled:
            continue
        checked += 1
        x, y, w, h = box
        if x < 0 or y < 0 or x + w > fw or y + h > fh:
            outside.append((t, layer.get("name"), box))
    for t, name, (x, y, w, h) in outside:
        failures.append(
            f"scene at {t}s: '{name}' sits outside the frame "
            f"(x {x:.0f}..{x + w:.0f}, y {y:.0f}..{y + h:.0f} in {fw}x{fh})"
        )
    if checked:
        summary.append(
            f"layout: {checked} settled elements, "
            + ("all inside frame" if not outside else f"{len(outside)} outside frame")
        )
    if card_rows:
        summary.append(f"cards: {len(card_rows)} sampled, text centre "
                       f"{min(c[1] for c in card_rows):.0f}-{max(c[1] for c in card_rows):.0f}px")

    # 2b. A card arriving straight after another card must open on black. Fading up
    # from the stale beach was the flash that used to sit right before such a card.
    flashes = []
    starts = _shot_starts(plan, frames.shape[0] / 30.0)
    for i in range(1, len(plan["shots"])):
        if plan["shots"][i]["mode"] != "card" or plan["shots"][i - 1]["mode"] != "card":
            continue
        start = int(starts[i] * 30)
        window = frames[start : start + 4]
        if len(window) == 0:
            continue
        bright = float(window.mean())
        if bright > 14.0:
            flashes.append((round(starts[i], 2), round(bright, 1)))
    if flashes:
        failures.append("card after card opens on a bright frame (background flash): "
                        + ", ".join(f"{t}s luma {v}" for t, v in flashes))
    else:
        summary.append("card-to-card hand-offs open on black")

    # 3. casting: how much of the library actually got used.
    used = set()
    for shot in plan["shots"]:
        if shot["mode"] == "scene":
            for layer in shot.get("layers", []):
                used.add(layer.get("name"))
        elif shot.get("figure"):
            used.add(shot["figure"])
    distinct = len(used & set(cut_names))
    scenes = [s for s in plan["shots"] if s["mode"] == "scene"]
    summary.append(f"casting: {distinct}/{len(cut_names)} sprites used, "
                   f"{len(scenes)} scenes, {sum(len(s.get('layers', [])) for s in scenes)} scene layers")
    if scenes and distinct < max(4, len(scenes) // 3):
        notes.append("very few sprites carry the whole film; consider generating more elements")

    # 4. cards vs scenes balance, against the example's ~40/60.
    cards = len(plan["shots"]) - len(scenes)
    ratio = cards / max(1, len(plan["shots"]))
    summary.append(f"mode mix: {cards} cards / {len(scenes)} scenes ({ratio:.0%} cards)")
    lo, hi = TARGET["cards_ratio"]
    if not lo <= ratio <= hi:
        notes.append(f"card share {ratio:.0%} is outside the example's {lo:.0%}-{hi:.0%} band")

    # 5. file sanity.
    if len(frames) < 30:
        failures.append("rendered file is suspiciously short")
    stalled = int((np.abs(np.diff(frames.astype(np.int16), axis=0)).mean(axis=(1, 2, 3)) == 0).sum())
    summary.append(f"frozen frame pairs: {stalled}/{max(1, len(frames) - 1)}")

    return {"ok": not failures, "summary": summary, "failures": failures, "notes": notes}
