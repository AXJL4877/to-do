"""把镜头里的角色/道具/花字/红字/气泡拆成可入轨透明层（E1）。

权威成片仍是 render_film 的 MP4；这里额外写出 layers/ + layers_manifest.json，
供宿主 bind 成独立片段（位置/缩放/透明度/宿主动效可改）。
文字层是光栅：可挪可缩，改字体需重渲（E3）。
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image

from . import assets as A
from . import bubble
from . import imaging as I
from . import stage
from . import typo

W, H, FPS = I.W, I.H, I.FPS
PAD = 24


def _even(n: int) -> int:
    n = max(2, int(n))
    return n if n % 2 == 0 else n + 1


def _ffmpeg() -> str:
    return os.environ.get("FFMPEG") or os.environ.get("TODO_FFMPEG") or "ffmpeg"


def _layer_video_path(dest_dir: Path, stem: str) -> Path:
    """分层视频一律 VP9 alpha WebM：宿主 Chromium 可播真透明，导出侧按 alpha_mode=1 自动转 qtrle/argb MOV。"""
    return dest_dir / f"{stem}.webm"


def _encode_fade(sprite_rgba: np.ndarray, video: Path, hold: Path, frames: int, fps: int = FPS) -> None:
    """透明画布上的精灵 → hold PNG + 短淡入 VP9 alpha WebM（yuva420p）。

    为什么不是 qtrle MOV：qtrle 确实保 alpha，但宿主预览是 Chromium，
    解不出该编码（DEMUXER_ERROR_NO_SUPPORTED_STREAMS）→ 入场层在时间轴上整段不可见。
    VP9 + alpha_mode=1 宿主可播且是真透明；同级规格下体积约为 qtrle 的 1/50
    （1080p 8 帧：11MB → 数百 KB），不会像 qtrle 那样把预览拖死。
    导出侧 electron/alphaVideoExport.cjs 会按 alpha_mode=1 自动转 qtrle/argb MOV 给原生引擎。
    """
    h, w = sprite_rgba.shape[:2]
    w, h = _even(w), _even(h)
    if sprite_rgba.shape[1] != w or sprite_rgba.shape[0] != h:
        canvas = np.zeros((h, w, 4), np.uint8)
        canvas[: sprite_rgba.shape[0], : sprite_rgba.shape[1]] = sprite_rgba
        sprite_rgba = canvas
    Image.fromarray(sprite_rgba, "RGBA").save(hold)
    dur = max(2, frames) / fps
    fade = min(0.35, dur * 0.65)
    cmd = [
        _ffmpeg(), "-y",
        "-loop", "1", "-i", str(hold),
        "-vf", f"fade=t=in:st=0:d={fade}:alpha=1,fps={fps},format=yuva420p",
        "-t", f"{dur:.3f}",
        "-an", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p",
        # alpha 轨必须关掉 alt-ref，否则解码端读不到透明层
        "-auto-alt-ref", "0", "-row-mt", "1",
        "-deadline", "good", "-cpu-used", "4",
        "-b:v", "0", "-crf", "32",
        str(video),
    ]
    p = subprocess.run(cmd, capture_output=True)
    if p.returncode != 0 or not video.is_file():
        tail = (p.stderr or b"")[-400:].decode("utf-8", "replace")
        raise RuntimeError(f"layer encode failed {video.name}: {tail}")


def _pad_sprite(sprite: np.ndarray, pad: int = PAD) -> tuple[np.ndarray, int, int]:
    """透明边距覆盖轻微动效包络；返回 (padded, pad_x, pad_y)。"""
    h, w = sprite.shape[:2]
    pw, ph = _even(w + pad * 2), _even(h + pad * 2)
    out = np.zeros((ph, pw, 4), np.uint8)
    ox = (pw - w) // 2
    oy = (ph - h) // 2
    out[oy : oy + h, ox : ox + w] = sprite
    return out, ox, oy


def _alpha_bbox(rgba: np.ndarray, pad: int = 8) -> tuple[int, int, int, int] | None:
    a = rgba[:, :, 3]
    ys, xs = np.where(a > 20)
    if xs.size == 0:
        return None
    x0 = max(0, int(xs.min()) - pad)
    y0 = max(0, int(ys.min()) - pad)
    x1 = min(rgba.shape[1], int(xs.max()) + 1 + pad)
    y1 = min(rgba.shape[0], int(ys.max()) + 1 + pad)
    return x0, y0, x1, y1


def _settled_boxes(layers: list) -> list[dict]:
    """在入场结束后采样一次，拿到 rest 位与 envelope。"""
    frame = np.zeros((H, W, 3), np.uint8)
    # phrase_index 很大 → 全部可见；elapsed 大 → idle 中位
    return stage.draw_shot(frame, layers, phrase_index=99, phrase_t=1.0, elapsed=2.5, t_abs=999.0)


def _shot_window(sentences: list, idx: int) -> tuple[float, float]:
    if idx < len(sentences):
        s = sentences[idx]
        return float(s.get("start") or 0), float(s.get("end") or 0)
    if sentences:
        last = sentences[-1]
        return float(last.get("end") or 0), float(last.get("end") or 0) + 1.0
    return 0.0, 1.0


def _voice_duration_ms(timing: dict, sentences: list) -> int:
    dur = float(timing.get("duration") or 0)
    if not dur and sentences:
        dur = float(sentences[-1].get("end") or 0)
    return max(1, int(round(dur * 1000)))


def _bg_layer(rgb: np.ndarray, dest_dir: Path, stem: str, frames: int, *, enter: str = "cut") -> dict:
    rgb = rgb if rgb.ndim == 3 else np.zeros((H, W, 3), np.uint8)
    rgba = np.dstack([rgb, np.full((H, W), 255, np.uint8)])
    video = _layer_video_path(dest_dir, stem)
    hold = dest_dir / f"{stem}_hold.png"
    fr = max(2, min(frames, 8))
    _encode_fade(rgba, video, hold, frames=fr)
    return {
        "id": stem,
        "label": "背景",
        "role": "plate",
        "video": video.name,
        "hold": hold.name,
        "crop": [0, 0, W, H],
        "enter": enter,
        "frames": fr,
    }


def _black_bg(dest_dir: Path, stem: str, frames: int) -> dict:
    return _bg_layer(np.zeros((H, W, 3), np.uint8), dest_dir, stem, frames, enter="cut")


def _cut_layer(name: str, box: tuple, dest_dir: Path, stem: str, frames: int, fx: str) -> dict | None:
    base = A.element(name)
    if base is None:
        return None
    px, py, bw, bh = box
    sprite = base
    if sprite.shape[1] != bw or sprite.shape[0] != bh:
        scale = min(bw / max(1, sprite.shape[1]), bh / max(1, sprite.shape[0]))
        sprite = I.resize(sprite, scale) if abs(scale - 1) > 0.01 else sprite
    padded, ox, oy = _pad_sprite(sprite)
    ph, pw = padded.shape[:2]
    crop_x = max(0, int(px) - ox)
    crop_y = max(0, int(py) - oy)
    if crop_x + pw > W:
        crop_x = max(0, W - pw)
    if crop_y + ph > H:
        crop_y = max(0, H - ph)
    video = _layer_video_path(dest_dir, stem)
    hold = dest_dir / f"{stem}_hold.png"
    _encode_fade(padded, video, hold, frames=frames)
    # 角色/道具：fade/stamp 入场动画（宿主叠透明 MOV）；底板才用 cut
    fx_l = (fx or "fade").lower()
    enter = "stamp" if fx_l in ("stamp", "pop", "hit") else "fade"
    return {
        "id": stem,
        "label": name[:12],
        "role": "hero" if name.startswith("ch_") else "support",
        "video": video.name,
        "hold": hold.name,
        "crop": [crop_x, crop_y, pw, ph],
        "enter": enter,
        "frames": frames,
        "sourceName": name,
    }


def _sprite_layer(
    sprite: np.ndarray,
    x: int,
    y: int,
    dest_dir: Path,
    stem: str,
    frames: int,
    *,
    label: str,
    role: str,
    enter: str,
    pad: int = 16,
) -> dict | None:
    if sprite is None or sprite.size == 0:
        return None
    padded, ox, oy = _pad_sprite(sprite, pad=pad)
    ph, pw = padded.shape[:2]
    video = _layer_video_path(dest_dir, stem)
    hold = dest_dir / f"{stem}_hold.png"
    _encode_fade(padded, video, hold, frames=frames)
    return {
        "id": stem,
        "label": label,
        "role": role,
        "video": video.name,
        "hold": hold.name,
        "crop": [max(0, int(x) - ox), max(0, int(y) - oy), pw, ph],
        "enter": enter,
        "frames": frames,
    }


def _huazi_layer(shot: dict, beat_text: str, dest_dir: Path, stem: str, frames: int) -> dict | None:
    text_spec = shot.get("text")
    if not isinstance(text_spec, dict) or not text_spec.get("content"):
        return None
    raw = str(text_spec.get("content") or "")
    if beat_text:
        raw = typo.complete_phrase(raw, beat_text, typo.HUAZI_MAX)
    content = typo.title_phrase(raw)
    if not content:
        return None
    stamp = str(text_spec.get("zone") or "") == "center_full"
    sprite = typo.huazi_sprite(content, size=150 if stamp else 112)
    if sprite is None:
        return None
    x = int((W - sprite.shape[1]) / 2)
    y = int((0.40 * H - sprite.shape[0] / 2) if stamp else max(22, 0.09 * H - sprite.shape[0] / 2))
    return _sprite_layer(
        sprite, x, y, dest_dir, stem, frames,
        label="花字", role="accent", enter="stamp", pad=16,
    )


def _bake_title_canvas(title_rgba: np.ndarray) -> np.ndarray:
    """满幅不透明黑底 + 红字（宿主预览不丢 alpha）。"""
    canvas = np.zeros((H, W, 4), np.uint8)
    canvas[..., 3] = 255
    if title_rgba is None or title_rgba.size == 0:
        return canvas
    th, tw = title_rgba.shape[:2]
    a = title_rgba[..., 3:4].astype(np.float32) / 255.0
    rgb = (title_rgba[..., :3] * a).astype(np.uint8)
    if th == H and tw == W:
        canvas[..., :3] = rgb
    else:
        x = max(0, (W - tw) // 2)
        y = max(0, (H - th) // 2)
        x1, y1 = min(W, x + tw), min(H, y + th)
        canvas[y:y1, x:x1, :3] = rgb[: y1 - y, : x1 - x]
    return canvas


def _intro_plate_layer(title_rgba: np.ndarray, dest_dir: Path, stem: str, frames: int, *, label: str) -> dict | None:
    canvas = _bake_title_canvas(title_rgba)
    video = _layer_video_path(dest_dir, stem)
    hold = dest_dir / f"{stem}_hold.png"
    fr = max(2, min(frames, 8))
    _encode_fade(canvas, video, hold, frames=fr)
    return {
        "id": stem,
        "label": label,
        "role": "accent",
        "video": video.name,
        "hold": hold.name,
        "crop": [0, 0, W, H],
        "enter": "cut",
        "frames": fr,
    }


def _intro_marks(sentence: dict, lines: list) -> dict:
    """与 render.intro_marks 对齐：先单行再多行，避免三行同时挤满。"""
    start = float(sentence.get("start") or 0)
    end = float(sentence.get("end") or (start + 1))
    span = max(0.4, end - start)
    line2 = start + span * 0.33
    shatter = end - min(0.48, span * 0.22)
    chars = []
    for p in sentence.get("phrases") or []:
        for c in p.get("chars") or []:
            ch = str(c.get("text") or "")
            if ch and ch not in "，。！？；、,.!?\"'":
                chars.append(c)
    if chars and lines:
        body = typo.title_trad(__import__("re").sub(r"[，。！？；,\s]", "", lines[0] or ""))
        i = 0
        j1 = None
        for j, c in enumerate(chars):
            if typo.title_trad(str(c.get("text") or "")) == (body[i] if i < len(body) else None):
                i += 1
                if i >= len(body):
                    j1 = j
                    break
        if j1 is not None:
            line2 = float(chars[j1].get("end") or line2)
            if j1 + 1 < len(chars):
                line2 = float(chars[j1 + 1].get("start") or line2)
        shatter = min(max(line2 + 0.12, shatter), end - 0.08)
        if end - shatter < 0.28:
            shatter = end - 0.28
        # 第二行要留得住。line2 是从"第一行念完"推出来的，shatter 是从"整句念完减提前量"
        # 推出来的：第一行一长就贴上——实测 line2=1.795s / shatter=2.19s，第二行只亮 0.39s，
        # 看片就是"一闪而过"✗。修法是**把第二行的切换点提前**（两行都读得完），
        # 而不是把碎裂往后挤（那会吃掉碎裂动画）。
        MIN_LINE2_HOLD = 0.9
        latest_line2 = shatter - MIN_LINE2_HOLD
        if line2 > latest_line2:
            line2 = max(start + span * 0.10, latest_line2)
    return {"line2_start": line2, "shatter": shatter, "end": end}


def _encode_rgba_seq(frames_rgba: list[np.ndarray], video: Path, hold: Path, fps: int = FPS) -> None:
    """满幅 RGBA 转场 → hold PNG + VP9 alpha WebM（yuva420p，真透明）。

    以前走「预乘黑底 + H.264 + 宿主 chromaKey=nearblack」，三个坑都实测到了：
      1) 4:2:0 色度把绿幕抠像的溢色糊成绿边，近黑阈值删不掉；
      2) 宿主 ≤18 是硬阈值、无羽化，软边上打出块状空洞；
      3) 依赖素材带 chromaKey，标记一丢就是满幅黑屏。
    真 alpha 编码没有这些问题，还更小：同一条 30 帧 1080p 转场
    VP9 alpha 3.1MB < H.264 3.4MB << ffv1 MKV 18.5MB。
    """
    if not frames_rgba:
        raise RuntimeError("empty rgba seq")
    mid = frames_rgba[len(frames_rgba) // 2]
    Image.fromarray(mid, "RGBA").save(hold)
    h, w = mid.shape[:2]
    w, h = _even(w), _even(h)
    seq = []
    for fr in frames_rgba:
        if fr.shape[1] != w or fr.shape[0] != h:
            canvas = np.zeros((h, w, 4), np.uint8)
            canvas[: fr.shape[0], : fr.shape[1]] = fr
            fr = canvas
        seq.append(np.ascontiguousarray(fr, dtype=np.uint8))
    cmd = [
        _ffmpeg(), "-y",
        "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{w}x{h}", "-r", str(fps),
        "-i", "pipe:0",
        "-an", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p",
        # alpha 轨必须关掉 alt-ref，否则解码端读不到透明层
        "-auto-alt-ref", "0", "-row-mt", "1",
        "-deadline", "good", "-cpu-used", "4",
        "-b:v", "0", "-crf", "32",
        str(video),
    ]
    raw = b"".join(fr.tobytes() for fr in seq)
    p = subprocess.run(cmd, input=raw, capture_output=True)
    if p.returncode != 0 or not video.is_file():
        tail = (p.stderr or b"")[-400:].decode("utf-8", "replace")
        raise RuntimeError(f"wipe encode failed {video.name}: {tail}")


def _media_duration(path: Path) -> float:
    """只用 ffmpeg 读时长（本机常缺 ffprobe）。与 server/production/sourceWorkflow.probeFilm 同一套解析。"""
    r = subprocess.run([_ffmpeg(), "-hide_banner", "-i", str(path)], capture_output=True)
    text = (r.stderr or b"").decode("utf-8", "replace")
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", text)
    if not m:
        return 0.0
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))


def _tempo_chain(speed: float) -> str:
    """atempo 只支持 0.5–100，倍率大时串起来。"""
    parts = []
    rem = max(0.5, min(100.0, speed))
    while rem > 2.0 + 1e-6:
        parts.append("atempo=2.0")
        rem /= 2.0
    while rem < 0.5 + 1e-6:
        parts.append("atempo=0.5")
        rem /= 0.5
    parts.append(f"atempo={rem:.6f}")
    return ",".join(parts)


def _wipe_sfx(dest_dir: Path, stem: str, wipe_path: Path, duration_s: float) -> str | None:
    """把泡泡转场片源【自带的音效】按墙钟时长压速后导成 wav。

    权威实现见 手绘风格/kit/kit/render.py：`[wipe] atempo,volume=5.0,adelay` ——
    这段音效就是泡泡的声音，之前扩展只导视频、把音轨整条丢了。
    """
    src_dur = _media_duration(wipe_path)
    if src_dur <= 0.05:
        return None
    name = f"{stem}_sfx.wav"
    out = dest_dir / name
    cmd = [
        _ffmpeg(), "-y", "-v", "error", "-i", str(wipe_path), "-vn",
        "-filter:a", f"{_tempo_chain(src_dur / max(0.2, duration_s))},volume=5.0",
        "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le",
        str(out),
    ]
    p = subprocess.run(cmd, capture_output=True)
    if p.returncode != 0 or not out.is_file():
        print("wipe sfx fail", (p.stderr or b"")[-200:], flush=True)
        return None
    return name


def _bake_wipe_layers(frames: list[np.ndarray], n: int) -> list[np.ndarray]:
    """复刻 kit.render 的泡泡遮罩推进，并烘成宿主可叠的单层 RGBA。

    原片是：`frame = scene * cover` 压暗新画面，再把泡泡 `blit` 上去；
    泡泡 alpha 经 wipe_matte 膨胀+羽化后【累积】成 cover，随 u 推进逐渐揭开下一镜。
    要单层表达同一结果，令 out = scene*(1-A) + C*A，则
        A = 1 - cover*(1-a_b)          （cover=0 处整块不透明 → 画面先黑）
        C = rgb*a_b / A                （泡泡按原强度画上去）
    """
    cover = np.zeros((H, W), np.float32)
    out: list[np.ndarray] = []
    for i in range(n):
        u = i / max(1, n - 1)
        rgba = frames[i]
        matte = I.wipe_matte(rgba[:, :, 3], grow=22, blur=16.0)
        cover = np.maximum(cover, matte)
        base = I.smooth(min(1.0, u / 0.72))
        c = np.clip(np.maximum(cover, base * 0.35) + base * 0.45, 0.0, 1.0)
        a_b = rgba[:, :, 3].astype(np.float32) / 255.0
        alpha = 1.0 - c * (1.0 - a_b)
        layer = np.zeros((H, W, 4), np.float32)
        layer[:, :, 3] = alpha * 255.0
        nz = alpha > 1e-4
        layer[nz, :3] = rgba[nz, :3].astype(np.float32) * a_b[nz, None] / alpha[nz, None]
        out.append(np.clip(layer, 0.0, 255.0).astype(np.uint8))
    return out


def _wipe_overlay_layer(dest_dir: Path, stem: str, duration_s: float) -> dict | None:
    """开场→场景的泡泡遮罩转场：绿幕抠 + 去溢色 → 遮罩推进 → VP9 alpha WebM + 自带音效。"""
    wipe_path = A.ASSETS / "fx" / "bubble_wipe.mp4"
    if not wipe_path.is_file():
        print("wipe missing", wipe_path, flush=True)
        return None
    try:
        # 抠像缓存放工作目录，别放 assets/ —— 放包内会被打进 .todoext（曾把包从 72MB 撑到 216MB）
        cache = dest_dir.parent / "wipe_cache"
        frames = I.load_keyed_wipe(wipe_path, (W, H), cache_dir=cache)
    except Exception as e:
        print("wipe load fail", e, flush=True)
        return None
    if not frames:
        return None
    # 预览友好：满幅转场 15fps 足够看清泡泡
    wipe_fps = 15
    n = max(2, int(round(duration_s * wipe_fps)))
    idxs = [min(len(frames) - 1, int(i * (len(frames) - 1) / max(1, n - 1))) for i in range(n)]
    hold = dest_dir / f"{stem}_hold.png"
    video = _layer_video_path(dest_dir, stem)
    try:
        _encode_rgba_seq(_bake_wipe_layers([frames[i] for i in idxs], n), video, hold, fps=wipe_fps)
    except Exception as e:
        print("wipe encode fail", e, flush=True)
        return None
    el = {
        "id": stem,
        "label": "泡泡转场",
        "role": "accent",
        "video": video.name,
        "hold": hold.name,
        "crop": [0, 0, W, H],
        "enter": "play",
        "frames": n,
        "pinTiming": True,
    }
    sfx = _wipe_sfx(dest_dir, stem, wipe_path, duration_s)
    if not sfx:
        # 兜底：包内预抽的原始音轨。没做 atempo 压缩（4.01s 原速），但**保证有声音**，
        # 不会因为 ffmpeg 抽轨失败就静默变成"没有气泡音效"。
        fallback = A.ASSETS / "fx" / "bubble_wipe.wav"
        if fallback.is_file():
            dst = dest_dir / fallback.name
            try:
                if not dst.exists():
                    shutil.copyfile(fallback, dst)
                sfx = fallback.name
                print("wipe sfx fallback ->", fallback.name, flush=True)
            except OSError as e:
                print("wipe sfx fallback fail", e, flush=True)
    if sfx:
        el["sfx"] = sfx
    else:
        # 生成期就吵，别留到验收才发现时间轴没声音
        print("wipe sfx MISSING: no extracted track and no pack fallback", flush=True)
    return el


def _bubble_layers(layers: list, drawn: list, dest_dir: Path, stem_base: str, frames: int) -> list[dict]:
    out = []
    by_name: dict[str, list[dict]] = {}
    for d in drawn:
        by_name.setdefault(d["name"], []).append(d)
    used: dict[str, int] = {}
    for li, raw in enumerate(layers):
        text = bubble.speech_only(str(raw.get("say") or ""))
        if not text:
            continue
        name = str(raw.get("name") or "").strip()
        idx = used.get(name, 0)
        cands = by_name.get(name) or []
        if idx >= len(cands):
            continue
        d = cands[idx]
        used[name] = idx + 1
        sprite, tip = bubble.make_bubble(text)
        side = str(raw.get("say_side") or "auto")
        x, y = bubble.bubble_xy(d["box"], sprite.shape, tip, side)
        el = _sprite_layer(
            sprite, int(x), int(y), dest_dir, f"{stem_base}_bub{li}", frames,
            label=f"气泡:{text[:8]}", role="accent", enter="stamp", pad=12,
        )
        if el:
            el["sourceName"] = f"bubble:{name}"
            out.append(el)
    return out


def _stitch_boards(boards: list[dict], duration_ms: int) -> None:
    """镜间无空隙：从 0 铺到口播时长，元素 startMs 用绝对时间（宿主时间轴契约）。"""
    if not boards:
        return
    boards.sort(key=lambda b: int(b.get("startMs") or 0))
    boards[0]["startMs"] = 0
    for i in range(len(boards) - 1):
        boards[i]["endMs"] = int(boards[i + 1]["startMs"])
    boards[-1]["endMs"] = max(int(boards[-1]["endMs"]), int(duration_ms))
    for b in boards:
        start = int(b["startMs"])
        end = int(b["endMs"])
        if end <= start:
            end = start + 200
            b["endMs"] = end
        dur = end - start
        for el in b.get("elements") or []:
            if el.get("pinTiming"):
                # 转场等短层：保留自身 duration，只把起点钳到本 board
                el["startMs"] = max(start, int(el.get("startMs") or start))
                el["durationMs"] = max(200, min(int(el.get("durationMs") or dur), end - el["startMs"]))
                continue
            # 元素按**口播时刻**错开进场（原管线 _starts/enter_at 的语义）。
            # 这里以前无条件写 el["startMs"] = start，把每层的进场时刻拍平成"同时出现"——
            # 于是时间轴上看不到"元素一个接一个出现"，观感与原成片不一致。
            rel = int(el.get("enterAtMs") or 0) - start
            rel = max(0, min(rel, max(0, dur - 200)))
            el["startMs"] = start + rel
            el["durationMs"] = max(200, end - el["startMs"])


def export_editable_layers(timing: dict, plan: dict, render_out: Path) -> Path:
    """写出 render_out/layers/* 与 layers_manifest.json。"""
    dest = render_out / "layers"
    if dest.exists():
        for p in dest.iterdir():
            if p.is_file():
                p.unlink()
    dest.mkdir(parents=True, exist_ok=True)

    A.build(force=False, verbose=False)
    beach_path = A.BG / "plate_beach.jpg"
    beach = I.load_rgb(beach_path) if beach_path.is_file() else np.zeros((H, W, 3), np.uint8)
    shots = plan.get("shots") or []
    sentences = timing.get("sentences") or []
    intro_lines = list((plan.get("intro") or {}).get("lines") or [])
    boards = []
    enter_frames = max(4, int(FPS * 0.45))
    duration_ms = _voice_duration_ms(timing, sentences)

    for si, shot in enumerate(shots):
        t0, t1 = _shot_window(sentences, si)
        start_ms = int(round(t0 * 1000))
        end_ms = int(round(max(t1, t0 + 0.2) * 1000))
        mode = shot.get("mode", "scene")
        vis = str(shot.get("_visual") or "")
        elements = []
        stem_base = f"s{si:02d}"
        is_intro = si == 0 and (vis == "intro_red" or bool(intro_lines))

        if is_intro and intro_lines:
            # 与成片一致：先单行居中，再多行（加行距），不要三行同时糊满 5 秒
            sent0 = sentences[0] if sentences else {"start": 0, "end": end_ms / 1000}
            marks = _intro_marks(sent0, intro_lines)
            t_line2 = int(round(marks["line2_start"] * 1000))
            t_shatter = int(round(marks["shatter"] * 1000))
            title1 = typo.title_plate([intro_lines[0]], [H / 2])
            el1 = _intro_plate_layer(title1, dest, f"{stem_base}_intro1", enter_frames, label="开场红字")
            if el1:
                boards.append({
                    "shot": si, "mode": "intro",
                    "startMs": start_ms, "endMs": max(start_ms + 200, t_line2),
                    "elements": [el1],
                })
            if len(intro_lines) > 1:
                rest = intro_lines[1:3]
                # 行距拉开，减轻拥挤（成片后段也是分行，不是挤在一起）
                centres = [360, 720] if len(rest) > 1 else [H / 2]
                title2 = typo.title_plate(rest, centres)
                el2 = _intro_plate_layer(title2, dest, f"{stem_base}_intro2", enter_frames, label="开场红字")
                if el2:
                    boards.append({
                        "shot": si, "mode": "intro",
                        "startMs": max(start_ms + 200, t_line2),
                        "endMs": max(t_line2 + 200, t_shatter),
                        "elements": [el2],
                    })
            # 碎裂→黑场段：纯黑底板，接到下一镜（泡泡转场揭开）
            black = _black_bg(dest, f"{stem_base}_intro_black", enter_frames)
            boards.append({
                "shot": si, "mode": "intro",
                "startMs": max(t_shatter, start_ms + 400),
                "endMs": end_ms,
                "elements": [black],
            })
            continue
        elif mode == "scene":
            elements.append(_bg_layer(beach, dest, f"{stem_base}_bg", enter_frames))
            layers = shot.get("layers") or []
            drawn = []
            if layers:
                drawn = _settled_boxes(layers)
                by_name = {d["name"]: d for d in drawn if d.get("settled")}
                for li, raw in enumerate(layers):
                    name = str(raw.get("name") or "")
                    meta = by_name.get(name)
                    if not meta:
                        continue
                    fx = str(meta.get("fx") or raw.get("fx") or "fade")
                    el = _cut_layer(name, meta["box"], dest, f"{stem_base}_e{li}_{name}"[:48], enter_frames, fx)
                    if el:
                        # 记住这一层的口播进场时刻，_stitch_boards 会把它落成绝对起点
                        ea = raw.get("enter_at")
                        if ea is not None:
                            try:
                                el["enterAtMs"] = int(round(float(ea) * 1000))
                            except (TypeError, ValueError):
                                pass
                        elements.append(el)
                for bub in _bubble_layers(layers, drawn, dest, stem_base, enter_frames):
                    elements.append(bub)
            hz = _huazi_layer(
                shot,
                str(sentences[si].get("text") if si < len(sentences) else ""),
                dest,
                f"{stem_base}_huazi",
                enter_frames,
            )
            if hz:
                elements.append(hz)
            # 首个非 intro 场景：叠泡泡遮罩转场（与成片 INTRO_WIPE_DUR=2s 对齐）
            if intro_lines and si == 1:
                wipe = _wipe_overlay_layer(dest, f"{stem_base}_wipe", 2.0)
                if wipe:
                    wipe["startMs"] = start_ms
                    wipe["durationMs"] = 2000
                    # 音效已在 _wipe_overlay_layer 里由 _wipe_sfx() 从 bubble_wipe.mp4 抽好
                    # （atempo 压到墙钟 2s + volume=5.0，与 kit/render.py 第 732-763 行的权威实现同参），
                    # 文件名是 <stem>_sfx.wav。宿主 bindLayerBoards 会把它收进产物目录并落到独立音轨。
                    #
                    # 这里曾经**再**从包内复制一份 bubble_wipe.mp4 覆盖 wipe["sfx"] —— 后果是
                    # 时间轴拿到的是 4.01s 的原始 AAC 视频当音效：既没有压速/增益，前端 `<audio>`
                    # 也解不了裸 mp4，于是"气泡转场音效缺失"。不要在生成器之后改写同一个键。
                    elements.append(wipe)
        elif mode == "card":
            lines = shot.get("text") if isinstance(shot.get("text"), list) else [str(shot.get("text") or "")]
            try:
                labels = [typo.card_line(line, int(H * typo.CAP)) for line in lines if line]
                if labels:
                    # 卡片 = 虚化变暗的主体/道具 + 黄字。
                    # 这里原来**只把黄字做成图层**，从没调用过 card_backdrop，于是时间轴上的
                    # 卡片镜头缺了背后那层虚化元素（成片里有 → 看片就是"少一层"）✗
                    # 用渲染侧同一个 card_backdrop 合成，保证时间轴与成片一致。
                    from . import render as _R

                    plate = np.zeros((H, W, 4), np.uint8)
                    try:
                        back = _R.card_backdrop(
                            shot.get("figure"), shot.get("icon"), float(shot.get("dim", _R.CARD_DIM))
                        )
                    except Exception as _e:
                        back = None
                        print("card backdrop skip", _e, flush=True)
                    if back is not None:
                        I.blit(plate, back, (W - back.shape[1]) / 2, H * 0.5 + 30 - back.shape[0] / 2, 1.0)
                    total_h = sum(im.shape[0] for im in labels) + 12 * max(0, len(labels) - 1)
                    y = (H - total_h) // 2
                    tx0, tx1 = W, 0
                    for im in labels:
                        x = (W - im.shape[1]) // 2
                        I.blit(plate, im, x, y)
                        tx0 = min(tx0, x)
                        tx1 = max(tx1, x + im.shape[1])
                        y += im.shape[0] + 12
                    ys, xs = np.where(plate[..., 3] > 8)
                    if xs.size == 0:
                        raise ValueError("卡片图层为空")
                    y0 = max(0, int(ys.min()) - 16)
                    y1 = min(H, int(ys.max()) + 17)
                    x0 = max(0, min(int(xs.min()), tx0) - 16)
                    x1 = min(W, max(int(xs.max()), tx1) + 16)
                    crop = plate[y0:y1, x0:x1]
                    el = _sprite_layer(
                        crop, x0, y0, dest, f"{stem_base}_card", enter_frames,
                        label="黄卡", role="accent", enter="stamp", pad=8,
                    )
                    if el:
                        elements.append(el)
            except Exception as e:
                print("card layer skip", e, flush=True)

        # 相对时长先写；_stitch_boards 再改成绝对 startMs（pinTiming 已是绝对时间，勿再加板起点）
        if elements:
            dur = end_ms - start_ms
            for el in elements:
                if el.get("pinTiming"):
                    continue
                el["startMs"] = 0
                el["durationMs"] = dur
            boards.append({
                "shot": si,
                "mode": "intro" if is_intro else mode,
                "startMs": start_ms,
                "endMs": end_ms,
                "elements": elements,
            })

    _stitch_boards(boards, duration_ms)

    manifest = {
        "version": 1,
        "fps": FPS,
        "width": W,
        "height": H,
        "dir": "layers",
        "durationMs": duration_ms,
        "boards": boards,
    }
    path = render_out / "layers_manifest.json"
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        "layers_manifest", path,
        "boards", len(boards),
        "elements", sum(len(b["elements"]) for b in boards),
        "span", f"{boards[0]['startMs'] if boards else 0}-{boards[-1]['endMs'] if boards else 0}",
        flush=True,
    )
    return path
