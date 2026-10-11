"""密匙 generate_images 批调度（扩展自带）：对接 vendor 的 generate_image / wait_image。

原工作流依赖作者机密匙里的批 API；TO DO 内嵌 vendor/mishi 只有单图接口。
本模块按同样契约：限速提交、在途上限、失败换稿、accept 质检拒图重试。
"""
from __future__ import annotations

import statistics
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Callable

from media import generate_image, wait_image


def generate_images(
    batch: list[dict],
    *,
    size: str = "1024x1024",
    transparent: bool = True,
    images: list[str] | None = None,
    rate: float = 2.0,
    max_inflight: int = 8,
    hedge_min_s: float = 90.0,
    stale_s: float = 150.0,
    max_jobs_per_item: int = 8,
    deadline_s: float = 840.0,
    prompt_fn: Callable[[dict, int], str],
    accept: Callable[[Path, dict], bool],
    on_done: Callable[[dict, dict], None] | None = None,
    reuse: bool = False,
) -> dict[str, Any]:
    del hedge_min_s, stale_s, reuse  # 简化：不做对冲，靠 attempt 重试
    t0 = time.time()
    lock = threading.Lock()
    submit_gap = 1.0 / max(0.2, float(rate))
    next_submit = [0.0]
    jobs_launched = [0]
    latencies: list[float] = []
    billing = False
    billing_err = ""
    results: dict[str, dict] = {
        it["name"]: {"name": it["name"], "ok": False, "jobs": 0, "error": None} for it in batch
    }

    def _throttle() -> None:
        with lock:
            now = time.time()
            wait = max(0.0, next_submit[0] - now)
            next_submit[0] = max(now, next_submit[0]) + submit_gap
        if wait:
            time.sleep(wait)

    def _one(item: dict) -> None:
        nonlocal billing, billing_err
        name = item["name"]
        out_dir = Path(__import__("os").environ.get("KOUBO_WORK", ".")) / "_asset_stage"
        out_dir.mkdir(parents=True, exist_ok=True)
        last_err = None
        for attempt in range(int(max_jobs_per_item)):
            if time.time() - t0 > deadline_s:
                last_err = "deadline"
                break
            if billing:
                break
            job = f"{name}_a{attempt}"
            out = out_dir / f"{job}.png"
            prompt = prompt_fn(item, attempt)
            try:
                _throttle()
                with lock:
                    jobs_launched[0] += 1
                t_job = time.time()
                generate_image(
                    prompt,
                    out=out,
                    images=images,
                    size=size,
                    name=job,
                    wait_done=False,
                    transparent=transparent,
                )
                res = wait_image(job, out=out)
                latencies.append(time.time() - t_job)
                with lock:
                    results[name]["jobs"] = attempt + 1
                if res.get("ok") is False:
                    err = str(res.get("error") or res)
                    last_err = err
                    if any(k in err.lower() for k in ("insufficient", "balance", "billing", "402", "余额")):
                        billing = True
                        billing_err = err
                        break
                    continue
                path = Path(res.get("out") or res.get("file") or out)
                if not path.is_file():
                    path = out
                if not path.is_file():
                    last_err = "no file"
                    continue
                if accept(path, item):
                    with lock:
                        results[name]["ok"] = True
                        results[name]["error"] = None
                    if on_done:
                        on_done(item, results[name])
                    return
                last_err = "accept rejected"
            except Exception as e:
                last_err = str(e)[:240]
                if any(k in last_err.lower() for k in ("insufficient", "balance", "billing", "402", "余额")):
                    billing = True
                    billing_err = last_err
                    break
        with lock:
            results[name]["ok"] = False
            results[name]["error"] = last_err
        if on_done:
            on_done(item, results[name])

    workers = max(1, min(int(max_inflight), len(batch) or 1, 12))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = [pool.submit(_one, it) for it in batch]
        for f in as_completed(futs):
            f.result()

    items = [results[it["name"]] for it in batch]
    # 只报 p50 会把问题藏起来：实测 19 张里 11 张不到 60s，剩下几张拖到 14 分钟，
    # 总耗时几乎全由**尾部**决定（性能准则本来也要求记 p50 与 max）。
    # 这里把分布一并返回，让报告能指出"慢在尾部"而不是让人去猜。
    lat = sorted(latencies)
    def _pct(q: float) -> float | None:
        if not lat:
            return None
        k = min(len(lat) - 1, max(0, int(round(q * (len(lat) - 1)))))
        return round(lat[k], 3)
    return {
        "items": items,
        "jobs_launched": jobs_launched[0],
        "latency_p50": round(statistics.median(latencies), 3) if latencies else None,
        "latency_p90": _pct(0.90),
        "latency_max": round(lat[-1], 3) if lat else None,
        "latency_n": len(lat),
        "billing": billing,
        "error": billing_err or None,
    }
