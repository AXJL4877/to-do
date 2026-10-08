"""Image generation: Huniu (default gpt-image-2) or Paipu TinySnow.

Upstream `/images/generations` is synchronous.
Client-side jobs: --no-wait spawns a local worker; --poll watches jobs/img_*.json.
Multiple named jobs can run in parallel (pay-per-request).
"""
from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any

from media.env import (
    JOBS,
    OUTPUTS,
    ROOT,
    ensure_dirs,
    huniu_api_key,
    huniu_base,
    huniu_video_strategy,
    image_default_size,
    image_model,
    image_provider,
    lec_api_key,
    paipu_base,
)
from media.util import http_json, log_progress, urlopen


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
    return JOBS / f"img_{safe}.json"


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


def _write_image_bytes(item: dict[str, Any], out_path: Path) -> Path:
    """Persist image from API item. URL downloads retry on transient SSL/EOF."""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    b64 = item.get("b64_json") or item.get("b64") or ""
    url = item.get("url") or item.get("image_url") or ""
    if b64:
        out_path.write_bytes(base64.b64decode(b64))
        return out_path
    if not url:
        raise RuntimeError(f"image no b64/url: {item!r}"[:800])
    return _download_url(str(url), out_path)


def _download_url(url: str, out_path: Path, *, attempts: int = 5) -> Path:
    """Chunked download with retries — 4K PNG over flaky TLS often hits UNEXPECTED_EOF."""
    from media.util import _proxy_is_loopback  # noqa: PLC0415 — avoid import cycle at module load

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_suffix(out_path.suffix + ".part")
    last: BaseException | None = None
    force_direct: bool | None = None
    for i in range(max(1, attempts)):
        try:
            if tmp.is_file():
                tmp.unlink()
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "mishi-image/1.1", "Accept": "*/*"},
            )
            with urlopen(req, timeout=300, force_direct=force_direct) as resp:
                with tmp.open("wb") as f:
                    while True:
                        chunk = resp.read(256 * 1024)
                        if not chunk:
                            break
                        f.write(chunk)
            if tmp.stat().st_size < 1024:
                raise RuntimeError(f"image download too small ({tmp.stat().st_size}B)")
            tmp.replace(out_path)
            return out_path
        except BaseException as e:
            last = e
            if tmp.is_file():
                try:
                    tmp.unlink()
                except OSError:
                    pass
            if force_direct is not True and _proxy_is_loopback():
                force_direct = True
                log_progress(f"download: transient; retry direct {i + 2}/{attempts}")
            time.sleep(1.5 * (i + 1))
    raise RuntimeError(f"image download failed after {attempts} tries: {last}") from last


def generate_sync(
    prompt: str,
    *,
    out: Path | None = None,
    images: list[str] | None = None,
    model: str | None = None,
    size: str | None = None,
    quality: str = "low",
    n: int = 1,
    provider: str | None = None,
    on_remote_ready: Any | None = None,
    transparent: bool = False,
) -> dict[str, Any]:
    prov = image_provider(provider)
    use_model = (model or image_model(prov)).strip()
    use_size = (size or image_default_size()).strip()
    payload: dict[str, Any] = {
        "model": use_model,
        "prompt": prompt,
        "n": int(n),
        "size": use_size,
    }
    if prov == "paipu":
        payload["quality"] = quality
        payload["response_format"] = "b64_json"
    else:
        strategy = huniu_video_strategy()
        if strategy:
            payload["strategy"] = strategy
        if transparent:
            payload["background"] = "transparent"
            payload["output_format"] = "png"
    if images:
        payload["images"] = list(images)

    code, body = http_json(
        "POST",
        f"{_base(prov)}/images/generations",
        headers=_headers(prov),
        body=payload,
        timeout=300,
    )
    if code >= 400 or not isinstance(body, dict):
        raise RuntimeError(f"image HTTP {code}: {body!r}"[:800])

    data = body.get("data") or []
    if not data:
        raise RuntimeError(f"image empty data: {body!r}"[:800])
    item = data[0] if isinstance(data[0], dict) else {}
    remote_url = str(item.get("url") or item.get("image_url") or "") or None
    if callable(on_remote_ready):
        on_remote_ready(remote_url, item)
    out_path = out or (OUTPUTS / f"image_{int(time.time())}.png")
    try:
        path = _write_image_bytes(item, out_path)
    except Exception as e:
        err = RuntimeError(f"image download error (url kept): {e}")
        setattr(err, "image_url", remote_url)
        setattr(err, "remote_ready", True)
        raise err from e
    usage = body.get("usage") if isinstance(body.get("usage"), dict) else None
    result: dict[str, Any] = {
        "ok": True,
        "mode": "image",
        "provider": prov,
        "model": use_model,
        "size": use_size,
        "file": str(path.resolve()),
        "prompt": prompt,
        "url": remote_url,
    }
    if usage:
        result["usage"] = usage
    return result


def _spawn_run_job(name: str) -> None:
    cmd = [sys.executable, str(ROOT / "run.py"), "image", "--run-job", name]
    kwargs: dict[str, Any] = {
        "cwd": str(ROOT),
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
    }
    if os.name == "nt":
        kwargs["creationflags"] = (
            getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
            | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
        )
    else:
        kwargs["start_new_session"] = True
    subprocess.Popen(cmd, **kwargs)


def run_job(name: str) -> dict[str, Any]:
    """Worker entry: execute a pending local image job (blocking sync call)."""
    rec = _load(name)
    if not rec:
        raise RuntimeError(f"image job {name!r} missing")
    if rec.get("status") == "completed" and rec.get("file"):
        return {"ok": True, "mode": "image", "job": name, **{k: rec[k] for k in ("file", "model", "size", "provider") if k in rec}}

    out_path = Path(rec["out"]) if rec.get("out") else (OUTPUTS / f"{name}.png")
    st0 = str(rec.get("status") or "")

    # Resume: remote already OK, only re-pull URL (no new generation charge).
    resume_dl = bool(rec.get("url")) and (
        st0 in {"download_failed", "failed"}
        or (st0 == "queued" and rec.get("remote_ready"))
    )
    if resume_dl:
        _save(name, {"status": "in_progress", "error": None})
        try:
            path = _download_url(str(rec["url"]), out_path)
            _save(
                name,
                {
                    "status": "completed",
                    "ok": True,
                    "file": str(path.resolve()),
                    "error": None,
                },
            )
            return {
                "ok": True,
                "mode": "image",
                "job": name,
                "file": str(path.resolve()),
                "provider": rec.get("provider"),
                "model": rec.get("model"),
                "size": rec.get("size"),
                "resumed_download": True,
            }
        except Exception as e:
            _save(name, {"status": "download_failed", "ok": False, "error": str(e)})
            return {
                "ok": False,
                "mode": "image",
                "job": name,
                "status": "download_failed",
                "error": str(e),
            }

    _save(name, {"status": "in_progress"})

    def _keep_url(url: str | None, _item: dict[str, Any]) -> None:
        if url:
            _save(name, {"url": url, "remote_ready": True})

    try:
        result = generate_sync(
            str(rec.get("prompt") or ""),
            out=out_path,
            images=rec.get("images") or None,
            model=rec.get("model"),
            size=rec.get("size"),
            quality=str(rec.get("quality") or "low"),
            n=int(rec.get("n") or 1),
            provider=str(rec.get("provider") or "") or None,
            on_remote_ready=_keep_url,
            transparent=bool(rec.get("transparent")),
        )
        _save(
            name,
            {
                "status": "completed",
                "ok": True,
                "file": result["file"],
                "url": result.get("url") or rec.get("url"),
                "model": result.get("model"),
                "size": result.get("size"),
                "provider": result.get("provider"),
                "error": None,
            },
        )
        return {"ok": True, "mode": "image", "job": name, **result}
    except Exception as e:
        url = getattr(e, "image_url", None) or rec.get("url")
        if getattr(e, "remote_ready", False) or url:
            _save(
                name,
                {
                    "status": "download_failed",
                    "ok": False,
                    "url": url,
                    "remote_ready": True,
                    "error": str(e),
                },
            )
            return {
                "ok": False,
                "mode": "image",
                "job": name,
                "status": "download_failed",
                "url": url,
                "error": str(e),
            }
        _save(name, {"status": "failed", "ok": False, "error": str(e)})
        return {"ok": False, "mode": "image", "job": name, "status": "failed", "error": str(e)}


def submit(
    name: str,
    prompt: str,
    *,
    out: Path | None = None,
    images: list[str] | None = None,
    model: str | None = None,
    size: str | None = None,
    quality: str = "low",
    n: int = 1,
    provider: str | None = None,
    transparent: bool = False,
) -> dict[str, Any]:
    """Queue a local background worker. Same name already running/completed → no re-POST."""
    rec = _load(name)
    st = str(rec.get("status") or "")
    if st in {"queued", "in_progress", "completed"} and rec.get("submit_sent"):
        return rec
    # Re-pull only when URL was saved after a download failure.
    if st == "download_failed" and rec.get("url") and rec.get("submit_sent"):
        _save(name, {"status": "queued", "error": None, "remote_ready": True})
        _spawn_run_job(name)
        return _load(name)
    # failed / url=null（IncompleteRead 等废单）：同名允许再 POST；故意换图请换 --name 或先删 job

    prov = image_provider(provider)
    use_model = (model or image_model(prov)).strip()
    use_size = (size or image_default_size()).strip()
    out_path = str(Path(out).resolve()) if out else str((OUTPUTS / f"{name}.png").resolve())
    _save(
        name,
        {
            "name": name,
            "mode": "image",
            "provider": prov,
            "submit_sent": True,
            "status": "queued",
            "prompt": prompt,
            "prompt_preview": prompt[:240],
            "model": use_model,
            "size": use_size,
            "quality": quality,
            "n": int(n),
            "images": list(images or []),
            "out": out_path,
            "transparent": bool(transparent),
            "ok": None,
            "file": None,
            "url": None,
            "error": None,
        },
    )
    _spawn_run_job(name)
    return _load(name)


def wait(
    name: str,
    *,
    interval: float = 2.0,
    timeout_s: int = 1800,
    out: Path | None = None,
) -> dict[str, Any]:
    t0 = time.time()
    last = ""
    download_retried = False
    while time.time() - t0 < timeout_s:
        rec = _load(name)
        if not rec:
            raise RuntimeError(f"image job {name!r} not found")
        st = str(rec.get("status") or "")
        msg = f"{name}: {st}"
        if msg != last:
            log_progress(msg)
            last = msg
        if st == "completed" and rec.get("file"):
            path = Path(rec["file"])
            if out and path.is_file() and Path(out).resolve() != path.resolve():
                Path(out).parent.mkdir(parents=True, exist_ok=True)
                Path(out).write_bytes(path.read_bytes())
                path = Path(out)
            return {
                "ok": True,
                "mode": "image",
                "job": name,
                "status": st,
                "provider": rec.get("provider"),
                "model": rec.get("model"),
                "size": rec.get("size"),
                "file": str(path.resolve()),
            }
        if st == "download_failed" and rec.get("url") and not download_retried:
            download_retried = True
            log_progress(f"{name}: resume download from saved url")
            submit(
                name,
                str(rec.get("prompt") or ""),
                out=Path(rec["out"]) if rec.get("out") else None,
                images=rec.get("images") or None,
                model=rec.get("model"),
                size=rec.get("size"),
                quality=str(rec.get("quality") or "low"),
                n=int(rec.get("n") or 1),
                provider=str(rec.get("provider") or "") or None,
                transparent=bool(rec.get("transparent")),
            )
            time.sleep(max(1.0, interval))
            continue
        if st in {"failed", "download_failed"}:
            return {
                "ok": False,
                "mode": "image",
                "job": name,
                "status": st,
                "error": rec.get("error") or "failed",
                "url": rec.get("url"),
            }
        time.sleep(max(1.0, interval))
    raise TimeoutError(f"image job {name!r} timeout after {timeout_s}s ({last})")



def generate(
    prompt: str,
    *,
    out: Path | None = None,
    images: list[str] | None = None,
    model: str | None = None,
    size: str | None = None,
    quality: str = "low",
    n: int = 1,
    name: str | None = None,
    wait_done: bool = True,
    provider: str | None = None,
    transparent: bool = False,
) -> dict[str, Any]:
    if not wait_done:
        job = name or f"img_{int(time.time())}"
        submit(
            job,
            prompt,
            out=out,
            images=images,
            model=model,
            size=size,
            quality=quality,
            n=n,
            provider=provider,
            transparent=transparent,
        )
        rec = _load(job)
        return {
            "ok": True,
            "mode": "image",
            "job": job,
            "status": rec.get("status"),
            "pending": True,
            "provider": rec.get("provider"),
            "model": rec.get("model"),
            "size": rec.get("size"),
        }
    if name:
        submit(
            name,
            prompt,
            out=out,
            images=images,
            model=model,
            size=size,
            quality=quality,
            n=n,
            provider=provider,
            transparent=transparent,
        )
        return wait(name, out=out)
    return generate_sync(
        prompt,
        out=out,
        images=images,
        model=model,
        size=size,
        quality=quality,
        n=n,
        provider=provider,
        transparent=transparent,
    )
