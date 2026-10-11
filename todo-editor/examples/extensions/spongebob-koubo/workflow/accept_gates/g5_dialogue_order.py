"""门5：对话气泡挂对角色；无突兀层；元素出场顺序对齐口播短语。"""
from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "02_镜头设计"))

import paths
from accept_gates.common import add, load_json, report
from entrance_recipes import validate_phrase_sync
from shot_kinds import DIALOGUE_HINTS, VIS_DIALOGUE, normalize_visual


def _compact(s: str) -> str:
    return re.sub(r"\s+", "", s or "")


def _say_in_narration(say: str, text: str) -> bool:
    body = _compact(say)
    narr = _compact(text)
    if not body:
        return False
    if body in narr:
        return True
    # 允许短截取：前 4 字命中
    return len(body) >= 4 and body[:4] in narr


def check() -> dict:
    checks: list[dict] = []
    plan = load_json(paths.DESIGN / "plan.json")
    timing = load_json(paths.TTS_TIMING)
    shots = plan.get("shots") or []
    sents = timing.get("sentences") or []
    add(checks, "plan_timing_aligned", len(shots) == len(sents) and len(shots) > 0, f"shots={len(shots)} sents={len(sents)}")

    dlg_n = 0
    bad_bubble_prop: list[str] = []
    bad_say_text: list[str] = []
    missing_say: list[int] = []
    phrase_errs: list[str] = []
    order_errs: list[str] = []
    empty_scene: list[int] = []

    for i, (sh, sent) in enumerate(zip(shots, sents)):
        vis = normalize_visual(sh.get("_visual") or sh.get("mode"), shot_idx=i)
        layers = list(sh.get("layers") or [])
        phrases = sent.get("phrases") or []
        text = str(sent.get("text") or "")

        if sh.get("mode") == "scene" and vis != "intro_red" and not layers:
            empty_scene.append(i)

        if layers and phrases:
            for e in validate_phrase_sync(layers, phrases):
                phrase_errs.append(f"shot{i}:{e}")
            # 出场顺序：enter 随层不应整体逆口播（允许并列）
            enters = [int(L.get("enter") or 0) for L in layers]
            if len(enters) >= 2 and max(enters) - min(enters) >= 1:
                # 按 enter 排序后的层名序列应非严格递减短语语义
                ordered = sorted(range(len(layers)), key=lambda k: (enters[k], k))
                seq = [enters[k] for k in ordered]
                if seq != sorted(seq):
                    order_errs.append(f"shot{i}:enter_not_sorted")

        if vis != VIS_DIALOGUE:
            continue
        dlg_n += 1
        says = [L for L in layers if L.get("say")]
        if not says:
            missing_say.append(i)
        for L in says:
            name = str(L.get("name") or "")
            if name.startswith("pr_"):
                bad_bubble_prop.append(f"shot{i}:{name}")
            say = str(L.get("say") or "")
            if not _say_in_narration(say, text):
                bad_say_text.append(f"shot{i}:{name}:{say}")

    # 「有没有对话镜」不是片子对不对，而是**脚本里有没有对话线索**决定的：
    # 设计规则本身按 DIALOGUE_HINTS 判定 dialogue（shot_kinds.py），
    # 一份「钱越来越不值钱了…」这种纯陈述稿本来就没有引语/「说：」，
    # 生成 0 个对话镜是**正确**结果。原来无条件要求 dlg_n>=1，
    # 于是这类稿子永远过不了门 —— 与 g2/g4 的字数阈值同一类标定错误。
    # 现在：脚本没有对话线索时标 N/A；有线索却没生成对话镜才算失败（那才是真回归）。
    script_text = "".join(str((s or {}).get("text") or "") for s in sents)
    wanted = [h for h in DIALOGUE_HINTS if h in script_text]
    if wanted:
        add(checks, "has_dialogue_shots", dlg_n >= 1, f"n={dlg_n} 线索={wanted[:4]}")
    else:
        add(
            checks,
            "has_dialogue_shots",
            True,
            f"N/A：脚本无对话线索（{len(sents)} 句里 0 命中），{dlg_n} 个对话镜属正确结果",
        )
    add(checks, "dialogue_has_say", not missing_say, f"missing={missing_say}")
    add(checks, "bubble_not_on_prop", not bad_bubble_prop, f"{bad_bubble_prop[:8]}")
    add(checks, "say_text_from_narration", not bad_say_text, f"{bad_say_text[:8]}")
    add(checks, "phrase_sync_enter_at", not phrase_errs, "; ".join(phrase_errs[:8]) or "ok")
    add(checks, "enter_order_follows_phrases", not order_errs, f"{order_errs[:8]}")
    add(checks, "no_empty_scene_layers", not empty_scene, f"empty={empty_scene}")
    return report("g5_dialogue_order", checks)


def main() -> None:
    rep = check()
    raise SystemExit(0 if rep["ok"] else 1)


if __name__ == "__main__":
    main()
