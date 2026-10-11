"""口播镜头种类（镜头种类设计.md + reveal/reaction）。

canonical id:
  intro_red | scene | card | dialogue | duo | emphasis | stamp | reveal | reaction

兼容旧名：scene_blur→scene，card_black→card。
海滩类（非 card）在 plan 里 mode 仍为 scene；card → mode card。
"""
from __future__ import annotations

import re
from typing import Any

VIS_INTRO = "intro_red"
VIS_SCENE = "scene"
VIS_CARD = "card"
VIS_DIALOGUE = "dialogue"
VIS_DUO = "duo"
VIS_EMPHASIS = "emphasis"
VIS_STAMP = "stamp"
VIS_REVEAL = "reveal"      # 多短语逐拍揭开（强制 cascade 语义）
VIS_REACTION = "reaction"  # 单角色反应锤

VIS_ALL = (
    VIS_INTRO,
    VIS_SCENE,
    VIS_CARD,
    VIS_DIALOGUE,
    VIS_DUO,
    VIS_EMPHASIS,
    VIS_STAMP,
    VIS_REVEAL,
    VIS_REACTION,
)

# 旧管线别名 → canonical
VIS_ALIASES = {
    "intro": VIS_INTRO,
    "intro_red": VIS_INTRO,
    "scene": VIS_SCENE,
    "scene_blur": VIS_SCENE,
    "card": VIS_CARD,
    "card_black": VIS_CARD,
    "dialogue": VIS_DIALOGUE,
    "duo": VIS_DUO,
    "emphasis": VIS_EMPHASIS,
    "stamp": VIS_STAMP,
    "reveal": VIS_REVEAL,
    "reaction": VIS_REACTION,
}

# render.mode：card 走黄卡；其余海滩贴纸
BEACH_MODES = frozenset(
    {
        VIS_INTRO,
        VIS_SCENE,
        VIS_DIALOGUE,
        VIS_DUO,
        VIS_EMPHASIS,
        VIS_STAMP,
        VIS_REVEAL,
        VIS_REACTION,
    }
)

LABELS = {
    VIS_INTRO: "红字黑底（开头）",
    VIS_SCENE: "虚化背景 + 元素入画",
    VIS_CARD: "黑场 + 黄字压角色",
    VIS_DIALOGUE: "人物对话（代码气泡）",
    VIS_DUO: "双人/双物对照",
    VIS_EMPHASIS: "词+元素（花字分槽）",
    VIS_STAMP: "盖章一句（花字盖上）",
    VIS_REVEAL: "多短语逐拍揭开",
    VIS_REACTION: "单角色反应锤",
}

CARD_HINTS = (
    "问题就在这里",
    "只有一个问题",
    "这笔机会，你该押多少",
    "最笨的勇气",
    "还能再玩的本金",
    "站在你这一边",
    "控制仓位",
    "真正卡住的地方",
)

DIALOGUE_HINTS = (
    "说：",
    "说道",
    "冷笑",
    "拍胸脯",
    "跟你说",
    "先问一句",
    "：「",
    "：“",
)

DUO_HINTS = (
    "一边",
    "另一边",
    "对比",
    "对照",
    "两派",
    "前后",
    "不是A是B",
    "不是",
    "而是",
)

EMPHASIS_FORCE = (
    "杠杆",
    "复利",
    "金本位",
    "手续费",
    "通胀",
    "接盘",
    "见底",
)

CARD_MIN_SECONDS = 1.5
CARD_STAMP_MAX_RATIO = 0.25


def normalize_visual(raw: str | None, *, shot_idx: int = -1) -> str:
    key = str(raw or "").strip().lower()
    vis = VIS_ALIASES.get(key) or VIS_ALIASES.get(key.replace("-", "_")) or VIS_SCENE
    if shot_idx == 0:
        return VIS_INTRO
    if vis == VIS_INTRO and shot_idx > 0:
        return VIS_SCENE
    return vis if vis in VIS_ALL else VIS_SCENE


def plan_mode(visual: str) -> str:
    vis = normalize_visual(visual)
    return "card" if vis == VIS_CARD else "scene"


def _compact(text: str) -> str:
    return re.sub(r"\s+", "", text or "")


def rule_classify(
    sentence_index: int,
    text: str,
    duration: float,
    *,
    used_stamp: bool = False,
    phrase_count: int = 1,
) -> str:
    """选镜决策表：从上到下第一条命中。"""
    if sentence_index == 0:
        return VIS_INTRO
    body = _compact(text)
    # 2. 对话
    if any(h in text for h in DIALOGUE_HINTS) or (
        ("：" in text or ":" in text)
        and any(n in text for n in ("派大星", "海绵", "蟹老板", "章鱼", "他说", "她说"))
    ):
        return VIS_DIALOGUE
    # 3. 强调词
    if 1 <= len(body) <= 6:
        return VIS_EMPHASIS
    if any(k in text for k in EMPHASIS_FORCE) and len(body) <= 18:
        if not any(h in text for h in CARD_HINTS):
            return VIS_EMPHASIS
    # 4. 黄卡
    if any(h in text for h in CARD_HINTS):
        short_punch = len(body) <= 14
        if duration >= CARD_MIN_SECONDS or short_punch:
            return VIS_CARD
    # 5. 盖章（全片最多 1）
    if (
        not used_stamp
        and len(body) <= 12
        and any(x in text for x in ("不会", "必须", "记住", "先问", "还算不算", "还在不在"))
    ):
        return VIS_STAMP
    # 6. 双人对立
    if ("不是" in text and "而是" in text) or any(
        h in text for h in DUO_HINTS if h not in ("不是", "而是")
    ):
        return VIS_DUO
    # 7. 反应锤：短句感叹/转折
    if len(body) <= 16 and any(x in text for x in ("？", "!", "！", "居然", "没想到", "完了")):
        return VIS_REACTION
    # 8. 多短语揭开：≥3 短语的叙事句
    if phrase_count >= 3 and duration >= 3.5:
        return VIS_REVEAL
    # 9. 默认场景
    return VIS_SCENE


def enforce_diversity(visuals: list[str]) -> list[str]:
    """连续两句禁止同一 visual（intro 除外）；dialogue/duo 不连三镜；stamp≤1。"""
    out = list(visuals)
    alts = (
        VIS_SCENE,
        VIS_DUO,
        VIS_EMPHASIS,
        VIS_DIALOGUE,
        VIS_REVEAL,
        VIS_REACTION,
        VIS_CARD,
    )
    for i in range(1, len(out)):
        if out[i] == VIS_INTRO:
            out[i] = VIS_SCENE
        if out[i] == out[i - 1]:
            for alt in alts:
                if alt != out[i - 1]:
                    out[i] = alt
                    break
        if (
            i >= 2
            and out[i] in (VIS_DIALOGUE, VIS_DUO)
            and out[i] == out[i - 1] == out[i - 2]
        ):
            for alt in alts:
                if alt != out[i - 1]:
                    out[i] = alt
                    break
    seen_stamp = False
    for i, v in enumerate(out):
        if v == VIS_STAMP:
            if seen_stamp:
                prev = out[i - 1] if i else VIS_INTRO
                out[i] = VIS_EMPHASIS if prev != VIS_EMPHASIS else VIS_SCENE
            else:
                seen_stamp = True
    if out:
        out[0] = VIS_INTRO
    # 第二遍扫相邻（stamp 降级后可能再撞）
    for i in range(1, len(out)):
        if out[i] == out[i - 1] and out[i] != VIS_INTRO:
            for alt in alts:
                if alt != out[i - 1]:
                    out[i] = alt
                    break
    return out


def enforce_card_stamp_budget(
    briefs: list[dict],
    sentences: list[dict],
    *,
    max_ratio: float = CARD_STAMP_MAX_RATIO,
) -> list[dict]:
    """card + stamp 合计时长 ≤ max_ratio。"""
    if not briefs or not sentences:
        return briefs
    total = sum(max(0.05, float(s["end"]) - float(s["start"])) for s in sentences)
    budget = total * max_ratio

    def _heavy(b: dict) -> bool:
        v = normalize_visual(b.get("visual_prefer"), shot_idx=int(b.get("_idx") or 0))
        return v in (VIS_CARD, VIS_STAMP) or bool(b.get("card"))

    def _dur() -> float:
        d = 0.0
        for b, s in zip(briefs, sentences):
            if _heavy(b):
                d += max(0.05, float(s["end"]) - float(s["start"]))
        return d

    while _dur() > budget + 0.05:
        cand = [
            (i, float(sentences[i]["end"]) - float(sentences[i]["start"]))
            for i, b in enumerate(briefs)
            if i > 0 and _heavy(b)
        ]
        if not cand:
            break
        cand.sort(key=lambda x: -x[1])
        i = cand[0][0]
        briefs[i]["card"] = False
        briefs[i]["visual_prefer"] = VIS_SCENE
    return briefs


_NARRATOR_SUBJECT = re.compile(r"^(海绵宝宝|派大星|章鱼哥|蟹老板|痞老板|珊迪|泡芙老师|小蜗|他|她|它)")
_SAY_LEAD_TAIL = re.compile(r"(说道?|叹气|嘀咕|吐槽|喊道?|问道?|心想|想着|回答|插话|笑着|在一旁)$")


SAY_MAX = 18
_PUNCT_RE = r"[，。！？；：、,.!?;:…—\s「」“”\"'『』]"


def _cc(s) -> str:
    return re.sub(_PUNCT_RE, "", str(s or ""))


def align_say(say: str, phrases: list[dict], max_chars: int = SAY_MAX) -> tuple[str, int | None, int | None]:
    """台词对齐口播短语：返回（整短语拼成的台词, 起始短语, 结束短语+1）。

    台词只由完整短语拼成（不在半句处截断）；引号内的短台词落在某个短语里时原样保留。
    """
    sc = _cc(say)
    if not sc or not phrases:
        return say, None, None
    comp = [_cc(p.get("text")) for p in phrases]
    for i, pc in enumerate(comp):
        if pc and sc in pc and len(sc) < len(pc):
            return sc, i, i + 1
    start = next((i for i, pc in enumerate(comp) if pc and (pc in sc or sc[: min(4, len(sc))] in pc)), None)
    if start is None:
        return say, None, None
    parts, j, total = [], start, 0
    while j < len(phrases) and comp[j] and (comp[j] in sc or j == start):
        piece = re.sub(r"^[\s「“]+|[\s。！？；：，、,.!?;:」”]+$", "", str(phrases[j].get("text") or ""))
        piece = re.sub(r"[「」“”\"']", "", piece)
        if parts and total + len(_cc(piece)) > max_chars:
            break
        parts.append(piece)
        total += len(_cc(piece))
        j += 1
    said = re.sub(r"^(说道|说|问道|问|喊道|喊)", "", "，".join(parts))
    return said, start, j


def speech_only(text, max_chars: int = SAY_MAX) -> str:
    """气泡台词：引号内 / 冒号后；纯旁白引导语返回空（与 kit.bubble.speech_only 同规则）。"""
    raw = str(text or "").strip()
    m = re.search(r"[「“\"『]([^」”\"』]+)[」”\"』]", raw)
    if m:
        raw = m.group(1)
    elif re.search(r"[：:]", raw):
        raw = re.split(r"[：:]", raw, maxsplit=1)[1]
    raw = re.sub(r"[「」“”\"'『』]", "", raw).strip().strip("，。！？；、,.!?; ")
    if len(raw) < 2 or _SAY_LEAD_TAIL.search(raw):
        return ""
    return raw


def synthesize_say(text: str, phrases: list[dict], max_chars: int = 14) -> list[dict]:
    """给 dialogue 补气泡：最多 2 条，来自短语压缩。"""
    out: list[dict] = []
    src = phrases or [{"text": text, "start": 0}]
    # 只取真正的台词：引号内 / 冒号后；旁白引导语（「章鱼哥在一旁叹气：」）不进气泡
    quoted = re.findall(r"[「“\"『]([^」”\"』]+)[」”\"』]", text)
    if not quoted and re.search(r"[：:]", text):
        tail = re.split(r"[：:]", text, maxsplit=1)[1]
        quoted = [tail] if tail.strip() else []
    for q in quoted[:2]:
        body = re.sub(r"[，。！？；、,.!?;\s「」“”\"']", "", q)
        if len(body) < 2:
            continue
        at = 0
        for i, p in enumerate(src):
            ptxt = re.sub(r"[，。！？；、,.!?;\s「」“”\"'：:]", "", str(p.get("text") or ""))
            if ptxt and (ptxt in body or body[: min(4, len(body))] in ptxt):
                at = i
                break
        out.append({"say": body, "say_at": at, "say_side": "auto"})
    if out:
        return out
    for i, p in enumerate(src):
        ptxt = str(p.get("text") or "").strip()
        if re.search(r"[：:]\s*$", ptxt) or _NARRATOR_SUBJECT.match(ptxt):
            continue
        say = speech_only(re.sub(r"[，。！？；、,.!?;\s]", "", ptxt), max_chars)
        if say:
            return [{"say": say, "say_at": i, "say_side": "auto"}]
    return out


def synthesize_emphasis_text(text: str) -> dict[str, Any]:
    body = _compact(text)
    for k in EMPHASIS_FORCE:
        if k in text:
            return {
                "content": k[:6],
                "zone": "right",
                "style": "white_soft",
                "enter": 0,
                "fx": "snap_in",
            }
    clauses = [_cc(c) for c in re.split(_PUNCT_RE, text) if _cc(c)]
    whole = [c for c in clauses if 3 <= len(c) <= 12]
    content = whole[0] if whole else (clauses[0][:12] if clauses else (body or "关键"))
    return {
        "content": content,
        "zone": "right",
        "style": "white_soft",
        "enter": 0,
        "fx": "snap_in",
    }


def synthesize_stamp_text(text: str) -> dict[str, Any]:
    body = _compact(text)
    # 取末尾口号感短句
    parts = [p for p in re.split(r"[，。！？；]", text) if p.strip()]
    whole = [_cc(p) for p in parts if 3 <= len(_cc(p)) <= 12]
    tip = whole[-1] if whole else (_compact(parts[-1])[:12] if parts else body)
    return {
        "content": tip or body[:10],
        "zone": "center_full",
        "style": "white_soft",
        "enter": 0,
        "z": "above_all",
    }


def zone_xy(zone: str, w: int = 1920, h: int = 1080) -> tuple[float, float]:
    """花字锚点（归一化中心）。"""
    z = str(zone or "right")
    table = {
        "left": (0.28, 0.48),
        "right": (0.72, 0.48),
        "center": (0.50, 0.45),
        "center_full": (0.50, 0.42),
        "mid_left": (0.35, 0.48),
        "mid_right": (0.65, 0.48),
    }
    return table.get(z, (0.72, 0.48))
