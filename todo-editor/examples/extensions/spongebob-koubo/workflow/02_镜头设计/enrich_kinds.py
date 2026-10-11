"""在不改素材名的前提下，按规则重标 visual / say / text，再供 --rebind。"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

import paths
from llm_briefs import build_rule_briefs, enforce_card_budget, write_bgm_plan
from shot_kinds import (
    VIS_CARD,
    VIS_DIALOGUE,
    VIS_DUO,
    VIS_EMPHASIS,
    VIS_INTRO,
    VIS_REACTION,
    VIS_REVEAL,
    VIS_SCENE,
    VIS_STAMP,
    normalize_visual,
    rule_classify,
    synthesize_emphasis_text,
    synthesize_say,
    synthesize_stamp_text,
)

KEEP = {
    VIS_DIALOGUE,
    VIS_DUO,
    VIS_EMPHASIS,
    VIS_STAMP,
    VIS_INTRO,
    VIS_REVEAL,
    VIS_REACTION,
    VIS_CARD,
}


def main() -> None:
    cache = paths.DESIGN / "briefs_active.json"
    timing = json.loads(paths.TTS_TIMING.read_text(encoding="utf-8"))
    sentences = timing.get("sentences") or []
    if not sentences:
        raise SystemExit("timing has no sentences")

    if cache.is_file():
        data = json.loads(cache.read_text(encoding="utf-8"))
        briefs = data.get("briefs") or []
    else:
        data = {"briefs": [], "bgm": None}
        briefs = []

    if len(briefs) != len(sentences):
        print(
            f"WARN enrich rebuild rule briefs ({len(briefs)} != {len(sentences)})",
            flush=True,
        )
        briefs = build_rule_briefs(sentences)
        data["briefs"] = briefs
        if not data.get("bgm"):
            from llm_briefs import _default_bgm

            data["bgm"] = _default_bgm(float(sentences[-1]["end"]))

    used_stamp = False
    for i, (b, s) in enumerate(zip(briefs, sentences)):
        text = str(s.get("text") or "")
        dur = float(s["end"]) - float(s["start"])
        nph = len(s.get("phrases") or [])
        old = normalize_visual(b.get("visual_prefer"), shot_idx=i)

        if i == 0:
            vis = VIS_INTRO
        elif old in KEEP:
            vis = old
        elif old == VIS_SCENE and nph >= 3 and dur >= 3.5:
            vis = VIS_REVEAL
        else:
            vis = rule_classify(
                i, text, dur, used_stamp=used_stamp, phrase_count=nph
            )

        if vis == VIS_STAMP:
            used_stamp = True
        b["visual_prefer"] = vis
        b["card"] = vis == VIS_CARD
        b["_idx"] = i
        if vis == VIS_DIALOGUE:
            says = synthesize_say(text, list(s.get("phrases") or []))
            chars = [a for a in (b.get("assets") or []) if a.get("role") == "character"]
            for a, sy in zip(chars, says):
                a.update(sy)
        if vis == VIS_EMPHASIS:
            b["text"] = synthesize_emphasis_text(text)
        if vis == VIS_STAMP:
            b["text"] = synthesize_stamp_text(text)

    briefs = enforce_card_budget(briefs, sentences)
    data["briefs"] = briefs
    cache.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if data.get("bgm"):
        write_bgm_plan(data["bgm"])
    for i, b in enumerate(briefs):
        tx = b.get("text") if isinstance(b.get("text"), dict) else {}
        print(
            i,
            b.get("visual_prefer"),
            (tx or {}).get("content") or "",
            [a.get("say") for a in (b.get("assets") or []) if a.get("say")],
        )


if __name__ == "__main__":
    main()
