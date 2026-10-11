"""口播文案 → 试听 wav + timing.json。配音走 TO DO 内嵌 TTS_timeline（TTS_TIMELINE_ROOT）。"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import paths

paths.ensure()
py = sys.executable
text = paths.TTS_SCRIPT.read_text(encoding="utf-8").strip()
han = sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff")
print("han", han, "chars", len(text), flush=True)

# 文案没变就别重配：配音是整条流水线里最"重"、也最不该反复来的一步——
# 每重配一次都会换一版声音和逐字时间戳，后面所有 enter_at / 字幕时刻跟着整体漂移 ✗
# 于是"我只想补一张失败的素材图"会变成"全片重来一版" ✗
# 做法：把文案哈希留在音频旁边；哈希一致且产物齐 → 直接跳过。
# 要强制重配：KOUBO_TTS_FORCE=1，或用 --clean（清掉音频后这个跳过自然失效）。
import hashlib

_stamp = paths.TTS / "script.sha256"
_sig = hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
_force = os.environ.get("KOUBO_TTS_FORCE", "").strip().lower() in ("1", "true", "yes")
if not _force and _stamp.is_file() and paths.TTS_AUDIO.is_file() and paths.TTS_TIMING.is_file():
    if _stamp.read_text(encoding="utf-8").strip() == _sig:
        print("tts skip: 文案未变，沿用已有配音", flush=True)
        raise SystemExit(0)

from resolve_voice import pacing, resolve

speaker, resource_id = resolve()
rate, max_pause = pacing()
print("voice", speaker, resource_id, "speech_rate", rate, "max_pause", max_pause, flush=True)

tts_root = Path(os.environ.get("TTS_TIMELINE_ROOT") or "").expanduser()
run_py = tts_root / "run.py"
if not run_py.is_file():
    raise SystemExit(
        "找不到 TTS_timeline。请确认 TO DO 已内嵌 vendor/tts-timeline，"
        "或设置环境变量 TTS_TIMELINE_ROOT。"
    )

# TTS_timeline 硬锁：--out 必须落在其 outputs/<作业>/，再拷回成片工作目录
job = Path(os.environ.get("KOUBO_WORK") or paths.TTS).resolve().name or "koubo_tts"
module_out = tts_root / "outputs" / job
module_out.mkdir(parents=True, exist_ok=True)
cmd = [
    py, str(run_py), "synth",
    "--text-file", str(paths.TTS_SCRIPT),
    "--out", str(module_out),
    "--speaker", speaker,
    "--resource-id", resource_id,
    "--speech-rate", str(rate),
]
if max_pause:
    cmd.extend(["--max-pause", str(max_pause)])
p = subprocess.run(cmd, capture_output=True)
(paths.TTS_LOGS / "tts_stdout.txt").write_bytes(p.stdout)
(paths.TTS_LOGS / "tts_stderr.txt").write_bytes(p.stderr)
print("tts", p.returncode, flush=True)
if p.returncode != 0:
    detail = (p.stdout or b"").decode("utf-8", "replace").strip() or (
        p.stderr or b""
    ).decode("utf-8", "replace").strip()
    if detail:
        print(detail[-800:], flush=True)
    raise SystemExit(p.returncode)

try:
    shutil.copyfile(module_out / "audio.wav", paths.TTS_AUDIO)
    shutil.copyfile(module_out / "timing.json", paths.TTS_TIMING)
finally:
    shutil.rmtree(module_out, ignore_errors=True)
print("written", paths.TTS_AUDIO, paths.TTS_TIMING, flush=True)
