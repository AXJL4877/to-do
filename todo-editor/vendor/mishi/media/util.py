"""Shared HTTP helpers (stdlib only)."""
from __future__ import annotations

import http.client
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request
from typing import Any


def log_progress(msg: str) -> None:
    """Human progress → stderr only. stdout must stay machine JSON (see run.py _emit)."""
    print(msg, file=sys.stderr, flush=True)


def _proxy_is_loopback() -> bool:
    """Windows 系统代理常指到 127.0.0.1:xxxxx（Clash 等）；失效时易 IncompleteRead/SSL EOF。"""
    try:
        proxies = urllib.request.getproxies() or {}
    except Exception:
        return False
    for key in ("https", "http", "all"):
        val = str(proxies.get(key) or "").strip().lower()
        if "127.0.0.1" in val or "localhost" in val or "[::1]" in val:
            return True
    return False


def _want_direct() -> bool:
    if os.environ.get("MISHI_DIRECT") == "1":
        return True
    # 本机环回代理：默认直连上游，避免半残代理把虎妞回包掐成 IncompleteRead
    if os.environ.get("MISHI_USE_SYSTEM_PROXY") == "1":
        return False
    return _proxy_is_loopback()


def _opener(*, force_direct: bool | None = None) -> urllib.request.OpenerDirector:
    """MISHI_DIRECT=1 或环回代理 → 忽略系统代理。MISHI_USE_SYSTEM_PROXY=1 强制走系统代理。"""
    direct = _want_direct() if force_direct is None else force_direct
    if direct:
        return urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return urllib.request.build_opener()


def urlopen(req: urllib.request.Request, *, timeout: int = 120, force_direct: bool | None = None):
    return _opener(force_direct=force_direct).open(req, timeout=timeout)


def _is_transient_net(exc: BaseException) -> bool:
    if isinstance(exc, (TimeoutError, ConnectionError, ConnectionResetError, BrokenPipeError)):
        return True
    if isinstance(exc, http.client.IncompleteRead):
        return True
    if isinstance(exc, ssl.SSLError):
        return True
    if isinstance(exc, urllib.error.URLError):
        reason = exc.reason
        if isinstance(reason, BaseException):
            return _is_transient_net(reason)
        msg = str(reason or exc).lower()
        return any(
            s in msg
            for s in (
                "incomplete",
                "unexpected_eof",
                "eof occurred",
                "connection reset",
                "timed out",
                "temporarily unavailable",
                "broken pipe",
            )
        )
    msg = str(exc).lower()
    return "incompleteread" in msg or "unexpected_eof" in msg


def http_json(
    method: str,
    url: str,
    *,
    headers: dict[str, str],
    body: dict[str, Any] | None = None,
    timeout: int = 120,
    attempts: int = 4,
) -> tuple[int, Any]:
    """POST/GET JSON。对 IncompleteRead / SSL EOF / 连接重置自动重试；环回代理失败时改直连再试。"""
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    last: BaseException | None = None
    force_direct: bool | None = None
    n = max(1, int(attempts))
    for i in range(n):
        try:
            with urlopen(req, timeout=timeout, force_direct=force_direct) as resp:
                raw = resp.read().decode("utf-8", "replace")
                try:
                    return resp.status, json.loads(raw) if raw else {}
                except json.JSONDecodeError:
                    return resp.status, raw
        except urllib.error.HTTPError as e:
            # 4xx/5xx 有正文：原样返回给上层（502 等由业务决定是否重试）
            raw = e.read().decode("utf-8", "replace")
            try:
                return e.code, json.loads(raw)
            except json.JSONDecodeError:
                return e.code, raw
        except BaseException as e:
            last = e
            if not _is_transient_net(e) or i + 1 >= n:
                break
            # 经系统环回代理失败 → 后续尝试强制直连
            if force_direct is not True and _proxy_is_loopback():
                force_direct = True
                log_progress(f"http_json: transient ({type(e).__name__}); retry direct {i + 2}/{n}")
            else:
                log_progress(f"http_json: transient ({type(e).__name__}); retry {i + 2}/{n}")
            time.sleep(1.2 * (i + 1))
    assert last is not None
    raise last
