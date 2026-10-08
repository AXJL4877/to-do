"""盖章扬尘 / 渐渐显现：不启动黑板书写器和 ffmpeg，只检查进场帧。"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "native" / "test-output" / "chalk-enter"


def load():
    path = ROOT / "server" / "skills" / "chalk-hand" / "render.py"
    spec = importlib.util.spec_from_file_location("chalk_hand_render", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def chalk_blob() -> np.ndarray:
    img = np.zeros((240, 320, 3), np.uint8)
    cv2.circle(img, (160, 118), 62, (236, 232, 220), 7, lineType=cv2.LINE_AA)
    cv2.line(img, (92, 168), (228, 72), (232, 210, 160), 5, lineType=cv2.LINE_AA)
    cv2.circle(img, (160, 118), 16, (245, 244, 238), -1, lineType=cv2.LINE_AA)
    return img


def alpha(frame: np.ndarray) -> np.ndarray:
    return frame[:, :, 3].astype(np.float32) / 255.0


def centroid_y(a: np.ndarray) -> float:
    ys = np.arange(a.shape[0], dtype=np.float32)[:, None]
    return float((ys * a).sum() / max(float(a.sum()), 1e-6))


def on_board(frame: np.ndarray) -> np.ndarray:
    a = alpha(frame)[..., None]
    board = np.zeros_like(frame[:, :, :3])
    board[:] = (28, 46, 32)
    return np.clip(frame[:, :, :3].astype(np.float32) * a + board * (1.0 - a), 0, 255).astype(np.uint8)


def sheet(frames: list[np.ndarray], name: str) -> None:
    picks = [frames[int(round(i * (len(frames) - 1) / 5))] for i in range(6)]
    OUT.mkdir(parents=True, exist_ok=True)
    cv2.imencode(".png", np.hstack([on_board(f) for f in picks]))[1].tofile(str(OUT / name))


def main() -> None:
    m = load()
    assert m.assign_enters(
        [{"role": "hero"}, {"role": "support"}, {"role": "accent"}], "mix",
    ) == ["draw", "fade", "stamp"]
    assert m.assign_enters([{"role": "hero"}, {"role": "hero"}, {"role": "hero"}], "mix") == ["draw", "stamp", "fade"]
    assert m.assign_enters([{"role": "support"}, {"role": "support"}, {"role": "support"}], "mix") == ["fade", "stamp", "draw"]
    assert m.assign_enters([{"role": "hero"}, {"role": "accent"}], "draw") == ["draw", "draw"]
    assert m.assign_enters([{"role": "accent", "enter": "fade"}], "stamp") == ["fade"]

    hero = {"role": "hero", "atMs": 100, "windowEndMs": 9000}
    timings, modes = m.narrated_timings([hero], [4000], 0, 1.0, "draw")
    assert modes == ["draw"] and timings == [(100, 3200)], timings
    stamp_ms = m.entrance_ms("stamp", "accent", 4000, 4000, 1.0, 8000)
    fade_ms = m.entrance_ms("fade", "support", 4000, 4000, 1.0, 8000)
    assert 400 <= stamp_ms < fade_ms < 3200, (stamp_ms, fade_ms)

    blob = chalk_blob()
    src_a = m.to_straight_rgba(blob, "chalk")[1]
    mask = cv2.dilate((src_a > 0.2).astype(np.uint8), np.ones((11, 11), np.uint8)) > 0

    fade = list(m.iter_entrance_frames(blob, "fade", 24, 30, 1000, "chalk", 7))
    assert len(fade) == 24
    means = [float(alpha(f).mean()) for f in fade]
    assert means[0] < means[4] < means[10] < means[-1], means
    assert abs(means[-1] - means[-3]) < 1e-6
    assert np.max(np.abs(alpha(fade[-1]) - src_a)) < 1.5 / 255
    assert float(alpha(fade[8])[~mask].mean()) < 0.02

    stamp = list(m.iter_entrance_frames(blob, "stamp", 28, 30, 760, "chalk", 11))
    assert len(stamp) == 28
    assert np.max(np.abs(alpha(stamp[-1]) - src_a)) < 1.5 / 255
    early = stamp[6]
    assert centroid_y(alpha(early)) < centroid_y(src_a) - 4, (centroid_y(alpha(early)), centroid_y(src_a))
    outside = [float(alpha(f)[~mask].sum()) for f in stamp]
    assert max(outside) > outside[0] + 40 and max(outside) > outside[-1] + 40, (outside[0], max(outside), outside[-1])

    box = [40, 30, 80, 60]
    draw_crop = m.element_crop(box, 400, 300, "draw")
    stamp_crop = m.element_crop(box, 400, 300, "stamp")
    assert (stamp_crop[2] - stamp_crop[0]) > (draw_crop[2] - draw_crop[0])
    assert (stamp_crop[2] - stamp_crop[0]) % 2 == 0 and (stamp_crop[3] - stamp_crop[1]) % 2 == 0

    small = m.to_straight_rgba(cv2.resize(blob, (80, 60)), "chalk")[1]
    big = m.to_straight_rgba(cv2.resize(blob, (640, 480)), "chalk")[1]
    dust_small = m._make_dust(small, 5, "chalk")
    dust_big = m._make_dust(big, 5, "chalk")
    assert float(np.mean(np.abs(dust_big["vy"]))) > float(np.mean(np.abs(dust_small["vy"]))) * 3, (
        float(np.mean(np.abs(dust_small["vy"]))), float(np.mean(np.abs(dust_big["vy"]))))

    sheet(fade, "fade.png")
    sheet(stamp, "stamp.png")
    print("chalk enter ok")


if __name__ == "__main__":
    main()
