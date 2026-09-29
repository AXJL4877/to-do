#!/usr/bin/env python3
"""黑板手绘渲染器（todo-skill-render/1 执行端）。

元素图（黑底粉笔）→ soft_cutout 抠透明 → 叙事版式排进画布 → 每元素一张蒙版
→ 黑板报 RegionStreamRenderer 按蒙版逐区骨架书写 + 粉笔手 → ffmpeg VP9 WebM。

  python render.py --request <request.json>

stdout 协议（每行一条，其余行均为日志）：
  @progress {"phase": "...", "pct": 0.42}
  @result   {...}               成功，退出码 0
  @error    {"message": "..."}  失败，退出码 1
完整协议见同目录 PROTOCOL.md。渲染核心来自黑板报仓库（BLACKBOARD_ROOT，默认 D:\\desktop\\黑板报）。
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import cv2
import numpy as np

BLACKBOARD_ROOT = Path(os.environ.get("BLACKBOARD_ROOT") or r"D:\desktop\黑板报")
sys.path.insert(0, str(BLACKBOARD_ROOT / "scripts"))
sys.path.insert(0, str(BLACKBOARD_ROOT))

RENDER_SPEC = "todo-skill-render/1"
SIZES = {"1280x720", "1920x1080", "1080x1920", "1080x1080", "720x1280"}
CRF = {"high": 24, "standard": 31, "draft": 38}


def emit(tag: str, payload: dict) -> None:
    sys.stdout.write(f"@{tag} {json.dumps(payload, ensure_ascii=False)}\n")
    sys.stdout.flush()


class Progress:
    def __init__(self) -> None:
        self._last = (None, -1.0, 0.0)

    def __call__(self, phase: str, pct: float) -> None:
        pct = float(min(1.0, max(0.0, pct)))
        last_phase, last_pct, last_t = self._last
        now = time.monotonic()
        if phase == last_phase and pct - last_pct < 0.02 and now - last_t < 1.5 and pct < 1.0:
            return
        self._last = (phase, pct, now)
        emit("progress", {"phase": phase, "pct": round(pct, 3)})


def load_bgr(path: Path) -> np.ndarray:
    img = cv2.imdecode(np.fromfile(str(path), dtype=np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise FileNotFoundError(f"读不到元素图: {path}")
    return img


def save_png(path: Path, img: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imencode(".png", img)[1].tofile(str(path))


# ── 版式 ────────────────────────────────────────────────────────────


def layout_rects(n: int, W: int, H: int, layout: str) -> tuple[str, list[tuple[int, int, int, int]]]:
    from blackbg_element_hand import LAYOUT_PRESETS, expressive_zones, layout_slot_rects, zones_to_rects

    if n == 1:
        return "single", [(int(W * 0.05), int(H * 0.05), int(W * 0.95), int(H * 0.95))]
    portrait = H > W * 1.15
    if layout == "grid" or (layout == "auto" and portrait):
        cols = 1 if portrait else (3 if n >= 5 else 2 if n == 4 else n)
        return "grid", layout_slot_rects(n, W, H, layout="grid", cols=cols)
    if layout in LAYOUT_PRESETS:
        preset = layout
    else:
        preset = {2: "hero_left", 3: "hero_left", 4: "fork_right"}.get(n, "climax_right")
    return preset, zones_to_rects(expressive_zones(n, preset), W, H)


def element_timings(weights: list[float], areas: list[int], total_ms: int, hold_ms: int) -> list[tuple[int, int]]:
    """按权重 × 墨量分配书写时长；最后 hold_ms 对着完成画面停住。"""
    n = len(weights)
    draw_ms = max(n * 600, total_ms - hold_ms)
    mean_area = (sum(areas) / n) or 1.0
    w = [max(0.1, wt) * (0.5 + 0.5 * a / mean_area) for wt, a in zip(weights, areas)]
    s = sum(w)
    out: list[tuple[int, int]] = []
    t = 0
    for i, wi in enumerate(w):
        dur = draw_ms - t if i == n - 1 else int(round(draw_ms * wi / s))
        dur = max(500, dur)
        out.append((t, dur))
        t += dur
    return out


# ── 帧输出：ffmpeg 管道 ──────────────────────────────────────────────


def open_sink(path: Path, W: int, H: int, fps: int, alpha: bool, crf: int, ffmpeg: str) -> subprocess.Popen:
    args = [
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "bgra" if alpha else "bgr24",
        "-s", f"{W}x{H}", "-r", str(fps), "-i", "-",
        "-an", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p" if alpha else "yuv420p",
        "-b:v", "0", "-crf", str(crf), "-row-mt", "1", "-deadline", "good", "-cpu-used", "4",
    ]
    if alpha:
        args += ["-auto-alt-ref", "0"]
    args.append(str(path))
    return subprocess.Popen(args, stdin=subprocess.PIPE, stderr=subprocess.PIPE)


def to_straight_rgba(bgr: np.ndarray, tone: str = "chalk") -> tuple[np.ndarray, np.ndarray]:
    """黑底粉笔 → 直通 alpha：亮度即不透明度，颜色反预乘，叠到任意底上仍是粉笔。
    tone=ink：压掉灰度分量只留色相，白粉笔变深色墨线，适合叠在浅色画面上。"""
    f = bgr.astype(np.float32)
    a = np.clip(f.max(axis=2) / 170.0, 0.0, 1.0)
    color = np.clip(f / np.maximum(a, 1e-3)[..., None], 0, 255)
    if tone == "ink":
        color = color - color.min(axis=2, keepdims=True) * 0.85
    color[a <= 1e-3] = 0
    return color, a


def stamp_hand_rgba(tip, color: np.ndarray, a: np.ndarray, x: int, y: int) -> None:
    H, W = a.shape
    ax, ay = x - tip.tip_px, y - tip.tip_py
    x0, y0 = max(0, ax), max(0, ay)
    x1, y1 = min(W, ax + tip.w), min(H, ay + tip.h)
    if x1 <= x0 or y1 <= y0:
        return
    sx0, sy0 = x0 - ax, y0 - ay
    m = tip.mask[sy0:sy0 + (y1 - y0), sx0:sx0 + (x1 - x0)]
    hand = tip.hand[sy0:sy0 + (y1 - y0), sx0:sx0 + (x1 - x0)].astype(np.float32)
    ra = a[y0:y1, x0:x1]
    rc = color[y0:y1, x0:x1]
    na = m + ra * (1.0 - m)
    rc[:] = (hand * m[..., None] + rc * (ra * (1.0 - m))[..., None]) / np.maximum(na, 1e-6)[..., None]
    ra[:] = na


def make_renderer_class():
    import render_stream_whiteboard as rsw

    class PipeRenderer(rsw.RegionStreamRenderer):
        """所有帧都经 _write_frame 出口：改写到 ffmpeg 管道；透明模式在此合成 alpha 与手部。"""

        sink: subprocess.Popen
        alpha = False
        tone = "chalk"
        total_frames = 1
        frames = 0
        progress = None
        _pending_tip: tuple[int, int] | None = None

        def _snapshot_with_tip(self, px: int, py: int) -> np.ndarray:
            self._last_tip = (int(px), int(py))
            self._pending_tip = self._last_tip
            return self.drawn.astype(np.uint8)

        def _write_frame(self, writer, snap: np.ndarray) -> None:
            tip, self._pending_tip = self._pending_tip, None
            frame = snap if snap.dtype == np.uint8 else snap.astype(np.uint8)
            if self.alpha:
                color, a = to_straight_rgba(frame, self.tone)
                if tip and self.tip is not None:
                    stamp_hand_rgba(self.tip, color, a, *tip)
                data = np.dstack([color, a * 255.0]).astype(np.uint8)
            else:
                data = frame
                if tip and self.tip is not None:
                    data = frame.copy()
                    self.tip.stamp(data, *tip)
            self.sink.stdin.write(data.tobytes())
            self.frames += 1
            if self.progress:
                self.progress("书写渲染", self.frames / self.total_frames)

    return rsw, PipeRenderer


# ── 主流程 ──────────────────────────────────────────────────────────


def render(req: dict, progress: Progress) -> dict:
    if req.get("spec") != RENDER_SPEC:
        raise ValueError(f"spec 必须为 {RENDER_SPEC}")
    import stream_render as sr
    from blackbg_element_hand import over, place_in_rect
    from soft_cutout import content_bbox, soft_cutout_bgr

    p = req.get("params") or {}
    size = str(p.get("size", "1280x720"))
    if size not in SIZES:
        raise ValueError(f"不支持的画幅 {size}")
    W, H = (int(x) for x in size.split("x"))
    fps = int(p.get("fps", 30))
    total_ms = int(round(float(p.get("duration", 8)) * 1000))
    hold_ms = int(round(float(p.get("hold", 1.5)) * 1000))
    background = str(p.get("background", "board"))
    alpha = background == "transparent"
    tone = str(p.get("tone", "chalk"))
    fill = str(p.get("fill", "wipe"))
    stroke = str(p.get("stroke", "skeleton"))
    hand_mode = str(p.get("hand", "chalk"))
    hand_scale = float(p.get("handSize", 1.0))
    crf = CRF.get(str(p.get("quality", "standard")), 31)
    ffmpeg = str(req.get("ffmpeg") or "ffmpeg")

    els = req.get("elements") or []
    if not 1 <= len(els) <= 8:
        raise ValueError("elements 须为 1~8 个")
    out_dir = Path(req["outDir"])
    outputs = req.get("outputs") or {}
    prefix = str(outputs.get("prefix") or req.get("jobId") or "chalk")
    work = out_dir / f"_{prefix}_work"
    shutil.rmtree(work, ignore_errors=True)
    (work / "masks").mkdir(parents=True, exist_ok=True)

    # 1. 抠图：黑底粉笔 → 透明 PNG，裁到内容框
    crops: list[np.ndarray] = []
    for i, el in enumerate(els):
        progress("抠图", i / len(els))
        rgba = soft_cutout_bgr(load_bgr(Path(el["image"])))
        x0, y0, x1, y1 = content_bbox(rgba)
        crops.append(rgba[y0:y1, x0:x1].copy())
    progress("抠图", 1.0)

    # 2. 版式：叙事模板槽位，权重大的略放大
    progress("排版", 0.0)
    preset, rects = layout_rects(len(els), W, H, str(p.get("layout", "auto")))
    weights = [float(el.get("weight", 1.0)) for el in els]
    w_max = max(weights) or 1.0
    canvas = np.zeros((H, W, 3), np.uint8)
    placed: list[dict] = []
    for i, (el, crop, rect, wt) in enumerate(zip(els, crops, rects, weights)):
        fill_ratio = float(np.clip(0.88 * (0.92 + 0.10 * wt / w_max), 0.82, 0.98))
        pl = place_in_rect(crop, rect, H, W, fill=fill_ratio)
        layer = np.zeros((H, W, 4), np.uint8)
        piece = cv2.resize(crop, (pl.width, pl.height), interpolation=cv2.INTER_AREA)
        layer[pl.y:pl.y + pl.height, pl.x:pl.x + pl.width] = piece
        canvas = over(canvas, layer)
        mask = (layer[:, :, 3] > 28).astype(np.uint8) * 255
        mask = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)), iterations=1)
        ys, xs = np.where(mask > 0)
        if ys.size == 0:
            raise RuntimeError(f"元素 {el.get('label') or el['id']} 抠图后为空")
        bx0, by0, bx1, by1 = int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1
        eid = str(el.get("id") or f"e{i + 1}")
        save_png(work / "masks" / f"{eid}.png", mask[by0:by1, bx0:bx1])
        save_png(out_dir / f"{prefix}_mask_{eid}.png", mask[by0:by1, bx0:bx1])
        save_png(out_dir / f"{prefix}_cut_{eid}.png", crop)
        placed.append({
            "id": eid, "label": str(el.get("label") or ""), "role": str(el.get("role") or "support"),
            "box": [bx0, by0, bx1 - bx0, by1 - by0], "area": int((mask > 0).sum()),
        })
    save_png(work / "image.png", canvas)
    progress("排版", 1.0)

    # 3. 蒙版编排：按规划顺序逐元素揭示，时长 ∝ 权重 × 墨量
    timings = element_timings(weights, [e["area"] for e in placed], total_ms, hold_ms)
    ann = {
        "sceneId": prefix,
        "canvas": {"width": W, "height": H},
        "sceneDurationMs": total_ms,
        "timingSource": "tts_timeline",
        "elements": [
            {
                "id": e["id"], "label": e["label"], "sequence": i + 1, "type": "structure",
                "region": {"x": e["box"][0], "y": e["box"][1], "width": e["box"][2], "height": e["box"][3]},
                "reveal": {"direction": "left_to_right", "startMs": st, "durationMs": du, "protectedRegions": []},
                "handPath": {"start": [e["box"][0], e["box"][1]], "end": [e["box"][0] + e["box"][2], e["box"][1] + e["box"][3]], "easing": "easeInOut"},
                "framed": True,
                "maskFile": f"masks/{e['id']}.png",
            }
            for i, (e, (st, du)) in enumerate(zip(placed, timings))
        ],
    }
    (work / "annotation.json").write_text(json.dumps(ann, ensure_ascii=False, indent=2), encoding="utf-8")

    # 4. 书写渲染
    rsw, PipeRenderer = make_renderer_class()
    if background != "board":
        rsw._load_chalk_board = lambda h, w: np.zeros((h, w, 3), np.uint8)
    cfg = sr.Config(
        fps=fps,
        cap_long_edge=max(W, H),
        ink_path_mode=stroke,
        color_fill="brush" if fill == "brush" else "contour-wipe",
        color_weight=0 if fill == "none" else 1,
        ink_weight=2,
        pause_mode="heavy",
        board_style="chalkboard",
        canvas_hex="#0b241c",
        ink_threshold=52,
        target_hand_height=max(120, int(round(min(W, H) * hand_scale))),
    )
    hand_png = BLACKBOARD_ROOT / "assets" / "hand-chalk.png"
    bare = hand_mode == "none"
    renderer = PipeRenderer(canvas, ann, cfg, None if bare else (hand_png if hand_png.exists() else None), bare, ann_dir=work)
    if (renderer.out_w, renderer.out_h) != (W, H):
        raise RuntimeError(f"输出尺寸对不齐: {renderer.out_w}x{renderer.out_h} ≠ {W}x{H}")
    video_name = str(outputs.get("video") or f"{prefix}.webm")
    renderer.sink = open_sink(out_dir / video_name, W, H, fps, alpha, crf, ffmpeg)
    renderer.alpha = alpha
    renderer.tone = tone
    renderer.total_frames = max(1, round(total_ms * fps / 1000))
    renderer.progress = progress
    try:
        renderer.render_to(work / "_unused.mp4", total_ms, draw_ahead_ms=0, lock_reveal=True)
        progress("编码", 0.5)
        renderer.sink.stdin.close()
        err = renderer.sink.stderr.read().decode("utf-8", "replace")
        if renderer.sink.wait() != 0:
            raise RuntimeError(f"ffmpeg 编码失败: {err[-400:]}")
    except BaseException:
        if renderer.sink.poll() is None:
            renderer.sink.kill()
        raise
    progress("编码", 1.0)

    # 5. 成品静帧（最终画面，无手）
    last = renderer.drawn.astype(np.uint8)
    still_name = str(outputs.get("still") or f"{prefix}_still.png")
    if alpha:
        color, a = to_straight_rgba(last, tone)
        save_png(out_dir / still_name, np.dstack([color, a * 255.0]).astype(np.uint8))
    else:
        save_png(out_dir / still_name, last)

    if not req.get("keepWork"):
        shutil.rmtree(work, ignore_errors=True)
    return {
        "video": video_name,
        "still": still_name,
        "alpha": alpha,
        "width": W,
        "height": H,
        "fps": fps,
        "frames": renderer.frames,
        "duration": round(renderer.frames / fps, 3),
        "layout": preset,
        "elements": [
            {
                "id": e["id"], "label": e["label"], "role": e["role"], "box": e["box"],
                "startMs": st, "durationMs": du,
                "mask": f"{prefix}_mask_{e['id']}.png", "cut": f"{prefix}_cut_{e['id']}.png",
            }
            for e, (st, du) in zip(placed, timings)
        ],
    }


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass
    ap = argparse.ArgumentParser(description="黑板手绘渲染器（todo-skill-render/1）")
    ap.add_argument("--request", type=Path, required=True)
    args = ap.parse_args()
    try:
        req = json.loads(args.request.read_text(encoding="utf-8"))
        emit("result", render(req, Progress()))
        return 0
    except Exception as e:  # noqa: BLE001
        emit("error", {"message": f"{type(e).__name__}: {e}"[:600]})
        return 1


if __name__ == "__main__":
    sys.exit(main())
