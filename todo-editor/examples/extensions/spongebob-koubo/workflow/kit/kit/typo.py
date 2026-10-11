"""Type: the yellow card face and the white subtitle, at the example's measurements.

Measured off 复利.mp4's eight yellow cards: fill cap height 170 px = 15.74 % of
frame height on every card, neutral black keyline near 0.07 x cap, fill
(254,220,0), about 2.5 % of the stroke body chipped out, line pitch 1.22 x cap.
Subtitles: cap 60 px, 3 px black keyline, fill (251,249,241).
"""
from __future__ import annotations

import re
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from . import imaging as I

KIT = Path(__file__).resolve().parent.parent
FONTS = KIT / "fonts"

# Cards keep 思源宋 Heavy；开场红字优先用户指定的「字魂剑气手书」。
# 自包含原则：**包内优先**，不依赖 C:\Windows\Fonts；机器路径只作兜底。
# 卡片：思源宋 Heavy（OFL，可随包分发）；字幕：Noto Sans SC Bold（OFL），
# 因为原本用的微软雅黑（msyhbd.ttc）授权上不能随扩展包分发。
_HAN_SERIF_BUNDLED = FONTS / "Source Han Serif SC Heavy (TrueType).ttf"
_HAN_SERIF_AMBIENT = Path(r"C:\Windows\Fonts\Source Han Serif SC Heavy (TrueType).ttf")
CARD_FONT = (_HAN_SERIF_BUNDLED if _HAN_SERIF_BUNDLED.exists()
             else _HAN_SERIF_AMBIENT if _HAN_SERIF_AMBIENT.exists()
             else FONTS / "FZCuHeiSongS-B-GB.ttf")
_SUB_BUNDLED = FONTS / "Noto Sans SC Bold (TrueType).otf"
SUB_FONT = _SUB_BUNDLED if _SUB_BUNDLED.exists() else Path(r"C:\Windows\Fonts\msyhbd.ttc")
# 字魂剑气手书：用户指定用于开场红字。
# **包内优先**（依赖收进 TODO，不依赖桌面目录）；机器路径只作兜底——
# 这样换机器或把扩展包发给别人也能出同样的字，而老机器上依然可用。
_TITLE_ZIHUN_BUNDLED = FONTS / "字魂剑气手书(商用需授权).ttf"
_TITLE_ZIHUN_AMBIENT = Path(r"D:\Desktop\TTF\字魂剑气手书(商用需授权).ttf")
_TITLE_AMEZUMI = FONTS / "AmezumiGothic.ttf"
_TITLE_PREFS = (_TITLE_ZIHUN_BUNDLED, _TITLE_ZIHUN_AMBIENT, _TITLE_AMEZUMI)
# 开场红字的字体链：首选剑气手书；某个字它没有时，用后备字体把这个字补上，不再丢字。
TITLE_FONT_CHAIN: tuple[Path, ...] = tuple(
    dict.fromkeys([p for p in _TITLE_PREFS if p.exists()] + [CARD_FONT])
)
TITLE_FONT = TITLE_FONT_CHAIN[0]
for _p in (CARD_FONT, *TITLE_FONT_CHAIN):
    if not _p.exists():
        raise SystemExit(f"missing font {_p}")

CAP = 0.1574
SUB_CAP = 66
FILL = (254, 220, 0)
KEYLINE = (14, 14, 14)
SUB_FILL = (251, 249, 241)

# 大字（卡片/标题花字）不带标点与引号：思源宋 Heavy 子集缺 ”，。？：等字形，画出来是方框
_DISPLAY_STRIP = "“”‘’「」『』\"'《》（）()[]【】，。！？；：、,.!?;:…—·~～ \t"
_cmaps: dict[str, set[int]] = {}


def _cmap_via_fonttools(font_path) -> set[int]:
    from fontTools.ttLib import TTCollection, TTFont

    p = Path(str(font_path))
    font = TTCollection(str(font_path)).fonts[0] if p.suffix.lower() == ".ttc" else TTFont(str(font_path), lazy=True)
    return set(font.getBestCmap().keys())


def _cmap_via_pil(font_path) -> set[int]:
    """没有 fontTools 时的退路：用 PIL 逐字比对 .notdef 判缺字。

    fontTools 是机器级 pip 依赖；缺了它不该让整条排版管线崩掉（实测会直接 ModuleNotFoundError）。
    """
    from PIL import ImageFont

    font = ImageFont.truetype(str(font_path), 64)
    try:
        notdef = font.getbbox("\ue000")  # 私用区：几乎必然是 .notdef
    except Exception:
        notdef = None
    cmap: set[int] = set()
    for lo, hi in ((0x20, 0x7F), (0x3000, 0x3040), (0x4E00, 0xA000), (0xFF00, 0xFF80)):
        for cp in range(lo, hi):
            try:
                box = font.getbbox(chr(cp))
            except Exception:
                continue
            if box is None or (notdef is not None and box == notdef):
                continue
            if box[2] - box[0] <= 0 and box[3] - box[1] <= 0:
                continue
            cmap.add(cp)
    return cmap


def font_cmap(font_path) -> set[int]:
    """字体覆盖的码点集合；优先 fontTools，缺了就退回 PIL。

    空集合表示"判不出字形"——调用方必须当"不筛"处理，否则会把整行文字清空。
    """
    key = str(font_path)
    if key in _cmaps:
        return _cmaps[key]
    try:
        _cmaps[key] = _cmap_via_fonttools(key)
    except Exception:
        try:
            _cmaps[key] = _cmap_via_pil(key)
        except Exception:
            _cmaps[key] = set()
    return _cmaps[key]


def missing_glyphs(text: str, font_path) -> str:
    cmap = font_cmap(font_path)
    if not cmap:
        return ""
    return "".join(sorted({ch for ch in text if not ch.isspace() and ord(ch) not in cmap}))


def _font_chain(font_path) -> tuple[Path, ...]:
    """单个字体路径 → 只含它的链；已经是链就原样返回。"""
    if isinstance(font_path, (tuple, list)):
        chain = tuple(Path(p) for p in font_path)
    else:
        chain = (Path(font_path),)
    return chain or (CARD_FONT,)


def pick_font(ch: str, chain) -> Path:
    """链上第一个真的覆盖该字的字体；都没有才退到链尾（保底字体）。"""
    fonts = _font_chain(chain)
    for font in fonts:
        if ord(ch) in font_cmap(font):
            return font
    return fonts[-1]


_font_cache: dict[tuple[str, int], object] = {}


def _load_font(font, size: int = 260):
    key = (str(font), int(size))
    if key not in _font_cache:
        _font_cache[key] = ImageFont.truetype(str(font), int(size))
    return _font_cache[key]


def _can_draw(ch: str, font) -> bool:
    """再确认一次这个字体真的画得出该字；画不出就换链上下一个（不抛异常）。"""
    try:
        f = _load_font(font)
        return f.getlength(ch) > 0 and f.getbbox(ch) is not None
    except Exception:
        return False


def _agreeing_font(ch: str, chain):
    """覆盖表说有、且 Pillow 也真的画得出，才用这个字体，否则顺着链往下找。"""
    fonts = _font_chain(chain)
    for font in fonts:
        if ord(ch) in font_cmap(font) and _can_draw(ch, font):
            return font
    for font in fonts:
        if _can_draw(ch, font):
            return font
    return fonts[-1]


def _run_fonts(text: str, chain):
    """把文本切成 (连续同字体的字符串, ImageFont) 段，用来混排绘制。

    字体的支持判据来自 cmap；判不出字形时 pick_font 落到链尾，行为跟单字体一致。
    """
    size = 260
    out: list[tuple[str, object]] = []
    prev_key = None
    for ch in str(text):
        key = _agreeing_font(ch, chain)
        if out and key == prev_key:
            out[-1] = (out[-1][0] + ch, out[-1][1])
        else:
            out.append((ch, _load_font(key, size)))
        prev_key = key
    return out


def font_chain_gaps(text: str, chain=TITLE_FONT_CHAIN) -> str:
    """链上首选字体缺、要靠后备字体补的字（做日志/诊断用）。"""
    fonts = _font_chain(chain)
    if len(fonts) < 2:
        return ""
    preferred = font_cmap(fonts[0])
    if not preferred:
        return ""
    return "".join(sorted({ch for ch in str(text) if not ch.isspace() and ord(ch) not in preferred}))


def display_text(text: str, font_path, *, strip_punct: bool = True) -> str:
    """去掉标点/引号（大字版式）并剔除字体里没有的字，保证不出方框。"""
    body = str(text or "")
    if strip_punct:
        body = "".join(ch for ch in body if ch not in _DISPLAY_STRIP)
    cmap = font_cmap(font_path)
    if not cmap:
        return body.strip()  # 判不了字形就不筛：宁可有方框，也别把整行清空
    return "".join(ch for ch in body if ord(ch) in cmap or ch == " ").strip()


def distress(mask, bite, drop, rate, sigma, seed):
    im = Image.fromarray(mask.astype(np.uint8) * 255)
    fat = np.array(im.filter(ImageFilter.MaxFilter(bite))) > 128
    thin = np.array(im.filter(ImageFilter.MinFilter(bite))) > 128
    edge = fat & ~thin & mask
    rng = np.random.default_rng(seed)
    keep = mask.copy()
    keep[edge & (rng.random(mask.shape) < drop)] = False
    noise = rng.random(mask.shape).astype(np.float32)
    speck = np.array(
        Image.fromarray((noise * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(sigma)),
        dtype=np.float32,
    ) / 255.0
    vals = speck[keep]
    if vals.size:
        keep = keep & (speck > np.quantile(vals, rate))
    return keep


def cap_sprite(text, cap_h, fill=FILL, stroke=KEYLINE, stroke_w=None, font_path=CARD_FONT,
               seed=None, hole=0.025, tracking=0.0, dilate=0):
    """Render text sized by its fill's cap height, so layout math is in pixels."""
    size = 260
    font = ImageFont.truetype(str(font_path), size)
    probe = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
    fill_box = probe.textbbox((0, 0), text, font=font)
    fill_h = max(1, fill_box[3] - fill_box[1])
    if stroke_w is None:
        stroke_w = max(4, int(round(0.07 * fill_h)))
    box = probe.textbbox((0, 0), text, font=font, stroke_width=stroke_w)
    pad = stroke_w + dilate + 18
    width = int(box[2] - box[0] + pad * 2)
    height = int(box[3] - box[1] + pad * 2)
    full = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    only = Image.new("L", (width, height), 0)
    draw, ink = ImageDraw.Draw(full), ImageDraw.Draw(only)
    cursor, top = float(pad), pad - box[1]
    for ch in text:
        draw.text((cursor, top), ch, font=font, fill=fill, stroke_width=stroke_w, stroke_fill=stroke)
        ink.text((cursor, top), ch, font=font, fill=255)
        cursor += font.getlength(ch) + tracking

    outer = np.array(full)[:, :, 3] > 128
    inner = np.array(only) > 128
    if dilate:
        import cv2

        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (dilate * 2 + 1, dilate * 2 + 1))
        inner = cv2.dilate(inner.astype(np.uint8), k) > 0
        outer = cv2.dilate(outer.astype(np.uint8), k) > 0
    if hole and seed is not None:
        outer = distress(outer, 5, 0.34, hole, 1.35, seed)
    key = outer & ~inner
    arr = np.zeros((height, width, 4), np.uint8)
    arr[key, 0], arr[key, 1], arr[key, 2] = stroke
    arr[inner, 0], arr[inner, 1], arr[inner, 2] = fill
    arr[outer, 3] = 255
    box2 = Image.fromarray(arr[:, :, 3]).getbbox()
    if box2:
        arr = arr[box2[1] : box2[3], box2[0] : box2[2]]
    return I.resize(arr, cap_h / fill_h)


def rough_sprite(text, cap_h, fill, stroke, stroke_frac, font_path, seed, weight=0.035,
                 rough=1.0, tracking=0.0, open_frac=0.0):
    """Heavy serif lettering with chipped edges, the example's card/title face.

    The example's distress lives on the stroke *edges* (notches and torn corners),
    not as speckle inside the stroke, and the keyline follows the torn edge.

    font_path may be a single font or a font *chain* (preferred first): each
    character is drawn with the first font in the chain that actually has it, so a
    missing glyph costs one character's typeface instead of dropping the character.

    open_frac: lightly erode the glyph body (fraction of fill height) to reopen
    counters on Heavy faces — used by intro red titles so 算/搞 etc. stay readable
    without dropping the torn-edge look.
    """
    import cv2

    size = 260
    runs = list(_run_fonts(str(text), font_path))
    first = ImageFont.truetype(str(_font_chain(font_path)[0]), size)
    probe = ImageDraw.Draw(Image.new("L", (8, 8)))
    fill_box = probe.textbbox((0, 0), text, font=first)
    fill_h = max(1, fill_box[3] - fill_box[1])
    grow = int(round(weight * fill_h))
    stroke_w = max(2, int(round(stroke_frac * fill_h)))
    pad = grow + stroke_w + 24
    # 混排时后备字体的字宽可能大于首选字体：按首选量的宽度留 15% 余量，末尾裁边不影响。
    width = int((fill_box[2] - fill_box[0]) * 1.15 + pad * 2 + tracking * len(text))
    height = int(fill_h + pad * 2)
    ink = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(ink)
    cursor, top = float(pad - fill_box[0]), pad - fill_box[1]
    for chars, font in runs:
        for ch in chars:
            draw.text((cursor, top), ch, font=font, fill=255)
            cursor += font.getlength(ch) + tracking
    body = np.array(ink) > 128
    if grow:
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (grow * 2 + 1, grow * 2 + 1))
        body = cv2.dilate(body.astype(np.uint8), k) > 0
    # Open counters *before* edge distress so torn notches still land on the rim.
    if open_frac > 0:
        op = max(1, int(round(open_frac * fill_h)))
        k_open = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (op * 2 + 1, op * 2 + 1))
        body = cv2.erode(body.astype(np.uint8), k_open) > 0
    rng = np.random.default_rng(seed)

    def field(sigma):
        n = rng.random(body.shape).astype(np.float32)
        n = cv2.GaussianBlur(n, (0, 0), sigma)
        return (n - n.min()) / max(1e-6, float(n.max() - n.min()))

    def below(n, region, q):
        vals = n[region]
        return region & (n < np.quantile(vals, q)) if vals.size and q > 0 else np.zeros_like(region)

    if rough > 0:
        band = max(2, int(round(0.05 * fill_h)))
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (band * 2 + 1, band * 2 + 1))
        core = cv2.erode(body.astype(np.uint8), k) > 0
        body = body & ~below(field(0.016 * fill_h), body & ~core, min(0.6, 0.07 * rough))
        deep = max(3, int(round(0.10 * fill_h)))
        k2 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (deep * 2 + 1, deep * 2 + 1))
        core2 = cv2.erode(body.astype(np.uint8), k2) > 0
        body = body & ~below(field(0.035 * fill_h), body & ~core2, min(0.5, 0.025 * rough))
        body = body & ~below(field(0.010 * fill_h), core, min(0.3, 0.03 * rough))
        soft = cv2.GaussianBlur(body.astype(np.float32), (0, 0), 0.008 * fill_h + 0.6)
        body = soft > 0.5
    ks = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (stroke_w * 2 + 1, stroke_w * 2 + 1))
    outer = cv2.dilate(body.astype(np.uint8), ks) > 0
    arr = np.zeros((height, width, 4), np.uint8)
    key = outer & ~body
    arr[key, 0], arr[key, 1], arr[key, 2] = stroke
    arr[body, 0], arr[body, 1], arr[body, 2] = fill
    arr[outer, 3] = 255
    soft = cv2.GaussianBlur(arr[:, :, 3], (0, 0), 0.7)
    arr[:, :, 3] = soft
    box2 = Image.fromarray(arr[:, :, 3]).getbbox()
    if box2:
        arr = arr[box2[1] : box2[3], box2[0] : box2[2]]
    return I.resize(arr, cap_h / fill_h)


_card_cache = {}


def card_line(text, cap_h=None, tracking=0.0):
    text = display_text(text, CARD_FONT)
    cap_h = int(cap_h or I.H * CAP)
    key = (text, cap_h)
    if key not in _card_cache:
        _card_cache[key] = rough_sprite(
            text, cap_h, FILL, KEYLINE, 0.045, CARD_FONT,
            seed=sum(map(ord, text)) % 10000, weight=0.022, rough=1.0, tracking=tracking,
        )
    return _card_cache[key]


def wrap_card(text, max_chars=8):
    """Break a card line the way the example does: at most ~8 characters a line,
    two balanced lines, never inside a word."""
    text = display_text(text, CARD_FONT)
    if len(text) <= max(6, max_chars - 2):
        return [text]
    try:
        import logging

        import jieba

        jieba.setLogLevel(logging.ERROR)
        cuts, pos = [], 0
        for word in jieba.cut(text):
            pos += len(word)
            cuts.append(pos)
    except Exception:
        cuts = list(range(1, len(text)))
    cuts = [c for c in cuts if 0 < c < len(text)]
    if not cuts:
        cuts = list(range(1, len(text)))
    half = len(text) / 2
    best = min(cuts, key=lambda c: (max(c, len(text) - c) > max_chars + 1, abs(c - half)))
    return [text[:best], text[best:]]


def pitch_for(cap_h):
    """Example line pitch is 1.22 x cap; a sprite already carries its own keyline."""
    return max(6, int(cap_h * 0.22) - 2 * int(cap_h * 0.094))


_sub_cache = {}


def subtitle(text, cap=SUB_CAP):
    text = text.strip().strip("，。！？、；：,;. ")
    # 字幕保留句内逗号等（微软雅黑字形齐全），只去引号和字体缺字
    text = display_text(text.replace("“", "").replace("”", "").replace("「", "").replace("」", ""),
                        SUB_FONT, strip_punct=False)
    if not text:
        return None
    if text not in _sub_cache:
        sprite = cap_sprite(text, cap, SUB_FILL, KEYLINE, 9, SUB_FONT, tracking=1.0)
        while sprite.shape[1] > int(I.W * 0.86) and cap > 40:
            cap -= 3
            sprite = cap_sprite(text, cap, SUB_FILL, KEYLINE, 9, SUB_FONT, tracking=1.0)
        _sub_cache[text] = sprite
    return _sub_cache[text]


def place_subtitle(frame, text, opacity=1.0):
    sprite = subtitle(text)
    if sprite is None or opacity <= 0:
        return
    I.blit(frame, sprite, (I.W - sprite.shape[1]) / 2, I.H - sprite.shape[0] - 74, opacity)


HUAZI_FONT = SUB_FONT
HUAZI_FILL = (255, 214, 10)
HUAZI_LINE = (58, 30, 8)
HUAZI_MAX = 12
_TAIL_WEAK = "就的了是把在和而但也都还又才与及并被让给对向从着过吗呢吧啊呀么"
_HEAD_WEAK = ("所以", "因为", "如果", "那么", "于是", "并且", "其实", "却是", "而是", "可是",
              "而", "但", "就", "却")


_CLAUSE_SPLIT = r"[，。！？；：、,.!?;:…—\s「」“”\"']+"


def _compact_cn(s: str) -> str:
    return re.sub(_CLAUSE_SPLIT, "", str(s or ""))


def complete_phrase(hint: str, narration: str, max_len: int = 12) -> str:
    """把截断的提示词补成口播里的完整分句：从提示起点取整句，不够长就续下一句，超长按词边界截。"""
    h = _compact_cn(hint)
    clauses = [c for c in re.split(_CLAUSE_SPLIT, str(narration or "")) if c]
    if not h or not clauses:
        return h
    flat = "".join(clauses)
    pos = flat.find(h[: min(4, len(h))])
    if pos < 0:
        return h
    acc, start = 0, None
    for i, c in enumerate(clauses):
        if start is None and acc + len(c) > pos:
            start, offset = i, pos - acc
        acc += len(c)
    if start is None:
        return h
    out = clauses[start][offset:]
    j = start + 1
    while len(out) < len(h) and j < len(clauses):
        out += clauses[j]
        j += 1
    while len(out) < 4 and j < len(clauses) and len(out) + len(clauses[j]) <= max_len:
        out += clauses[j]
        j += 1
    if len(out) > max_len:
        out = _tail_words(out, max_len)
    return out


def _tail_words(text: str, max_len: int) -> str:
    """超长分句取句尾若干整词：中文修饰在前、中心词在后，句尾才是落点（「…还能站稳的那块木板」）。"""
    try:
        import jieba

        words = jieba.lcut(text)
    except ImportError:
        return text[-max_len:]
    cut = ""
    for w in reversed(words):
        if len(cut) + len(w) > max_len:
            break
        cut = w + cut
    return cut or text[-max_len:]


def ends_at_clause(text: str, narration: str) -> bool:
    """text 在口播里是否收在分句边界（后面紧跟标点或句末）。"""
    t = _compact_cn(text)
    raw = str(narration or "")
    if not t:
        return False
    idx = [i for i, ch in enumerate(raw) if not re.match(_CLAUSE_SPLIT, ch)]
    flat = "".join(raw[i] for i in idx)
    k = flat.find(t)
    if k < 0:
        return False
    end = k + len(t)
    if end >= len(flat):
        return True
    return idx[end] - idx[end - 1] > 1


def title_phrase(text: str) -> str:
    """花字取「一个完整的短语」：按标点取首个成句片段，去掉首尾虚词，超长按词边界截。"""
    raw = str(text or "").strip()
    clauses = [c for c in re.split(r"[，。！？；：、,.!?;:…—\s]+", raw) if c.strip()]
    body = display_text(clauses[0] if clauses else raw, HUAZI_FONT)
    for head in _HEAD_WEAK:
        if body.startswith(head) and len(body) - len(head) >= 2:
            body = body[len(head):]
            break
    # 句尾虚词只在「超长被词边界截断」之后才清理：那时可能留下半个虚词。
    # 短语本来就装得下就一个字都不动 —— 否则「抄不走的才是你的」会被砍成「抄不走的才是你」，
    # 句尾的「的」是语义核心（"才是你的"），不是可以丢的虚词。
    # （原版这里是无条件清理，只是它的花字恰好没有以「的/了」收尾，所以从没暴露。）
    if len(body) > HUAZI_MAX:
        body = _tail_words(body, HUAZI_MAX)
        while len(body) > 2 and body[-1] in _TAIL_WEAK:
            body = body[:-1]
    return body if len(body) >= 2 else ""


_huazi_cache: dict[tuple[str, int], np.ndarray] = {}


def huazi_sprite(text: str, *, size: int = 112) -> np.ndarray | None:
    """标题花字：亮黄字 + 深棕粗描边 + 下投影（对齐参考的顶部大标题）。"""
    body = title_phrase(text)
    if not body:
        return None
    key = (body, int(size))
    hit = _huazi_cache.get(key)
    if hit is not None:
        return hit
    sprite = cap_sprite(body, size, fill=HUAZI_FILL, stroke=HUAZI_LINE,
                        stroke_w=None, font_path=HUAZI_FONT, seed=None, hole=0)
    h, w = sprite.shape[:2]
    off = max(4, size // 14)
    out = np.zeros((h + off, w + off, 4), np.uint8)
    shadow = sprite[:, :, 3] > 0
    out[off:, off:][shadow] = (30, 16, 4, 200)
    top = sprite[:, :, 3:4].astype(np.float32) / 255.0
    region = out[:h, :w].astype(np.float32)
    region[:, :, :3] = sprite[:, :, :3] * top + region[:, :, :3] * (1 - top)
    region[:, :, 3] = np.maximum(region[:, :, 3], sprite[:, :, 3])
    out[:h, :w] = region.astype(np.uint8)
    max_w = int(I.W * 0.86)
    if out.shape[1] > max_w:
        out = I.resize(out, max_w / out.shape[1])
    _huazi_cache[key] = out
    return out


def place_huazi(frame, text_spec: dict, phrase_index: int, phrase_t: float,
                narration: str = "") -> dict | None:
    """标题花字：顶部居中；stamp（center_full）居中更大。不与底部字幕抢位置。"""
    if not isinstance(text_spec, dict):
        return None
    raw = str(text_spec.get("content") or "")
    if narration:
        raw = complete_phrase(raw, narration, HUAZI_MAX)
    content = title_phrase(raw)
    if not content:
        return None
    enter = int(text_spec.get("enter") or 0)
    if phrase_index < enter:
        return None
    stamp = str(text_spec.get("zone") or "") == "center_full"
    sprite = huazi_sprite(content, size=150 if stamp else 112)
    if sprite is None:
        return None
    u = 1.0
    if phrase_index == enter:
        u = min(1.0, max(0.0, phrase_t / 0.26))
        if u < 0.02:
            return None
        k = 0.6 + 0.52 * I.smooth(u) - 0.12 * np.sin(np.pi * min(1.0, u))
        if abs(k - 1.0) > 0.01:
            sprite = I.resize(sprite, max(0.3, k))
        u = I.smooth(u)
    x = (I.W - sprite.shape[1]) / 2
    y = (0.40 * I.H - sprite.shape[0] / 2) if stamp else max(22, 0.09 * I.H - sprite.shape[0] / 2)
    I.blit(frame, sprite, x, y, u)
    return {
        "name": "huazi",
        "text": content,
        "box": (int(x), int(y), sprite.shape[1], sprite.shape[0]),
        "alpha": round(float(u), 3),
    }


TITLE_CAP = 185
GHOST_SCALE = 1.32
# Intro red：字魂剑气手书为主，缺字逐字退到 AmezumiGothic；简体字形优先，简体缺了才用繁体。
TITLE_WEIGHT = 0.0
TITLE_OPEN = 0.012
TITLE_ROUGH = 0.9

# 开场红字：简→繁（字体缺「說」时用日文形「説」）
_TITLE_SC2TRAD = str.maketrans({
    "为": "為",
    "么": "麼",
    "说": "説",
    "凯": "凱",
    "觉": "覺",
    "会": "會",
    "时": "時",
    "间": "間",
    "发": "發",
    "经": "經",
    "钱": "錢",
    "复": "復",
    "与": "與",
    "这": "這",
    "还": "還",
    "让": "讓",
    "开": "開",
    "关": "關",
    "门": "門",
    "问": "問",
    "题": "題",
    "过": "過",
    "进": "進",
    "对": "對",
    "个": "個",
    "来": "來",
    "后": "後",
    "从": "從",
    "当": "當",
    "应": "應",
    "该": "該",
    "实": "實",
    "现": "現",
    "点": "點",
    "种": "種",
    "样": "樣",
    "东": "東",
    "西": "西",
    "买": "買",
    "卖": "賣",
    "仓": "倉",
    "优": "優",
    "势": "勢",
    "赌": "賭",
})


def title_trad(text: str) -> str:
    """开场红字统一繁体（含字体可用的近形）。已是繁体的字保持不动。"""
    return (text or "").translate(_TITLE_SC2TRAD)


def _resolve_pick(ch: str, chain) -> tuple[str, Path]:
    """一个字符在开场红字里「实际画成什么字、由谁来画」。

    简体字形首选字体有，就照简体画（剑气手书是简体字体）；
    简体没有、繁体有，才换成繁体（保留旧的繁体外壳）；
    链上谁都没有，落回链尾保底字体——口径和 rough_sprite 的混排完全一致。
    """
    fonts = _font_chain(chain)
    trad = ch.translate(_TITLE_SC2TRAD)
    for cand in dict.fromkeys((ch, trad)):  # 无映射时两者相同，只试一次
        for font in fonts:
            if ord(cand) in font_cmap(font) and _can_draw(cand, font):
                return cand, font
    for cand in dict.fromkeys((ch, trad)):
        for font in fonts:
            if _can_draw(cand, font):
                return cand, font
    return ch, fonts[-1]


def title_resolved(text: str, chain=None) -> str:
    """开场红字实际会画出来的字（可能混着简繁），供时间轴逐字对齐。"""
    return "".join(_resolve_pick(ch, chain or TITLE_FONT_CHAIN)[0] for ch in (text or ""))


def title_same_char(shown: str, spoken: str) -> bool:
    """渲染后的红字 vs 口播原文（简体）是否同一个字：任一方向能对上就算。"""
    a, b = str(shown), str(spoken)
    if not a or not b:
        return False
    return a == b or title_trad(b) == a or title_trad(a) == b


def title_chain_gaps(text: str) -> str:
    """开场字里首选字体没有、要靠后备补的字；空串表示全部由首选字体渲染。"""
    return font_chain_gaps(title_resolved(text), TITLE_FONT_CHAIN)


def line_sprites(text, seed, cap=TITLE_CAP):
    text = title_resolved(text)
    red = _solid(rough_sprite(
        text, cap, (236, 8, 8), (236, 8, 8), 0.0, TITLE_FONT_CHAIN, seed,
        weight=TITLE_WEIGHT, rough=TITLE_ROUGH, open_frac=TITLE_OPEN,
    ))
    gray = _solid(rough_sprite(
        text, int(cap * GHOST_SCALE), (62, 60, 60), (62, 60, 60), 0.0,
        TITLE_FONT_CHAIN, seed + 9, weight=TITLE_WEIGHT, rough=1.3, open_frac=TITLE_OPEN,
    ))
    return red, gray


def _solid(sprite):
    out = np.zeros_like(sprite)
    out[:, :, :3] = sprite[:, :, :3]
    out[:, :, 3] = sprite[:, :, 3]
    return out


def title_plate(lines, centres, seed=11):
    """The opening's chipped red lettering over a grey shadow copy."""
    plate = np.zeros((I.H, I.W, 4), np.uint8)
    sprites = [line_sprites(text, seed + i * 17) for i, text in enumerate(lines)]
    # The grey copy is the whole block scaled about frame centre, so it has to fit too.
    widest = max(g.shape[1] for _r, g in sprites)
    if widest > I.W * 0.94:
        k = I.W * 0.94 / widest
        sprites = [(I.resize(r, k), I.resize(g, k)) for r, g in sprites]
    cy = I.H / 2
    for (red, gray), c in zip(sprites, centres):
        gy = cy + (c - cy) * GHOST_SCALE
        I.blit(plate, gray, I.W / 2 - gray.shape[1] / 2, gy - gray.shape[0] / 2, 1.0)
    for (red, gray), c in zip(sprites, centres):
        shadow = np.zeros((red.shape[0] + 40, red.shape[1] + 40, 4), np.uint8)
        shadow[20:-20, 20:-20, 3] = red[:, :, 3]
        shadow[:, :, 3] = np.array(Image.fromarray(shadow[:, :, 3]).filter(ImageFilter.GaussianBlur(7)))
        I.blit(plate, shadow, I.W / 2 - red.shape[1] / 2 - 20 + 6, c - red.shape[0] / 2 - 20 + 9, 0.85)
        I.blit(plate, red, I.W / 2 - red.shape[1] / 2, c - red.shape[0] / 2, 1.0)
    return plate


def shatter_parts(plate, step=16, seed=4):
    import math

    alpha = plate[:, :, 3]
    ys, xs = np.where(alpha > 20)
    if xs.size == 0:
        return []
    rng = np.random.default_rng(seed)
    parts = []
    for y in range(int(ys.min()), int(ys.max()) + 1, step):
        for x in range(int(xs.min()), int(xs.max()) + 1, step):
            patch = plate[y : y + step, x : x + step]
            if int(patch[:, :, 3].sum()) < 280:
                continue
            cx = x + patch.shape[1] / 2 - I.W / 2
            cy = y + patch.shape[0] / 2 - I.H / 2
            dist = math.hypot(cx, cy) + 1.0
            speed = 640 + float(rng.random()) * 820
            vx = cx / dist * speed + float(rng.normal(0, 90))
            vy = cy / dist * speed * 0.5 + float(rng.normal(0, 70)) + 50
            parts.append((x, y, patch.copy(), vx, vy))
    return parts


def draw_parts(frame, parts, u):
    move = u ** 0.62
    opacity = max(0.0, 1.0 - u * 1.25)
    if opacity <= 0:
        return
    for x, y, patch, vx, vy in parts:
        I.blit(frame, patch, x + vx * move, y + vy * move, opacity)
