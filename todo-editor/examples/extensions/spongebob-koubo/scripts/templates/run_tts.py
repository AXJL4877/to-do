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
