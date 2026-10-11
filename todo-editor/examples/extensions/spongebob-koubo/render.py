"""协议自检入口：贴纸排布一层透明 WebM + 定格 PNG（FFmpeg 淡入，不逐帧 PIL）。

⚠️ 这不是成片渲染器，生成时宿主**不会**调用它。
   本扩展用 `preserveSource` 把成片委托给包内 `workflow/run_pipeline.py`；
   宿主看到该字段后直接走包内管线（见 server/production/runner.mjs:136），
   分段/分镜/生图/渲染全由包内决定。真实逐元素分层在
   `workflow/kit/kit/layers_export.py`，那才是时间轴上的产物。

它的用途只有一个：按 `todo-skill-render/1` 手搓一次 `@progress` / `@result`
握手，证明包内 Python 与宿主协议对得上（离线、不花钱、不需要 AI 服务）。
所以这里刻意用最简单的贴纸排布，**不要**拿它去对齐成片观感——
下面 layout 标成 `protocol-probe` 就是在提醒这件事。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image


def log(msg: str) -> None:
    print(msg, flush=True)


def emit(kind: str, payload: dict) -> None:
    print(f"@{kind} {json.dumps(payload, ensure_ascii=False)}", flush=True)


def parse_size(value: str) -> tuple[int, int]:
    w, h = str(value or "1920x1080").lower().split("x")
    return int(w), int(h)


def even(n: int) -> int:
    n = max(2, int(n))
    return n if n % 2 == 0 else n + 1


def load_request(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("spec") != "todo-skill-render/1":
        raise SystemExit("spec must be todo-skill-render/1")
    if data.get("mode") != "scene-clips":
        raise SystemExit("mode must be scene-clips")
    return data


def trim_box(im: Image.Image) -> tuple[int, int, int, int]:
    rgba = im.convert("RGBA")
    box = rgba.getbbox()
    if not box:
        return 0, 0, rgba.width, rgba.height
    return box


def place(index: int, count: int, fw: int, fh: int, tw: int, th: int) -> tuple[int, int]:
    slot = (index + 1) / (count + 1)
    x = int(fw * slot - tw / 2)
    y = int(fh * 0.72 - th)
    return max(0, min(x, fw - tw)), max(0, min(y, fh - th))


def write_hold(sprite: Image.Image, crop: tuple[int, int, int, int], dest: Path) -> None:
    canvas = Image.new("RGBA", (crop[2], crop[3]), (0, 0, 0, 0))
    canvas.paste(sprite, (8, 8), sprite)
    canvas.save(dest)


def encode_ffmpeg(sprite_path: Path, crop_wh: tuple[int, int], frames: int, fps: int, dest: Path, ffmpeg: str) -> None:
    w, h = crop_wh
    dur = frames / fps
    fade = min(0.45, dur * 0.7)
    cmd = [
        ffmpeg, "-y",
        "-loop", "1", "-i", str(sprite_path),
        "-f", "lavfi", "-i", f"color=c=black@0.0:s={w}x{h}:d={dur:.3f},format=rgba",
        "-filter_complex",
        f"[0:v]scale={w-16}:{h-16}:force_original_aspect_ratio=decrease,format=rgba,fade=t=in:st=0:d={fade}:alpha=1[s];"
        f"[1:v][s]overlay=(W-w)/2:(H-h)/2:format=auto,fps={fps},format=yuva420p",
        "-t", f"{dur:.3f}",
        "-an", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "36",
        "-auto-alt-ref", "0",
        str(dest),
    ]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0 or not dest.is_file():
        tail = (proc.stderr or b"")[-400:].decode("utf-8", "replace")
        raise SystemExit(f"ffmpeg encode failed: {tail}")


def encode_python(sprite: Image.Image, crop_wh: tuple[int, int], frames: int, fps: int, dest: Path, ffmpeg: str) -> None:
    """串行参考：PIL 逐帧再交给编码器。只用于基线对比。"""
    w, h = crop_wh
    sw, sh = sprite.size
    cmd = [
        ffmpeg, "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{w}x{h}", "-r", str(fps),
        "-i", "-", "-an", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0",
        "-b:v", "0", "-crf", "36", str(dest),
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    assert proc.stdin
    for i in range(frames):
        alpha = int(255 * min(1.0, (i + 1) / max(1, int(frames * 0.6))))
        frame = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        layer = sprite.copy()
        a = layer.getchannel("A").point(lambda p, k=alpha: p * k // 255)
        layer.putalpha(a)
        frame.paste(layer, ((w - sw) // 2, (h - sh) // 2), layer)
        proc.stdin.write(frame.tobytes())
    proc.stdin.close()
    if proc.wait() != 0:
        raise SystemExit("python frame encode failed")


def one_element(job: dict) -> dict:
    el = job["el"]
    im = Image.open(el["image"]).convert("RGBA")
    box = trim_box(im)
    sprite = im.crop(box)
    max_h = int(job["fh"] * (0.46 if el.get("role") == "hero" else 0.32))
    scale = min(1.0, max_h / max(1, sprite.height))
    sprite = sprite.resize((even(sprite.width * scale), even(sprite.height * scale)), Image.Resampling.BILINEAR)
    pad = 8
    cw, ch = even(sprite.width + pad * 2), even(sprite.height + pad * 2)
    x, y = place(job["index"], job["count"], job["fw"], job["fh"], cw, ch)
    crop = [x, y, cw, ch]
    prefix = job["prefix"]
    sid = job["scene_id"]
    eid = el["id"]
    video = f"{prefix}_{sid}_{eid}.webm"
    hold = f"{prefix}_{sid}_{eid}_hold.png"
    out = Path(job["out"])
    write_hold(sprite, (0, 0, cw, ch), out / hold)
    tmp = out / f"_{eid}_sprite.png"
    sprite.save(tmp)
    fps = job["fps"]
    speed = max(0.5, float(job["speed"]))
    frames = max(8, int(round(fps * 0.8 / speed)))
    if job["backend"] == "python":
        encode_python(sprite, (cw, ch), frames, fps, out / video, job["ffmpeg"])
    else:
        encode_ffmpeg(tmp, (cw, ch), frames, fps, out / video, job["ffmpeg"])
    tmp.unlink(missing_ok=True)
    enter = job["enter"] if job["enter"] in ("draw", "stamp", "fade") else "fade"
    return {
        "id": eid,
        "label": el.get("label") or eid,
        "role": el.get("role") or "support",
        "enter": enter,
        "box": crop,
        "crop": crop,
        "startMs": int(el.get("atMs") or 0),
        "durationMs": int(round(1000 * frames / fps)),
        "frames": frames,
        "video": video,
        "hold": hold,
        "tip": [],
    }


def main() -> None:
    if "--request" not in sys.argv:
        raise SystemExit("usage: render.py --request <file>")
    req = load_request(Path(sys.argv[sys.argv.index("--request") + 1]))
    scene = req["scene"]
    params = req.get("params") or {}
    fw, fh = parse_size(params.get("size"))
    fps = int(params.get("fps") or 30)
    out = Path(req["outDir"])
    out.mkdir(parents=True, exist_ok=True)
    elements = list(scene.get("elements") or [])
    backend = os.environ.get("SB_RENDER", "ffmpeg")
    workers = 1 if backend == "python" else min(2, max(1, len(elements)))
    jobs = []
    for i, el in enumerate(elements):
        jobs.append({
            "el": el, "index": i, "count": len(elements),
            "fw": fw, "fh": fh, "fps": fps, "speed": params.get("drawSpeed") or 1,
            "enter": str(params.get("enter") or "fade"),
            "out": str(out), "ffmpeg": req.get("ffmpeg") or "ffmpeg",
            "prefix": req["outputs"]["prefix"], "scene_id": scene["id"],
            "backend": backend,
        })
    emit("progress", {"phase": "render", "pct": 0.1})
    if workers == 1:
        done = [one_element(j) for j in jobs]
    else:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            done = list(pool.map(one_element, jobs))
    emit("progress", {"phase": "render", "pct": 1})
    emit("result", {
        "alpha": True,
        "width": fw,
        "height": fh,
        "fps": fps,
        "scene": {
            "id": scene["id"],
            "startMs": int(scene.get("startMs") or 0),
            "endMs": int(scene.get("endMs") or 0),
            # 明确标注这是协议探针产物，不是成片；真实分层见 workflow/kit/kit/layers_export.py
            "layout": "protocol-probe",
            "probe": True,
            "elements": done,
        },
    })


if __name__ == "__main__":
    main()
