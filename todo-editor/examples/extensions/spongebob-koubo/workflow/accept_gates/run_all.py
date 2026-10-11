"""跑完全部硬验收门；全部通过且 --shutdown 时自动关机。"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import paths

GATES = (
    "g1_shot_diversity",
    "g2_asset_efficiency",
    "g3_bgm_prescribed",
    "g4_pipeline_timing",
    "g5_dialogue_order",
    "g6_auto_retry",
    "g8_layout_text",
    "g7_shutdown_armed",
)


def _arm_shutdown(armed: bool, delay_sec: int) -> None:
    out_dir = paths.RENDER_OUT / "accept_gates"
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "armed": bool(armed),
        "delay_sec": int(delay_sec),
        "ts": time.time(),
    }
    (out_dir / "shutdown_arm.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _run_gate(mod: str) -> int:
    script = Path(__file__).resolve().parent / f"{mod}.py"
    print("+", sys.executable, script, flush=True)
    return subprocess.run([sys.executable, str(script)]).returncode


def _do_shutdown(delay_sec: int) -> None:
    # Windows
    cmd = ["shutdown", "/s", "/t", str(int(delay_sec)), "/c", "koubo accept_gates PASS"]
    print("SHUTDOWN ARMED:", " ".join(cmd), flush=True)
    subprocess.run(cmd, check=False)


def main() -> None:
    ap = argparse.ArgumentParser(description="口播管线硬验收门")
    ap.add_argument(
        "--shutdown",
        action="store_true",
        help="全部通过后自动关机（要求7）",
    )
    ap.add_argument("--no-shutdown", action="store_true", help="显式禁止关机")
    ap.add_argument("--shutdown-delay", type=int, default=90, help="关机倒计时秒")
    ap.add_argument("--skip-g7", action="store_true", help="调试时跳过 g7")
    args = ap.parse_args()

    paths.ensure()
    # 先武装，供 g7 检查
    want_shutdown = bool(args.shutdown) and not bool(args.no_shutdown)
    _arm_shutdown(True, args.shutdown_delay)

    results = []
    gates = [g for g in GATES if not (args.skip_g7 and g == "g7_shutdown_armed")]
    # g7 依赖 arm 文件，放最后；先跑 1-6
    ordered = [g for g in gates if g != "g7_shutdown_armed"]
    if "g7_shutdown_armed" in gates:
        ordered.append("g7_shutdown_armed")

    ok_all = True
    for g in ordered:
        rc = _run_gate(g)
        results.append({"gate": g, "ok": rc == 0, "rc": rc})
        if rc != 0:
            ok_all = False

    summary = {
        "ok": ok_all,
        "results": results,
        "shutdown_requested": want_shutdown,
        "ts": time.time(),
    }
    out = paths.RENDER_OUT / "accept_gates" / "summary.json"
    out.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("GATES", "PASS" if ok_all else "FAIL", out, flush=True)

    if ok_all and want_shutdown:
        _do_shutdown(args.shutdown_delay)
    elif ok_all:
        print("all gates passed; shutdown not requested (use --shutdown)", flush=True)
    else:
        print("gates failed; no shutdown", flush=True)

    raise SystemExit(0 if ok_all else 1)


if __name__ == "__main__":
    main()
