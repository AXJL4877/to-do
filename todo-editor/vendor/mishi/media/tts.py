"""Volcano / Doubao Seed TTS (X-Api-Key).

TTS 2.0 可通过 audio_params.enable_subtitle 拿到字/词级时间戳
（响应里的 sentence / TTSSubtitle 事件）。
"""
from __future__ import annotations

import base64
import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from media.env import OUTPUTS, ensure_dirs, speech

URL = "https://openspeech.bytedance.com/api/v3/tts/unidirectional"

# TTS 2.0 字幕仅中/英；与 format 一并放进 audio_params
_SUPPORTED_FORMATS = frozenset({"mp3", "wav", "pcm", "ogg_opus"})


def _parse_stream(raw: str) -> tuple[list[bytes], list[dict[str, Any]]]:
    """解析单向流：音频 data 块 + sentence 字幕块。"""
    chunks: list[bytes] = []
    sentences: list[dict[str, Any]] = []

    def _consume(obj: dict[str, Any]) -> bool:
        """返回 True 表示流结束。"""
        code = obj.get("code")
        if code == 0 and obj.get("data"):
            chunks.append(base64.b64decode(obj["data"]))
        sent = obj.get("sentence")
        if isinstance(sent, dict) and (sent.get("words") or sent.get("text")):
            sentences.append(sent)
        if code == 20000000:
            return True
        if code not in (0, None, 20000000):
            raise RuntimeError(f"tts error code={code} msg={obj.get('message') or obj}")
        return False

    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        # SSE: "data: {...}" / "event: N"
        if line.startswith("event:"):
            continue
        if line.startswith("data:"):
            line = line[5:].strip()
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if _consume(obj):
            return chunks, sentences

    if not chunks and raw.strip().startswith("{"):
        decoder = json.JSONDecoder()
        idx = 0
        s = raw.strip()
        while idx < len(s):
            while idx < len(s) and s[idx].isspace():
                idx += 1
            if idx >= len(s):
                break
            try:
                obj, end = decoder.raw_decode(s, idx)
            except json.JSONDecodeError:
                break
            idx = end
            if _consume(obj):
                break

    return chunks, sentences


def synthesize(
    text: str,
    *,
    out: Path | None = None,
    speaker: str | None = None,
    resource_id: str | None = None,
    format: str = "mp3",
    sample_rate: int = 24000,
    enable_subtitle: bool = False,
    timing_out: Path | None = None,
    disable_markdown_filter: bool = True,
    additions: dict[str, Any] | None = None,
    speech_rate: int | None = None,
) -> dict[str, Any]:
    """合成语音。

    enable_subtitle / timing_out：TTS 2.0 字词时间戳。
    timing_out 若给定，会把原始 sentence 列表写成 JSON（业务侧可再聚合成句/短语/字）。

    disable_markdown_filter 默认 True：过滤 markdown，避免 `**你好**` 读成「星星你好星星」。
    （火山字段名反直觉：true = 开启过滤。）
    """
    cfg = speech()
    key = cfg["api_key"]
    rid = (resource_id or cfg["resource_id"] or "seed-tts-2.0").strip()
    voice = (speaker or cfg["speaker"]).strip()
    fmt = (format or "mp3").strip().lower()
    if fmt not in _SUPPORTED_FORMATS:
        raise RuntimeError(f"unsupported audio format: {fmt}")
    if not key:
        raise RuntimeError("missing VOLC_SPEECH_API_KEY in 密匙/.env")
    if not text.strip():
        raise RuntimeError("empty TTS text")

    want_sub = bool(enable_subtitle or timing_out)
    ensure_dirs()
    audio_params: dict[str, Any] = {
        "format": fmt,
        "sample_rate": int(sample_rate),
    }
    if speech_rate:
        # 火山 V3：-50 = 0.5 倍速，100 = 2 倍速
        audio_params["speech_rate"] = max(-50, min(100, int(speech_rate)))
    if want_sub:
        # TTS 2.0 / ICL 2.0：enable_subtitle；1.0 用 enable_timestamp（本默认 seed-tts-2.0）
        if "2.0" in rid or rid.startswith("seed-icl-2"):
            audio_params["enable_subtitle"] = True
        else:
            audio_params["enable_timestamp"] = True

    # additions 必须是 JSON 字符串；默认开 markdown 过滤防 * 误读
    add: dict[str, Any] = {"disable_markdown_filter": bool(disable_markdown_filter)}
    if additions:
        add.update(additions)
    req_params: dict[str, Any] = {
        "text": text.strip(),
        "speaker": voice,
        "audio_params": audio_params,
        "additions": json.dumps(add, ensure_ascii=False),
    }

    body = json.dumps(
        {
            "user": {"uid": "mi_shi_toolkit"},
            "req_params": req_params,
        },
        ensure_ascii=False,
    ).encode("utf-8")
    req = urllib.request.Request(
        URL,
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Api-Key": key,
            "X-Api-Resource-Id": rid,
        },
        method="POST",
    )
    last_err: Exception | None = None
    raw = ""
    for attempt in range(1, 4):
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
            last_err = None
            break
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"tts HTTP {e.code}: {e.read()[:400]!r}") from e
        except Exception as e:  # SSL EOF / 瞬时断连
            last_err = e
            if attempt >= 3:
                break
            time.sleep(1.5 * attempt)
            # Request 不可复用 body 已读？urllib Request 可重复，data 仍在
            continue
    if last_err is not None:
        raise RuntimeError(f"tts network error after retries: {last_err}") from last_err

    chunks, sentences = _parse_stream(raw)
    if not chunks:
        raise RuntimeError("tts returned no audio")

    ext = {"mp3": ".mp3", "wav": ".wav", "pcm": ".pcm", "ogg_opus": ".ogg"}.get(fmt, f".{fmt}")
    out_path = Path(out) if out else (OUTPUTS / f"tts_{int(time.time())}{ext}")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(b"".join(chunks))

    words: list[dict[str, Any]] = []
    for sent in sentences:
        for w in sent.get("words") or []:
            if not isinstance(w, dict):
                continue
            words.append(
                {
                    "word": w.get("word") or "",
                    "start": float(w.get("startTime") or 0.0),
                    "end": float(w.get("endTime") or 0.0),
                    "confidence": w.get("confidence"),
                }
            )

    result: dict[str, Any] = {
        "ok": True,
        "mode": "tts",
        "file": str(out_path.resolve()),
        "speaker": voice,
        "resource_id": rid,
        "format": fmt,
        "sample_rate": int(sample_rate),
        "chars": len(text.strip()),
        "enable_subtitle": want_sub,
        "disable_markdown_filter": bool(add.get("disable_markdown_filter")),
        "sentences_raw": sentences,
        "words": words,
    }

    if timing_out is not None:
        tpath = Path(timing_out)
        tpath.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "text": text.strip(),
            "audio": str(out_path.resolve()),
            "speaker": voice,
            "resource_id": rid,
            "format": fmt,
            "sample_rate": int(sample_rate),
            "sentences_raw": sentences,
            "words": words,
        }
        tpath.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        result["timing"] = str(tpath.resolve())

    return result
