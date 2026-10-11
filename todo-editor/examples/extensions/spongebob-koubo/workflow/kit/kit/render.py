"""Assemble the film: background, staged scenes, cards, dips, subtitles, finished.

One sentence is one beat. A beat is either a card (big yellow type across a dimmed
figure, the example's "make this land" mode) or a scene (elements staged on the
beach, the example's "show this" mode). The director decides which; this module
renders whichever it is and stitches the beats together.
"""
from __future__ import annotations

import json
import math
import os
import re
import subprocess
import wave
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

from . import assets as A
from . import bubble
from . import gpu as G
from . import imaging as I

_FFMPEG = I.ffmpeg_bin()
_FFPROBE = I.ffprobe_bin()
from . import stage
from . import typo

W, H, FPS = I.W, I.H, I.FPS
SR = 24000
CARD_DIM = 0.68
END_DIM = 0.85
DIP_OUT, DIP_IN = 0.14, 0.26
TO_CARD_DIP = 0.26
CARD_BLACK, CARD_IN = 0.06, 0.16
INTRO_SECONDS = 1.8
# 开场后绿幕泡泡遮罩转场：片源按 INTRO_WIPE_DUR 墙钟秒播完（会加速）
INTRO_WIPE_DUR = 2.0
import os as _os
_assets = Path(_os.environ["KOUBO_KIT_ASSETS"]) if _os.environ.get("KOUBO_KIT_ASSETS") else (Path(__file__).resolve().parents[1] / "assets")
INTRO_WIPE = _assets / "fx" / "bubble_wipe.mp4"


def _video_encoder_args():
    """Prefer NVENC when ffmpeg + GPU expose it; else libx264.

    KOUBO_CPU=1 时强制 libx264（规避部分环境 NVENC stdin 写帧 Invalid argument）。
    """
    import os

    preset = os.environ.get("KOUBO_X264_PRESET", "veryfast").strip() or "veryfast"
    crf = os.environ.get("KOUBO_X264_CRF", "20").strip() or "20"
    cpu = ["-c:v", "libx264", "-preset", preset, "-crf", crf, "-pix_fmt", "yuv420p"]
    if os.environ.get("KOUBO_CPU", "").strip().lower() in ("1", "true", "yes"):
        return cpu
    try:
        probe = subprocess.run(
            [_FFMPEG, "-hide_banner", "-encoders"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if "h264_nvenc" not in (probe.stdout or ""):
            return cpu
        # 驱动 API 落后时 ffmpeg 仍列出 nvenc，开编会立刻 Invalid argument
        smoke = subprocess.run(
            [
                _FFMPEG, "-hide_banner", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=0.04",
                "-frames:v", "1", "-c:v", "h264_nvenc", "-f", "null", "-",
            ],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if smoke.returncode != 0:
            print("nvenc smoke failed → libx264", preset, "crf", crf, flush=True)
            return cpu
        return ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "19", "-b:v", "0"]
    except OSError:
        pass
    return cpu


# ------------------------------------------------------------------- sfx ----

def _tone(kind):
    rng = np.random.default_rng({"whoosh": 3, "hit": 5, "tick": 7, "clink": 9, "pop": 11}[kind])
    if kind == "whoosh":
        n = int(SR * 0.46)
        noise = rng.normal(0, 1, n).astype(np.float32)
        acc, y = 0.0, np.empty(n, np.float32)
        for i in range(n):
            acc += (0.04 + 0.55 * (i / n) ** 1.4) * (noise[i] - acc)
            y[i] = acc
        return y * (np.sin(np.linspace(0, math.pi, n)) ** 1.15) * 0.62
    if kind == "hit":
        n = int(SR * 0.22)
        t = np.arange(n) / SR
        env = np.exp(-t * 18)
        return ((np.sin(2 * math.pi * 78 * t) + 0.35 * np.sin(2 * math.pi * 156 * t)) * env).astype(np.float32) * 0.7
    if kind == "tick":
        n = int(SR * 0.09)
        t = np.arange(n) / SR
        return (np.sin(2 * math.pi * 210 * t) * np.exp(-t * 40)).astype(np.float32) * 0.35
    if kind == "clink":
        n = int(SR * 0.28)
        y = np.zeros(n, np.float32)
        for delay, freq in ((0.0, 1680), (0.055, 2100), (0.11, 1420)):
            start = int(delay * SR)
            t = np.arange(n - start) / SR
            env = np.exp(-t * 28)
            y[start:] += (np.sin(2 * math.pi * freq * t) + 0.25 * np.sin(2 * math.pi * freq * 2.02 * t)) * env
        return y * 0.45
    n = int(SR * 0.12)
    env = np.exp(-np.arange(n) / SR * 36)
    return rng.normal(0, 1, n).astype(np.float32) * env * 0.4


def sfx_track(events, duration):
    buf = np.zeros(int((duration + 0.2) * SR), np.float32)
    tones = {k: _tone(k) for k in ("whoosh", "hit", "tick", "clink", "pop")}
    for t, kind in events:
        tone = tones.get(kind)
        if tone is None:
            continue
        i = max(0, int(t * SR))
        j = min(len(buf), i + len(tone))
        if j > i:
            buf[i:j] += tone[: j - i]
    peak = float(np.max(np.abs(buf))) if buf.size else 0.0
    if peak > 0.9:
        buf *= 0.9 / peak
    return buf


def write_wav(path, data):
    pcm = (np.clip(data, -1, 1) * 32767).astype(np.int16)
    with wave.open(str(path), "w") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SR)
        handle.writeframes(pcm.tobytes())


# ----------------------------------------------------------------- cards ----

CARD_GROUP_H = 0.60
CARD_BLUR = 2.5
_backdrop_cache = {}


def card_backdrop(figure, icon, dim):
    """The figure (and its prop) the card sits on: big, centred, blurred and dimmed.

    The example never puts the prop beside the type; it is part of the dimmed
    picture behind it, up and to the right of the figure.
    """
    key = (figure, icon, round(dim, 3))
    if key in _backdrop_cache:
        return _backdrop_cache[key]
    fig = A.element(figure) if figure else None
    ico = A.element(icon) if icon else None
    if fig is None and ico is None:
        _backdrop_cache[key] = None
        return None
    target_h = H * CARD_GROUP_H
    parts = []
    if fig is not None:
        fig = I.resize(fig, target_h / fig.shape[0])
        parts.append((fig, 0.0, 0.0))
    if ico is not None:
        k = (target_h * (0.42 if fig is not None else 0.8)) / ico.shape[0]
        ico = I.resize(ico, k)
        if fig is not None:
            parts.append((ico, fig.shape[1] * 0.78, -target_h * 0.06))
        else:
            parts.append((ico, 0.0, 0.0))
    x0 = min(px for _s, px, _py in parts)
    y0 = min(py for _s, _px, py in parts)
    x1 = max(px + s.shape[1] for s, px, _py in parts)
    y1 = max(py + s.shape[0] for s, _px, py in parts)
    pad = int(CARD_BLUR * 4)
    group = np.zeros((int(y1 - y0) + pad * 2, int(x1 - x0) + pad * 2, 4), np.uint8)
    for s, px, py in parts:
        I.blit(group, s, px - x0 + pad, py - y0 + pad, 1.0)
    if group.shape[1] > W * 0.86:
        group = I.resize(group, W * 0.86 / group.shape[1])
    img = Image.fromarray(group, "RGBA").filter(ImageFilter.GaussianBlur(CARD_BLUR))
    group = np.array(img)
    group[:, :, :3] = (group[:, :, :3].astype(np.float32) * dim).astype(np.uint8)
    _backdrop_cache[key] = group
    return group


def draw_card(frame, shot, text_alpha=1.0):
    """Yellow type centred on the frame, across a dimmed, blurred figure."""
    lines = shot.get("text") or []
    if isinstance(lines, str):
        lines = [lines]
    cap = int(H * typo.CAP)
    labels = [typo.card_line(line, cap) for line in lines if line]
    if not labels:
        return []
    widest = max(l.shape[1] for l in labels)
    if widest > W * 0.92:
        k = W * 0.92 / widest
        labels = [I.resize(l, k) for l in labels]
    pitch = typo.pitch_for(cap)
    text_h = sum(l.shape[0] for l in labels) + pitch * (len(labels) - 1)
    text_w = max(l.shape[1] for l in labels)

    drawn = []
    dim = float(shot.get("dim", CARD_DIM))
    back = card_backdrop(shot.get("figure"), shot.get("icon"), dim)
    if back is not None:
        bx = (W - back.shape[1]) / 2
        by = H * 0.5 + 30 - back.shape[0] / 2
        I.blit(frame, back, bx, by, 1.0)
        drawn.append({"name": shot.get("figure") or shot.get("icon"),
                      "box": (bx, by, back.shape[1], back.shape[0]), "alpha": 1.0})

    top = H * 0.5 - text_h / 2
    tx = (W - text_w) / 2
    y = top
    for lab in labels:
        I.blit(frame, lab, tx + (text_w - lab.shape[1]) / 2, y, text_alpha)
        y += lab.shape[0] + pitch
    drawn.append({"name": "text", "box": (tx, top, text_w, text_h), "alpha": text_alpha})
    return drawn


# ------------------------------------------------------------------ film ----

# 镜头运镜：整幅（背景+角色）推/拉/横移，相邻镜头轮换，避免全片一个死机位
SHOT_MOVES = (
    ((1.00, 0.50, 0.52), (1.09, 0.50, 0.46)),   # 推近（略上抬到脸）
    ((1.07, 0.44, 0.50), (1.07, 0.56, 0.50)),   # 右移
    ((1.10, 0.50, 0.47), (1.01, 0.50, 0.50)),   # 拉远
    ((1.07, 0.56, 0.50), (1.07, 0.44, 0.50)),   # 左移
    ((1.02, 0.47, 0.50), (1.10, 0.53, 0.48)),   # 斜推
)


def shot_cam(idx, u):
    """把整幅运镜折进背景 camera 的 zoom/pan，避免每帧再 warpAffine 一次成片。"""
    (s0, x0, y0), (s1, x1, y1) = SHOT_MOVES[idx % len(SHOT_MOVES)]
    e = I.smooth(max(0.0, min(1.0, u)))
    s = s0 + (s1 - s0) * e
    return max(0.0, s - 1.0), ((x1 - x0) * e * 0.35, (y1 - y0) * e * 0.35)


def shot_move(frame, drawn, idx, u):
    """兼容旧调用：运镜已并入 camera，这里直接返回。"""
    return frame, drawn


def render_film(timing, plan, out_path, workdir, preview=False, log=print, intro_seconds=None):
    """Render the whole thing and mux the narration and stingers back on."""
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    sentences = timing["sentences"]
    body = float(timing.get("duration") or sentences[-1]["end"]) + 0.35
    shots = plan["shots"]

    beach = I.load_rgb(A.BG / "plate_beach.jpg")
    intro = plan.get("intro") or {}
    intro_lines = intro.get("lines") or []
    # pre>0：片头静音预滚（旧行为）。koubo 传 intro_seconds=0，红字叠在第 0 句口播上同步出声。
    pre = float(intro_seconds if intro_seconds is not None else (1.8 if intro_lines else 0.0))
    title1 = title2 = None
    parts = []
    if intro_lines:
        title1 = typo.title_plate([intro_lines[0]], [I.H / 2])
        if len(intro_lines) > 1:
            rest = intro_lines[1:3]
            title2 = typo.title_plate(rest, [422, 658] if len(rest) > 1 else [I.H / 2])
            parts = typo.shatter_parts(title2)
        else:
            title2 = title1
            parts = typo.shatter_parts(title2)
    duration = pre + body
    street = None
    busy = A.BG / "plate_street.jpg"
    if busy.exists():
        blurred = Image.open(busy).convert("RGB").resize((W, H), Image.Resampling.LANCZOS)
        street = np.array(blurred.filter(ImageFilter.GaussianBlur(14)))

    def street_blur(amount):
        if street is None:
            return np.zeros((H, W, 3), np.uint8)
        return I.zoom_blur(street, amount)

    nframes = int(round((pre + body) * FPS))
    silent = workdir / "silent.mp4"
    canvas = G.get_canvas(W, H)
    venc = _video_encoder_args()
    log(f"  compose={'cuda' if canvas is not None else 'cpu'}  encode={venc[1]}")
    err = open(workdir / "ffmpeg_video.txt", "w", encoding="utf-8")
    proc = subprocess.Popen(
        [_FFMPEG, "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS),
         "-i", "-", "-an", *venc, "-pix_fmt", "yuv420p",
         "-movflags", "+faststart", str(silent)],
        stdin=subprocess.PIPE, stderr=err,
    )
    preview_dir = workdir / "preview"
    if preview:
        preview_dir.mkdir(exist_ok=True)
        for stale in preview_dir.glob("f_*.jpg"):
            stale.unlink()
    # Sample in *film* time. The title pre-roll shifts every beat later, so sampling
    # on the audio timeline here lands the stills 1.8 s early -- inside the entrance,
    # which reads as an element hanging off the frame when it is only sliding in.
    sample_frames = {
        int((pre + s["start"] + (s["end"] - s["start"]) * 0.62) * FPS) for s in sentences
    }
    # 气泡只在台词短语里出现：每条台词在其短语中点额外抽一帧，验收才能看到气泡
    for s, sh in zip(sentences, shots):
        phr = s.get("phrases") or []
        for L in sh.get("layers") or []:
            if L.get("say") and phr:
                p = phr[min(int(L.get("say_at") or 0), len(phr) - 1)]
                sample_frames.add(int((pre + (p["start"] + p["end"]) / 2 + 0.25) * FPS))

    events = []
    for s in sentences:
        if s.get("cue"):
            events.append((float(s["start"]) + 0.04, s["cue"]))
    sfx = sfx_track(events, duration)
    write_wav(workdir / "sfx.wav", sfx)

    layout_log = []
    last_scene = None
    shot_of = {}
    wipe_frames = []
    wipe_cover = np.zeros((H, W), np.float32)
    if INTRO_WIPE.is_file() and intro_lines and sentences and len(sentences) > 1:
        log(f"  keying intro wipe {INTRO_WIPE.name}…")
        # 缓存写工作目录：写进 assets/ 会随扩展包一起发出去（曾撑到 137MB）
        wipe_frames = I.load_keyed_wipe(INTRO_WIPE, (W, H), cache_dir=Path(workdir) / "wipe_cache")
        log(f"  wipe frames {len(wipe_frames)}")
    intro_wipe_t0 = float(sentences[1]["start"]) if wipe_frames and len(sentences) > 1 else None

    def shot_at(t):
        cur = sentences[0]
        if t < cur["start"]:
            return 0, cur
        for i, s in enumerate(sentences):
            if t < s["start"]:
                return i - 1, sentences[i - 1]
            cur = s
            if s["start"] <= t < s["end"]:
                return i, s
        return len(sentences) - 1, cur

    def phrase_state(sentence, t):
        phrases = sentence.get("phrases") or []
        if not phrases:
            return 0, t - sentence["start"]
        idx = 0
        for i, p in enumerate(phrases):
            if t >= p["start"]:
                idx = i
        return idx, t - phrases[idx]["start"]

    def phrase_text(sentence, t):
        phrases = sentence.get("phrases") or []
        if not phrases:
            return sentence["text"]
        for p in phrases:
            if p["start"] <= t < p["end"] + 0.02:
                return p["text"]
        return phrases[-1]["text"]

    def spoken_chars(sentence):
        """字级时间轴（去掉标点），供红字/入画对齐口播。"""
        out = []
        for p in sentence.get("phrases") or []:
            for c in p.get("chars") or []:
                ch = str(c.get("text") or "")
                if not ch or ch in "，。！？；、,.!?\"'":
                    continue
                out.append(c)
        return out

    def match_line_end(chars, line):
        """顺序匹配一行红字，返回该行念完时的字下标。

        开场红字可能是繁体（显示），口播 timing 仍是简体——两侧都经 title_trad 再比。
        """
        body = typo.title_trad(re.sub(r"[，。！？；,\s]", "", line or ""))
        if not body or not chars:
            return None
        i = 0
        for j, c in enumerate(chars):
            if typo.title_trad(str(c.get("text") or "")) == body[i]:
                i += 1
                if i >= len(body):
                    return j
        return None

    def intro_marks(sentence, lines):
        """用字级时间戳定红字切换与碎裂起点；无 chars 时回退比例。"""
        start = float(sentence["start"])
        end = float(sentence["end"])
        span = max(0.4, end - start)
        chars = spoken_chars(sentence)
        line1_end_t = start + span * 0.33
        line2_start_t = start + span * 0.33
        shatter_t = end - min(0.48, span * 0.22)
        if chars and lines:
            j1 = match_line_end(chars, lines[0])
            if j1 is not None:
                line1_end_t = float(chars[j1]["end"])
                if len(lines) > 1 and j1 + 1 < len(chars):
                    line2_start_t = float(chars[j1 + 1]["start"])
                else:
                    line2_start_t = line1_end_t
            if len(lines) > 1:
                j2 = match_line_end(chars[j1 + 1 :] if j1 is not None else chars, "".join(lines[1:]))
                if j2 is not None:
                    base = (j1 + 1) if j1 is not None else 0
                    shatter_t = max(line2_start_t + 0.12, float(chars[base + j2]["end"]))
            shatter_t = min(shatter_t, end - 0.08)
            # 碎裂窗口至少 0.28s，避免贴句尾闪一下
            if end - shatter_t < 0.28:
                shatter_t = end - 0.28
        return {
            "line1_end": line1_end_t,
            "line2_start": line2_start_t,
            "shatter": shatter_t,
            "end": end,
            "fade_in": 0.16,
        }

    intro_sync_marks = None
    if intro_lines and sentences:
        intro_sync_marks = intro_marks(sentences[0], intro_lines)

    for n in range(nframes):
        t_film = n / FPS
        t = t_film - pre
        frame = np.zeros((H, W, 3), np.uint8)

        if t < 0:
            # Pre-roll titles, then the letters shatter into the first shot.
            u = -t / pre if pre else 1.0
            if title1 is not None and u < 0.45:
                I.blit(frame, title1, 0, 0, I.smooth(u / 0.18))
            elif title2 is not None and u < 0.86:
                I.blit(frame, title2, 0, 0, 1.0)
            elif title2 is not None:
                k = (u - 0.86) / 0.14
                frame = street_blur(0.30 * (1 - k) ** 0.8).copy()
                typo.draw_parts(frame, parts, k)
                flash = math.exp(-((k - 0.28) / 0.16) ** 2) * 0.7
                if flash > 0.04:
                    frame = (frame.astype(np.float32) * (1 - flash) + 255 * flash).astype(np.uint8)
            if preview and n in sample_frames:
                layout_log.append({"t": round(t_film, 2), "mode": "intro", "layers": []})
            if os.environ.get("KOUBO_FAST", "").strip().lower() not in ("1", "true", "yes"):
                frame = I.grain(I.grade(frame, 0.10), 2.0, n)
            if preview and n in sample_frames:
                Image.fromarray(frame).save(preview_dir / f"f_{n:04d}.jpg", quality=88)
            proc.stdin.write(frame.tobytes())
            continue

        idx, beat = shot_at(t)
        shot = shots[idx] if idx < len(shots) else {"mode": "card", "text": [""]}
        mode = shot.get("mode", "scene")
        local = t - beat["start"]
        span = max(0.4, beat["end"] - beat["start"])
        prev_mode = shots[idx - 1].get("mode", "scene") if idx > 0 else None

        # 第 0 句 + 无静音预滚：红字按字级时间戳跟口播，后段碎裂进海滩
        intro_synced = (
            pre <= 0
            and idx == 0
            and bool(intro_lines)
            and title1 is not None
            and intro_sync_marks is not None
        )
        # 开场红字占满第 0 句后，若再播一遍「角色进海滩」往往只剩 0.2–0.4s，
        # 观感就是红字后闪一下又切走。碎裂后落到空海滩，并一直撑到下一句再压黑交接。
        next_after_intro = (
            float(sentences[1]["start"]) if intro_synced and len(sentences) > 1 else None
        )
        if intro_synced and t < intro_sync_marks["shatter"]:
            marks = intro_sync_marks
            frame = np.zeros((H, W, 3), np.uint8)
            voice0 = float(beat["start"])
            if t < voice0:
                pass
            elif t < marks["line2_start"] or title2 is None:
                fade = I.smooth(min(1.0, max(0.0, (t - voice0) / marks["fade_in"])))
                I.blit(frame, title1, 0, 0, fade)
            else:
                I.blit(frame, title2, 0, 0, 1.0)
            if preview and n in sample_frames:
                layout_log.append({"t": round(t, 2), "mode": "intro_sync", "layers": []})
            if os.environ.get("KOUBO_FAST", "").strip().lower() not in ("1", "true", "yes"):
                frame = I.grain(I.grade(frame, 0.10), 2.0, n)
            if preview and n in sample_frames:
                Image.fromarray(frame).save(preview_dir / f"f_{n:04d}.jpg", quality=88)
            proc.stdin.write(np.ascontiguousarray(frame, dtype=np.uint8).tobytes())
            continue
        if intro_synced and next_after_intro is not None and t < next_after_intro:
            marks = intro_sync_marks
            shatter_span = max(0.01, marks["end"] - marks["shatter"])
            k = min(1.0, (t - marks["shatter"]) / shatter_span)
            # 碎裂 → 黑场：粒子在暗底上散开，不露出海滩/角色（否则只亮 0.3s 又切走）
            frame = np.zeros((H, W, 3), np.uint8)
            if k < 1.0:
                if street is not None:
                    # 极暗底，只为碎裂有一点景深，不读成「空镜闪一下」
                    dim = street_blur(0.22 * (1 - k) ** 0.8)
                    frame = (dim.astype(np.float32) * (0.18 * (1 - k))).astype(np.uint8)
                if parts:
                    typo.draw_parts(frame, parts, k)
                flash = math.exp(-((k - 0.22) / 0.14) ** 2) * 0.4
                if flash > 0.04:
                    frame = (frame.astype(np.float32) * (1 - flash) + 255 * flash).astype(np.uint8)
                if k > 0.55:
                    w = I.smooth((k - 0.55) / 0.45)
                    frame = (frame.astype(np.float32) * (1.0 - w)).astype(np.uint8)
            last_scene = None
            if preview and n in sample_frames:
                layout_log.append({"t": round(t, 2), "mode": "intro_land", "layers": []})
            if os.environ.get("KOUBO_FAST", "").strip().lower() not in ("1", "true", "yes"):
                frame = I.grain(I.grade(frame, 0.10), 2.0, n)
            if preview and n in sample_frames:
                Image.fromarray(frame).save(preview_dir / f"f_{n:04d}.jpg", quality=88)
            proc.stdin.write(np.ascontiguousarray(frame, dtype=np.uint8).tobytes())
            continue

        if mode == "scene":
            cam = shot.get("camera") or {}
            u = min(1.0, max(0.0, local / span))
            zoom = float(cam.get("zoom", 0.022))
            pan = tuple(cam.get("pan", (0.008, 0.002)))
            # 镜头级运镜并进背景推拉（替代整幅二次变形）
            mz, mp = shot_cam(idx, u)
            zoom = zoom + mz
            pan = (pan[0] + mp[0], pan[1] + mp[1])
            from_card = prev_mode == "card" or (idx == 0 and not intro_synced)
            from_intro = idx == 1 and bool(intro_lines) and pre <= 0
            # 开场后第一句：不走「scene→scene 压黑叠溶」（没有可溶的上一镜角色）
            switching_scene = idx > 0 and prev_mode == "scene" and not from_intro
            # 句间空隙：仍挂在上一镜，用句尾时间做 local，避免空隙里再播一遍入场
            in_gap = t >= float(beat["end"])
            elapsed = local if not in_gap else max(local, span)
            dipping = (
                switching_scene
                and last_scene is not None
                and not in_gap
                and local < DIP_OUT + DIP_IN
            )
            if dipping and local < DIP_OUT:
                frame = (last_scene.astype(np.float32) * (1 - local / DIP_OUT)).astype(np.uint8)
            else:
                p_idx, p_t = phrase_state(beat, t)
                layers = shot.get("layers") or []
                if canvas is not None:
                    canvas.camera(beach, u, zoom, pan)
                    drawn = stage.draw_shot(
                        None, layers, p_idx, p_t, elapsed, t_abs=t, canvas=canvas
                    )
                    frame = canvas.download()
                else:
                    frame = I.camera(beach, u, zoom, pan).copy()
                    drawn = stage.draw_shot(frame, layers, p_idx, p_t, elapsed, t_abs=t)
                frame, drawn = shot_move(frame, drawn, idx, min(1.0, elapsed / span))
                bubbles = bubble.attach(frame, layers, drawn, p_idx, p_t)
                if bubbles:
                    drawn = list(drawn) + bubbles
                # emphasis / stamp 花字（shot.text 为 dict；card 的 text 是 list，不走这里）
                text_spec = shot.get("text")
                vis = str(shot.get("_visual") or "")
                if isinstance(text_spec, dict) and text_spec.get("content"):
                    if vis == "stamp" or str(text_spec.get("zone") or "") == "center_full":
                        frame = (frame.astype(np.float32) * 0.78).astype(np.uint8)
                    hz = typo.place_huazi(frame, text_spec, p_idx, p_t,
                                          narration=str(beat.get("text") or ""))
                    if hz:
                        drawn = list(drawn) + [hz]
                # 底部字幕常驻（参考版式）：标题花字在顶部、气泡贴角色，三者不抢位置
                sub_text = "" if in_gap else phrase_text(beat, t)
                if sub_text:
                    typo.place_subtitle(frame, sub_text)
                if from_intro and wipe_frames and intro_wipe_t0 is not None and not in_gap:
                    u_wipe = (t - intro_wipe_t0) / max(0.01, INTRO_WIPE_DUR)
                    if 0.0 <= u_wipe < 1.0:
                        fi = min(len(wipe_frames) - 1, int(u_wipe * (len(wipe_frames) - 1)))
                        rgba = wipe_frames[fi]
                        matte = I.wipe_matte(rgba[:, :, 3], grow=22, blur=16.0)
                        wipe_cover = np.maximum(wipe_cover, matte)
                        # 泡泡遮罩揭开下一镜；整体曲线兜底保证收尾全亮
                        base = I.smooth(min(1.0, u_wipe / 0.72))
                        cover = np.clip(np.maximum(wipe_cover, base * 0.35) + base * 0.45, 0.0, 1.0)
                        scene = frame.astype(np.float32)
                        frame = (scene * cover[:, :, None]).astype(np.uint8)
                        I.blit(frame, rgba, 0, 0, 1.0)
                    elif u_wipe >= 1.0 and wipe_cover.max() < 0.99:
                        # 转场结束后若遮罩未盖满，直接切满
                        pass
                elif (from_card or from_intro) and local < 0.30 and not in_gap:
                    frame = (frame.astype(np.float32) * I.smooth(local / 0.30)).astype(np.uint8)
                if dipping:
                    w = I.smooth((local - DIP_OUT) / DIP_IN)
                    frame = (frame.astype(np.float32) * w).astype(np.uint8)
                next_is_card = idx + 1 < len(shots) and shots[idx + 1].get("mode") == "card"
                if next_is_card:
                    next_start = float(sentences[idx + 1]["start"])
                    left = next_start - t
                    if left < TO_CARD_DIP:
                        w = I.smooth(max(0.0, left) / TO_CARD_DIP)
                        frame = (frame.astype(np.float32) * w).astype(np.uint8)
                if not dipping and local > 0.34:
                    last_scene = frame.copy()
                if n in sample_frames:
                    layout_log.append({"t": round(t, 2), "mode": mode, "shot": idx,
                                       "subtitle": sub_text, "layers": drawn})
        else:
            # 黄字卡：禁止「先压黑 → 再淡入 → 又压黑」的二次黑闪。
            # 进：与上一镜海滩交叉溶解；出：拖到下一镜前再淡；句间空隙稳住黄字。
            in_gap = t >= float(beat["end"])
            next_start = (
                float(sentences[idx + 1]["start"])
                if idx + 1 < len(sentences)
                else float(beat["end"])
            )
            # 卡片占用到下一句起点（含气口），避免句尾压黑后空隙里又弹回
            hold_end = max(float(beat["end"]), next_start)
            hold_span = max(0.25, hold_end - float(beat["start"]))
            local_hold = t - float(beat["start"])
            # 短卡压缩过渡，给黄字留可见时间
            in_t = min(CARD_IN, hold_span * 0.22)
            out_t = min(0.20, hold_span * 0.18)

            shot_draw = dict(shot)
            phrases = beat.get("phrases") or []
            if phrases:
                p_idx, _p_t = phrase_state(beat, t)
                raw = str(phrases[min(p_idx, len(phrases) - 1)].get("text") or "").strip()
                raw = re.sub(r"[，。！？；,、]", "", raw)
                shot_draw["text"] = typo.wrap_card(raw)

            frame = np.zeros((H, W, 3), np.uint8)
            drawn = draw_card(frame, shot_draw)
            last_scene = None
            # 示例：上一镜先压到全黑（在实景那一侧做完），黄字卡再从黑里亮起。
            # 不与实景交叉溶解，否则黄字会以残影叠在海滩上。
            if local_hold < CARD_BLACK + in_t:
                w = I.smooth((local_hold - CARD_BLACK) / max(0.01, in_t))
                frame = (frame.astype(np.float32) * w).astype(np.uint8)

            # 只在「下一镜将至」的尾巴淡出；口播段 + 气口中段保持满亮度
            fade_start = hold_span - out_t
            if local_hold > fade_start:
                fade = max(0.0, 1.0 - (local_hold - fade_start) / max(0.01, out_t))
                frame = (frame.astype(np.float32) * fade).astype(np.uint8)

            if n in sample_frames:
                layout_log.append(
                    {
                        "t": round(t, 2),
                        "mode": "card",
                        "shot": idx,
                        "layers": drawn,
                        "in_gap": in_gap,
                        "hold_span": round(hold_span, 3),
                    }
                )

        if os.environ.get("KOUBO_FAST", "").strip().lower() not in ("1", "true", "yes"):
            frame = I.grain(I.grade(frame, 0.10), 2.0, n)
        if preview and n in sample_frames:
            Image.fromarray(frame).save(preview_dir / f"f_{n:04d}.jpg", quality=88)
        # Windows 管道：必须 C-contiguous uint8，否则偶发写坏 NAL / 前半段黑场
        buf = np.ascontiguousarray(frame, dtype=np.uint8)
        if buf.shape != (H, W, 3):
            raise SystemExit(f"bad frame shape {buf.shape} at n={n}")
        proc.stdin.write(buf.tobytes())
        if n % 120 == 0:
            log(f"  frame {n}/{nframes}  t={t_film:5.2f}  {mode}")

    proc.stdin.close()
    code = proc.wait()
    err.close()
    if code != 0:
        raise SystemExit(f"ffmpeg video failed ({code}); see {workdir / 'ffmpeg_video.txt'}")
    (workdir / "layout_check.json").write_text(
        json.dumps(layout_log, ensure_ascii=False, indent=2), encoding="utf-8")

    # mux 前抽帧自检：**必须多点采样**。
    # 只看 t=8s 会误判——卡片/压字镜头本来就是黑底（本片 t≈8.7s 正是卡片，mean=11.4），
    # 于是整片被当成黑场中止，混音与成片都出不来。
    # 改为多数采样点足够亮才算通过：真正的整片黑场仍会被拦住，且每个点的数值都打出来便于排查。
    sample_times = [2.0, 8.0, 14.0, 20.0, 26.0]
    means = []
    for _t in sample_times:
        probe = subprocess.run(
            [
                _FFMPEG, "-v", "error", "-ss", str(_t), "-i", str(silent),
                "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
            ],
            capture_output=True,
        )
        if probe.returncode == 0 and len(probe.stdout) >= H * W * 3:
            sample = np.frombuffer(probe.stdout[: H * W * 3], dtype=np.uint8)
            means.append((_t, float(sample.mean())))
    if means:
        log("  silent check " + ", ".join(f"t={t:g}s mean={m:.1f}" for t, m in means))
        if not any(m >= 40 for _t, m in means):
            raise SystemExit(
                "silent.mp4 所有采样点都接近黑场 ("
                + ", ".join(f"{t:g}s={m:.1f}" for t, m in means)
                + f")，中止 mux；见 {silent}"
            )
    else:
        log("  silent check skipped (frame extract failed)")

    final = Path(out_path)
    # 口播 + 卡片 stinger；若有开场泡泡转场，再叠 bubble_wipe 原声音（与画面同速压到 INTRO_WIPE_DUR）
    mix_inputs = [
        _FFMPEG, "-y",
        "-i", str(timing["audio_path"]),
        "-i", str(workdir / "sfx.wav"),
    ]
    filters = [
        f"[0:a]adelay={int(pre * 1000)}:all=1[nar]",
        f"[1:a]adelay={int(pre * 1000)}:all=1,volume=0.85[s]",
    ]
    mix_labels = ["[nar]", "[s]"]
    if intro_wipe_t0 is not None and INTRO_WIPE.is_file():
        mix_inputs += ["-i", str(INTRO_WIPE)]
        # 片源 ~4s → 墙钟 INTRO_WIPE_DUR；adelay 对齐第 1 句起点（+pre）
        wipe_delay_ms = int(round((pre + float(intro_wipe_t0)) * 1000))
        # atempo 仅支持 0.5–100；两段串即可覆盖常见倍率
        speed = max(0.5, min(100.0, 4.01 / max(0.2, INTRO_WIPE_DUR)))
        # 用实际探测时长更稳
        probe = subprocess.run(
            [_FFPROBE, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", str(INTRO_WIPE)],
            capture_output=True, text=True,
        )
        try:
            wipe_src_dur = float((probe.stdout or "").strip() or "4.01")
        except ValueError:
            wipe_src_dur = 4.01
        speed = max(0.5, min(100.0, wipe_src_dur / max(0.2, INTRO_WIPE_DUR)))
        # chain atempo if needed (rarely >2 for our asset)
        tempo_chain = []
        rem = speed
        while rem > 2.0 + 1e-6:
            tempo_chain.append("atempo=2.0")
            rem /= 2.0
        while rem < 0.5 - 1e-6:
            tempo_chain.append("atempo=0.5")
            rem /= 0.5
        tempo_chain.append(f"atempo={rem:.6f}")
        tempo = ",".join(tempo_chain)
        filters.append(
            f"[2:a]aformat=sample_rates={SR}:channel_layouts=mono,"
            f"{tempo},volume=5.0,adelay={wipe_delay_ms}:all=1[wipe]"
        )
        mix_labels.append("[wipe]")
    n_mix = len(mix_labels)
    filters.append(
        "".join(mix_labels)
        + f"amix=inputs={n_mix}:duration=longest:normalize=0[a]"
    )
    mix = subprocess.run(
        mix_inputs + ["-filter_complex", ";".join(filters),
                      "-map", "[a]", str(workdir / "mix.wav")],
        capture_output=True,
    )
    if mix.returncode != 0:
        raise SystemExit(
            f"audio mix failed: {(mix.stderr or b'')[-400:].decode('utf-8', 'replace')}"
        )
    # 先写到临时文件再替换，避免播放器占用 成片.mp4 导致半截坏文件
    tmp_final = Path(str(final) + ".tmp.mp4")
    if tmp_final.exists():
        tmp_final.unlink()
    mux = subprocess.run(
        [
            _FFMPEG, "-y",
            "-i", str(silent),
            "-i", str(workdir / "mix.wav"),
            "-map", "0:v:0", "-map", "1:a:0",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
            "-shortest",
            "-movflags", "+faststart",
            str(tmp_final),
        ],
        capture_output=True,
    )
    if mux.returncode != 0:
        raise SystemExit(
            f"mux failed: {(mux.stderr or b'')[-400:].decode('utf-8', 'replace')}"
        )
    if final.exists():
        try:
            final.unlink()
        except OSError:
            # 播放器锁文件时写旁路名
            final = final.with_name(final.stem + "_new" + final.suffix)
    tmp_final.replace(final)
    log(f"  wrote {final}")
    return final
