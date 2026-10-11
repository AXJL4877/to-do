"""Element staging: put a few things on the beach at different moments.

The example never drops one combined picture per sentence. It holds the background
and brings a second and third thing in partway through, usually on the phrase
boundaries of the narration, and each thing moves its own way. This module is the
motion library and the shot renderer for that.
"""
from __future__ import annotations

import math

import numpy as np
from PIL import Image

from . import assets as A
from . import imaging as I

W, H = I.W, I.H

MOTIONS = (
    "cut", "fade", "rise", "pop", "slide_l", "slide_r", "drop", "spin",
    "dim_up", "grow", "wipe",
    # 示例里常见、但原先库里缺的几种
    "float_in", "stamp", "punch", "roll_l", "roll_r", "hop", "swing", "unfold", "toss",
)
IDLES = ("", "float", "bob", "sway", "breathe")
ZONES = {
    "far_left": 0.13, "left": 0.24, "mid_left": 0.34, "center": 0.50,
    "mid_right": 0.66, "right": 0.76, "far_right": 0.87,
}
GROUNDS = (0.70, 0.72, 0.74, 0.76)


def zone_x(zone):
    return ZONES.get(zone, 0.5)


def _u(u):
    return 1.0 if u >= 1 else max(0.0, u)


def fx_cut(u, t, seed):
    return 1.0, 0.0, 0.0, 1.0, 0.0


def fx_fade(u, t, seed):
    return _u(u), 0.0, 0.0, 1.0, 0.0


def fx_rise(u, t, seed):
    u = _u(u)
    e = I.ease_out_cubic(u)
    return min(1.0, u * 1.8), 0.0, (1 - e) * 64, 1.0, 0.0


def fx_pop(u, t, seed):
    u = _u(u)
    return min(1.0, u * 2.2), 0.0, (1 - u) * 16, max(0.05, 0.24 + 0.76 * I.ease_out_back(u)), 0.0


def fx_slide_left(u, t, seed):
    u = _u(u)
    e = I.ease_out_cubic(u)
    return min(1.0, u * 3), -(1 - e) * W * 0.42, 0.0, 1.0, 0.0


def fx_slide_right(u, t, seed):
    u = _u(u)
    e = I.ease_out_cubic(u)
    return min(1.0, u * 3), (1 - e) * W * 0.42, 0.0, 1.0, 0.0


def fx_drop(u, t, seed):
    u = _u(u)
    if u >= 1:
        return 1.0, 0.0, 0.0, 1.0, 0.0
    e = I.ease_out_bounce(u)
    return 1.0, 0.0, -(1 - e) * 300, 1.0, 0.0


def fx_spin(u, t, seed):
    u = _u(u)
    return min(1.0, u * 2.0), 0.0, (1 - u) * 20, max(0.1, 0.3 + 0.7 * I.ease_out_back(u)), (1 - u) * -34


def fx_dim_up(u, t, seed):
    u = _u(u)
    return 0.30 + 0.70 * I.smooth(u), 0.0, (1 - I.smooth(u)) * 10, 1.0, 0.0


def fx_grow(u, t, seed):
    u = _u(u)
    e = I.ease_out_back(u)
    return min(1.0, u * 2.4), 0.0, 0.0, max(0.06, 0.18 + 0.82 * e), 0.0


def fx_wipe(u, t, seed):
    return _u(u), 0.0, 0.0, 1.0, 0.0


def fx_float_in(u, t, seed):
    """轻飘落下：示例里道具/气泡常用的柔和入场。"""
    u = _u(u)
    e = I.ease_out_cubic(u)
    return min(1.0, u * 1.6), math.sin(seed + u * 2.2) * 10 * (1 - e), (1 - e) * 90, 1.0, 0.0


def fx_stamp(u, t, seed):
    """盖章式砸下：带轻微压扁回弹。"""
    u = _u(u)
    e = I.ease_out_bounce(u)
    squash = 1.0
    if 0.55 < u < 0.85:
        squash = 1.0 - 0.12 * math.sin((u - 0.55) / 0.30 * math.pi)
    elif u >= 0.85:
        squash = 1.0
    return 1.0, 0.0, -(1 - e) * 380, squash, 0.0


def fx_punch(u, t, seed):
    """过大→落定：强调词/关键道具的冲击入场。"""
    u = _u(u)
    e = I.ease_out_back(u)
    return min(1.0, u * 2.5), 0.0, (1 - e) * 8, max(0.2, 1.55 - 0.55 * e), 0.0


def fx_roll_left(u, t, seed):
    u = _u(u)
    e = I.ease_out_cubic(u)
    return min(1.0, u * 2.5), -(1 - e) * W * 0.38, (1 - e) * 12, 1.0, (1 - e) * -220


def fx_roll_right(u, t, seed):
    u = _u(u)
    e = I.ease_out_cubic(u)
    return min(1.0, u * 2.5), (1 - e) * W * 0.38, (1 - e) * 12, 1.0, (1 - e) * 220


def fx_hop(u, t, seed):
    """两段小跳着入位。"""
    u = _u(u)
    e = I.ease_out_cubic(u)
    hop = abs(math.sin(u * math.pi * 2.0)) * 38 * (1 - u)
    side = (1 if (int(seed * 10) % 2 == 0) else -1)
    return min(1.0, u * 2.0), side * (1 - e) * W * 0.22, -hop, 1.0, 0.0


def fx_swing(u, t, seed):
    """钟摆式荡入：闹钟/挂件类。"""
    u = _u(u)
    e = I.ease_out_elastic(u)
    ang = (1 - e) * (28 if seed % 1 < 0.5 else -28)
    return min(1.0, u * 1.8), 0.0, (1 - I.ease_out_cubic(u)) * 40, 1.0, ang


def fx_unfold(u, t, seed):
    """横向展开：日历/票券/标签。用 scale 近似 unfold。"""
    u = _u(u)
    e = I.ease_out_back(u)
    return min(1.0, u * 2.0), 0.0, 0.0, max(0.08, e), 0.0


def fx_toss(u, t, seed):
    """抛物线抛入。"""
    u = _u(u)
    e = I.ease_out_cubic(u)
    side = 1 if (int(seed * 7) % 2 == 0) else -1
    dx = side * (1 - e) * W * 0.34
    dy = (1 - e) * 160 - math.sin(u * math.pi) * 90
    spin = side * (1 - e) * 48
    return min(1.0, u * 2.2), dx, dy, 1.0, spin


FX = {
    "cut": fx_cut, "fade": fx_fade, "rise": fx_rise, "pop": fx_pop,
    "slide_l": fx_slide_left, "slide_r": fx_slide_right, "drop": fx_drop,
    "spin": fx_spin, "dim_up": fx_dim_up, "grow": fx_grow, "wipe": fx_wipe,
    "float_in": fx_float_in, "stamp": fx_stamp, "punch": fx_punch,
    "roll_l": fx_roll_left, "roll_r": fx_roll_right, "hop": fx_hop,
    "swing": fx_swing, "unfold": fx_unfold, "toss": fx_toss,
}


def idle(name, t, seed):
    if name == "float":
        return 0.0, math.sin(t * 2.1 + seed) * 7.0, 0.0
    if name == "bob":
        return math.sin(t * 3.4 + seed) * 4.0, 0.0, math.sin(t * 1.7 + seed) * 1.6
    if name == "sway":
        return 0.0, 0.0, math.sin(t * 1.9 + seed) * 2.4
    if name == "breathe":
        return 0.0, 0.0, 0.0
    return 0.0, 0.0, 0.0


def idle_scale(name, t, seed):
    if name == "breathe":
        return 1.0 + math.sin(t * 1.6 + seed) * 0.014
    return 1.0


def wipe_mask(sprite, u):
    keep = int(round(sprite.shape[1] * min(1.0, max(0.0, u))))
    if keep >= sprite.shape[1]:
        return sprite
    out = sprite.copy()
    out[:, keep:] = 0
    return out


_shadow_cache = {}


def _shadow_for(width):
    key = max(24, int(round(width / 12.0)) * 12)
    if key not in _shadow_cache:
        _shadow_cache[key] = I.contact_shadow(key, 0.115)
    return _shadow_cache[key]


def normalise_layer(raw):
    """Accept the loose shape the director returns and make it renderable."""
    name = str(raw.get("name", "")).strip()
    fx = str(raw.get("fx", "rise"))
    idle_name = str(raw.get("idle", ""))
    zone = raw.get("zone")
    x = float(raw.get("x")) if raw.get("x") is not None else zone_x(zone)
    ground = float(raw.get("ground", 0.72))
    if A.bleeds_bottom(name):
        ground = 1.0
    exit_raw = raw.get("exit", None)
    exit_at = None if exit_raw is None else max(0, int(exit_raw))
    enter_t = raw.get("enter_at", None)
    return {
        "name": name,
        "x": min(0.92, max(0.08, x)),
        "ground": min(1.0, max(0.66, ground)),
        "fx": fx if fx in FX else "rise",
        "idle": idle_name if idle_name in IDLES else "",
        "enter": max(0, int(raw.get("enter", 0))),
        "enter_at": None if enter_t is None else float(enter_t),
        "exit": exit_at,
        "z": max(1, int(raw.get("z", 2))),
        "seed": float(raw.get("seed", (sum(map(ord, name)) % 97) / 13.0)),
    }


GROUP_W = 0.82
GAP_W = 0.045
SWAP_GAP = 0.16
# 静止姿态的高度上限（占画面高）：参考画面角色约半屏、道具更小，留出顶部标题与底部字幕
CHAR_MAX_H = 0.56
PROP_MAX_H = 0.42
REST_MAX_W = 0.62


def is_prop(name):
    if name.startswith("pr_"):
        return True
    base = name.split("_")[0] if name.split("_")[-1].isdigit() else name
    spec = A.SPEC.get(name) or A.SPEC.get(base) or {}
    return spec.get("kind") == "prop"


def rest_fit(name, base, fit):
    """Shrink the settled scale so no element towers over the frame."""
    if A.bleeds_bottom(name):
        return fit
    cap_h = H * (PROP_MAX_H if is_prop(name) else CHAR_MAX_H)
    k = min(1.0, cap_h / max(1.0, base.shape[0] * fit), W * REST_MAX_W / max(1.0, base.shape[1] * fit))
    return fit * k


def _rest_width(name):
    base = A.element(name)
    if base is None:
        return 0
    return int(base.shape[1] * rest_fit(name, base, 1.0))


GLIDE = 0.40


def plan_layout(layers, norm, visible):
    """Settled x and scale for every layer, so the picture on screen is centred.

    The example composes each shot as one balanced group around frame centre; fixed
    zone fractions leave a lone figure hugging one side or push a wide prop off the
    edge. Layers sharing a zone are one slot (a state swap), ordered by zone. Only
    slots with something already on screen take part.
    """
    slots = {}
    for i, (raw, L) in enumerate(zip(layers, norm)):
        if raw.get("x") is not None or A.bleeds_bottom(L["name"]):
            continue
        slots.setdefault(str(raw.get("zone") or round(L["x"], 3)), []).append(i)
    out = {i: (L["x"], 1.0) for i, L in enumerate(norm)}
    slots = {k: v for k, v in slots.items() if any(i in visible for i in v)}
    if not slots:
        return out
    order = sorted(slots.values(), key=lambda idx: norm[idx[0]]["x"])
    widths = [max(_rest_width(norm[i]["name"]) for i in idx) for idx in order]
    gap = W * GAP_W
    total = sum(widths) + gap * (len(widths) - 1)
    scale = 1.0
    # 单槽：略放大，避免小贴纸漂在中央；最终仍受 rest_fit 的高度上限约束
    if len(order) == 1:
        scale = 1.15
        widths = [w * scale for w in widths]
        total = widths[0]
        # 仍不超过画面可用宽度
        if total > W * 0.92:
            scale *= (W * 0.92) / total
            widths = [W * 0.92]
            total = W * 0.92
    elif total > W * GROUP_W:
        gap = W * 0.02
        total = sum(widths) + gap * (len(widths) - 1)
        if total > W * GROUP_W:
            scale = W * GROUP_W / total
            widths = [w * scale for w in widths]
            gap *= scale
            total = W * GROUP_W
    x = (W - total) / 2
    for idx, w in zip(order, widths):
        for i in idx:
            out[i] = ((x + w / 2) / W, scale)
        x += w + gap
    return out


def _swap_delay(layers, norm, li):
    return SWAP_GAP if any(
        o["exit"] is not None and o["exit"] == norm[li]["enter"]
        and str(layers[j].get("zone")) == str(layers[li].get("zone"))
        for j, o in enumerate(norm) if j != li
    ) else 0.0


def _starts(layers, norm, phrase_index, t_abs):
    """When each layer arrives (absolute seconds), or -inf/inf on phrase-only plans."""
    out = []
    for li, L in enumerate(norm):
        if L["enter_at"] is not None and t_abs is not None:
            out.append(L["enter_at"] + _swap_delay(layers, norm, li))
        else:
            out.append(float("-inf") if phrase_index >= L["enter"] else float("inf"))
    return out


def glide_layout(layers, norm, phrase_index, t_abs):
    starts = _starts(layers, norm, phrase_index, t_abs)
    now = t_abs if t_abs is not None else 0.0
    visible = {i for i, s in enumerate(starts) if s <= now}
    cur = plan_layout(layers, norm, visible)
    recent = [s for s in starts if s <= now and s != float("-inf")]
    if not recent:
        return cur
    last = max(recent)
    w = I.smooth((now - last) / GLIDE)
    if w >= 1.0:
        return cur
    before = {i for i, s in enumerate(starts) if s < last}
    if not before:
        return cur
    prev = plan_layout(layers, norm, before)
    out = {}
    for i in cur:
        if i in before:
            (x0, s0), (x1, s1) = prev[i], cur[i]
            out[i] = (x0 + (x1 - x0) * w, s0 + (s1 - s0) * w)
        else:
            out[i] = cur[i]
    return out


def draw_shot(frame, layers, phrase_index, phrase_t, elapsed, t_abs=None, canvas=None):
    """Draw every layer of a scene whose entrance phrase has already started.

    Optional ``exit`` (phrase index): leave when that phrase begins — used for
    same-slot state swaps (before → disappear → after at the same zone).

    Optional ``enter_at`` (absolute seconds on the narration timeline): when
    ``t_abs`` is provided, prefer it over phrase index for entrance timing.

    Optional ``canvas``: GPU compositor (kit.gpu.Canvas); blits go there instead
    of ``frame``. Caller downloads after overlays that still need numpy.
    """
    drawn = []
    put = canvas.blit if canvas is not None else (
        lambda src, x, y, opacity=1.0: I.blit(frame, src, x, y, opacity)
    )
    norm = [normalise_layer(raw) for raw in layers]
    placed = glide_layout(layers, norm, phrase_index, t_abs)
    for li, (raw, layer) in enumerate(zip(layers, norm)):
        layer = dict(layer)
        layer["x"], fit = placed[li]
        # 同站位换状态：等旧状态淡出再进，避免两张同一角色半透明叠在一起
        delay = _swap_delay(layers, norm, li)
        # 口播绝对时间优先；否则回退短语下标
        if layer["enter_at"] is not None and t_abs is not None:
            if t_abs < layer["enter_at"] + delay:
                continue
            since = t_abs - layer["enter_at"] - delay
            entering_now = since < 0.50
            enter_u = min(1.0, max(0.0, since / 0.46))
        else:
            if phrase_index < layer["enter"]:
                continue
            entering_now = layer["enter"] == phrase_index
            if entering_now and phrase_t < delay:
                continue
            enter_u = min(1.0, max(0.0, (phrase_t - delay) / 0.46)) if entering_now else 1.0
            since = phrase_t - delay if entering_now else 1.0

        exit_at = layer["exit"]
        leaving = False
        leave_u = 1.0
        if exit_at is not None:
            if phrase_index > exit_at:
                continue
            if phrase_index == exit_at:
                # Quick fade-out as the replacement state enters.
                leave_u = max(0.0, 1.0 - phrase_t / (SWAP_GAP * 0.85))
                if leave_u <= 0.01:
                    continue
                leaving = True
        base = A.element(layer["name"])
        if base is None:
            continue
        sprite = base
        fit = rest_fit(layer["name"], base, fit)
        u = 1.0 if leaving else enter_u
        opacity, dx, dy, scale, spin = FX[layer["fx"]](u, since, layer["seed"])
        if leaving:
            opacity *= leave_u
            dy -= (1.0 - leave_u) * 28
        ix, iy, ispin = idle(layer["idle"], elapsed, layer["seed"])
        dy += iy
        dx += ix
        spin += ispin
        scale *= idle_scale(layer["idle"], elapsed, layer["seed"]) * fit
        if layer["fx"] == "wipe" and u < 1.0:
            sprite = wipe_mask(sprite, u)
            scale = fit
            sprite = I.transform(sprite, scale, spin) if (abs(scale - 1) > 0.01 or abs(spin) > 0.4) else sprite
        else:
            sprite = I.transform(sprite, scale, spin)

        # Keep the resting position inside the frame. Motion offsets are applied
        # afterwards, because an entrance is allowed to start off-screen -- it is
        # only the settled pose that must not hang over the edge.
        bleed = A.bleeds_bottom(layer["name"])
        max_w = int(W * (1.0 if bleed else 0.66))
        if sprite.shape[1] > max_w:
            sprite = I.resize(sprite, max_w / sprite.shape[1])
        rest_x = min(max(W * layer["x"] - sprite.shape[1] / 2, 0), max(0, W - sprite.shape[1]))
        rest_y = min(max(H * layer["ground"] - sprite.shape[0], 0), max(0, H - sprite.shape[0]))
        px = int(round(rest_x + dx))
        py = int(round(rest_y + dy))
        drawn.append(
            {
                "name": layer["name"],
                "fx": layer["fx"],
                "settled": bool(u >= 1.0) and not leaving,
                "box": (px, py, sprite.shape[1], sprite.shape[0]),
                "alpha": round(opacity, 3),
            }
        )
        if layer["ground"] >= 0.69 and opacity > 0.05 and not bleed:
            sh = _shadow_for(int(sprite.shape[1] * 0.70))
            put(sh, px + sprite.shape[1] / 2 - sh.shape[1] / 2,
                py + sprite.shape[0] - sh.shape[0] * 0.42, opacity)
        put(sprite, px, py, opacity)
    return drawn
