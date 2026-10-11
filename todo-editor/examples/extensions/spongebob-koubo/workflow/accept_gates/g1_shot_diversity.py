"""门1：镜头种类≥7；相邻 visual 异质；相邻出场配方多样。"""
from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "02_镜头设计"))

import paths
from accept_gates.common import add, load_json, report
from shot_kinds import VIS_ALL, normalize_visual

MIN_KINDS = 7
MAX_ADJ_ENTRANCE_SAME_RATIO = 0.35
MIN_ENTRANCE_KINDS = 5


def check() -> dict:
    checks: list[dict] = []
    plan = load_json(paths.DESIGN / "plan.json")
    design = load_json(paths.DESIGN / "shots_design.json")
    shots = plan.get("shots") or []
    add(checks, "plan_has_shots", len(shots) >= 7, f"n={len(shots)}")

    visuals = [
        normalize_visual(s.get("_visual") or s.get("mode"), shot_idx=i)
        for i, s in enumerate(shots)
    ]
    kinds = {v for v in visuals if v in VIS_ALL}
    add(checks, "unique_visuals_ge_7", len(kinds) >= MIN_KINDS, f"n={len(kinds)} kinds={sorted(kinds)}")

    adj_vis = [i for i in range(1, len(visuals)) if visuals[i] == visuals[i - 1]]
    add(checks, "adjacent_visual_diverse", len(adj_vis) == 0, f"dup_idx={adj_vis[:12]}")

    entrances = [str(s.get("_entrance") or "") for s in shots]
    multi = [
        (i, entrances[i])
        for i, s in enumerate(shots)
        if (s.get("mode") != "card") and len(s.get("layers") or []) >= 1
    ]
    ent_kinds = {e for _, e in multi if e and e not in ("empty",)}
    add(
        checks,
        "entrance_kinds_ge_5",
        len(ent_kinds) >= MIN_ENTRANCE_KINDS,
        f"n={len(ent_kinds)} kinds={sorted(ent_kinds)}",
    )

    adj_ent_same = 0
    adj_ent_total = 0
    for a, b in zip(multi, multi[1:]):
        if a[0] + 1 != b[0]:
            # 中间隔了 card 等，仍比相邻句
            pass
        adj_ent_total += 1
        if a[1] == b[1] and a[1] not in ("", "empty", "card"):
            adj_ent_same += 1
    # 用镜头序列相邻（含全部 beach）再算一次更严
    beach_idx = [i for i, s in enumerate(shots) if s.get("mode") != "card"]
    same = 0
    tot = 0
    for j in range(1, len(beach_idx)):
        i0, i1 = beach_idx[j - 1], beach_idx[j]
        if i1 != i0 + 1:
            continue
        e0, e1 = entrances[i0], entrances[i1]
        if not e0 or not e1 or e0 == "card" or e1 == "card":
            continue
        tot += 1
        if e0 == e1:
            same += 1
    ratio = (same / tot) if tot else 0.0
    add(
        checks,
        "adjacent_entrance_diverse",
        ratio <= MAX_ADJ_ENTRANCE_SAME_RATIO,
        f"same={same}/{tot} ratio={ratio:.2f} counter={dict(Counter(entrances))}",
    )

    summary = (design.get("summary") or {}) if design else {}
    add(checks, "design_summary_present", bool(summary), str(summary)[:120])
    return report("g1_shot_diversity", checks, extra={"visuals": visuals, "entrances": entrances})


def main() -> None:
    rep = check()
    raise SystemExit(0 if rep["ok"] else 1)


if __name__ == "__main__":
    main()
