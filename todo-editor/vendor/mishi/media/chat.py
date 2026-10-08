"""文案 / 纯文本 chat：虎妞 GPT-6 Astra 与 Claude Fable5。

默认 gpt-6-astra；--kind fable5 → claude-fable-5。
OpenAI-compatible /chat/completions（无图；看图走 vision）。
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from media.env import chat_model, huniu_api_key, huniu_base
from media.util import http_json
from media.vision import _extract_text, try_parse_json


def _headers() -> dict[str, str]:
    key = huniu_api_key()
    if not key:
        raise RuntimeError("missing HUNIU_API_KEY / huniu_api_key in 密匙/.env")
    return {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def generate(
    prompt: str,
    *,
    kind: str | None = None,
    model: str | None = None,
    system: str | None = None,
    max_tokens: int = 4096,
    temperature: float | None = None,
    out: Path | None = None,
) -> dict[str, Any]:
    """纯文本补全。kind=gpt6|fable5；也可直接传完整 --model。"""
    prompt = (prompt or "").strip()
    if not prompt:
        raise ValueError("prompt is required")

    resolved_kind, model_id = chat_model(kind=kind, model=model)

    messages: list[dict[str, Any]] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    body: dict[str, Any] = {
        "model": model_id,
        "messages": messages,
        "max_tokens": int(max_tokens),
    }
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
            "mode": "chat",
            "kind": resolved_kind,
            "model": model_id,
            "status": code,
            "error": data if not isinstance(data, dict) else data.get("error") or data,
        }
    if data.get("error"):
        return {
            "ok": False,
            "mode": "chat",
            "kind": resolved_kind,
            "model": model_id,
            "status": code,
            "error": data.get("error"),
        }

    text = _extract_text(data)
    usage = data.get("usage")
    result: dict[str, Any] = {
        "ok": True,
        "mode": "chat",
        "kind": resolved_kind,
        "model": data.get("model") or model_id,
        "text": text,
        "usage": usage,
        "id": data.get("id"),
    }
    parsed = try_parse_json(text)
    if parsed is not None:
        result["json"] = parsed

    if out:
        path = Path(out)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        result["file"] = str(path.resolve())

    return result
