"""镜级出场准则：随机选「谁跟谁一组」，但时间必须锁在口播短语起点。

硬锁：
- enter = 短语下标
- enter_at = phrases[enter].start（同组同秒，对齐口播开口）
- 禁止句内比例乱插时间（那会和旁白错位）

多样性只来自：选哪几个层绑到哪几个短语、是否成组齐出、fx 池。
"""
from __future__ import annotations

import random
import re
from typing import Any

RECIPES = (
    "cascade",       # 一层一短语（或均匀摊）
    "pair_lead",     # 前两层锁短语0齐出，其余跟后续短语
    "pair_late",     # 最后两层锁末短语齐出
    "hero_solo",     # 角色锁短语0，道具锁后续
    "burst_mid",     # 多数锁中间短语齐出
    "reverse",       # 倒序摊到短语
    "bookends",      # 首层短语0、末层短语0/1、中间后段
    "phrase_match",  # 尽量按图层 _phrase / phrase_match 语义对齐
    "hold_punch",    # 一层短语0，其余末短语齐出
)

_GROUP_FX = ("pop", "stamp", "punch", "grow", "toss")
_SOLO_FX = ("rise", "slide_l", "slide_r", "float_in", "hop", "drop", "dim_up")


def _phrase_starts(phrases: list[dict], s: dict) -> list[float]:
    if phrases:
        return [float(p["start"]) for p in phrases]
    return [float(s.get("start") or 0.0)]


def _score_phrase(layer: dict, phrase_text: str) -> int:
    """图层与短语的语义重合分。"""
    pt = phrase_text or ""
    blob = " ".join(
        str(layer.get(k) or "")
        for k in ("_phrase", "_why", "name", "say")
    )
    score = 0
    for key in (layer.get("phrase_match") or []):
        if isinstance(key, str) and len(key) >= 2 and key in pt:
            score = max(score, len(key) * 3)
    # 中文碎片重叠
    hans = re.findall(r"[\u4e00-\u9fff]{2,}", blob)
    for h in hans:
        if h in pt:
            score = max(score, len(h))
    if layer.get("say") and str(layer["say"])[:4] in pt:
        score = max(score, 8)
    return score


def preferred_phrase_index(layer: dict, phrases: list[dict]) -> int | None:
    if not phrases:
        return 0
    best_i, best = None, 0
    for i, p in enumerate(phrases):
        sc = _score_phrase(layer, str(p.get("text") or ""))
        if sc > best:
            best, best_i = sc, i
    return best_i if best >= 2 else None


def _pick_recipe(
    rng: random.Random,
    n: int,
    visual: str,
    prev: str | None,
    nph: int,
    *,
    recent: list[str] | None = None,
) -> str:
    if n <= 1:
        # 单层也轮换标签，避免相邻镜全部记成 cascade
        solo_pool = ["cascade", "phrase_match", "hold_punch", "hero_solo"]
        if prev and prev in solo_pool and len(solo_pool) > 1:
            solo_pool = [r for r in solo_pool if r != prev]
        return rng.choice(solo_pool)
    pool = list(RECIPES)
    if nph <= 1:
        # 单短语镜：只能齐出或同秒，多样性靠 fx；pair/cascade 退化
        pool = ["pair_lead", "hold_punch", "phrase_match", "cascade", "burst_mid"]
    if visual == "dialogue":
        pool = ["phrase_match", "hero_solo", "pair_lead", "cascade", "bookends"]
    elif visual == "duo":
        pool = ["pair_lead", "cascade", "phrase_match", "reverse", "bookends"]
    elif visual == "reveal":
        # 仍按短语摊开，但配方名轮换，避免镜间全 cascade
        pool = ["cascade", "reverse", "phrase_match", "hero_solo", "bookends"]
    elif visual in ("emphasis", "stamp"):
        pool = ["phrase_match", "hero_solo", "cascade", "hold_punch"]
    elif visual == "reaction":
        pool = ["hold_punch", "cascade", "phrase_match", "burst_mid"]
    if prev and prev in pool and len(pool) > 1:
        pool = [r for r in pool if r != prev]
    # 压低近窗重复（最近 3 镜）
    recent = recent or []
    hot = {r for r in recent[-3:] if r}
    cooled = [r for r in pool if r not in hot]
    if cooled:
        pool = cooled
    # cascade 降权：仍可选，但优先其它
    non_cascade = [r for r in pool if r != "cascade"]
    if non_cascade and rng.random() < 0.72:
        pool = non_cascade
    return rng.choice(pool)


def _assign_group_fx(layers: list[dict], idxs: list[int], rng: random.Random) -> None:
    if len(idxs) >= 2 and rng.random() < 0.6:
        fx = rng.choice(_GROUP_FX)
        for i in idxs:
            layers[i]["fx"] = fx
    else:
        for i in idxs:
            if rng.random() < 0.4:
                layers[i]["fx"] = rng.choice(_SOLO_FX + _GROUP_FX)


def _set_phrase(layers: list[dict], i: int, pi: int, starts: list[float]) -> None:
    pi = max(0, min(int(pi), len(starts) - 1))
    layers[i]["enter"] = pi
    layers[i]["enter_at"] = round(starts[pi], 4)


def _distribute(n: int, nph: int) -> list[int]:
    """n 层均匀摊到 nph 个短语。"""
    if n <= 1:
        return [0]
    if nph <= 1:
        return [0] * n
    return [int(round(i * (nph - 1) / (n - 1))) for i in range(n)]


def apply_entrance_recipe(
    layers: list[dict],
    phrases: list[dict],
    s: dict,
    *,
    rng: random.Random,
    visual: str = "scene",
    prev_recipe: str | None = None,
    forced_recipe: str | None = None,
    recent_recipes: list[str] | None = None,
) -> str:
    """就地改 enter / enter_at（短语锚定）与部分 fx。"""
    n = len(layers)
    if n == 0:
        return "empty"
    starts = _phrase_starts(phrases, s)
    nph = len(starts)
    recent = list(recent_recipes or [])
    if prev_recipe and (not recent or recent[-1] != prev_recipe):
        recent.append(prev_recipe)
    recipe = forced_recipe or _pick_recipe(
        rng, n, visual, prev_recipe, nph, recent=recent
    )
    # 相邻强制换配方（forced 除外）
    if (
        not forced_recipe
        and prev_recipe
        and recipe == prev_recipe
        and recipe in RECIPES
    ):
        alt = _pick_recipe(rng, n, visual, prev_recipe, nph, recent=recent + [recipe])
        if alt != recipe:
            recipe = alt
    if recipe not in RECIPES:
        recipe = "cascade"
    order = list(range(n))
    strict = forced_recipe is not None or visual == "reveal"

    # 语义首选
    pref = [preferred_phrase_index(layers[i], phrases) for i in order]

    if recipe == "phrase_match":
        for i in order:
            pi = pref[i]
            if pi is None:
                # 无命中：按槽位摊
                pi = _distribute(n, nph)[i]
            _set_phrase(layers, i, pi, starts)
        # 同一短语≥2 → 成组 fx
        buckets: dict[int, list[int]] = {}
        for i in order:
            buckets.setdefault(int(layers[i]["enter"]), []).append(i)
        for idxs in buckets.values():
            if len(idxs) >= 2:
                _assign_group_fx(layers, idxs, rng)

    elif recipe == "cascade":
        dist = _distribute(n, nph)
        for i, pi in zip(order, dist):
            # reveal/强制 cascade：严格摊开，禁止语义全挤回短语0
            if not strict and pref[i] is not None and rng.random() < 0.55:
                pi = pref[i]
            _set_phrase(layers, i, pi, starts)

    elif recipe == "pair_lead":
        k = min(2, n)
        # 优先前两个槽（构图左右），否则随机
        lead = order[:k] if rng.random() < 0.55 else rng.sample(order, k=k)
        for i in lead:
            _set_phrase(layers, i, 0, starts)
        _assign_group_fx(layers, lead, rng)
        rest = [i for i in order if i not in set(lead)]
        if rest:
            # 剩余从短语1起摊（无则全在0）
            base = 1 if nph > 1 else 0
            dist = _distribute(len(rest), max(1, nph - base))
            for j, i in enumerate(rest):
                _set_phrase(layers, i, min(nph - 1, base + dist[j]), starts)

    elif recipe == "pair_late":
        k = min(2, n)
        late = order[-k:]
        last = nph - 1
        early = order[:-k] if n > k else []
        for j, i in enumerate(early):
            _set_phrase(layers, i, min(j, max(0, last - 1)), starts)
        for i in late:
            _set_phrase(layers, i, last, starts)
        _assign_group_fx(layers, late, rng)

    elif recipe == "hero_solo":
        hero = next(
            (i for i, L in enumerate(layers) if str(L.get("name") or "").startswith("ch_")),
            0,
        )
        _set_phrase(layers, hero, 0, starts)
        layers[hero]["fx"] = rng.choice(("rise", "dim_up", "slide_l", "slide_r", "hop"))
        rest = [i for i in order if i != hero]
        if rest and nph > 1 and rng.random() < 0.55:
            mid = min(1, nph - 1) if nph == 2 else min(nph // 2, nph - 1)
            for i in rest:
                _set_phrase(layers, i, mid, starts)
            _assign_group_fx(layers, rest, rng)
        else:
            dist = _distribute(len(rest), nph)
            for j, i in enumerate(rest):
                _set_phrase(layers, i, max(1, dist[j]) if nph > 1 else 0, starts)

    elif recipe == "burst_mid":
        mid = 0 if nph == 1 else (nph // 2)
        lead_n = 1 if n >= 3 and nph > 1 and rng.random() < 0.6 else 0
        for i in order[:lead_n]:
            _set_phrase(layers, i, 0, starts)
        burst = order[lead_n:]
        for i in burst:
            _set_phrase(layers, i, mid, starts)
        _assign_group_fx(layers, burst, rng)

    elif recipe == "reverse":
        dist = list(reversed(_distribute(n, nph)))
        for i, pi in zip(order, dist):
            _set_phrase(layers, i, pi, starts)
            if rng.random() < 0.35:
                layers[i]["fx"] = rng.choice(("slide_l", "slide_r", "toss", "roll_l", "roll_r"))

    elif recipe == "bookends":
        _set_phrase(layers, order[0], 0, starts)
        if n >= 2:
            # 末元素跟第二短语或末短语
            end_pi = min(1, nph - 1) if nph > 1 else 0
            if rng.random() < 0.4:
                end_pi = nph - 1
            _set_phrase(layers, order[-1], end_pi, starts)
        mid = order[1:-1]
        if mid:
            base = 1 if nph > 2 else (nph - 1)
            dist = _distribute(len(mid), max(1, nph - base))
            for j, i in enumerate(mid):
                _set_phrase(layers, i, min(nph - 1, base + dist[j]), starts)

    elif recipe == "hold_punch":
        _set_phrase(layers, order[0], 0, starts)
        late = order[1:]
        last = nph - 1
        for i in late:
            _set_phrase(layers, i, last, starts)
            layers[i]["fx"] = rng.choice(("stamp", "punch", "pop", "drop", "grow"))
        if late:
            _assign_group_fx(layers, late, rng)

    else:
        dist = _distribute(n, nph)
        for i, pi in zip(order, dist):
            _set_phrase(layers, i, pi, starts)

    # 硬底：至少一层锁在短语0（口播一开口就有画面）
    if layers and all(int(L.get("enter") or 0) > 0 for L in layers):
        i0 = 0
        # 优先角色
        for i, L in enumerate(layers):
            if str(L.get("name") or "").startswith("ch_"):
                i0 = i
                break
        _set_phrase(layers, i0, 0, starts)

    # 多短语镜：禁止全部挤在同一短语（否则「渐进」失效、也对不上后半口播）
    if n >= 2 and nph >= 2:
        ents = [int(L.get("enter") or 0) for L in layers]
        if len(set(ents)) == 1:
            dist = _distribute(n, nph)
            for i, pi in zip(order, dist):
                _set_phrase(layers, i, pi, starts)

    return recipe


def recipe_rng(seed: int, shot_idx: int) -> random.Random:
    return random.Random((int(seed) * 10007 + int(shot_idx) * 9176 + 13) & 0xFFFFFFFF)


def validate_phrase_sync(layers: list[dict], phrases: list[dict], *, tol: float = 0.08) -> list[str]:
    """验收：enter_at 必须落在对应短语 start±tol。"""
    if not phrases:
        return []
    errs = []
    for L in layers:
        pi = int(L.get("enter") or 0)
        if not (0 <= pi < len(phrases)):
            errs.append(f"{L.get('name')} enter={pi} out of range")
            continue
        want = float(phrases[pi]["start"])
        got = float(L.get("enter_at") or -1)
        if abs(got - want) > tol:
            errs.append(f"{L.get('name')} enter_at={got} != phrase[{pi}].start={want}")
    return errs
