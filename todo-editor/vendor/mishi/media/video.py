"""Video generation: Paipu (Seedance / H3) or Huniu (Grok). Submit once + poll."""
from __future__ import annotations

import json
import time
import urllib.request
from pathlib import Path
from typing import Any

from media.env import (
    JOBS,
    OUTPUTS,
    ensure_dirs,
    huniu_api_key,
    huniu_base,
    huniu_video_strategy,
    lec_api_key,
    paipu_base,
    video_model,
    video_provider,
)
from media.util import http_json, log_progress

TERMINAL_OK = {"completed", "succeeded", "success"}
TERMINAL_FAIL = {"failed", "error", "cancelled", "canceled"}


def _headers(provider: str) -> dict[str, str]:
    if provider == "huniu":
        key = huniu_api_key()
        if not key:
            raise RuntimeError("missing HUNIU_API_KEY / huniu_api_key in 密匙/.env")
    else:
        key = lec_api_key()
        if not key:
            raise RuntimeError("missing LEC_API_KEY in 密匙/.env")
    return {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def _base(provider: str) -> str:
    return huniu_base() if provider == "huniu" else paipu_base()


def _job_path(name: str) -> Path:
    ensure_dirs()
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in name)[:80]
    return JOBS / f"{safe}.json"


def _save(name: str, payload: dict[str, Any]) -> None:
    p = _job_path(name)
    cur: dict[str, Any] = {}
    if p.is_file():
        try:
            cur = json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            cur = {}
    cur.update(payload)
    cur["updated_at"] = time.time()
    p.write_text(json.dumps(cur, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _load(name: str) -> dict[str, Any]:
    p = _job_path(name)
    if not p.is_file():
        return {}
    return json.loads(p.read_text(encoding="utf-8"))


def _task_id(rec: dict[str, Any]) -> str:
    return str(rec.get("id") or rec.get("task_id") or rec.get("taskId") or "").strip()


def _provider_of(rec: dict[str, Any], kind: str | None = None) -> str:
    p = str(rec.get("provider") or "").strip().lower()
    if p in {"paipu", "huniu"}:
        return p
    if kind:
        return video_provider(kind)
    # huniu task ids look like task-1788...
    tid = _task_id(rec)
    if tid.startswith("task-"):
        return "huniu"
    return "paipu"


def submit(
    name: str,
    prompt: str,
    *,
    kind: str | None = None,
    model: str | None = None,
    aspect_ratio: str = "16:9",
    duration: int | None = None,
    images: list[str] | None = None,
    audios: list[str] | None = None,
) -> dict[str, Any]:
    """Create at most one task per job name. Re-call only queries if already submitted."""
    from media.env import default_video_kind

    rec = _load(name)
    tid = _task_id(rec)
    if tid:
        return rec

    use_kind = (kind or default_video_kind()).strip() or "grok"
    provider = video_provider(use_kind)
    use_model = (model or video_model(use_kind)).strip()
    body: dict[str, Any] = {
        "model": use_model,
        "prompt": prompt,
        "aspect_ratio": aspect_ratio,
    }
    if duration is not None:
        body["duration"] = int(duration)
    if images:
        body["images"] = list(images)
    if audios:
        body["audios"] = list(audios)
    # Huniu console「渠道策略」：默认经济优先（price_first），避免落到贵的按次渠道（如 DPW）
    strategy = ""
    if provider == "huniu":
        strategy = huniu_video_strategy()
        if strategy:
            body["strategy"] = strategy

    _save(
        name,
        {
            "name": name,
            "provider": provider,
            "kind": use_kind,
            "submit_sent": True,
            "model": use_model,
            "strategy": strategy or None,
            "prompt_preview": prompt[:240],
            "aspect_ratio": aspect_ratio,
            "duration": duration,
            "images": images or [],
            "audios": audios or [],
        },
    )
    code, resp = http_json(
        "POST",
        f"{_base(provider)}/videos",
        headers=_headers(provider),
        body=body,
        timeout=90,
    )
    _save(
        name,
        {
            "submit_http": code,
            "submit_resp": resp if isinstance(resp, dict) else {"raw": str(resp)[:800]},
        },
    )
    if not isinstance(resp, dict):
        raise RuntimeError(f"video POST {code} non-json: {str(resp)[:400]}")
    tid = _task_id(resp)
    if not tid:
        # No task created: unlock name so a later retry (after refund confirm) can POST again.
        if int(code) in {400, 401, 403, 404, 422, 429, 500, 502, 503, 504} or (
            isinstance(resp, dict)
            and str(resp.get("code") or "").upper()
            in {"PROVIDER_UNAVAILABLE", "INVALID_REQUEST", "REQUEST_INVALID"}
        ):
            _save(name, {"submit_sent": False, "submit_rejected": True})
        raise RuntimeError(
            f"video POST {code} no task id: {json.dumps(resp, ensure_ascii=False)[:500]}"
        )
    _save(name, {"id": tid, "task_id": tid, "status": resp.get("status")})
    return _load(name)


def query(task_id: str, *, provider: str = "paipu") -> dict[str, Any]:
    code, body = http_json(
        "GET",
        f"{_base(provider)}/videos/{task_id}",
        headers=_headers(provider),
        timeout=60,
    )
    # nginx HTML 502/503 → treat as transient, let wait() retry
    if int(code) in {429, 500, 502, 503, 504} or not isinstance(body, dict):
        raise RuntimeError(f"video query {task_id} HTTP {code}: {str(body)[:200]}")
    if str(body.get("code") or "").upper() in {"PROVIDER_UNAVAILABLE"}:
        raise RuntimeError(f"video query {task_id} provider unavailable: {body!r}"[:300])
    body["_http"] = code
    return body


def _pick_url(obj: Any) -> str | None:
    if isinstance(obj, str) and obj.startswith("http"):
        return obj
    if not isinstance(obj, dict):
        return None
    for k in ("video_url", "url", "result_url", "output_url"):
        v = obj.get(k)
        if isinstance(v, str) and v.startswith("http"):
            return v
    return None


def _download(task: dict[str, Any], out: Path) -> Path:
    ensure_dirs()
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    url = _pick_url(task)
    if not url and isinstance(task.get("output"), dict):
        url = _pick_url(task["output"])
    if not url:
        data = task.get("data")
        if isinstance(data, list) and data:
            url = _pick_url(data[0])
        elif isinstance(data, dict):
            url = _pick_url(data)
    if not url:
        for key in ("result", "results", "videos"):
            block = task.get(key)
            if isinstance(block, list) and block:
                url = _pick_url(block[0])
                if url:
                    break
            if isinstance(block, dict):
                url = _pick_url(block)
                if not url:
                    vids = block.get("videos")
                    if isinstance(vids, list) and vids:
                        url = _pick_url(vids[0])
                if url:
                    break
    if not url:
        raise RuntimeError(
            f"completed but no video url: {json.dumps(task, ensure_ascii=False)[:600]}"
        )
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(out.suffix + ".part")
    last: BaseException | None = None
    for i in range(5):
        try:
            if tmp.is_file():
                tmp.unlink()
            req = urllib.request.Request(
                str(url),
                headers={"User-Agent": "mishi-video/1.1", "Accept": "*/*"},
            )
            with urllib.request.urlopen(req, timeout=300) as resp:
                with tmp.open("wb") as f:
                    while True:
                        chunk = resp.read(256 * 1024)
                        if not chunk:
                            break
                        f.write(chunk)
            if tmp.stat().st_size < 10_000:
                raise RuntimeError(f"video download too small ({tmp.stat().st_size}B)")
            tmp.replace(out)
            return out
        except BaseException as e:
            last = e
            if tmp.is_file():
                try:
                    tmp.unlink()
                except OSError:
                    pass
            time.sleep(1.5 * (i + 1))
    raise RuntimeError(f"video download failed after 5 tries: {last}") from last


def wait(
    name: str,
    *,
    interval: int = 8,
    timeout_s: int = 1800,
    download: bool = True,
    out: Path | None = None,
) -> dict[str, Any]:
    rec = _load(name)
    tid = _task_id(rec)
    if not tid:
        raise RuntimeError(f"video job {name!r} has no task id — submit first")
    provider = _provider_of(rec, kind=str(rec.get("kind") or "") or None)
    t0 = time.time()
    last = ""
    while time.time() - t0 < timeout_s:
        try:
            task = query(tid, provider=provider)
        except Exception as e:
            # Transient gateway / TLS blips on GET: keep polling same task_id.
            msg = f"{name}: query_retry ({str(e)[:80]})"
            if msg != last:
                log_progress(msg)
                last = msg
            time.sleep(max(8, interval))
            continue
        st = str(task.get("status") or "").lower()
        _save(name, {"last_task": task, "status": st, "provider": provider})
        msg = f"{name}: {st} progress={task.get('progress')} stage={task.get('stage')}"
        if msg != last:
            log_progress(msg)
            last = msg
        if st in TERMINAL_OK:
            result: dict[str, Any] = {
                "ok": True,
                "mode": "video",
                "job": name,
                "task_id": tid,
                "status": st,
                "provider": provider,
                "model": rec.get("model"),
            }
            if download:
                try:
                    dest = out or (OUTPUTS / f"{name}.mp4")
                    path = _download(task, out=dest)
                    result["file"] = str(path.resolve())
                    from media.cleanup import discard_after_delivery

                    cleaned = discard_after_delivery(
                        job=name,
                        delivered_file=path,
                        toolkit_file=None,
                    )
                    if cleaned.get("deleted"):
                        result["cleaned"] = cleaned["deleted"]
                except Exception as e:
                    # Completed remotely; local pull failed — keep polling/retry download.
                    msg = f"{name}: download_retry ({str(e)[:80]})"
                    if msg != last:
                        log_progress(msg)
                        last = msg
                    time.sleep(max(8, interval))
                    continue
            return result
        if st in TERMINAL_FAIL:
            return {
                "ok": False,
                "mode": "video",
                "job": name,
                "task_id": tid,
                "status": st,
                "provider": provider,
                "error": task.get("error") or task,
            }
        time.sleep(max(5, interval))
    raise TimeoutError(f"video job {name!r} timeout after {timeout_s}s ({last})")


def generate(
    prompt: str,
    *,
    name: str | None = None,
    kind: str | None = None,
    model: str | None = None,
    aspect_ratio: str = "16:9",
    duration: int | None = None,
    images: list[str] | None = None,
    audios: list[str] | None = None,
    wait_done: bool = True,
    out: Path | None = None,
) -> dict[str, Any]:
    from media.env import default_video_kind

    use_kind = (kind or default_video_kind()).strip() or "grok"
    job = name or f"vid_{int(time.time())}"
    submit(
        job,
        prompt,
        kind=use_kind,
        model=model,
        aspect_ratio=aspect_ratio,
        duration=duration,
        images=images,
        audios=audios,
    )
    if not wait_done:
        rec = _load(job)
        return {
            "ok": True,
            "mode": "video",
            "job": job,
            "task_id": _task_id(rec),
            "status": rec.get("status"),
            "provider": rec.get("provider") or video_provider(use_kind),
            "pending": True,
        }
    return wait(job, out=out)
