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
import zlib
from pathlib import Path

import cv2
import numpy as np

BLACKBOARD_ROOT = Path(os.environ.get("BLACKBOARD_ROOT") or r"D:\desktop\黑板报")
sys.path.insert(0, str(BLACKBOARD_ROOT / "scripts"))
sys.path.insert(0, str(BLACKBOARD_ROOT))

RENDER_SPEC = "todo-skill-render/1"
# 书写效果变了就加一：宿主不复用更低版本的分镜缓存（元素图不受影响，只重渲）
SCENE_REV = 3
ENTERS = ("draw", "stamp", "fade")
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


def open_sink(path: Path, W: int, H: int, fps: int, alpha: bool, crf: int, ffmpeg: str, audio: Path | None = None) -> subprocess.Popen:
    args = [
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "bgra" if alpha else "bgr24",
        "-s", f"{W}x{H}", "-r", str(fps), "-i", "-",
    ]
    if audio:
        args += ["-i", str(audio), "-map", "0:v", "-map", "1:a", "-c:a", "libopus", "-b:a", "128k"]
    else:
        args.append("-an")
    args += [
        "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p" if alpha else "yuv420p",
        "-b:v", "0", "-crf", str(crf), "-row-mt", "1", "-deadline", "good", "-cpu-used", "4",
    ]
    if alpha:
        args += ["-auto-alt-ref", "0"]
    args.append(str(path))
    return subprocess.Popen(args, stdin=subprocess.PIPE, stderr=subprocess.PIPE)


def last_frame_png(video: Path, out: Path, ffmpeg: str) -> bool:
    """定格图取视频自己的最后一帧：原图无损、视频是 yuv420，直接存原图会在切换那帧跳色。"""
    r = subprocess.run(
        [ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-c:v", "libvpx-vp9", "-sseof", "-1", "-i", str(video),
         "-an", "-pix_fmt", "rgba", "-f", "image2", "-update", "1", str(out)],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )
    return r.returncode == 0 and out.exists() and out.stat().st_size > 0


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
        # 多板共用一路编码时，每板帧数须精确落在换板点：超出的丢弃，不足的由 pad_to_budget 补静帧
        budget: int | None = None
        scene_frames = 0
        _pending_tip: tuple[int, int] | None = None
        # 单元素片段：只输出元素自己的框，不压手，逐帧记下笔尖（整幅坐标，没落笔的帧为 None）
        crop: tuple[int, int, int, int] | None = None
        stamp_hand = True
        tips: list | None = None

        def _snapshot_with_tip(self, px: int, py: int) -> np.ndarray:
            self._last_tip = (int(px), int(py))
            self._pending_tip = self._last_tip
            return self.drawn.astype(np.uint8)

        # 上色不再让手扫一遍：线稿写完后颜色在本元素区域内直接淡入，这几帧不落笔尖
        def _wash_contour(self, writer, frames: int, allowed: np.ndarray) -> None:
            self._fade_color(writer, frames, allowed)

        def _wash_brush(self, writer, frames: int, centers, allowed: np.ndarray) -> None:
            self._fade_color(writer, frames, allowed)

        # 库在上色前会把骨架漏掉的墨一次补齐；从最后输出的那一帧开始淡，免得突然冒出一块
        def _fade_color(self, writer, frames: int, allowed: np.ndarray) -> None:
            ys, xs = np.where(allowed)
            if ys.size == 0:
                return
            y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
            mask = allowed[y0:y1, x0:x1]
            view = self.drawn[y0:y1, x0:x1]
            shown = getattr(self, "_last_snap", None)
            base = (shown if shown is not None else self.drawn)[y0:y1, x0:x1][mask].astype(np.float32)
            target = self.color_img[y0:y1, x0:x1][mask].astype(np.float32)
            for fi in range(max(0, frames)):
                a = (fi + 1) / frames
                view[mask] = base + (target - base) * a
                self._write_frame(writer, self.drawn.astype(np.uint8))
            view[mask] = target

        def pad_to_budget(self) -> None:
            if self.budget is None:
                return
            snap = self.drawn.astype(np.uint8)
            while self.scene_frames < self.budget:
                self._write_frame(None, snap)

        def _write_frame(self, writer, snap: np.ndarray) -> None:
            tip, self._pending_tip = self._pending_tip, None
            if self.budget is not None:
                if self.scene_frames >= self.budget:
                    return
                self.scene_frames += 1
            frame = snap if snap.dtype == np.uint8 else snap.astype(np.uint8)
            self._last_snap = frame
            if self.tips is not None:
                self.tips.append(tip)
            if self.crop is not None:
                x0, y0, x1, y1 = self.crop
                frame = frame[y0:y1, x0:x1]
            if self.alpha:
                color, a = to_straight_rgba(frame, self.tone)
                if tip and self.tip is not None and self.stamp_hand:
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


def canvas_size(p: dict) -> tuple[int, int]:
    size = str(p.get("size", "1280x720"))
    if size not in SIZES:
        raise ValueError(f"不支持的画幅 {size}")
    W, H = (int(x) for x in size.split("x"))
    return W, H


def cut_crops(els: list[dict]) -> list[np.ndarray]:
    """黑底粉笔 → 透明 PNG，裁到内容框"""
    from soft_cutout import content_bbox, soft_cutout_bgr

    crops = []
    for el in els:
        rgba = soft_cutout_bgr(load_bgr(Path(el["image"])))
        x0, y0, x1, y1 = content_bbox(rgba)
        crops.append(rgba[y0:y1, x0:x1].copy())
    return crops


def place_scene(els: list[dict], crops: list[np.ndarray], W: int, H: int, layout: str,
                out_dir: Path, prefix: str, mask_dir: Path) -> tuple[str, np.ndarray, list[dict], list[np.ndarray]]:
    """叙事模板槽位排版，权重大的略放大；每元素一张白色蒙版（渲染用 + 产物）。另返回每个元素单独的黑底画面"""
    from blackbg_element_hand import over, place_in_rect

    preset, rects = layout_rects(len(els), W, H, layout)
    weights = [float(el.get("weight", 1.0)) for el in els]
    w_max = max(weights) or 1.0
    canvas = np.zeros((H, W, 3), np.uint8)
    placed: list[dict] = []
    singles: list[np.ndarray] = []
    for i, (el, crop, rect, wt) in enumerate(zip(els, crops, rects, weights)):
        fill_ratio = float(np.clip(0.88 * (0.92 + 0.10 * wt / w_max), 0.82, 0.98))
        pl = place_in_rect(crop, rect, H, W, fill=fill_ratio)
        layer = np.zeros((H, W, 4), np.uint8)
        piece = cv2.resize(crop, (pl.width, pl.height), interpolation=cv2.INTER_AREA)
        layer[pl.y:pl.y + pl.height, pl.x:pl.x + pl.width] = piece
        canvas = over(canvas, layer)
        singles.append(over(np.zeros((H, W, 3), np.uint8), layer))
        mask = (layer[:, :, 3] > 28).astype(np.uint8) * 255
        mask = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)), iterations=1)
        ys, xs = np.where(mask > 0)
        if ys.size == 0:
            raise RuntimeError(f"元素 {el.get('label') or el['id']} 抠图后为空")
        bx0, by0, bx1, by1 = int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1
        eid = str(el.get("id") or f"e{i + 1}")
        save_png(mask_dir / f"{eid}.png", mask[by0:by1, bx0:bx1])
        save_png(out_dir / f"{prefix}_mask_{eid}.png", mask[by0:by1, bx0:bx1])
        save_png(out_dir / f"{prefix}_cut_{eid}.png", crop)
        placed.append({
            "id": eid, "label": str(el.get("label") or ""), "role": str(el.get("role") or "support"),
            "box": [bx0, by0, bx1 - bx0, by1 - by0], "area": int((mask > 0).sum()),
        })
    return preset, canvas, placed, singles


def annotation(scene_id: str, W: int, H: int, total_ms: int, placed: list[dict], timings: list[tuple[int, int]], mask_prefix: str) -> dict:
    return {
        "sceneId": scene_id,
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
                "maskFile": f"{mask_prefix}{e['id']}.png",
            }
            for i, (e, (st, du)) in enumerate(zip(placed, timings))
        ],
    }


class Stage:
    """一次渲染的共享设置：书写配置、背景、手部、编码出口"""

    def __init__(self, p: dict, W: int, H: int, fps: int) -> None:
        import stream_render as sr

        self.rsw, self.Renderer = make_renderer_class()
        self.background = str(p.get("background", "board"))
        self.alpha = self.background == "transparent"
        self.tone = str(p.get("tone", "chalk"))
        if self.background != "board":
            self.rsw._orig_load_chalk_board = getattr(self.rsw, "_orig_load_chalk_board", self.rsw._load_chalk_board)
            self.rsw._load_chalk_board = lambda h, w: np.zeros((h, w, 3), np.uint8)
        fill = str(p.get("fill", "wipe"))
        self.cfg = sr.Config(
            fps=fps,
            cap_long_edge=max(W, H),
            ink_path_mode=str(p.get("stroke", "skeleton")),
            color_fill="brush" if fill == "brush" else "contour-wipe",
            color_weight=0 if fill == "none" else 1,
            ink_weight=9,
            pause_mode="heavy",
            board_style="chalkboard",
            canvas_hex="#0b241c",
            ink_threshold=52,
            target_hand_height=max(120, int(round(min(W, H) * float(p.get("handSize", 1.0))))),
        )
        hand_png = BLACKBOARD_ROOT / "assets" / "hand-chalk.png"
        self.bare = str(p.get("hand", "chalk")) == "none"
        self.hand = None if self.bare else (hand_png if hand_png.exists() else None)
        self.W, self.H, self.fps = W, H, fps
        self.crf = CRF.get(str(p.get("quality", "standard")), 31)
        self.sink: subprocess.Popen | None = None
        self.frames = 0
        self.total_frames = 1
        self.progress: Progress | None = None

    def open(self, path: Path, ffmpeg: str, total_frames: int, progress: Progress, audio: Path | None = None,
             size: tuple[int, int] | None = None) -> None:
        w, h = size or (self.W, self.H)
        self.sink = open_sink(path, w, h, self.fps, self.alpha, self.crf, ffmpeg, audio)
        self.total_frames = max(1, total_frames)
        self.progress = progress

    def renderer(self, canvas: np.ndarray, ann: dict, ann_dir: Path, budget: int | None = None):
        r = self.Renderer(canvas, ann, self.cfg, self.hand, self.bare, ann_dir=ann_dir)
        if (r.out_w, r.out_h) != (self.W, self.H):
            raise RuntimeError(f"输出尺寸对不齐: {r.out_w}x{r.out_h} ≠ {self.W}x{self.H}")
        r.sink = self.sink
        r.alpha = self.alpha
        r.tone = self.tone
        r.total_frames = self.total_frames
        r.frames = self.frames
        r.progress = self.progress
        r.budget = budget
        return r

    def run(self, r, total_ms: int, work: Path) -> None:
        r.render_to(work / "_unused.mp4", total_ms, draw_ahead_ms=0, lock_reveal=True)
        r.pad_to_budget()
        self.frames = r.frames

    def close(self) -> None:
        sink = self.sink
        if sink is None:
            return
        try:
            self.progress("编码", 0.5)
            sink.stdin.close()
            err = sink.stderr.read().decode("utf-8", "replace")
            if sink.wait() != 0:
                raise RuntimeError(f"ffmpeg 编码失败: {err[-400:]}")
        except BaseException:
            if sink.poll() is None:
                sink.kill()
            raise
        self.progress("编码", 1.0)

    def abort(self) -> None:
        if self.sink is not None and self.sink.poll() is None:
            self.sink.kill()

    def save_still(self, path: Path, drawn: np.ndarray, crop: tuple[int, int, int, int] | None = None) -> None:
        last = drawn.astype(np.uint8)
        if crop is not None:
            x0, y0, x1, y1 = crop
            last = last[y0:y1, x0:x1]
        if self.alpha:
            color, a = to_straight_rgba(last, self.tone)
            save_png(path, np.dstack([color, a * 255.0]).astype(np.uint8))
        else:
            save_png(path, last)


def render(req: dict, progress: Progress) -> dict:
    if req.get("spec") != RENDER_SPEC:
        raise ValueError(f"spec 必须为 {RENDER_SPEC}")
    if req.get("mode") == "scene-clips":
        return render_scene_clips(req, progress)
    if req.get("mode") == "plate":
        return render_plate(req)

    p = req.get("params") or {}
    W, H = canvas_size(p)
    fps = int(p.get("fps", 30))
    total_ms = int(round(float(p.get("duration", 8)) * 1000))
    hold_ms = int(round(float(p.get("hold", 1.5)) * 1000))
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

    # 1. 抠图
    progress("抠图", 0.0)
    crops = cut_crops(els)
    progress("抠图", 1.0)

    # 2. 版式
    progress("排版", 0.0)
    preset, canvas, placed, _ = place_scene(els, crops, W, H, str(p.get("layout", "auto")), out_dir, prefix, work / "masks")
    save_png(work / "image.png", canvas)
    progress("排版", 1.0)

    # 3. 蒙版编排：按规划顺序逐元素揭示，时长 ∝ 权重 × 墨量
    weights = [float(el.get("weight", 1.0)) for el in els]
    timings = element_timings(weights, [e["area"] for e in placed], total_ms, hold_ms)
    ann = annotation(prefix, W, H, total_ms, placed, timings, "masks/")
    (work / "annotation.json").write_text(json.dumps(ann, ensure_ascii=False, indent=2), encoding="utf-8")

    # 4. 书写渲染
    stage = Stage(p, W, H, fps)
    video_name = str(outputs.get("video") or f"{prefix}.webm")
    stage.open(out_dir / video_name, ffmpeg, round(total_ms * fps / 1000), progress)
    try:
        renderer = stage.renderer(canvas, ann, work)
        stage.run(renderer, total_ms, work)
        stage.close()
    except BaseException:
        stage.abort()
        raise

    # 5. 成品静帧（最终画面，无手）
    still_name = str(outputs.get("still") or f"{prefix}_still.png")
    stage.save_still(out_dir / still_name, renderer.drawn)

    if not req.get("keepWork"):
        shutil.rmtree(work, ignore_errors=True)
    return {
        "video": video_name,
        "still": still_name,
        "alpha": stage.alpha,
        "width": W,
        "height": H,
        "fps": fps,
        "frames": stage.frames,
        "duration": round(stage.frames / fps, 3),
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


# ── narrated：按块黑板出时间轴片段（每元素一条书写视频 + 写完的定格图） ───────

ROLE_BASE_MS = {"hero": 3200, "support": 2400, "accent": 1500}
# 书写视频写完后多留几帧完成画面，接定格图时不闪
DRAW_TAIL_MS = 200


def resolve_enter(policy: str, role: str) -> str:
    policy = str(policy or "mix")
    if policy in ENTERS:
        return policy
    if role == "accent":
        return "stamp"
    if role == "support":
        return "fade"
    return "draw"


def assign_enters(els: list[dict], policy: str) -> list[str]:
    """混合进场：主视觉手写，配角渐显，标题盖章。一整板都是同一种时，从第二个起改用另外两种，避免整板一个动作。"""
    modes: list[str] = []
    for el in els:
        explicit = str(el.get("enter") or "")
        modes.append(explicit if explicit in ENTERS else resolve_enter(policy, str(el.get("role") or "support")))
    pinned = any(str(el.get("enter") or "") in ENTERS for el in els)
    if str(policy or "mix") in ENTERS or pinned or len(modes) < 2 or len(set(modes)) > 1:
        return modes
    rest = [m for m in ("stamp", "fade", "draw") if m != modes[0]]
    for i in range(1, len(modes)):
        modes[i] = rest[(i - 1) % len(rest)]
    return modes


def entrance_ms(mode: str, role: str, area: float, mean_area: float, speed: float, window: int) -> int:
    window = max(300, int(window))
    speed = max(0.25, float(speed))
    if mode == "stamp":
        natural, floor = 760 / max(0.55, speed), 400
    elif mode == "fade":
        natural, floor = 1080 / max(0.55, speed), 480
    else:
        natural = ROLE_BASE_MS.get(role, 2400) * float(np.clip((area / mean_area) ** 0.5, 0.7, 1.5)) / speed
        floor = 600
    return int(round(min(window, max(min(floor, window), natural))))


def narrated_timings(els: list[dict], areas: list[int], scene_start: int, speed: float, policy: str = "mix") -> tuple[list[tuple[int, int]], list[str]]:
    """元素在锚点起笔，且必须在下一个元素起笔前完成。手写时长仍按角色基准 × 墨量；盖章和渐显用更短的固定节奏。"""
    mean_area = (sum(areas) / len(areas)) or 1.0
    modes = assign_enters(els, policy)
    out = []
    for el, area, mode in zip(els, areas, modes):
        start = int(el["atMs"]) - scene_start
        window = max(300, int(el["windowEndMs"]) - int(el["atMs"]))
        out.append((max(0, start), entrance_ms(mode, str(el.get("role") or "support"), area, mean_area, speed, window)))
    return out, modes


CROP_PAD = 8
# 笔尖轨迹最多每秒 15 个点（编辑器生成手部位置关键帧用）
TIP_RATE = 15


def element_crop(box: list[int], W: int, H: int, enter: str = "draw") -> tuple[int, int, int, int]:
    """元素框外扩一点，宽高取偶数（yuva420p）。盖章要留出下压和粉尘的空，渐显要留出虚化边。"""
    x, y, w, h = box
    extra = int(round(max(w, h) * (0.34 if enter == "stamp" else 0.05 if enter == "fade" else 0)))
    pad = CROP_PAD + extra
    x0, y0 = max(0, x - pad), max(0, y - pad)
    x1, y1 = min(W, x + w + pad), min(H, y + h + pad)
    if (x1 - x0) % 2:
        x1 = x1 - 1 if x1 == W else x1 + 1
    if (y1 - y0) % 2:
        y1 = y1 - 1 if y1 == H else y1 + 1
    return x0, y0, x1, y1


def tip_path(tips: list, crop: tuple[int, int, int, int], fps: int) -> list[list[float]]:
    """逐帧笔尖 → [[秒, u, v], …]，u/v 为元素片段内的 0~1 坐标；只在落笔区间内采样"""
    x0, y0, x1, y1 = crop
    step = max(1, round(fps / TIP_RATE))
    idx = [i for i, t in enumerate(tips) if t]
    if not idx:
        return []
    keep = sorted(set(list(range(idx[0], idx[-1] + 1, step)) + [idx[-1]]))
    out, last = [], None
    for i in keep:
        last = tips[i] or last
        if last is None:
            continue
        out.append([round(i / fps, 3), round((last[0] - x0) / (x1 - x0), 4), round((last[1] - y0) / (y1 - y0), 4)])
    return out


def _smooth(t: float) -> float:
    t = min(1.0, max(0.0, t))
    return t * t * (3.0 - 2.0 * t)


def _pack_bgra(color: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    return np.dstack([np.clip(color, 0, 255), np.clip(alpha, 0, 1) * 255.0]).astype(np.uint8)


def _ink_stats(alpha: np.ndarray) -> tuple[float, float, float, float] | None:
    ys, xs = np.where(alpha > 0.15)
    if xs.size == 0:
        return None
    return float(xs.mean()), float(ys.mean()), float(ys.max() - ys.min() + 1), float(xs.max() - xs.min() + 1)


_DISC_CACHE: dict[int, np.ndarray] = {}


def _soft_disc(radius: float) -> np.ndarray:
    key = max(2, int(round(radius * 2)))
    hit = _DISC_CACHE.get(key)
    if hit is not None:
        return hit
    r = max(1, key // 2)
    yy, xx = np.mgrid[-r:r + 1, -r:r + 1]
    disc = np.clip(1.0 - np.hypot(xx, yy) / max(radius, 0.5), 0.0, 1.0) ** 1.7
    _DISC_CACHE[key] = disc
    return disc


def _splat(acc: np.ndarray, disc: np.ndarray, x: float, y: float, amount: float) -> None:
    if amount <= 0.004:
        return
    h, w = acc.shape
    dh, dw = disc.shape
    cx, cy = int(round(x)), int(round(y))
    x0, y0 = cx - dw // 2, cy - dh // 2
    x1, y1 = x0 + dw, y0 + dh
    sx0, sy0 = max(0, -x0), max(0, -y0)
    dx0, dy0 = max(0, x0), max(0, y0)
    dx1, dy1 = min(w, x1), min(h, y1)
    if dx1 <= dx0 or dy1 <= dy0:
        return
    acc[dy0:dy1, dx0:dx1] += disc[sy0:sy0 + (dy1 - dy0), sx0:sx0 + (dx1 - dx0)] * amount


def _dust_scale(alpha: np.ndarray) -> float:
    """粉尘的像素速度、颗粒和烟团按墨迹外接框缩放。140px 是当初调好的参照大小。"""
    stats = _ink_stats(alpha)
    extent = max(alpha.shape) * 0.45 if stats is None else max(stats[2], stats[3])
    return max(0.25, extent / 140.0)


def _make_dust(alpha: np.ndarray, seed: int, tone: str) -> dict:
    h, w = alpha.shape
    ink = (alpha > 0.22).astype(np.uint8)
    kernel_out = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    kernel_in = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    rim = (cv2.dilate(ink, kernel_out) > 0) & (cv2.erode(ink, kernel_in) == 0)
    ys, xs = np.where(rim)
    rng = np.random.default_rng(seed & 0xFFFFFFFF)
    if xs.size < 8:
        yy, xx = np.mgrid[0:h:6, 0:w:6]
        ys, xs = yy.ravel(), xx.ravel()
    n = int(np.clip(float(ink.sum()) / 42.0, 70, 150))
    weight = (ys - ys.min() + 1.0) ** 1.35
    weight /= weight.sum()
    pick = rng.choice(xs.size, size=n, replace=True, p=weight)
    px, py = xs[pick].astype(np.float64), ys[pick].astype(np.float64)
    cx, cy = float(np.average(xs, weights=weight)), float(np.average(ys, weights=weight))
    dx, dy = px - cx, py - cy
    norm = np.hypot(dx, dy) + 1e-3
    scale = _dust_scale(alpha)
    vx = dx / norm * rng.uniform(50, 210, n) * scale + rng.normal(0, 18, n) * scale
    vy = dy / norm * rng.uniform(10, 70, n) * scale - rng.uniform(140, 340, n) * scale
    life = rng.uniform(0.38, 0.78, n)
    radius = rng.uniform(1.3, 4.2, n) * scale
    peak = rng.uniform(0.45, 0.95, n)
    # 几团更大的灰，砸下去才有扬起来的体积
    puffs = max(10, n // 6)
    puff_i = rng.choice(n, size=puffs, replace=False)
    radius[puff_i] = rng.uniform(9.0, 18.0, puffs) * scale
    peak[puff_i] = rng.uniform(0.28, 0.5, puffs)
    vy[puff_i] -= rng.uniform(30, 110, puffs) * scale
    dust = np.array([210, 228, 236], np.float32) if tone != "ink" else np.array([42, 44, 48], np.float32)
    return {"x": px, "y": py, "vx": vx, "vy": vy, "life": life, "radius": radius, "peak": peak, "rgb": dust, "gravity": 340.0 * scale, "scale": scale}


def _dust_alpha(dust: dict, age: float) -> np.ndarray:
    h = int(dust["h"])
    w = int(dust["w"])
    acc = np.zeros((h, w), np.float32)
    alive = age < dust["life"]
    if not np.any(alive) or age < 0:
        return acc
    t = np.full(dust["life"].shape, age, np.float64)
    x = dust["x"] + dust["vx"] * t
    y = dust["y"] + dust["vy"] * t + 0.5 * float(dust["gravity"]) * t * t
    fade = np.clip(1.0 - t / dust["life"], 0, 1) ** 1.35
    grow = 1.0 + 1.5 * np.clip(t / dust["life"], 0, 1)
    for i in np.flatnonzero(alive):
        _splat(acc, _soft_disc(float(dust["radius"][i] * grow[i])), float(x[i]), float(y[i]), float(dust["peak"][i] * fade[i]))
    return np.clip(acc, 0, 0.85)


def _warp_chalk(color: np.ndarray, alpha: np.ndarray, cx: float, cy: float, sx: float, sy: float, ty: float, opacity: float) -> tuple[np.ndarray, np.ndarray]:
    h, w = alpha.shape
    matrix = np.array([[sx, 0, cx * (1 - sx)], [0, sy, cy * (1 - sy) + ty]], np.float32)
    warped_c = cv2.warpAffine(color, matrix, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))
    warped_a = cv2.warpAffine(alpha, matrix, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    return warped_c, warped_a * opacity


def _stamp_pose(u: float, travel: float) -> tuple[float, float, float, float, float]:
    """返回 sx, sy, ty（向下为正）, 不透明度, 撞击后的粉尘进度。撞击点之前加速下压，砸上后压扁再回弹。"""
    impact = 0.36
    if u < impact:
        p = (u / impact) ** 2.2
        return 1.08 - 0.08 * p, 1.14 - 0.14 * p, -travel * (1.0 - p), p ** 0.72, 0.0
    q = (u - impact) / (1.0 - impact)
    if q < 0.24:
        k = q / 0.24
        return 1.12 - 0.12 * k, 0.78 + 0.22 * k, travel * 0.035 * (1.0 - k), 1.0, q
    k = (q - 0.24) / 0.76
    bounce = float(np.sin(k * np.pi) * (1.0 - k))
    return 1.0 - 0.035 * bounce, 1.0 + 0.06 * bounce, 0.0, 1.0, q


def _over_dust(color: np.ndarray, alpha: np.ndarray, dust_a: np.ndarray, rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    out_a = dust_a + alpha * (1.0 - dust_a)
    out_c = (rgb * dust_a[..., None] + color * (alpha * (1.0 - dust_a))[..., None]) / np.maximum(out_a, 1e-6)[..., None]
    out_c[out_a < 1e-4] = 0
    return out_c, out_a


def iter_entrance_frames(bgr: np.ndarray, mode: str, n: int, fps: int, duration_ms: int, tone: str = "chalk", seed: int = 1):
    """盖章或渐显的逐帧直通 BGRA。末尾几帧是干净的完成画面，接定格图时不跳。"""
    color, alpha = to_straight_rgba(bgr, tone)
    settled = _pack_bgra(color, alpha)
    n = max(2, int(n))
    tail = min(max(1, int(round(DRAW_TAIL_MS * fps / 1000))), n - 1)
    anim = n - tail
    if mode == "fade":
        for i in range(n):
            if i >= anim:
                yield settled
                continue
            u = 0.0 if anim <= 1 else i / (anim - 1)
            reveal = _smooth(u)
            if reveal >= 0.985:
                yield settled
                continue
            sigma = (1.0 - reveal) * 1.8
            shown = alpha
            shown_c = color
            if sigma > 0.4:
                shown = cv2.GaussianBlur(alpha, (0, 0), sigma)
                premul = cv2.GaussianBlur(color * alpha[..., None], (0, 0), sigma)
                shown_c = premul / np.maximum(shown, 1e-3)[..., None]
                shown_c[shown < 1e-3] = 0
            yield _pack_bgra(shown_c, shown * reveal)
        return

    stats = _ink_stats(alpha)
    h, w = alpha.shape
    if stats is None:
        for _ in range(n):
            yield settled
        return
    cx, cy, content_h, content_w = stats
    margin = min(cy, h - 1 - cy)
    travel = min(0.28 * content_h, max(8.0, margin * 0.9))
    dust = _make_dust(alpha, seed, tone)
    dust["h"], dust["w"] = h, w
    post = max(0.18, duration_ms / 1000.0 * 0.64)
    for i in range(n):
        if i >= anim:
            yield settled
            continue
        u = 0.0 if anim <= 1 else i / (anim - 1)
        if u >= 0.995:
            yield settled
            continue
        sx, sy, ty, opacity, dust_u = _stamp_pose(u, travel)
        warped_c, warped_a = _warp_chalk(color, alpha, cx, cy, sx, sy, ty, opacity)
        if dust_u > 0.02 and opacity > 0.9:
            dust_a = _dust_alpha(dust, dust_u * post)
            rise = dust_u * content_h * 0.62
            cloud = content_h * (0.18 + dust_u * 0.42)
            amount = 0.55 * (1.0 - dust_u) ** 1.15
            _splat(dust_a, _soft_disc(cloud), cx, cy + content_h * 0.12 - rise, amount)
            _splat(dust_a, _soft_disc(cloud * 0.5), cx - content_h * 0.38, cy - rise * 0.65, amount * 0.75)
            _splat(dust_a, _soft_disc(cloud * 0.5), cx + content_h * 0.38, cy - rise * 0.65, amount * 0.75)
            dust_a = np.clip(dust_a, 0, 0.9)
            # 刚砸上的一瞬间把粉笔提亮一点，像灰被压出来
            flash = max(0.0, 1.0 - dust_u / 0.18) * 0.28
            if flash > 0:
                warped_c = warped_c + (255.0 - warped_c) * flash * warped_a[..., None]
            warped_c, warped_a = _over_dust(warped_c, warped_a, dust_a, dust["rgb"])
        yield _pack_bgra(warped_c, warped_a)


def write_raw_frames(stage, frames) -> None:
    sink = stage.sink
    if sink is None or sink.stdin is None:
        raise RuntimeError("编码管道还没打开")
    total = max(1, stage.total_frames)
    for frame in frames:
        sink.stdin.write(np.ascontiguousarray(frame).tobytes())
        stage.frames += 1
        if stage.progress and stage.frames % 4 == 0:
            stage.progress("书写渲染", stage.frames / total)


def save_hand(path: Path, tip) -> dict:
    """粉笔手（整幅比例下的尺寸），编辑器的「粉笔手书写」入场动画用；tipX/tipY 为笔尖在图里的位置"""
    if not path.is_file():
        save_png(path, np.dstack([tip.hand, np.clip(tip.mask * 255.0, 0, 255)]).astype(np.uint8))
    return {"file": path.name, "width": int(tip.w), "height": int(tip.h),
            "tipX": round(tip.tip_px / max(1, tip.w - 1), 4), "tipY": round(tip.tip_py / max(1, tip.h - 1), 4)}


def render_scene_clips(req: dict, progress: Progress) -> dict:
    """一块黑板 → 每个元素单独的透明素材。手写元素出书写 WebM（不带手）+ 笔尖轨迹；
    盖章和渐显直接把进场做进 WebM，不落笔尖。粉笔手单独出一张图，只跟着手写元素。"""
    p = req.get("params") or {}
    W, H = canvas_size(p)
    fps = int(p.get("fps", 30))
    speed = float(p.get("drawSpeed", 1.0))
    ffmpeg = str(req.get("ffmpeg") or "ffmpeg")
    scene = req.get("scene") or {}
    els = scene.get("elements") or []
    if not 1 <= len(els) <= 8:
        raise ValueError("scene.elements 须为 1~8 个")

    out_dir = Path(req["outDir"])
    outputs = req.get("outputs") or {}
    prefix = str(outputs.get("prefix") or req.get("jobId") or "chalk")
    # 宿主可指定共用的手图文件名（同一成片所有镜头共用一张）
    hand_name = str(outputs.get("hand") or f"{prefix}_hand.png")
    sid = str(scene.get("id") or "s1")
    work = out_dir / f"_{prefix}_{sid}_work"
    shutil.rmtree(work, ignore_errors=True)
    (work / "masks").mkdir(parents=True, exist_ok=True)

    progress("准备画面", 0.0)
    crops = cut_crops(els)
    preset, _, placed, singles = place_scene(els, crops, W, H, str(p.get("layout", "auto")), out_dir, prefix, work / "masks")
    start = int(scene["startMs"])
    policy = str(p.get("enter", "mix"))
    timings, modes = narrated_timings(els, [e["area"] for e in placed], start, speed, policy)
    progress("准备画面", 1.0)

    # 手一律加载（只取笔尖轨迹和手图），不压进元素片段；盖章 / 渐显没有笔尖
    stage = Stage({**p, "background": "transparent", "hand": "chalk"}, W, H, fps)
    frames_of = [max(2, int(round((du + DRAW_TAIL_MS) * fps / 1000))) for _, du in timings]
    total = sum(frames_of)
    clips = []
    hand = None
    try:
        for e, single, (st, du), n, mode in zip(placed, singles, timings, frames_of, modes):
            video = f"{prefix}_{sid}_{e['id']}.webm"
            hold = f"{prefix}_{sid}_{e['id']}_hold.png"
            crop = element_crop(e["box"], W, H, mode)
            stage.open(out_dir / video, ffmpeg, total, progress, size=(crop[2] - crop[0], crop[3] - crop[1]))
            before = stage.frames
            tip: list = []
            entrance = None
            if mode == "draw":
                ann = annotation(f"{prefix}_{sid}_{e['id']}", W, H, du + DRAW_TAIL_MS, [e], [(0, du)], "masks/")
                r = stage.renderer(single, ann, work, budget=n)
                r.crop, r.stamp_hand, r.tips = crop, False, []
                if hand is None and r.tip is not None:
                    hand = save_hand(out_dir / hand_name, r.tip)
                stage.run(r, du + DRAW_TAIL_MS, work)
                tip = tip_path(r.tips, crop, fps)
            else:
                x0, y0, x1, y1 = crop
                entrance = iter_entrance_frames(
                    single[y0:y1, x0:x1], mode, n, fps, du, stage.tone, zlib.crc32(str(e["id"]).encode("utf-8")),
                )
                write_raw_frames(stage, entrance)
            stage.close()
            if not last_frame_png(out_dir / video, out_dir / hold, ffmpeg):
                if mode == "draw":
                    stage.save_still(out_dir / hold, r.drawn, crop)
                else:
                    x0, y0, x1, y1 = crop
                    color, alpha = to_straight_rgba(single[y0:y1, x0:x1], stage.tone)
                    save_png(out_dir / hold, _pack_bgra(color, alpha))
            clips.append({
                "id": e["id"], "label": e["label"], "role": e["role"], "box": e["box"], "enter": mode,
                "crop": [crop[0], crop[1], crop[2] - crop[0], crop[3] - crop[1]],
                "startMs": start + st, "durationMs": du, "frames": stage.frames - before,
                "video": video, "hold": hold, "tip": tip,
                "mask": f"{prefix}_mask_{e['id']}.png", "cut": f"{prefix}_cut_{e['id']}.png",
            })
    except BaseException:
        stage.abort()
        raise

    if not req.get("keepWork"):
        shutil.rmtree(work, ignore_errors=True)
    return {
        "rev": SCENE_REV,
        "alpha": True,
        "width": W,
        "height": H,
        "fps": fps,
        "hand": hand,
        "scene": {"id": sid, "startMs": start, "endMs": int(scene["endMs"]), "layout": preset, "elements": clips},
    }


def render_plate(req: dict) -> dict:
    """整片底板：黑板报仓库的黑板底图，铺满画布（cover 裁切）；成片宿主把它放在最底层轨道"""
    p = req.get("params") or {}
    W, H = canvas_size(p)
    src = BLACKBOARD_ROOT / "assets" / "chalkboard-bg-black.png"
    if not src.is_file():
        raise FileNotFoundError(f"找不到黑板底图 {src}")
    img = load_bgr(src)
    h, w = img.shape[:2]
    s = max(W / w, H / h)
    img = cv2.resize(img, (max(W, round(w * s)), max(H, round(h * s))), interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC)
    y0, x0 = (img.shape[0] - H) // 2, (img.shape[1] - W) // 2
    out_dir = Path(req["outDir"])
    outputs = req.get("outputs") or {}
    name = str(outputs.get("plate") or f"{outputs.get('prefix') or req.get('jobId') or 'chalk'}_plate.png")
    save_png(out_dir / name, img[y0:y0 + H, x0:x0 + W])
    return {"plate": name, "width": W, "height": H}


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
