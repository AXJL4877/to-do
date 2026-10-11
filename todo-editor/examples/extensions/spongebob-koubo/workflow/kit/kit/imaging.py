"""Image primitives for the hand-drawn short-video kit.

Background removal here is background-agnostic on purpose. The image provider
sometimes returns a cutout on a pure white field and sometimes on pure black, and
a white-only keyer turns the black ones into opaque rectangles that read as a
cropped picture pasted into frame.
"""
from __future__ import annotations

import numpy as np
from PIL import Image

W, H = 1920, 1080
FPS = 30


def ffmpeg_bin() -> str:
    """宿主把自带的 ffmpeg 通过 FFMPEG 传下来；没有才退回 PATH。"""
    import os

    return os.environ.get("FFMPEG") or os.environ.get("TODO_FFMPEG") or "ffmpeg"


def ffprobe_bin() -> str:
    import os

    return os.environ.get("FFPROBE") or os.environ.get("TODO_FFPROBE") or "ffprobe"


def clip(v, a, b):
    return a if v < a else b if v > b else v


def smooth(t):
    t = clip(t, 0.0, 1.0)
    return t * t * (3 - 2 * t)


def ease_out_back(t):
    t = clip(t, 0.0, 1.0)
    c1 = 1.35
    c3 = c1 + 1
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2


def ease_out_cubic(t):
    t = clip(t, 0.0, 1.0)
    return 1.0 - (1.0 - t) ** 3


def ease_out_elastic(t):
    t = clip(t, 0.0, 1.0)
    if t == 0 or t == 1:
        return t
    import math

    return 2 ** (-10 * t) * math.sin((t * 10.0 - 0.75) * (2 * math.pi) / 3.0) + 1.0


def ease_out_bounce(t):
    t = clip(t, 0.0, 1.0)
    n1, d1 = 7.5625, 2.75
    if t < 1 / d1:
        return n1 * t * t
    if t < 2 / d1:
        t -= 1.5 / d1
        return n1 * t * t + 0.75
    if t < 2.5 / d1:
        t -= 2.25 / d1
        return n1 * t * t + 0.9375
    t -= 2.625 / d1
    return n1 * t * t + 0.984375


def resize(sprite, scale):
    h, w = sprite.shape[:2]
    nw = max(1, int(round(w * scale)))
    nh = max(1, int(round(h * scale)))
    resample = Image.Resampling.LANCZOS if scale < 1 else Image.Resampling.BILINEAR
    return np.array(Image.fromarray(sprite).resize((nw, nh), resample))


_XF = {}


def transform(sprite, scale=1.0, spin=0.0):
    """Cached scale+rotate (expand). Cuts per-frame PIL work when poses settle."""
    sq = round(float(scale), 2)
    sp = round(float(spin) * 2.0) / 2.0
    if abs(sq - 1.0) <= 0.01 and abs(sp) <= 0.4:
        return sprite
    key = (id(sprite), sq, sp)
    hit = _XF.get(key)
    if hit is not None:
        return hit
    out = sprite
    if abs(sq - 1.0) > 0.01:
        out = resize(out, sq)
    if abs(sp) > 0.4:
        out = np.array(Image.fromarray(out).rotate(sp, resample=Image.BICUBIC, expand=True))
    if len(_XF) > 512:
        _XF.clear()
    _XF[key] = out
    return out


def trim(im):
    im = im.convert("RGBA")
    box = im.getbbox()
    return im.crop(box) if box else im


def fit_height(im, height):
    scale = height / im.height
    return im.resize((max(1, int(im.width * scale)), height), Image.Resampling.LANCZOS)


def blit(dst, src, x, y, opacity=1.0):
    if opacity <= 0.001:
        return
    sh, sw = src.shape[:2]
    x, y = int(round(x)), int(round(y))
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(dst.shape[1], x + sw), min(dst.shape[0], y + sh)
    if x0 >= x1 or y0 >= y1:
        return
    patch = src[y0 - y : y0 - y + (y1 - y0), x0 - x : x0 - x + (x1 - x0)]
    sa = patch[:, :, 3:4].astype(np.float32) * (opacity / 255.0)
    if sa.max() <= 0:
        return
    sr = patch[:, :, :3].astype(np.float32)
    region = dst[y0:y1, x0:x1]
    if region.shape[2] == 4:
        da = region[:, :, 3:4].astype(np.float32) / 255.0
        dr = region[:, :, :3].astype(np.float32)
        out_a = sa + da * (1.0 - sa)
        out_rgb = (sr * sa + dr * da * (1.0 - sa)) / np.maximum(out_a, 1e-4)
        region[:, :, :3] = out_rgb.astype(np.uint8)
        region[:, :, 3:4] = np.clip(out_a * 255.0, 0, 255).astype(np.uint8)
        return
    base = region.astype(np.float32)
    region[:] = (sr * sa + base * (1.0 - sa)).astype(np.uint8)


# ------------------------------------------------------------ background ----

def backdrop_colour(arr, patch=28):
    """Background colour from the four corner patches.

    Sampling the whole outer ring fails exactly when it matters: a subject that
    runs off the bottom of the frame puts ink in the ring, the ring stops looking
    flat, and a keyer that trusts flatness gives up and leaves the whole rectangle
    opaque. Corners are background even then.
    """
    h, w = arr.shape[:2]
    p = max(4, min(patch, h // 8, w // 8))
    corners = np.concatenate(
        [
            arr[:p, :p, :3].reshape(-1, 3),
            arr[:p, -p:, :3].reshape(-1, 3),
            arr[-p:, :p, :3].reshape(-1, 3),
            arr[-p:, -p:, :3].reshape(-1, 3),
        ],
        axis=0,
    ).astype(np.float32)
    colour = np.median(corners, axis=0)
    spread = float(np.percentile(np.abs(corners - colour).max(axis=1), 90))
    return colour, spread


def remove_background(im, tol=30.0, peel=True):
    """Drop a flat backdrop of any colour, then unmix the anti-aliased fringe.

    Returns (image, report). The report carries what the asset QA needs: the
    backdrop colour it settled on, how uniform the corners were, whether the
    subject still runs into the picture edge (a badly framed generation), and
    whether keying actually removed anything.
    """
    import cv2

    im = im.convert("RGBA")
    arr = np.array(im)
    h, w = arr.shape[:2]
    colour, spread = backdrop_colour(arr)
    already = float((arr[:, :, 3] < 16).mean()) > 0.02
    report = {
        "bg_rgb": [int(v) for v in colour],
        "bg_spread": round(spread, 1),
        "flat_bg": bool(spread < 26.0),
        "bg_near_white": bool(colour.min() > 225),
        "already_keyed": already,
    }

    candidates = []
    if already:
        candidates = []
    elif spread < 26.0:
        candidates = [colour]
    else:
        # Unreliable corners: try the two backdrops the provider actually uses.
        candidates = [np.array([255.0, 255.0, 255.0]), np.array([0.0, 0.0, 0.0])]

    removed = 0
    for cand in candidates:
        dist = np.abs(arr[:, :, :3].astype(np.float32) - cand).max(axis=2)
        cand_mask = (dist <= tol).astype(np.uint8)
        if cand_mask.mean() < 0.02:
            continue
        count, labels = cv2.connectedComponents(cand_mask, 4)
        if count <= 1:
            continue
        border = np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]])
        touching = set(int(v) for v in np.unique(border)) - {0}
        if not touching:
            continue
        mask = np.isin(labels, list(touching))
        if mask.mean() < 0.02:
            continue
        arr[mask, 3] = 0
        removed = int(mask.sum())
        report["bg_rgb"] = [int(v) for v in cand]
        if peel:
            arr = _unmix_fringe(arr, cand, tol, mask)
        break

    alpha = arr[:, :, 3]
    report["removed_px"] = removed
    report["key_failed"] = bool(not already and removed == 0)
    report["subject_at_edge"] = [
        bool(alpha[0].max() > 24),
        bool(alpha[-1].max() > 24),
        bool(alpha[:, 0].max() > 24),
        bool(alpha[:, -1].max() > 24),
    ]
    report["cropped"] = any(report["subject_at_edge"])
    report["ink_px"] = int((alpha > 24).sum())
    return Image.fromarray(arr), report


def _unmix_fringe(arr, colour, tol, bg_mask):
    """Recover edge pixels that the renderer blended into the backdrop colour."""
    import cv2

    alpha = arr[:, :, 3]
    opaque = ((alpha > 16) & ~bg_mask).astype(np.uint8)
    if int(opaque.sum()) < 32:
        return arr
    dist = cv2.distanceTransform(opaque, cv2.DIST_L2, 3)
    band = (opaque == 1) & (dist <= 2.6)
    if not band.any():
        return arr
    d = np.abs(arr[:, :, :3].astype(np.float32) - colour).max(axis=2)
    a = np.clip((d - tol * 0.45) / (tol * 1.5), 0.0, 1.0)
    new_alpha = alpha.astype(np.float32)
    new_alpha[band] = np.minimum(new_alpha[band], a[band] * 255.0)
    af = np.clip(new_alpha / 255.0, 0.12, 1.0)
    pix = arr[:, :, :3].astype(np.float32)
    for c in range(3):
        unmixed = (pix[:, :, c] - colour[c] * (1.0 - af)) / af
        pix[:, :, c] = np.where(band, np.clip(unmixed, 0, 255), pix[:, :, c])
    out = arr.copy()
    out[:, :, :3] = np.clip(pix, 0, 255).astype(np.uint8)
    out[:, :, 3] = np.clip(new_alpha, 0, 255).astype(np.uint8)
    return out


def white_knock(im):
    """Backwards-compatible alias: white-backdrop keying plus fringe peel."""
    return remove_background(im)[0]


# --------------------------------------------------------------- finish ----

_VIGNETTE = {}
_GRAIN = {}


def vignette(strength=0.10, power=2.2):
    key = (round(strength, 3), round(power, 2))
    if key not in _VIGNETTE:
        ys, xs = np.mgrid[0:H, 0:W]
        nx = (xs - W / 2) / (W / 2)
        ny = (ys - H / 2) / (H / 2)
        r = np.clip(np.sqrt(nx * nx * 0.82 + ny * ny) / 1.28, 0, 1) ** power
        _VIGNETTE[key] = (1.0 - strength * r)[:, :, None].astype(np.float32)
    return _VIGNETTE[key]


def grade(frame, vig=0.10):
    # 就地缩放，少一份全帧 float32 峰值内存
    out = frame.astype(np.float32, copy=False)
    out = out * vignette(vig)
    return np.clip(out, 0, 255).astype(np.uint8)


def grain(frame, amount=2.0, frame_no=0):
    if amount <= 0:
        return frame
    key = frame_no % 8
    if key not in _GRAIN:
        rng = np.random.default_rng(1000 + key)
        # int16 噪声，避免每帧再开一份 float32 大数组（OOM）
        _GRAIN[key] = (rng.normal(0, 1, (H, W, 1)) * amount).astype(np.int16)
    noise = _GRAIN[key]
    out = frame.astype(np.int16, copy=True)
    out += noise
    return np.clip(out, 0, 255).astype(np.uint8)


def contact_shadow(width, strength=0.115, squash=0.085):
    w = max(8, int(width))
    h = max(6, int(w * squash))
    ys, xs = np.mgrid[0:h, 0:w]
    e = ((xs - w / 2) / (w / 2)) ** 2 + ((ys - h / 2) / (h / 2)) ** 2
    alpha = np.clip(1.0 - e, 0, 1) ** 1.5 * strength * 255
    out = np.zeros((h, w, 4), np.uint8)
    out[:, :, 3] = alpha.astype(np.uint8)
    return out


_PLATES = {}


def load_rgb(path, size=None):
    key = (str(path), size)
    if key not in _PLATES:
        im = Image.open(path).convert("RGB")
        if size:
            im = im.resize(size, Image.Resampling.LANCZOS)
        _PLATES[key] = np.array(im)
    return _PLATES[key]


_CAM = {}


def camera(plate, u, zoom=0.0, pan=(0.0, 0.0), centre=(0.5, 0.5)):
    """Sample one frame from a plate as a virtual camera with a slow push.

    量化 u 缓存裁剪结果：相邻帧复用同一张海滩底，少做 LANCZOS/BILINEAR。
    """
    steps = 40
    key = (id(plate), int(round(u * steps)), round(float(zoom), 4),
           round(float(pan[0]), 4), round(float(pan[1]), 4),
           round(float(centre[0]), 3), round(float(centre[1]), 3))
    hit = _CAM.get(key)
    if hit is not None:
        return hit
    ph, pw = plate.shape[:2]
    m = 1.0 + zoom * u
    cw = pw * min(1.0, 1.0 / m)
    ch = ph * min(1.0, 1.0 / m)
    cx = pw * (centre[0] + pan[0] * (u - 0.5))
    cy = ph * (centre[1] + pan[1] * (u - 0.5))
    x0 = int(round(min(max(cx - cw / 2, 0), pw - cw)))
    y0 = int(round(min(max(cy - ch / 2, 0), ph - ch)))
    crop = plate[y0 : y0 + int(round(ch)), x0 : x0 + int(round(cw))]
    if crop.shape[0] == H and crop.shape[1] == W:
        out = crop
    else:
        out = np.array(Image.fromarray(crop).resize((W, H), Image.Resampling.BILINEAR))
    if len(_CAM) > 256:
        _CAM.clear()
    _CAM[key] = out
    return out


def zoom_blur(rgb, amount, steps=7):
    if amount <= 0.001:
        return rgb
    src = Image.fromarray(rgb)
    acc = np.zeros_like(rgb, dtype=np.float32)
    for i in range(steps):
        z = 1 + amount * i / (steps - 1)
        nw, nh = int(W * z), int(H * z)
        scaled = np.asarray(src.resize((nw, nh), Image.Resampling.BILINEAR))
        x0 = (nw - W) // 2
        y0 = (nh - H) // 2
        acc += scaled[y0 : y0 + H, x0 : x0 + W]
    return (acc / steps).astype(np.uint8)


def background_plate(im, sky_rows):
    """Move the horizon down by continuing the flat top of a background painting."""
    arr = np.asarray(im.convert("RGB")).astype(np.float32)
    top = arr[:4].mean(axis=0, keepdims=True)
    head = np.repeat(top, sky_rows, axis=0)
    ramp = np.linspace(0.0, 1.0, 12)[:, None, None]
    head[-12:] = head[-12:] * (1 - ramp) + arr[:12] * ramp
    out = np.concatenate([head, arr[: arr.shape[0] - sky_rows]], axis=0)
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))


def chroma_key_green(rgb, soft=50.0, floor=18.0):
    """Key a bright chroma-green plate; return RGBA with green spill suppressed."""
    import cv2

    f = rgb.astype(np.float32)
    r, g, b = f[:, :, 0], f[:, :, 1], f[:, :, 2]
    greenness = g - np.maximum(r, b)
    alpha = 1.0 - np.clip((greenness - floor) / max(1.0, soft), 0.0, 1.0)
    # Spill: pull leftover green toward the warmer bubble colours
    spill = np.clip(greenness / 80.0, 0.0, 1.0) * alpha
    g2 = np.minimum(g, np.maximum(r, b) * 0.92 + 28.0)
    out = f.copy()
    out[:, :, 1] = g * (1.0 - spill) + g2 * spill
    a8 = (np.clip(alpha, 0, 1) * 255.0).astype(np.uint8)
    # Soften jagged key edges a touch
    a8 = cv2.GaussianBlur(a8, (0, 0), 0.8)
    rgba = np.dstack([np.clip(out, 0, 255).astype(np.uint8), a8])
    return rgba


def load_keyed_wipe(path, size=(W, H), cache_dir=None):
    """Decode a green-screen wipe clip → list of RGBA frames at ``size``.

    Caches to ``cache_dir / <stem>_rgba.npz`` so re-renders skip the keying pass.
    """
    import subprocess
    from pathlib import Path

    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(path)
    cache_dir = Path(cache_dir) if cache_dir else path.parent
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache = cache_dir / f"{path.stem}_rgba_{size[0]}x{size[1]}.npz"
    if cache.is_file() and cache.stat().st_mtime >= path.stat().st_mtime:
        data = np.load(cache)
        return [data[f"f{i}"] for i in range(int(data["n"]))]

    w0, h0 = video_size(path)
    raw = subprocess.run(
        [ffmpeg_bin(), "-v", "error", "-i", str(path),
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True,
    )
    if raw.returncode != 0:
        raise SystemExit(f"ffmpeg decode wipe failed: {path}")
    frame_bytes = w0 * h0 * 3
    buf = raw.stdout
    n = len(buf) // frame_bytes
    frames = []
    for i in range(n):
        rgb = np.frombuffer(buf, np.uint8, count=frame_bytes, offset=i * frame_bytes).reshape(h0, w0, 3)
        rgba = chroma_key_green(rgb)
        if (rgba.shape[1], rgba.shape[0]) != size:
            rgba = np.array(
                Image.fromarray(rgba, "RGBA").resize(size, Image.Resampling.LANCZOS)
            )
        frames.append(rgba)
    # 去掉片头/片尾纯绿空帧，避免转场先黑一会儿才出泡泡
    def _alive(fr, thr=1.5):
        return float(fr[:, :, 3].mean()) > thr

    lo = next((i for i, fr in enumerate(frames) if _alive(fr)), 0)
    hi = next((i for i in range(len(frames) - 1, -1, -1) if _alive(frames[i])), len(frames) - 1)
    frames = frames[lo : hi + 1] or frames
    np.savez_compressed(cache, n=len(frames), **{f"f{i}": fr for i, fr in enumerate(frames)})
    return frames


def video_size(path) -> tuple[int, int]:
    """只用 ffmpeg 读视频分辨率。

    以前这里调 ffprobe；设备上常只装了 ffmpeg（ffprobe 缺失），
    一抛 FileNotFoundError 整个泡泡转场就被静默跳过，所以改成单依赖 ffmpeg。
    读不到时退回 1280x720（历史兜底值）。
    """
    import re
    import subprocess

    r = subprocess.run(
        [ffmpeg_bin(), "-hide_banner", "-i", str(path)],
        capture_output=True,
    )
    text = (r.stderr or b"").decode("utf-8", "replace")
    m = re.search(r"Video:.*?(\d{2,5})x(\d{2,5})", text)
    if m:
        return int(m.group(1)), int(m.group(2))
    return 1280, 720


def wipe_matte(alpha_u8, grow=18, blur=14.0):
    """Expand keyed alpha into a soft reveal matte for A→B wipe."""
    import cv2

    a = alpha_u8.astype(np.float32) / 255.0
    if grow > 0:
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (grow * 2 + 1, grow * 2 + 1))
        a = cv2.dilate(a, k)
    if blur > 0:
        a = cv2.GaussianBlur(a, (0, 0), blur)
    return np.clip(a, 0.0, 1.0)
