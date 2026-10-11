"""Thin clients for the two external services the kit depends on."""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import os

def _tool(env_name: str, leaf: str) -> Path:
    root = Path(os.environ.get(env_name) or "").expanduser()
    cand = root / leaf
    return cand if cand.is_file() else Path()

LLM_RUN = _tool("MISHI_ROOT", "run.py")
TTS_RUN = _tool("TTS_TIMELINE_ROOT", "run.py")

_CHAT_FLAGS: set[str] | None = None


def _child_env() -> dict[str, str]:
    """随包服务子进程强制 UTF-8。

    Windows 控制台默认 GBK，vendored run.py 一打印模型回复里的特殊字符就
    UnicodeEncodeError 退出，主进程只看到"chat failed"这种误导信息。
    """
    return {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}


def _chat_flags() -> set[str]:
    """探测随包的 run.py chat 支持哪些开关。

    以前这里写死 --prompt-file/--system-file，而 vendored 版本只有 --prompt/--system，
    结果每次调用都以 "the following arguments are required: --prompt" 失败。
    探测一次并缓存，两种版本都能用。
    """
    global _CHAT_FLAGS
    if _CHAT_FLAGS is None:
        flags: set[str] = set()
        if LLM_RUN.exists():
            try:
                p = subprocess.run(
                    [sys.executable, str(LLM_RUN), "chat", "--help"],
                    capture_output=True, timeout=60,
                )
                text = (p.stdout + p.stderr).decode("utf-8", "replace")
                flags = set(re.findall(r"--[a-z][a-z0-9-]*", text))
            except Exception:
                flags = set()
        _CHAT_FLAGS = flags
    return _CHAT_FLAGS


class ServiceError(RuntimeError):
    pass


def _write_temp(text: str, suffix: str = ".txt") -> Path:
    fd, name = tempfile.mkstemp(prefix="koubo_llm_", suffix=suffix)
    os.close(fd)
    path = Path(name)
    path.write_text(text, encoding="utf-8")
    return path


def chat(prompt, system=None, kind="gpt6", model=None, max_tokens=None, temperature=None, timeout=300):
    """One turn against the configured LLM. Returns its text.

    Long prompts go via --prompt-file to avoid Windows CreateProcess 8191 limit.
    """
    if not LLM_RUN.exists():
        raise ServiceError(f"LLM runner not found: {LLM_RUN}")
    flags = _chat_flags()
    prompt_path = _write_temp(prompt or "", ".prompt.txt")
    system_path = None
    cmd = [sys.executable, str(LLM_RUN), "chat"]
    if "--prompt-file" in flags:
        cmd += ["--prompt-file", str(prompt_path)]
    else:
        cmd += ["--prompt", prompt or ""]
    cmd += ["--kind", kind]
    try:
        if system:
            if "--system-file" in flags:
                system_path = _write_temp(system, ".system.txt")
                cmd += ["--system-file", str(system_path)]
            else:
                cmd += ["--system", system]
        if model:
            cmd += ["--model", model]
        if max_tokens:
            cmd += ["--max-tokens", str(max_tokens)]
        if temperature is not None:
            cmd += ["--temperature", str(temperature)]
        p = subprocess.run(cmd, capture_output=True, timeout=timeout, env=_child_env())
    finally:
        prompt_path.unlink(missing_ok=True)
        if system_path is not None:
            system_path.unlink(missing_ok=True)
    if p.returncode != 0:
        detail = (p.stderr.decode("utf-8", "replace").strip()
                  or p.stdout.decode("utf-8", "replace").strip())
        raise ServiceError(f"chat failed: {detail[-400:]}")
    text = p.stdout.decode("utf-8", "replace").strip()
    if not text:
        raise ServiceError("chat returned nothing")
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return text
    if isinstance(payload, dict):
        if payload.get("ok") is False:
            raise ServiceError(f"chat error: {payload.get('error')}")
        for key in ("text", "content", "message", "reply"):
            if isinstance(payload.get(key), str):
                return payload[key].strip()
    return text


def vision(prompt, image, system=None, model=None, max_tokens=None, timeout=300):
    """Ask the vision model about one image. Returns its text."""
    if not LLM_RUN.exists():
        raise ServiceError(f"LLM runner not found: {LLM_RUN}")
    cmd = [sys.executable, str(LLM_RUN), "vision", "--prompt", prompt, "--image", str(image)]
    if system:
        cmd += ["--system", system]
    if model:
        cmd += ["--model", model]
    if max_tokens:
        cmd += ["--max-tokens", str(max_tokens)]
    p = subprocess.run(cmd, capture_output=True, timeout=timeout)
    if p.returncode != 0:
        raise ServiceError(f"vision failed: {p.stderr.decode('utf-8', 'replace')[:300]}")
    text = p.stdout.decode("utf-8", "replace").strip()
    if not text:
        raise ServiceError("vision returned nothing")
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return text
    if isinstance(payload, dict):
        if payload.get("ok") is False:
            raise ServiceError(f"vision error: {payload.get('error')}")
        for key in ("text", "content", "message", "reply"):
            if isinstance(payload.get(key), str):
                return payload[key].strip()
    return text


def synth(text, out_dir, timeout=1800):
    """Narrate the script and return the timing json path."""
    import shutil

    if not TTS_RUN.exists():
        raise ServiceError(f"TTS runner not found: {TTS_RUN}")
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    project = out_dir.name
    stage = TTS_RUN.parent / "outputs" / project
    p = subprocess.run(
        [sys.executable, str(TTS_RUN), "synth", "--text-file", str(text), "--out", str(stage)],
        capture_output=True,
        timeout=timeout,
    )
    if p.returncode != 0:
        detail = p.stdout.decode("utf-8", "replace")[:400] or p.stderr.decode("utf-8", "replace")[:400]
        raise ServiceError(f"tts failed: {detail}")
    for name in ("audio.wav", "timing.json"):
        src = stage / name
        if not src.exists():
            raise ServiceError(f"tts produced no {name} in {stage}")
        shutil.copyfile(src, out_dir / name)
    timing_path = out_dir / "timing.json"
    data = json.loads(timing_path.read_text(encoding="utf-8"))
    data["audio_path"] = str(out_dir / "audio.wav")
    timing_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return timing_path


def extract_json(text):
    """Pull the first JSON object out of an LLM reply, fences and prose included."""
    text = text.strip()
    if text.startswith("```"):
        text = text.split("```", 2)[1]
        if text.startswith("json"):
            text = text[4:]
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("no JSON object in reply")
    return json.loads(text[start : end + 1])
