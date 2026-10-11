"""门7：验收通过后自动关机 — 本门检查关机动作已武装（脚本+开关），不在此门内立刻关机。"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import paths
from accept_gates.common import add, load_json, report


def check() -> dict:
    checks: list[dict] = []
    run_all = Path(__file__).resolve().parent / "run_all.py"
    src = run_all.read_text(encoding="utf-8") if run_all.is_file() else ""
    add(checks, "run_all_exists", bool(src), str(run_all))
    add(
        checks,
        "shutdown_impl_present",
        ("shutdown" in src.lower()) and ("/s" in src or "os.system" in src or "subprocess" in src),
        "shutdown command wiring",
    )
    pipe = Path(__file__).resolve().parents[1] / "run_pipeline.py"
    psrc = pipe.read_text(encoding="utf-8") if pipe.is_file() else ""
    add(
        checks,
        "pipeline_shutdown_flag",
        "shutdown" in psrc.lower() and ("--shutdown" in psrc or "shutdown_on_pass" in psrc),
        "pipeline flag",
    )
    # 武装标记：最近一次总验收写过 armed=true（由 run_all 写入）
    meta = load_json(paths.RENDER_OUT / "accept_gates" / "shutdown_arm.json")
    add(
        checks,
        "shutdown_arm_file",
        bool(meta.get("armed")),
        f"{meta}",
    )
    return report("g7_shutdown_armed", checks)


def main() -> None:
    rep = check()
    raise SystemExit(0 if rep["ok"] else 1)


if __name__ == "__main__":
    main()
