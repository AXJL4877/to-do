"""Solid-background keying: remove only bg flood-connected from image borders.

Interior whites (eyes, highlights, snowball body) stay if not edge-connected.
"""
from __future__ import annotations

from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image


def key_flat_bg(
    im: Image.Image,
    *,
    bg: tuple[int, int, int] = (255, 255, 255),
    thresh: int = 28,
    soft: int = 18,
) -> Image.Image:
    """Flood from borders: pixels within ``thresh`` of ``bg`` become transparent.

    Soft fringe: near-bg pixels at the cut get partial alpha by distance to ``bg``.
    """
    rgb = np.asarray(im.convert("RGB"), dtype=np.int16)
    h, w = rgb.shape[:2]
    br, bgc, bb = (int(bg[0]), int(bg[1]), int(bg[2]))
    gap = np.maximum(
        np.maximum(np.abs(rgb[:, :, 0] - br), np.abs(rgb[:, :, 1] - bgc)),
        np.abs(rgb[:, :, 2] - bb),
    ).astype(np.int16)
    near = gap <= int(thresh)

    marked = np.zeros((h, w), dtype=bool)
    q: deque[tuple[int, int]] = deque()

    def try_push(y: int, x: int) -> None:
        if near[y, x] and not marked[y, x]:
            marked[y, x] = True
            q.append((y, x))

    for x in range(w):
        try_push(0, x)
        try_push(h - 1, x)
    for y in range(h):
        try_push(y, 0)
        try_push(y, w - 1)

    while q:
        y, x = q.popleft()
        if y > 0:
            try_push(y - 1, x)
        if y + 1 < h:
            try_push(y + 1, x)
        if x > 0:
            try_push(y, x - 1)
        if x + 1 < w:
            try_push(y, x + 1)

    alpha = np.full((h, w), 255, dtype=np.uint8)
    alpha[marked] = 0

    if soft > 0:
        # Soften only the subject ring that still looks like bg color.
        # Build 1px exterior neighborhood of the keyed region via dilation.
        from numpy.lib.stride_tricks import sliding_window_view  # noqa: F401 — keep simple

        dil = marked.copy()
        # 3x3 dilate without scipy
        pad = np.pad(marked, 1, constant_values=False)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dy == 0 and dx == 0:
                    continue
                dil |= pad[1 + dy : h + 1 + dy, 1 + dx : w + 1 + dx]
        fringe = dil & ~marked
        # only soft-key fringe pixels that are somewhat close to bg
        soft_zone = fringe & (gap <= int(thresh) + int(soft))
        # alpha falls as gap → 0 (closer to bg → more transparent)
        # map gap in [0, thresh+soft] → alpha in [0, 255]
        span = float(max(1, int(thresh) + int(soft)))
        a = np.clip((gap.astype(np.float32) / span) * 255.0, 0, 255).astype(np.uint8)
        alpha = np.where(soft_zone, np.minimum(alpha, a), alpha)

    out = np.zeros((h, w, 4), dtype=np.uint8)
    out[:, :, :3] = np.asarray(im.convert("RGB"), dtype=np.uint8)
    out[:, :, 3] = alpha
    # clear RGB on fully transparent for cleaner composites
    out[alpha == 0, :3] = 0
    return Image.fromarray(out, "RGBA")


def key_file(
    src: str | Path,
    dst: str | Path | None = None,
    *,
    bg: tuple[int, int, int] = (255, 255, 255),
    thresh: int = 28,
    soft: int = 18,
) -> Path:
    src_p = Path(src)
    dst_p = Path(dst) if dst else src_p
    out = key_flat_bg(Image.open(src_p), bg=bg, thresh=thresh, soft=soft)
    dst_p.parent.mkdir(parents=True, exist_ok=True)
    out.save(dst_p)
    return dst_p.resolve()


def parse_rgb(s: str) -> tuple[int, int, int]:
    parts = [p.strip() for p in s.replace(" ", "").split(",")]
    if len(parts) != 3:
        raise ValueError(f"bg must be R,G,B got {s!r}")
    rgb = tuple(int(p) for p in parts)
    if any(c < 0 or c > 255 for c in rgb):
        raise ValueError(f"bg out of range: {rgb}")
    return rgb[0], rgb[1], rgb[2]
