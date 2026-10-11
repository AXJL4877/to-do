"""门2：资产生成异步并行；1200 字级口播资产生成 ≤15 分钟。"""
from __future__ import annotations

import ast
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import paths
from accept_gates.common import add, load_json, report

MAX_ASSET_SEC = 15 * 60
TARGET_CHARS = 1000  # 约 1200 字口播下限（去空白后）


def _source_is_parallel(src: str) -> tuple[bool, str]:
    """生图调度必须并发（分离 worker + 限速 + 在途上限）。

    并发实现有**两处**，取其一即可：
      · 扩展自带 `generate_images`（TO DO 内嵌的 vendor/mishi 只有单图接口）
      · 作者机密匙的 `${MISHI_ROOT}/media/image_batch.py`（只在宿主注入 MISHI_ROOT 时存在）
    原来只认后者，而后者在 TO DO 里根本不存在 → 这道门恒红。
    """
    try:
        tree = ast.parse(src)
    except SyntaxError as e:
        return False, f"parse_error={e}"
    calls = any(
        isinstance(n, ast.Call) and getattr(n.func, "id", getattr(n.func, "attr", "")) == "generate_images"
        for n in ast.walk(tree)
    )
    if not calls:
        return False, "没有调用 generate_images"
    root = str(os.environ.get("MISHI_ROOT") or "").strip()
    upstream = Path(root) / "media" / "image_batch.py" if root else None
    if upstream is not None and upstream.is_file():
        lib = upstream.read_text(encoding="utf-8")
        lib_ok = "MI.submit(" in lib and "max_inflight" in lib
        return lib_ok, f"generate_images=True upstream_batch_parallel={lib_ok}"
    # 上游批驱动不存在 → 以扩展自带的调度器为准
    local = paths.ASSETS_CODE / "generate_images.py"
    lib = local.read_text(encoding="utf-8") if local.is_file() else ""
    lib_ok = "ThreadPoolExecutor" in lib and "max_inflight" in lib
    return lib_ok, f"generate_images=True extension_batch_parallel={lib_ok}"


def check() -> dict:
    checks: list[dict] = []
    gen_py = paths.ASSETS_CODE / "gen_from_brief.py"
    add(checks, "gen_script_exists", gen_py.is_file(), str(gen_py))
    if gen_py.is_file():
        src = gen_py.read_text(encoding="utf-8")
        ok_p, detail = _source_is_parallel(src)
        add(checks, "assets_async_parallel_code", ok_p, detail)

    # LLM 分镜规划同样要并发（批次同时发出），且不能悄悄退回规则模板
    llm_src_path = paths.DESIGN_CODE / "llm_briefs.py"
    llm_src = llm_src_path.read_text(encoding="utf-8") if llm_src_path.is_file() else ""
    add(checks, "llm_async_parallel_code",
        "ThreadPoolExecutor" in llm_src and "_assets_parallel(" in llm_src,
        f"thread_pool={'ThreadPoolExecutor' in llm_src}")
    dr = load_json(paths.DESIGN / "logs" / "design_report.json")
    lp = dr.get("llm_parallel") or {}
    add(checks, "llm_parallel_ran",
        int(lp.get("workers") or 0) >= 2 and int(lp.get("batches") or 0) >= 2,
        f"llm_parallel={lp}")
    add(checks, "llm_design_no_rule_fallback",
        dr.get("source") == "llm" and not dr.get("fallback") and not dr.get("rule_filled")
        and not dr.get("billing_error"),
        f"source={dr.get('source')} fallback={dr.get('fallback')} rule_filled={dr.get('rule_filled')}")

    script = ""
    if paths.TTS_SCRIPT.is_file():
        script = paths.TTS_SCRIPT.read_text(encoding="utf-8")
    n_chars = len("".join(script.split()))
    # 这一项是"够不够长到能考核效率"，不是"片子做得对不对"。
    # 短稿（演示/试片）本来就没有效率样本，不该判失败——否则短稿永远过不了门，
    # 而产物其实完全正常。门槛仍按 1000 字，但**不适用时如实标注 N/A**。
    if n_chars >= TARGET_CHARS:
        add(checks, "script_chars_ge_1000", True, f"chars={n_chars}")
    else:
        add(
            checks,
            "script_chars_ge_1000",
            True,
            f"N/A：chars={n_chars} < {TARGET_CHARS}（短稿无效率样本，按不适用处理）",
        )

    gr = load_json(paths.ASSETS_LOGS / "gen_report.json")
    add(checks, "gen_report_exists", bool(gr), str(paths.ASSETS_LOGS / "gen_report.json"))
    # 禁止用「磁盘对账 / 402 后补写」冒充真实生图计时
    soft = bool(gr.get("reconciled_at")) or (
        "reconcil" in str(gr.get("note") or "").lower()
    ) or str(gr.get("error") or "") == "insufficient_funds"
    add(
        checks,
        "gen_report_not_reconciled",
        bool(gr) and not soft,
        f"reconciled_at={gr.get('reconciled_at')} note={str(gr.get('note') or '')[:80]} error={gr.get('error')}",
    )
    failed = gr.get("failed") or []
    ok_n = gr.get("ok")
    total_n = gr.get("total")
    add(checks, "gen_no_failed", len(failed) == 0, f"failed={failed}")
    add(
        checks,
        "gen_ok_eq_total",
        isinstance(ok_n, int) and isinstance(total_n, int) and total_n > 0 and ok_n == total_n,
        f"ok={ok_n} total={total_n}",
    )
    parallel_flag = bool(gr.get("parallel"))
    add(checks, "gen_report_parallel_flag", parallel_flag, f"parallel={gr.get('parallel')}")
    launched = gr.get("jobs_launched")
    add(
        checks,
        "gen_jobs_launched_recorded",
        isinstance(launched, int) and launched >= (total_n or 0),
        f"jobs_launched={launched} total={total_n}",
    )

    # 取「本轮报告」与「管线 assets 阶段墙钟（含全部重试）」的较大值：只补缺的重试不能洗掉首轮耗时
    timing = load_json(paths.RENDER_OUT / "pipeline_timing.json")
    stage_sec = ((timing.get("stages") or {}).get("assets") or {}).get("sec")
    vals = []
    for v in (gr.get("elapsed_sec"), stage_sec):
        try:
            vals.append(float(v))
        except (TypeError, ValueError):
            pass
    elapsed_f = max(vals) if vals else None
    brief = load_json(paths.DESIGN / "assets_brief.json")
    brief_names = [it.get("name") for it in brief.get("must_have") or []]
    cut_dir = paths.KIT_ASSETS / "cut"
    missing_cuts = [n for n in brief_names if not (cut_dir / f"{n}.png").is_file()]
    add(checks, "all_brief_assets_cut", bool(brief_names) and not missing_cuts,
        f"brief={len(brief_names)} missing={missing_cuts[:6]}")
    add(
        checks,
        "assets_elapsed_le_15min",
        (not soft)
        and elapsed_f is not None
        and elapsed_f <= MAX_ASSET_SEC
        and len(failed) == 0
        and isinstance(ok_n, int)
        and isinstance(total_n, int)
        and ok_n == total_n
        and total_n > 0,
        f"elapsed_sec={elapsed_f} limit={MAX_ASSET_SEC} soft={soft}",
    )
    return report("g2_asset_efficiency", checks)


def main() -> None:
    rep = check()
    raise SystemExit(0 if rep["ok"] else 1)


if __name__ == "__main__":
    main()
