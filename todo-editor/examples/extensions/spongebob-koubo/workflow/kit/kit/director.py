"""The director: decide, per sentence, whether to *show* it or *say* it big.

This is the piece the pipeline was missing. The example alternates two modes and
never uses one for everything:

  card   big yellow type laid across a dimmed figure on black. Used for a claim,
         a summary, a turn, a punchline -- anything whose job is to land, and
         anything with no concrete thing to point at. 7 of its 18 beats.
  scene  elements staged on the beach background, brought in on the phrase
         boundaries of the narration. Used for anything showable: an action, an
         object, a comparison. 11 of its 18 beats.

The LLM picks the mode and casts the elements; everything it returns is clamped
and repaired against the real asset list before it reaches the renderer.
"""
from __future__ import annotations

import json
import re

from . import assets as A
from . import llm
from . import stage

CARD_MIN_SECONDS = 1.5
SCENE_MIN_SECONDS = 1.4

STYLE_GUIDE = """\
You are directing a 59-second vertical-style Chinese finance short in the hand-drawn
style of a SpongeBob cartoon. A narrator reads the script; on screen there are only
two kinds of beat, and the reference film uses both, roughly 40% cards and 60% scenes.

CARD (big type):
- Pure black frame. Yellow hand-brushed Chinese type, cap height 15.7% of the frame,
  laid horizontally across a DIMMED cartoon figure standing behind it.
- Use it when the line is a claim, a warning, a summary, a turn, or a number worth
  landing: "时间不会等你", "问题就在这里", "身体会变旧", "不敢再下注", "不是本金".
- Use it when the line has no concrete object to point at.
- Text must be SHORT: at most 2 lines, at most 9 characters per line. Do not invent
  wording; condense the line itself.

SCENE (staged elements):
- The same beach background, with 1 to 4 cartoon cut-outs standing on the sand,
  each entering at a different phrase of the sentence, each with its own motion.
- Use it when the line describes something showable: an action, an object, a
  comparison, a change of state.
- The first layer is the anchor: the subject of the sentence. Later layers are props
  or a second character, entering on phrase 1, 2 or 3.

Motion vocabulary (use a different one for each layer in a shot):
  rise      fade up while rising          pop      scale in with overshoot
  slide_l   slide in from the left        slide_r  slide in from the right
  drop      fall in from above            spin     spin in while scaling
  dim_up    arrive dark then brighten     grow     keep growing over the beat
  fade      plain fade                    cut      appear instantly
Idle vocabulary (small life while it stays on screen):
  ""        still        float    drifts up and down    bob   gentle bounce
  sway      tilts slowly breathe  very slow scale pulse
"""

SCHEMA = """\
Return ONLY this JSON, no prose:
{
  "intro": {"lines": ["<opening line 1, <=7 chars>", "<opening line 2, <=7 chars>"]},
  "shots": [
    {"mode": "card", "text": ["<line 1>", "<line 2>"], "figure": "<element>",
     "icon": "<element or null>", "cue": "hit"},
    {"mode": "scene", "camera": {"zoom": 0.02, "pan": [0.01, 0.0]},
     "layers": [
        {"name": "<element>", "zone": "left", "ground": 0.72, "fx": "rise", "idle": "bob", "enter": 0},
        {"name": "<element>", "zone": "right", "ground": 0.74, "fx": "pop", "idle": "float", "enter": 1}
     ]}
  ]
}
Exactly one shot per sentence, in order. zones: far_left left mid_left center mid_right right far_right.
ground is 0.70 to 0.76. enter is a phrase index of that sentence (0 = with the anchor).
cue is a sound: hit, whoosh, pop, clink, tick, or null.
"""


def inventory():
    """The elements the director is allowed to cast, grouped for the prompt."""
    names = A.cut_names()
    if not names:
        return {}, []
    chars, props = [], []
    for n in names:
        spec = A.SPEC.get(n) or A.SPEC.get(n.rsplit("_", 1)[0])
        kind = (spec or {}).get("kind", "prop")
        (chars if kind == "character" else props).append(n)
    return {"characters": chars, "props": props}, names


def _sentence_block(sentences):
    out = []
    for i, s in enumerate(sentences):
        phrases = s.get("phrases") or []
        dur = s["end"] - s["start"]
        ph = " | ".join(f"{p['start'] - s['start']:.2f}-{p['end'] - s['start']:.2f}s {p['text']}" for p in phrases)
        out.append(f"[{i}] {dur:.2f}s  {s['text']}\n     phrases: {ph}")
    return "\n".join(out)


def direct(sentences, log=print, kind="gpt6"):
    """Ask the LLM for a shot plan, then repair it. Falls back to rules on failure."""
    inv, names = inventory()
    if not names:
        raise SystemExit("no cut sprites; run `python -m kit.assets_build` first")
    prompt = (
        f"{STYLE_GUIDE}\n"
        f"Available elements ({len(names)}):\n"
        f"  characters: {', '.join(inv['characters'])}\n"
        f"  props: {', '.join(inv['props'])}\n\n"
        "Narration, one numbered sentence per line, with its phrase timings:\n"
        f"{_sentence_block(sentences)}\n\n"
        f"Rules: a card needs at least {CARD_MIN_SECONDS}s of screen time, a scene at least "
        f"{SCENE_MIN_SECONDS}s. Prefer a scene when the sentence has something to show, a card when "
        "it is a claim. Do not put two layers in the same zone in one shot. Never cast an element "
        "that is not in the list above.\n\n"
        f"{SCHEMA}"
    )
    try:
        reply = llm.chat(prompt, system="You are a precise video director. You reply with JSON only.",
                         kind=kind, max_tokens=4000, temperature=0.4)
        plan = llm.extract_json(reply)
        plan = repair(plan, sentences, names, log=log)
        if plan:
            log(f"  director: LLM plan accepted ({sum(1 for s in plan['shots'] if s['mode']=='card')} cards, "
                f"{sum(1 for s in plan['shots'] if s['mode']=='scene')} scenes)")
            return plan
        log("  director: LLM plan unusable, falling back to rules")
    except Exception as exc:  # noqa: BLE001 - any failure should fall back, not abort the run
        log(f"  director: LLM unavailable ({exc}); falling back to rules")
    return rule_based(sentences, names, log=log)


def _clean_text(value, limit=9, max_lines=2):
    if isinstance(value, str):
        value = [value]
    lines = []
    for raw in (value or [])[:max_lines]:
        line = re.sub(r"\s+", "", str(raw))
        line = line.strip("，。！？、；：,;.!? ")
        if line:
            lines.append(line[:limit])
    return lines


def repair(plan, sentences, names, log=print):
    """Clamp the LLM's casting against what actually exists and what is renderable."""
    if not isinstance(plan, dict) or not isinstance(plan.get("shots"), list):
        log("  director: reply was not an object with a shots list")
        return None
    shots = plan["shots"]
    if len(shots) != len(sentences):
        log(f"  director: reply had {len(shots)} shots for {len(sentences)} sentences")
        return None
    fixed = []
    for i, (raw, sent) in enumerate(zip(shots, sentences)):
        if not isinstance(raw, dict):
            log(f"  director: shot {i} is not an object")
            return None
        mode = raw.get("mode")
        if mode not in ("card", "scene"):
            log(f"  director: shot {i} has mode {mode!r}")
            return None
        if mode == "scene":
            layers = []
            seen = set()
            for layer in (raw.get("layers") or [])[:4]:
                if not isinstance(layer, dict):
                    continue
                name = str(layer.get("name", ""))
                if name not in names or name in seen:
                    continue
                seen.add(name)
                layers.append(layer)
            if not layers:
                log(f"  director: scene shot {i} has no castable layers")
                return None
            fixed.append({
                "mode": "scene",
                "camera": raw.get("camera") if isinstance(raw.get("camera"), dict) else {},
                "layers": layers,
            })
        else:
            text = _clean_text(raw.get("text"))
            if not text:
                # An empty card is still a beat; fall back to the sentence itself.
                text = _card_text(sent["text"])
            figure = str(raw.get("figure") or "")
            if figure not in names:
                figure = _pick_figure(names)
            icon = raw.get("icon")
            if icon not in names:
                icon = None
            fixed.append({
                "mode": "card", "text": text, "figure": figure, "icon": icon,
                "cue": raw.get("cue") if raw.get("cue") in ("hit", "whoosh", "pop", "clink", "tick") else "hit",
                "seconds": round(sent["end"] - sent["start"], 2),
            })
    intro = plan.get("intro") if isinstance(plan.get("intro"), dict) else {}
    lines = _clean_text(intro.get("lines"), limit=7, max_lines=2)
    return {"intro": {"lines": lines} if lines else {}, "shots": fixed}


def _pick_figure(names):
    for want in ("krabs", "tired", "squid", "sb_point", "pat_stand", "piggy", "hold"):
        if want in names:
            return want
    for n in names:
        spec = A.SPEC.get(n) or A.SPEC.get(n.rsplit("_", 1)[0])
        if (spec or {}).get("kind") == "character":
            return n
    return names[0]


# ------------------------------------------------------------- fallback ----

CARD_HINTS = ("问题就在这里", "不会等", "身体会变旧", "不敢再", "不是本金", "本金有", "复利", "记住", "所以")
SCENE_CAST = {
    "年轻": ["crowd_0", "crowd_1", "crowd_2"],
    "着急": ["crowd_0", "crowd_1"],
    "放一放": ["lounge", "calendar"],
    "赚到": ["lounge", "coinbag"],
    "区别": ["grill", "prop_piggy"],
    "新机器": ["cheer", "sb_sleep"],
    "精神": ["cheer", "sb_point"],
    "折旧": ["tired", "scale"],
    "打折": ["tired", "coinbag"],
    "钱放对地方": ["piggy", "prop_piggy", "prop_coins"],
    "长大": ["piggy", "prop_coins"],
    "一百块": ["pair_1", "pair_0", "pair_2", "pair_3"],
    "雪球": ["hold", "ball"],
    "最陡": ["push", "coinbag"],
    "试错": ["noodles", "calendar"],
    "账单": ["squid", "coinbag"],
    "本金": ["krabs", "prop_coins"],
    "时间有多长": ["krabs", "calendar"],
    "越早": ["sb_point", "coinbag", "prop_coins"],
    "站到你": ["hold", "ball"],
}
LAYER_FX = ["rise", "pop", "slide_l", "slide_r", "drop", "spin", "dim_up", "grow"]
LAYER_IDLE = ["bob", "float", "sway", "breathe", ""]
# 对照示例片：1 居中；2 左右对开；3/4 横向铺满（与 koubo/02 design.LAYOUTS 对齐）
LAYOUTS = {
    1: [("center", 0.72)],
    2: [("mid_left", 0.72), ("mid_right", 0.74)],
    3: [("left", 0.70), ("center", 0.72), ("right", 0.74)],
    4: [("far_left", 0.70), ("mid_left", 0.72), ("mid_right", 0.73), ("far_right", 0.74)],
}
SPOTS = LAYOUTS[4]  # 兜底：按个数截取时用 LAYOUTS


def rule_based(sentences, names, log=print):
    """Deterministic director: keywords pick the cast, sentence shape picks the mode."""
    shots = []
    for i, s in enumerate(sentences):
        text = s["text"]
        dur = s["end"] - s["start"]
        phrases = s.get("phrases") or []
        want_card = any(h in text for h in CARD_HINTS) and dur >= CARD_MIN_SECONDS
        if i == 0:
            want_card = True
        if want_card:
            shots.append({
                "mode": "card",
                "text": _card_text(text),
                "figure": _pick_figure(names),
                "icon": "calendar" if "时间" in text else ("coinbag" if "钱" in text else None),
                "cue": "hit",
            })
            continue
        cast = None
        for key, names_ in SCENE_CAST.items():
            if key in text:
                cast = names_
                break
        if not cast:
            cast = [n for n in ("crowd_0", "lounge", "grill") if n in names] or names[:1]
        layers = []
        picked = [c for c in cast if c in names][:4]
        spots = LAYOUTS.get(len(picked), SPOTS)[: len(picked)]
        for k, name in enumerate(picked):
            zone, ground = spots[k]
            layers.append({
                "name": name,
                "zone": zone,
                "ground": ground,
                "fx": "rise" if k == 0 else LAYER_FX[(i + k) % len(LAYER_FX)],
                "idle": LAYER_IDLE[(i + k) % len(LAYER_IDLE)],
                "enter": min(k, max(0, len(phrases) - 1)),
            })
        shots.append({"mode": "scene", "camera": {"zoom": 0.02, "pan": [0.01, 0.0]}, "layers": layers})
    first = sentences[0]["text"] if sentences else ""
    log(f"  director: rule-based plan ({sum(1 for s in shots if s['mode']=='card')} cards, "
        f"{sum(1 for s in shots if s['mode']=='scene')} scenes)")
    return {"intro": {"lines": _intro_lines(first)}, "shots": shots}


def _card_text(text):
    body = re.split(r"[，。！？；,]", text)[0]
    body = body.strip()
    if len(body) <= 9:
        return [body]
    return [body[:9], body[9:18]]


def _intro_lines(text):
    body = re.sub(r"[，。！？；,]", "", text)
    if len(body) <= 7:
        return [body]
    half = (len(body) + 1) // 2
    return [body[:half], body[half:]]
