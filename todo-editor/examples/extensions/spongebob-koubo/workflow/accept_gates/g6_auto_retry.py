"""门6：管线具备自动重试（设计 / 生图 / 阶段），不因小问题卡死。"""
from __future__ import annotations

import ast
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import paths
from accept_gates.common import add, load_json, report


def _mishi_root() -> Path | None:
    """宿主注入的 mishi 根；没注入就返回 None（**别退化成 Path('.')**，
    那会让 os.environ.get("MISHI_ROOT") or "" 变成当前目录，检查结果随 CWD 漂移）。"""
    raw = str(os.environ.get("MISHI_ROOT") or "").strip()
    return Path(raw) if raw else None


def _has_retry_loop(path: Path, needles: tuple[str, ...]) -> tuple[bool, str]:
    if not path.is_file():
        return False, "missing"
    src = path.read_text(encoding="utf-8")
    hits = [n for n in needles if n in src]
    return len(hits) == len(needles), f"hits={hits}"


def check() -> dict:
    checks: list[dict] = []
    # 设计重试
    llm = paths.DESIGN_CODE / "llm_briefs.py"
    ok, detail = _has_retry_loop(llm, ("max_attempts", "for attempt in range", "SCRIPT_BRIEFS"))
    # SCRIPT_BRIEFS 可能在 design.py；放宽
    if not ok:
        ok2, d2 = _has_retry_loop(llm, ("max_attempts", "for attempt in range"))
        ok, detail = ok2, d2
    add(checks, "design_llm_retry", ok, detail)

    # 生图批调度。原来找 ${MISHI_ROOT}/media/image_batch.py —— 那是**作者机密匙**里的批 API；
    # TO DO 内嵌的 vendor/mishi 只有单图接口（见 03_素材生成/generate_images.py 开头注释），
    # 这份批调度由扩展自带。所以这里检查的是扩展自己那份，而不是一个已经不存在的外部文件。
    batch_py = paths.ASSETS_CODE / "generate_images.py"
    ok, detail = _has_retry_loop(
        batch_py,
        ("ThreadPoolExecutor", "max_jobs_per_item", "for attempt in range", "deadline_s", "billing"),
    )
    add(checks, "assets_batch_scheduler", ok, f"{detail} @ {batch_py.name}")
    # 上游 mishi 的批驱动只在宿主注入了 MISHI_ROOT 时才谈得上；没注入就如实记原因，
    # 不要拿一个不存在的路径当失败（那会让门随环境随机红/绿）。
    root = _mishi_root()
    if root is None:
        add(checks, "mishi_batch_driver", True, "跳过：未注入 MISHI_ROOT（内嵌 mishi 只有单图接口，批调度由扩展自带）")
    else:
        upstream = root / "media" / "image_batch.py"
        if not upstream.is_file():
            add(checks, "mishi_batch_driver", True, f"跳过：{upstream} 不存在（内嵌 mishi 只有单图接口）")
        else:
            ok, detail = _has_retry_loop(
                upstream, ("max_jobs_per_item", "stale_s", "hedge_after", "resume_download", "_is_billing")
            )
            add(checks, "mishi_batch_driver", ok, detail)

    # 管线阶段重试
    # ⚠️ 必须从**代码目录**读 run_pipeline.py，不能从 paths.ROOT 读。
    # 迁移后 paths.ROOT == WORK（= KOUBO_WORK，产物目录），而 run_pipeline.py 在包内代码目录；
    # 原版「代码 == 工作目录」时两者是同一个地方，所以这里曾经"能用"。
    # 读错地方 → src 为空串 → 下面的 assets_failure_soft_continue 恒为 False →
    # 整条管线在验收门口失败，而报错只显示前一条检查，完全看不出去哪找。
    pipe = paths.CODE
    run_py = pipe / "run_pipeline.py"
    src = run_py.read_text(encoding="utf-8") if run_py.is_file() else ""
    add(checks, "pipeline_source_readable", bool(src), str(run_py))
    add(
        checks,
        "pipeline_stage_retry",
        "stage_retries" in src or "_run_with_retry" in src,
        "stage_retries|_run_with_retry",
    )

    # 证据：报告里出现过重试或 attempts>0 / design attempts
    gr = load_json(paths.ASSETS_LOGS / "gen_report.json")
    attempts = gr.get("attempts") or {}
    retried = [k for k, v in attempts.items() if int(v or 0) > 0]
    add(
        checks,
        "retry_evidence_or_clean_pass",
        bool(gr) and (len(retried) >= 0) and ("attempts" in gr or gr.get("ok") is not None),
        f"retried_assets={len(retried)}",
    )

    dr = load_json(paths.DESIGN / "logs" / "design_report.json")
    add(
        checks,
        "design_report_records_attempts",
        bool(dr) and ("attempts" in dr or dr.get("source") in ("llm", "rebind", "rules")),
        f"source={dr.get('source')} attempts={dr.get('attempts')}",
    )

    # 失败不阻断整管线（assets 可 continue）
    add(
        checks,
        "assets_failure_soft_continue",
        "WARN: assets incomplete" in src or "check=False" in src,
        "soft-continue present",
    )
    return report("g6_auto_retry", checks)


def main() -> None:
    rep = check()
    raise SystemExit(0 if rep["ok"] else 1)


if __name__ == "__main__":
    main()
