"""门3：BGM 三段硬锁（Holding Court → 精卫降调 → Memories），LLM 阶段即规定。"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "02_镜头设计"))

import paths
from accept_gates.common import add, load_json, report
from bgm_policy import BGM_DEFAULT_SOURCES, normalize_bgm_plan, validate_sources


def check() -> dict:
    checks: list[dict] = []
    # 源码硬锁：llm_briefs 必须引用规定曲目
    llm_py = paths.DESIGN_CODE / "llm_briefs.py"
    src = llm_py.read_text(encoding="utf-8") if llm_py.is_file() else ""
    add(checks, "llm_briefs_exists", bool(src), str(llm_py))
    for key, name in BGM_DEFAULT_SOURCES.items():
        # 文件名片段即可（避免编码噪音）
        needle = "Holding Court" if key == "intro" else ("精卫" if key == "mid" else "Memories")
        add(checks, f"llm_mentions_{key}", needle in src, needle)

    bgm_path = paths.DESIGN / "bgm_plan.json"
    raw = load_json(bgm_path)
    add(checks, "bgm_plan_exists", bool(raw.get("segments")), str(bgm_path))
    bp = normalize_bgm_plan(dict(raw)) if raw else {}
    if bp:
        bgm_path.write_text(
            __import__("json").dumps(bp, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    errs = validate_sources(bp) if bp else ["missing plan"]
    add(checks, "bgm_validate_sources", not errs, str(errs) or "ok")

    by_id = {str(s.get("id")): s for s in (bp.get("segments") or [])}
    for sid, expect in BGM_DEFAULT_SOURCES.items():
        got = str((by_id.get(sid) or {}).get("source") or "")
        ok = expect in got or (
            ("Holding Court" in got and sid == "intro")
            or ("精卫" in got and sid == "mid")
            or ("Memories" in got and sid == "outro")
        )
        add(checks, f"seg_{sid}_source", ok, f"got={got!r} expect~{expect!r}")

    # 叠轨日志
    mix_log = paths.RENDER_OUT / "_bgm_mix" / "ffmpeg_bgm.txt"
    log = mix_log.read_text(encoding="utf-8", errors="replace") if mix_log.is_file() else ""
    add(checks, "mix_log_exists", bool(log), str(mix_log))
    if log:
        add(checks, "mix_uses_holding_court", "Holding Court" in log, "Holding Court")
        add(checks, "mix_uses_jingwei", "精卫" in log, "精卫")
        add(checks, "mix_uses_memories", "Memories" in log or "TRA$H" in log, "Memories")

    return report("g3_bgm_prescribed", checks)


def main() -> None:
    rep = check()
    raise SystemExit(0 if rep["ok"] else 1)


if __name__ == "__main__":
    main()
