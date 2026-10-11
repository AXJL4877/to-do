"""读取 01 的 timing.json，生成镜头设计表 + kit plan.json。

默认：Gemini 3.8 Flash 生成逐句 brief + BGM，校验失败自动重试；
失败回退 SCRIPT_BRIEFS 规则匹配。`--rules-only` 跳过 LLM。
`--rebind`：复用已落盘 briefs/bgm，只按现有 cut 重绑 plan（生图后用）。
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import paths

from design import _load_sentences, run
from llm_briefs import (
    BillingError,
    build_rule_briefs,
    generate_briefs,
    write_bgm_plan,
    write_design_report,
    _default_bgm,
)

BRIEFS_CACHE = paths.DESIGN / "briefs_active.json"
BRIEFS_LOCK = paths.DESIGN / "briefs_locked.json"


def _inventory():
    """只读已有 cut 素材名，不跑 build（镜头设计不依赖生图完成）。"""
    cut = paths.KIT_ASSETS / "cut"
    if cut.is_dir():
        names = sorted(p.stem for p in cut.glob("*.png"))
        if names:
            return names
    return []


def _save_briefs(briefs: list | None, bgm_plan: dict) -> None:
    payload = {"briefs": briefs, "bgm": bgm_plan}
    BRIEFS_CACHE.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _load_cached() -> tuple[list | None, dict | None]:
    # rebind 优先锁文件（与生图清单同名），避免 enrich/误写改名导致空层
    src = BRIEFS_LOCK if BRIEFS_LOCK.is_file() else BRIEFS_CACHE
    if not src.is_file():
        return None, None
    data = json.loads(src.read_text(encoding="utf-8"))
    return data.get("briefs"), data.get("bgm")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=20260408, help="scene 元素个数随机种子")
    ap.add_argument("--rules-only", action="store_true", help="不用 LLM，只走 SCRIPT_BRIEFS")
    ap.add_argument("--rebind", action="store_true", help="复用 briefs_active.json，只重绑 cut")
    ap.add_argument("--design-attempts", type=int, default=3)
    args = ap.parse_args()
    paths.ensure()
    if not paths.TTS_TIMING.is_file():
        raise SystemExit(f"缺少 {paths.TTS_TIMING}，请先跑 01_口播试听/run_tts.py")

    names = _inventory()
    sentences = _load_sentences(paths.TTS_TIMING)
    duration = float(sentences[-1]["end"]) if sentences else 60.0
    briefs = None
    bgm_plan = _default_bgm(duration)
    design_report = {"source": "rules", "ok": True, "model": None}

    if args.rebind:
        briefs, cached_bgm = _load_cached()
        if cached_bgm:
            bgm_plan = cached_bgm
        # rebind 也强制红字跟当前 timing 首句，避免旧主题 intro_lines 残留
        if briefs and sentences:
            from llm_briefs import (
                sanitize_intro_lines,
                normalize_bgm_plan,
                _coerce_phrase_match,
            )

            briefs[0]["intro_lines"] = sanitize_intro_lines(
                briefs[0].get("intro_lines"),
                source_text=str((sentences[0] or {}).get("text") or ""),
            )
            briefs[0]["visual_prefer"] = "intro_red"
            # 缓存里若残留「整串被拆成单字」的 phrase_match，会把 scene 绑成空层
            for b in briefs:
                for a in b.get("assets") or []:
                    if isinstance(a, dict):
                        a["phrase_match"] = _coerce_phrase_match(a.get("phrase_match"))
            bgm_plan = normalize_bgm_plan(bgm_plan or _default_bgm(duration))
            _save_briefs(briefs, bgm_plan)
        rp = paths.DESIGN / "logs" / "design_report.json"
        try:
            design_report = json.loads(rp.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            design_report = {"source": "rebind", "ok": True, "model": None}
        design_report["rebound"] = True
        write_design_report(design_report)
    elif not args.rules_only:
        try:
            briefs, bgm_plan, design_report = generate_briefs(
                sentences, max_attempts=args.design_attempts
            )
        except BillingError as exc:
            print("STOP billing (LLM):", str(exc)[:200], flush=True)
            raise SystemExit(2)
        if not briefs:
            briefs = build_rule_briefs(sentences)
            design_report["source"] = "rules_fallback"
            print("llm_design fallback → build_rule_briefs", len(briefs))
        write_design_report(design_report)
        _save_briefs(briefs, bgm_plan)
    else:
        briefs = build_rule_briefs(sentences)
        write_design_report(design_report)
        _save_briefs(briefs, bgm_plan)

    write_bgm_plan(bgm_plan)

    payload = run(
        paths.TTS_TIMING,
        paths.DESIGN,
        seed=args.seed,
        available_names=names or None,
        briefs=briefs,
        bgm_plan=bgm_plan,
    )
    s = payload["summary"]
    print(
        "shots_design.json",
        "source", payload.get("design_source"),
        "intro", s.get("intro_red"),
        "scene", s.get("scene"),
        "card", s.get("card"),
        "dialogue", s.get("dialogue"),
        "duo", s.get("duo"),
        "emphasis", s.get("emphasis"),
        "stamp", s.get("stamp"),
        "reveal", s.get("reveal"),
        "reaction", s.get("reaction"),
        "slots", s.get("asset_slots"),
        "missing", s.get("missing_assets"),
        "seed", payload["seed"],
        "bgm_segs", len((bgm_plan or {}).get("segments") or []),
    )
    print(
        "written",
        paths.DESIGN / "shots_design.json",
        paths.DESIGN / "plan.json",
        paths.DESIGN / "bgm_plan.json",
        paths.DESIGN / "镜头表.md",
        paths.DESIGN / "素材需求.md",
    )


if __name__ == "__main__":
    main()
