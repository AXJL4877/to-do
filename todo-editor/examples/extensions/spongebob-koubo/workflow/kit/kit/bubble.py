"""Code-drawn speech bubbles, anchored to staged element boxes.

Cartoon look: cream fill, thick black outline, triangular tail aimed at the
speaker's head. Placement prefers above the head; falls back to the outer side
so the bubble stays on-frame and does not cover the face.
"""
from __future__ import annotations

import re
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from . import imaging as I

W, H = I.W, I.H
# 包内优先（自包含）：气泡文字不依赖系统字体；机器路径只作兜底。
_FONT_BUNDLED = Path(__file__).resolve().parent.parent / "fonts" / "Noto Sans SC Bold (TrueType).otf"
FONT = _FONT_BUNDLED if _FONT_BUNDLED.exists() else Path(r"C:\Windows\Fonts\msyhbd.ttc")
FILL = (255, 252, 235, 255)
STROKE = (20, 20, 20, 255)
TEXT = (28, 28, 28, 255)
PAD_X, PAD_Y = 28, 18
TAIL_H, TAIL_W = 28, 34
RADIUS = 28
STROKE_W = 5


def _font(size: int):
    try:
        return ImageFont.truetype(str(FONT), size)
    except OSError:
        return ImageFont.load_default()


def _wrap(text: str, font, max_w: int) -> list[str]:
    text = (text or "").strip()
    if not text:
        return []
    lines: list[str] = []
    cur = ""
    draw = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
    for ch in text:
        trial = cur + ch
        bb = draw.textbbox((0, 0), trial, font=font)
        if bb[2] - bb[0] <= max_w or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = ch
    if cur:
        lines.append(cur)
    return lines


def make_bubble(text: str, *, max_chars_w: int = 10, font_size: int = 42) -> tuple[np.ndarray, tuple[float, float]]:
    """Return RGBA bubble sprite and local (tip_x, tip_y) of the tail tip."""
    font = _font(font_size)
    probe = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
    # approx char width for wrap budget
    sample = probe.textbbox((0, 0), "国" * max(1, max_chars_w), font=font)
    max_text_w = max(80, sample[2] - sample[0])
    lines = _wrap(text, font, max_text_w)
    if not lines:
        lines = ["…"]

    line_sizes = [probe.textbbox((0, 0), ln, font=font) for ln in lines]
    text_w = max(b[2] - b[0] for b in line_sizes)
    line_h = max(b[3] - b[1] for b in line_sizes)
    gap = max(6, int(font_size * 0.18))
    text_h = line_h * len(lines) + gap * (len(lines) - 1)

    body_w = int(text_w + PAD_X * 2)
    body_h = int(text_h + PAD_Y * 2)
    img_w = body_w + STROKE_W * 2 + 4
    img_h = body_h + TAIL_H + STROKE_W * 2 + 4
    img = Image.new("RGBA", (img_w, img_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    ox, oy = STROKE_W + 2, STROKE_W + 2
    body = [ox, oy, ox + body_w, oy + body_h]
    # outer stroke then fill
    draw.rounded_rectangle(body, radius=RADIUS, fill=STROKE)
    inner = [body[0] + STROKE_W, body[1] + STROKE_W, body[2] - STROKE_W, body[3] - STROKE_W]
    draw.rounded_rectangle(inner, radius=max(8, RADIUS - STROKE_W), fill=FILL)

    # tail: tip at bottom center of body (will be biased later via placement)
    cx = ox + body_w / 2
    base_y = oy + body_h - 2
    tip = (cx, base_y + TAIL_H)
    left = (cx - TAIL_W / 2, base_y)
    right = (cx + TAIL_W / 2, base_y)
    draw.polygon([left, right, tip], fill=STROKE)
    # inner tail
    inset = STROKE_W * 0.9
    draw.polygon(
        [
            (cx - TAIL_W / 2 + inset * 1.2, base_y - 1),
            (cx + TAIL_W / 2 - inset * 1.2, base_y - 1),
            (cx, base_y + TAIL_H - inset * 1.4),
        ],
        fill=FILL,
    )

    # text
    ty = oy + PAD_Y - (line_sizes[0][1] if line_sizes else 0)
    for i, ln in enumerate(lines):
        bb = line_sizes[i]
        lw = bb[2] - bb[0]
        tx = ox + (body_w - lw) / 2 - bb[0]
        draw.text((tx, ty), ln, font=font, fill=TEXT)
        ty += line_h + gap

    tip_local = (tip[0], tip[1])
    return np.array(img), tip_local


def _anchor_side(box, side: str) -> str:
    if side in ("left", "right"):
        return side
    px, _py, bw, _bh = box
    cx = px + bw / 2
    # speaker on left half → bubble prefers right-of-head; right half → left-of-head
    return "right" if cx < W * 0.5 else "left"


def bubble_xy(box, sprite_shape, tip_local, side: str) -> tuple[float, float]:
    """Place bubble so tail tip aims at the speaker head, body stays on-frame."""
    px, py, bw, bh = box
    head_x = px + bw * 0.5
    head_y = py + bh * 0.10
    tip_x, tip_y = tip_local
    sh, sw = sprite_shape[0], sprite_shape[1]

    # default: tip on head, body above
    x = head_x - tip_x
    y = head_y - tip_y

    prefer = _anchor_side(box, side)
    # nudge body toward outer / open space so it does not sit on the face
    if prefer == "right":
        x = head_x - tip_x + bw * 0.18
    else:
        x = head_x - tip_x - bw * 0.18

    # keep fully inside frame with margin
    margin = 16
    x = min(max(margin, x), W - sw - margin)
    y = min(max(margin, y), H - sh - margin)

    # if still covering too much of the face top, push further up
    if y + tip_y > head_y + 8:
        y = max(margin, head_y - tip_y)

    # if clipped to top and overlapping face, park beside the head
    body_bottom = y + (tip_y - TAIL_H)
    if body_bottom > py + bh * 0.22:
        if prefer == "right":
            x = min(W - sw - margin, px + bw * 0.55)
        else:
            x = max(margin, px + bw * 0.45 - sw)
        y = max(margin, py + bh * 0.02 - sh * 0.55)

    return x, y


_QUOTED = re.compile(r"[「“\"『]([^」”\"』]+)[」”\"』]")
_LEAD_TAIL = re.compile(r"(说道?|叹气|嘀咕|吐槽|喊道?|问道?|心想|想着|回答|插话|笑着|在一旁)$")


def speech_only(text: str, max_chars: int = 20) -> str:
    """气泡只放角色台词：取引号内；有冒号取冒号后；旁白引导语（「X 叹气：」）返回空。"""
    raw = str(text or "").strip()
    m = _QUOTED.search(raw)
    if m:
        raw = m.group(1)
    elif re.search(r"[：:]", raw):
        raw = re.split(r"[：:]", raw, maxsplit=1)[1]
    raw = re.sub(r"[「」“”\"'『』]", "", raw).strip().strip("，。！？；、,.!?; ")
    if len(raw) < 2 or _LEAD_TAIL.search(raw):
        return ""
    return raw[:max_chars]


def attach(frame, layers, drawn, phrase_index, phrase_t) -> list[dict]:
    """Draw bubbles for layers that have ``say`` and are visible this phrase.

    Layer fields:
      say: text
      say_at: phrase index when the line appears (default = enter)
      say_side: auto | left | right
    """
    by_name: dict[str, list[dict]] = {}
    for d in drawn:
        by_name.setdefault(d["name"], []).append(d)

    placed = []
    used: dict[str, int] = {}
    for raw in layers:
        text = speech_only(str(raw.get("say") or ""))
        if not text:
            continue
        name = str(raw.get("name", "")).strip()
        enter = int(raw.get("enter", 0))
        say_at = int(raw.get("say_at", enter))
        say_until = raw.get("say_until")
        if phrase_index < say_at:
            continue
        if say_until is not None and phrase_index >= int(say_until):
            continue
        # default: only during the speaking phrase (minimal dialogue beat)
        if say_until is None and phrase_index != say_at:
            continue

        idx = used.get(name, 0)
        cands = by_name.get(name) or []
        if idx >= len(cands):
            continue
        d = cands[idx]
        used[name] = idx + 1
        if d.get("alpha", 1.0) < 0.35:
            continue

        sprite, tip = make_bubble(text)
        # pop-in on the speaking phrase
        if phrase_index == say_at:
            u = min(1.0, max(0.0, phrase_t / 0.28))
            u = I.smooth(u)
            if u < 0.02:
                continue
            if abs(u - 1.0) > 0.01:
                sprite = I.resize(sprite, 0.72 + 0.28 * u)
                tip = (tip[0] * (0.72 + 0.28 * u), tip[1] * (0.72 + 0.28 * u))
            opacity = u
        else:
            opacity = 1.0

        side = str(raw.get("say_side") or "auto")
        x, y = bubble_xy(d["box"], sprite.shape, tip, side)
        I.blit(frame, sprite, x, y, opacity)
        placed.append(
            {
                "name": f"bubble:{name}",
                "text": text,
                "box": (int(x), int(y), sprite.shape[1], sprite.shape[0]),
                "alpha": round(opacity, 3),
            }
        )
    return placed
