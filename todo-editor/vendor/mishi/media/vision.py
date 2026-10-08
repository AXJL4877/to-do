"""Vision / VLM via Huniu OpenAI-compatible chat.

Default model: gemini-3.8-flash (虎妞「GM-3.8 Flash」).
"""
from __future__ import annotations

import base64
import mimetypes
import re
from pathlib import Path
from typing import Any

from media.env import huniu_api_key, huniu_base, huniu_vision_model
from media.util import http_json


def _headers() -> dict[str, str]:
    key = huniu_api_key()
    if not key:
        raise RuntimeError("missing HUNIU_API_KEY / huniu_api_key in 密匙/.env")
    return {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def _guess_mime(path: Path) -> str:
    mime, _ = mimetypes.guess_type(str(path))
    if mime and mime.startswith("image/"):
        return mime
    ext = path.suffix.lower()
    return {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".bmp": "image/bmp",
    }.get(ext, "image/png")


def image_ref_to_url(ref: str | Path) -> str:
    """Local path → data URL; http(s) left as-is."""
    s = str(ref).strip()
    if s.startswith(("http://", "https://", "data:")):
        return s
    path = Path(s)
    if not path.is_file():
        raise FileNotFoundError(f"image not found: {path}")
    data = path.read_bytes()
    if len(data) > 18 * 1024 * 1024:
        raise RuntimeError(f"image too large for inline vision ({len(data)} bytes): {path}")
    b64 = base64.b64encode(data).decode("ascii")
    return f"data:{_guess_mime(path)};base64,{b64}"


def _extract_text(payload: dict[str, Any]) -> str:
    choices = payload.get("choices") or []
    if not choices:
        return ""
    msg = choices[0].get("message") or {}
    content = msg.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for p in content:
            if isinstance(p, dict) and p.get("type") == "text":
                parts.append(str(p.get("text") or ""))
            elif isinstance(p, str):
                parts.append(p)
        return "\n".join(parts).strip()
    return str(content or "")


_JSON_FENCE = re.compile(r"```(?:json)?\s*([\s\S]*?)```", re.IGNORECASE)


def try_parse_json(text: str) -> Any | None:
    text = (text or "").strip()
    if not text:
        return None
    import json

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    m = _JSON_FENCE.search(text)
    if m:
        try:
            return json.loads(m.group(1).strip())
        except json.JSONDecodeError:
            pass
    # 截取首尾花括号
    i, j = text.find("{"), text.rfind("}")
    if i >= 0 and j > i:
        try:
            return json.loads(text[i : j + 1])
        except json.JSONDecodeError:
            pass
    return None


def analyze(
    prompt: str,
    *,
    images: list[str | Path] | None = None,
    model: str | None = None,
    max_tokens: int = 2048,
    system: str | None = None,
    temperature: float | None = None,
) -> dict[str, Any]:
    """Call Huniu chat/completions with optional images. Returns ok + text (+ parsed json if any)."""
    prompt = (prompt or "").strip()
    if not prompt:
        raise ValueError("prompt is required")

    model_id = (model or huniu_vision_model()).strip()
    content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
    for ref in images or []:
        content.append(
            {
                "type": "image_url",
                "image_url": {"url": image_ref_to_url(ref)},
            }
        )

    messages: list[dict[str, Any]] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": content})

    body: dict[str, Any] = {
        "model": model_id,
        "messages": messages,
        "max_tokens": int(max_tokens),
    }
    # Gemini 3.x 部分网关拒 temperature；仅显式传入时带上
    if temperature is not None:
        body["temperature"] = float(temperature)

    code, data = http_json(
        "POST",
        f"{huniu_base()}/chat/completions",
        headers=_headers(),
        body=body,
        timeout=300,
    )
    if code >= 400 or not isinstance(data, dict):
        return {
            "ok": False,
            "mode": "vision",
            "model": model_id,
            "status": code,
            "error": data if not isinstance(data, dict) else data.get("error") or data,
        }
    if data.get("error"):
        return {
            "ok": False,
            "mode": "vision",
            "model": model_id,
            "status": code,
            "error": data.get("error"),
        }

    text = _extract_text(data)
    usage = data.get("usage")
    out: dict[str, Any] = {
        "ok": True,
        "mode": "vision",
        "model": data.get("model") or model_id,
        "text": text,
        "usage": usage,
        "id": data.get("id"),
    }
    parsed = try_parse_json(text)
    if parsed is not None:
        out["json"] = parsed
    return out
