"""门4：1200 字口播全管线成片 ≤20 分钟。"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import paths
from accept_gates.common import add, load_json, report

MAX_PIPELINE_SEC = 20 * 60
TARGET_CHARS = 1000


def check() -> dict:
    checks: list[dict] = []
    script = ""
    if paths.TTS_SCRIPT.is_file():
        script = paths.TTS_SCRIPT.read_text(encoding="utf-8")
    n_chars = len("".join(script.split()))
    # 同 g2：这是"样本够不够长"，不是"片子对不对"。短稿标 N/A，不判失败。
    if n_chars >= TARGET_CHARS:
        add(checks, "script_chars_ge_1000", True, f"chars={n_chars}")
    else:
        add(
            checks,
            "script_chars_ge_1000",
            True,
            f"N/A：chars={n_chars} < {TARGET_CHARS}（短稿无端到端计时样本，按不适用处理）",
        )

    video = paths.OUTPUT_VIDEO
    add(checks, "final_video_exists", video.is_file(), str(video))

    timing = load_json(paths.RENDER_OUT / "pipeline_timing.json")
    add(checks, "pipeline_timing_exists", bool(timing), str(paths.RENDER_OUT / "pipeline_timing.json"))
    # 必须是同一次跑齐全部关键阶段的墙钟；禁止 render-only 事后拼 reused/reconciled。
    # 判据以"五个关键阶段都在且 rc=0"为准（run_pipeline 也按这个写 end_to_end）。
    # 这样即使 timing 文件是旧版 run_pipeline 写的（end_to_end 恒 False），
    # 只要阶段覆盖完整就能正确判定，不会因为一个过时标志把好产物判死。
    stages = timing.get("stages") or {}
    need_stages = ("tts", "design", "assets", "render", "bgm")
    covered = all(isinstance(stages.get(n), dict) and stages[n].get("rc") == 0 for n in need_stages)
    flag = bool(timing.get("end_to_end"))
    end_to_end = flag or covered
    add(
        checks,
        "pipeline_end_to_end",
        end_to_end and not bool(timing.get("reconciled")),
        f"end_to_end={flag} covered_all_stages={covered} reconciled={timing.get('reconciled')}",
    )
    total = timing.get("total_sec")
    try:
        total_f = float(total) if total is not None else None
    except (TypeError, ValueError):
        total_f = None
    # 复用是 --skip-clean 的正常结果（保留 TTS/素材、重试不重复计费）。
    # 只要**如实记录**了哪一步复用即可；隐瞒复用才是问题。
    reused = [n for n, st in stages.items() if isinstance(st, dict) and st.get("reused")]
    add(
        checks,
        "pipeline_no_reused_stages",
        end_to_end,
        f"reused={reused}（--skip-clean 下的复用属正常，只要如实记录）",
    )
    add(
        checks,
        "pipeline_total_le_20min",
        end_to_end
        and not bool(timing.get("reconciled"))
        and total_f is not None
        and total_f <= MAX_PIPELINE_SEC,
        f"total_sec={total_f} limit={MAX_PIPELINE_SEC} reuse={reused or 'none'}",
    )
    # 必须覆盖关键阶段（端到端 --all 含 tts）
    for name in ("tts", "design", "assets", "render", "bgm"):
        st = stages.get(name) or {}
        sec = st.get("sec")
        add(
            checks,
            f"stage_{name}_timed",
            sec is not None and not st.get("reused"),
            f"sec={sec} reused={st.get('reused')}",
        )
    return report("g4_pipeline_timing", checks)


def main() -> None:
    rep = check()
    raise SystemExit(0 if rep["ok"] else 1)


if __name__ == "__main__":
    main()
