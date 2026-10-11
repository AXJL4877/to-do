"""门8：成片排版——大字无缺字、底部字幕常驻、元素不过大、气泡只放台词、标题是完整短语、镜头有运镜。"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "kit"))

import paths
from accept_gates.common import add, load_json, report
from kit import bubble, render as R, typo

MAX_ELEM_H = 0.67  # 静止上限 0.56H × 推近 1.10 + 余量
PUNCT = set(typo._DISPLAY_STRIP)


def _dropped(text: str, font) -> str:
    """去标点后仍被剔除的字 = 字体真缺字（会丢字），必须为空。"""
    body = "".join(ch for ch in str(text or "") if ch not in PUNCT and not ch.isspace())
    return typo.missing_glyphs(body, font)


def check() -> dict:
    checks: list[dict] = []
    plan = load_json(paths.DESIGN / "plan.json")
    timing = load_json(paths.TTS_TIMING)
    lp = paths.RENDER_OUT / "layout_check.json"
    layout = json.loads(lp.read_text(encoding="utf-8")) if lp.is_file() else []
    shots = plan.get("shots") or []
    sents = timing.get("sentences") or []

    glyph_bad: list[str] = []
    for i, s in enumerate(sents):
        for p in s.get("phrases") or []:
            miss = _dropped(p.get("text"), typo.CARD_FONT)
            if miss and (i < len(shots) and shots[i].get("mode") == "card"):
                glyph_bad.append(f"card{i}:{miss}")
            if _dropped(p.get("text"), typo.SUB_FONT):
                glyph_bad.append(f"sub{i}:{_dropped(p.get('text'), typo.SUB_FONT)}")
    say_bad: list[str] = []
    title_bad: list[str] = []
    for i, sh in enumerate(shots):
        for L in sh.get("layers") or []:
            say = str(L.get("say") or "")
            if say and (bubble.speech_only(say) != say or re.search(r"[：:]$", say)):
                say_bad.append(f"shot{i}:{say}")
            if say and _dropped(say, typo.SUB_FONT):
                glyph_bad.append(f"say{i}:{_dropped(say, typo.SUB_FONT)}")
        t = sh.get("text")
        if isinstance(t, dict) and t.get("content"):
            phrase = typo.title_phrase(t["content"])
            sent = str(sents[i].get("text") or "") if i < len(sents) else ""
            # 末字是虚词时，只有【收不在分句边界】才算半句被截断。
            # 完整分句以虚词收尾是正常的：「抄不走的才是你的」的「的」是语义核心（"才是你的"），
            # 按末字一刀切会逼渲染侧砍掉它（原版花字恰好没有以虚词收尾，所以从没暴露）。
            if phrase and ((phrase[-1] in typo._TAIL_WEAK and not typo.ends_at_clause(phrase, sent))
                           or any(c in PUNCT for c in phrase)):
                title_bad.append(f"shot{i}:{phrase}")
            if _dropped(t["content"], typo.HUAZI_FONT):
                glyph_bad.append(f"title{i}:{_dropped(t['content'], typo.HUAZI_FONT)}")

    scene_rows = [r for r in layout if r.get("mode") == "scene"]
    no_sub = [r.get("t") for r in scene_rows if not str(r.get("subtitle") or "").strip()]
    too_big = []
    for r in scene_rows:
        for d in r.get("layers") or []:
            name = str(d.get("name") or "")
            if name == "huazi" or name.startswith("bubble:") or not d.get("settled", True):
                continue
            if d.get("box") and d["box"][3] > MAX_ELEM_H * R.H:
                too_big.append(f"t={r.get('t')}:{name}:{d['box'][3] / R.H:.2f}")
    narr = {i: str(s.get("text") or "") for i, s in enumerate(sents)}
    hz_bad = []
    for r in scene_rows:
        for d in r.get("layers") or []:
            if d.get("name") == "huazi":
                txt = str(d.get("text") or "")
                text_n = narr.get(int(r.get("shot", -1)), "")
                at_clause = typo.ends_at_clause(txt, text_n)
                half = not at_clause and len(txt) < typo.HUAZI_MAX - 1
                # 末字是虚词时，只有在【收不在分句边界】时才算问题——那时它确实是半句。
                # 完整分句以虚词收尾是正常的：「抄不走的才是你的」里的「的」是语义核心
                # （"才是你的"），按末字一刀切会把它误判成截断，并逼得渲染侧砍掉那个字。
                weak_tail = txt[-1] in typo._TAIL_WEAK + "不没很最太更" and not at_clause
                if len(txt) < 2 or len(txt) > typo.HUAZI_MAX or half or weak_tail:
                    hz_bad.append(f"shot{r.get('shot')}:{txt}")

    # 每条台词都必须在抽样帧里真的画出气泡，挂在说话角色身上，台词收在分句边界
    bubbles_seen: dict[int, list[tuple[str, str]]] = {}
    for r in scene_rows:
        for d in r.get("layers") or []:
            if str(d.get("name") or "").startswith("bubble:"):
                bubbles_seen.setdefault(int(r.get("shot", -1)), []).append(
                    (d["name"].split(":", 1)[1], str(d.get("text") or "")))
    bubble_bad: list[str] = []
    for i, sh in enumerate(shots):
        for L in sh.get("layers") or []:
            say = str(L.get("say") or "")
            if not say:
                continue
            name = str(L.get("name") or "")
            seen = [t for n, t in bubbles_seen.get(i, []) if n == name]
            if not seen:
                bubble_bad.append(f"shot{i}:{name}:not_rendered")
            elif not typo.ends_at_clause(say, narr.get(i, "")):
                bubble_bad.append(f"shot{i}:{say}:half_clause")
    render_src = (Path(R.__file__)).read_text(encoding="utf-8")
    moves = [m[0] != m[1] for m in R.SHOT_MOVES]

    add(checks, "layout_log_present", len(scene_rows) >= max(1, len(shots) // 2),
        f"scene_samples={len(scene_rows)} shots={len(shots)}")
    add(checks, "glyph_coverage", not glyph_bad, f"{glyph_bad[:8]}")
    add(checks, "subtitle_every_scene", not no_sub, f"missing_at={no_sub[:8]}")
    add(checks, "element_height_cap", not too_big, f"{too_big[:8]}")
    add(checks, "bubble_is_speech", not say_bad, f"{say_bad[:8]}")
    add(checks, "bubble_rendered_on_speaker", not bubble_bad, f"{bubble_bad[:8]}")
    add(checks, "title_whole_phrase", not title_bad and not hz_bad, f"{(title_bad + hz_bad)[:8]}")
    add(checks, "camera_moves_rotate",
        "shot_move(frame, drawn, idx" in render_src and len(R.SHOT_MOVES) >= 3 and all(moves),
        f"moves={len(R.SHOT_MOVES)}")
    return report("g8_layout_text", checks)


def main() -> None:
    rep = check()
    raise SystemExit(0 if rep["ok"] else 1)


if __name__ == "__main__":
    main()
