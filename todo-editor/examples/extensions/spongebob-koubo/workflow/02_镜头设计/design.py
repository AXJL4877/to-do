"""逐句镜头设计：intro / scene / card。

硬规则：每一镜素材必须「对口播说话」——专用名 ch_sN_* / pr_sN_* + depict + prompt。
**禁止复用旧库存。** 一律由 03_素材生成 按 assets_brief 新生；
生成前 status=need_generate；生成后同名 cut 存在才 resolved。
"""
from __future__ import annotations

import json
import random
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import paths  # noqa: E402

from entrance_recipes import apply_entrance_recipe, recipe_rng  # noqa: E402
from shot_kinds import (  # noqa: E402
    LABELS as VIS_LABELS,
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
    plan_mode,
    rule_classify,
    align_say as _align_say,
    speech_only as _speech_only,
    synthesize_emphasis_text,
    synthesize_say,
    synthesize_stamp_text,
)

# 兼容旧常量名（部分 SCRIPT_BRIEFS / 外部引用）
VIS_SCENE_LEGACY = "scene_blur"
VIS_CARD_LEGACY = "card_black"

LAYER_FX = [
    "rise", "pop", "slide_l", "slide_r", "drop", "spin", "dim_up", "grow",
    "float_in", "stamp", "punch", "roll_l", "roll_r", "hop", "swing", "unfold", "toss",
]
LAYER_IDLE = ["bob", "float", "sway", "breathe", ""]

# 角色 / 道具分池，避免道具关键词误伤角色（如「成本涨价」写进角色 depict）
_FX_CHAR = (
    (("tired", "old", "疲", "折旧", "账单", "迟", "late"), ("dim_up", "drop", "fade", "rise")),
    (("young", "新", "开心", "cheer", "early", "dca"), ("pop", "hop", "punch", "rise")),
    (("train", "上车", "board", "push", "推"), ("slide_r", "hop", "toss", "rise")),
)
_FX_PROP = (
    (("price", "涨价", "箭头", "ruler", "木尺", "price_tag"), ("stamp", "drop", "punch", "slide_l")),
    (("clock", "闹钟", "alarm", "time_ally", "time_earns"), ("swing", "pop", "punch", "drop")),
    (("coin", "金币", "雪球", "ball", "snow", "tower", "stack"), ("roll_r", "roll_l", "toss", "grow", "pop")),
    (("calendar", "日历", "ticket", "票", "jar", "罐", "later"), ("unfold", "pop", "slide_r", "grow")),
    (("monster", "通胀", "bubble", "幻想", "dream", "inflation"), ("float_in", "pop", "grow", "toss")),
)


def pick_layer_fx(
    asset: dict,
    shot_idx: int,
    enter: int,
    zone: str,
    *,
    rng: random.Random | None = None,
) -> str:
    """语义池 + 随机抽取，避免每镜同一套 rise/grow。"""
    import random as _random

    rng = rng or _random.Random((shot_idx + 1) * 997 + enter * 13)
    role = asset.get("role") or ""
    blob = " ".join(
        str(asset.get(k) or "")
        for k in ("id", "name", "depict", "resolved", "line_phrase")
    ).lower()
    table = _FX_PROP if role == "prop" else _FX_CHAR
    pool = None
    for keys, fxs in table:
        if any(k.lower() in blob for k in keys):
            pool = list(fxs)
            break
    if pool is None:
        if role == "prop":
            pool = ["pop", "grow", "float_in", "toss", "slide_r", "drop", "stamp", "punch"]
        else:
            pool = ["rise", "pop", "hop", "slide_l", "slide_r", "dim_up", "punch"]
    if zone in ("far_left", "left", "mid_left"):
        pool = [f for f in pool if f not in ("slide_r", "roll_r")] or pool
    elif zone in ("far_right", "right", "mid_right"):
        pool = [f for f in pool if f not in ("slide_l", "roll_l")] or pool
    # 首角色偶尔仍用稳入场，但不强制
    if enter == 0 and role in ("character", "figure") and rng.random() < 0.35:
        return "rise"
    return rng.choice(pool)

LAYOUTS: dict[int, list[tuple[str, float]]] = {
    1: [("center", 0.72)],
    2: [("mid_left", 0.72), ("mid_right", 0.74)],
    3: [("left", 0.70), ("center", 0.72), ("right", 0.74)],
    4: [("far_left", 0.70), ("mid_left", 0.72), ("mid_right", 0.73), ("far_right", 0.74)],
}


def spots_for_count(n: int) -> list[tuple[str, float]]:
    n = max(1, min(4, int(n)))
    return list(LAYOUTS[n])


SPOTS = LAYOUTS[4]

# ---------------------------------------------------------------------------
# 按口播语义写死本片素材需求（专用名 + 画面描述 + 英文生图提示）
# 名：ch_=角色高约 0.44；pr_=道具高约 0.28
# ---------------------------------------------------------------------------

AssetSpec = dict[str, Any]


def _A(
    slot: str,
    name: str,
    role: str,
    depict: str,
    prompt: str,
    *,
    printed: bool = False,
    phrase_match: tuple[str, ...] = (),
    swap_group: str | None = None,
    swap_order: int = 0,
) -> AssetSpec:
    """本镜专用素材。

    phrase_match: 绑到含这些关键词的短语（按本镜口播切分），禁止错位。
    swap_group: 同组同站位状态切换（先入后出）；swap_order 小的先出场。
    """
    return {
        "id": slot,
        "name": name,
        "role": role,
        "depict": depict,
        "prompt": prompt,
        "printed": printed,
        "phrase_match": list(phrase_match),
        "swap_group": swap_group,
        "swap_order": int(swap_order),
        "want": [name],  # 兼容旧表头：只允许这一个专用名
    }


def _ground_prompt(
    line_text: str,
    phrase_hint: str,
    depict: str,
    prompt: str,
    *,
    role: str | None = None,
) -> str:
    """把本镜口播写进生图提示，避免画面跟错半句；叠 L5 丰富度。"""
    from richness import apply_richness

    line = re.sub(r"\s+", "", (line_text or "").strip())
    phrase = re.sub(r"\s+", "", (phrase_hint or "").strip()) or line
    body = (
        f'Narration for THIS asset only: 「{phrase}」. '
        f'Full sentence context: 「{line}」. '
        f'Must depict: {depict}. '
        f"{prompt} "
        f"Do not illustrate a different half of the sentence."
    )
    return apply_richness(role, body)


# 当前「凯莉公式」~2min 口播：逐句专用资产（禁止复用其它镜的图）
SCRIPT_BRIEFS: list[dict[str, Any]] = [
    {
        "match": ("下注之前先算", "先算凯莉公式", "为什么说下注"),
        "title": "开题：下注之前先算凯莉公式",
        "visual_Prefer": VIS_INTRO,
        "assets": [
            _A(
                "host",
                "ch_s0_kelly_host",
                "character",
                "海绵宝宝拿着放大镜盯着一张下注单（先算再押）",
                "SpongeBob SquarePants holding a magnifying glass over a betting slip, thoughtful calculating expression, "
                "full body, single character only.",
            ),
            _A(
                "theme",
                "pr_s0_kelly_sheet",
                "prop",
                "写着 KELLY 的计算器式账本",
                "A cartoon ledger with bold KELLY lettering and a tiny calculator, thick black outline, "
                "single prop only, no character.",
                printed=True,
            ),
        ],
    },
    {
        "match": ("水母大赛", "谁会夺冠", "全镇都在"),
        "title": "全镇议论水母大赛",
        "assets": [
            _A(
                "crowd",
                "ch_s1_town_buzz",
                "character",
                "海绵宝宝举着大赛传单听全镇议论",
                "SpongeBob SquarePants holding a contest flyer listening to town buzz, curious pose, "
                "full body, single character only.",
            ),
            _A(
                "poster",
                "pr_s1_jelly_poster",
                "prop",
                "水母大赛夺冠海报",
                "A colorful jellyfish contest champion poster, cartoon, thick outline, single prop only, no character.",
                printed=True,
            ),
        ],
    },
    {
        "match": ("全部金币", "逢人就说", "这次稳了"),
        "title": "派大星梭哈喊稳了",
        "assets": [
            _A(
                "allin",
                "ch_s2_patrick_allin",
                "character",
                "派大星把整袋金币推上赌桌并喊稳了",
                "Patrick Star shoving a huge sack of gold coins onto a betting table shouting confidently, "
                "overconfident grin, green flower shorts, full body, single character only. Not SpongeBob.",
            ),
            _A(
                "sack",
                "pr_s2_full_sack",
                "prop",
                "鼓鼓的全部金币袋",
                "An oversized stuffed gold coin sack ready for all-in, cartoon, single prop only, no character.",
            ),
        ],
    },
    {
        "match": ("留一点后手", "胆子大", "才能发财"),
        "title": "劝留后手 vs 胆子大发财",
        "assets": [
            _A(
                "warn",
                "ch_s3_bob_warn",
                "character",
                "海绵宝宝劝说留一点后手",
                "Concerned SpongeBob SquarePants advising to keep a reserve, hands open warning pose, "
                "full body, single character only.",
                phrase_match=("后手", "劝他"),
                swap_group="brave",
                swap_order=0,
            ),
            _A(
                "brave",
                "ch_s3_patrick_brave",
                "character",
                "派大星拍胸脯说胆子大才能发财",
                "Boastful Patrick Star thumping chest saying bravery makes you rich, "
                "full body, single character only. Not SpongeBob.",
                phrase_match=("胆子大", "发财"),
                swap_group="brave",
                swap_order=1,
            ),
        ],
    },
    {
        "match": ("风向一变", "跑偏了赛道", "只剩一条短裤"),
        "title": "风向一变输光短裤",
        "assets": [
            _A(
                "broke",
                "ch_s4_patrick_broke",
                "character",
                "派大星空着手只剩短裤一脸懵（输光）",
                "Broke Patrick Star standing empty-handed in only flower shorts looking stunned and broke, "
                "no coins left, full body, single character only. Not SpongeBob.",
            ),
            _A(
                "offtrack",
                "pr_s4_jelly_offtrack",
                "prop",
                "水母群跑偏赛道的箭头",
                "Cartoon jellyfish swarm veering off a race track with wrong-way arrows, single prop only, no character.",
            ),
        ],
    },
    {
        "match": ("蟹老板", "不是敢赌", "而是敢算", "压低声音"),
        "title": "蟹老板：敢算比敢赌厉害",
        "assets": [
            _A(
                "krabs",
                "ch_s5_krabs_teach",
                "character",
                "蟹老板在柜台后压低声音指教",
                "Mr Krabs behind the Krusty Krab counter leaning in teaching quietly and seriously, "
                "red crab character full body, single character only. Not SpongeBob, not Patrick.",
                phrase_match=("蟹老板", "压低声音"),
            ),
            _A(
                "listen",
                "ch_s5_bob_listen",
                "character",
                "海绵宝宝在柜台前认真听讲",
                "SpongeBob SquarePants standing in front of a counter listening carefully with notebook, "
                "attentive pose, full body, single character only.",
                phrase_match=("海绵宝宝", "敢算"),
            ),
            _A(
                "vs",
                "pr_s5_gamble_vs_calc",
                "prop",
                "骰子被计算器压住（敢算压过敢赌）",
                "A cartoon calculator pressing down on a pair of dice, thick outline, single prop only, no character.",
                phrase_match=("敢赌", "敢算"),
            ),
        ],
    },
    {
        "match": ("只有一个问题", "要回答的"),
        "title": "凯莉只回答一个问题",
        "card": True,
        "assets": [
            _A(
                "figure",
                "ch_s6_one_question",
                "figure",
                "海绵宝宝举起一根手指强调只有一个问题",
                "SpongeBob SquarePants holding up one finger seriously as if asking one key question, "
                "full body, single character only.",
            ),
        ],
    },
    {
        "match": ("该押多少", "这笔机会"),
        "title": "这笔机会该押多少",
        "card": True,
        "assets": [
            _A(
                "figure",
                "ch_s7_how_much",
                "figure",
                "海绵宝宝双手比出多大仓位的手势",
                "SpongeBob SquarePants gesturing with both hands showing a sizing question how much to bet, "
                "curious thinking face, full body, single character only.",
            ),
            _A(
                "icon",
                "pr_s7_bet_scale",
                "icon",
                "天平一边金币一边问号",
                "A cartoon balance scale with gold coins on one side and a big question mark on the other, "
                "single prop only.",
            ),
        ],
    },
    {
        "match": ("多想赢", "多知道多少", "赔率"),
        "title": "看优势与赔率，不看想赢",
        "assets": [
            _A(
                "want",
                "ch_s8_want_win",
                "character",
                "海绵宝宝眼睛冒星幻想大赢（多想赢）",
                "Excited SpongeBob SquarePants with starry eyes daydreaming about winning big, "
                "full body, single character only.",
                phrase_match=("多想赢", "想赢"),
                swap_group="edge",
                swap_order=0,
            ),
            _A(
                "edge",
                "ch_s8_know_more",
                "character",
                "海绵宝宝捧着情报卷轴比别人多知道（优势）",
                "Focused SpongeBob SquarePants holding an intelligence scroll looking wiser than the crowd, "
                "full body, single character only.",
                phrase_match=("多知道多少", "知道"),
                swap_group="edge",
                swap_order=1,
            ),
            _A(
                "odds",
                "pr_s8_odds_board",
                "prop",
                "赔率牌写着 odds",
                "A cartoon odds board with bold ODDS numbers, thick outline, single prop only, no character.",
                printed=True,
                phrase_match=("赔率",),
            ),
        ],
    },
    {
        "match": ("优势越大", "多押一点"),
        "title": "优势大可以多押",
        "assets": [
            _A(
                "big",
                "ch_s9_big_edge",
                "character",
                "海绵宝宝自信地推较大一袋金币（多押）",
                "Confident SpongeBob SquarePants pushing a medium-large coin bag forward with measured courage, "
                "full body, single character only. Not reckless all-in.",
            ),
            _A(
                "gauge",
                "pr_s9_edge_high",
                "prop",
                "优势仪表指向高档",
                "A cartoon advantage gauge needle pointing to HIGH, thick outline, single prop only, no character.",
            ),
        ],
    },
    {
        "match": ("优势很小", "一小勺"),
        "title": "优势小只动一小勺",
        "assets": [
            _A(
                "tiny",
                "ch_s10_tiny_scoop",
                "character",
                "海绵宝宝小心舀一小勺金币",
                "Careful SpongeBob SquarePants scooping only a tiny spoonful of gold coins, "
                "gentle precise pose, full body, single character only.",
            ),
            _A(
                "spoon",
                "pr_s10_small_spoon",
                "prop",
                "盛着几枚金币的小勺",
                "A tiny cartoon spoon holding just a few gold coins, single prop only, no character.",
            ),
        ],
    },
    {
        "match": ("大胆就是梭哈", "很多人以为"),
        "title": "误区：大胆等于梭哈",
        "assets": [
            _A(
                "crowd",
                "ch_s11_crowd_allin",
                "character",
                "派大星挥拳喊梭哈状（以为大胆）",
                "Patrick Star pumping fist yelling like all-in is bravery, overexcited pose, "
                "full body, single character only. Not SpongeBob.",
            ),
            _A(
                "banner",
                "pr_s11_allin_banner",
                "prop",
                "写着 ALL IN 的横幅",
                "A flashy ALL IN banner, cartoon, thick outline, single prop only, no character.",
                printed=True,
            ),
        ],
    },
    {
        "match": ("最笨的勇气", "其实梭哈"),
        "title": "梭哈是最笨的勇气",
        "card": True,
        "assets": [
            _A(
                "figure",
                "ch_s12_dumb_brave",
                "figure",
                "海绵宝宝摇头否定梭哈勇气",
                "SpongeBob SquarePants shaking head seriously rejecting reckless all-in bravery, "
                "full body, single character only.",
            ),
            _A(
                "icon",
                "pr_s12_broken_courage",
                "icon",
                "裂开的勇气徽章",
                "A cracked cartoon bravery badge looking foolish, single prop only.",
            ),
        ],
    },
    {
        "match": ("押太少", "会被浪费"),
        "title": "押太少浪费优势",
        "assets": [
            _A(
                "waste",
                "ch_s13_too_little",
                "character",
                "海绵宝宝对着巨大机会只塞一枚硬币（太少）",
                "SpongeBob SquarePants placing only one tiny coin into a huge opportunity slot looking wasteful, "
                "regretful face, full body, single character only.",
            ),
            _A(
                "leak",
                "pr_s13_wasted_edge",
                "prop",
                "优势从沙漏漏走",
                "An hourglass leaking glowing advantage dust away, cartoon, single prop only, no character.",
            ),
        ],
    },
    {
        "match": ("押太多", "踢出局", "一次回撤"),
        "title": "押太多一次出局",
        "assets": [
            _A(
                "kick",
                "ch_s14_kicked_out",
                "character",
                "海绵宝宝被回撤巨浪踢飞出局",
                "SpongeBob SquarePants being kicked off a game board by a huge drawdown wave, "
                "startled flying pose, full body, single character only.",
            ),
            _A(
                "wave",
                "pr_s14_drawdown_wave",
                "prop",
                "写着回撤的巨浪",
                "A giant cartoon wave labeled DRAWDOWN crashing down, single prop only, no character.",
                printed=True,
            ),
        ],
    },
    {
        "match": ("问题就在这里",),
        "title": "问题就在这里",
        "card": True,
        "assets": [
            _A(
                "figure",
                "ch_s15_problem_here",
                "figure",
                "海绵宝宝双手指向问题节点",
                "Serious SpongeBob SquarePants pointing both index fingers at a glowing problem node, "
                "as if saying the problem is here, full body, single character only.",
            ),
        ],
    },
    {
        "match": ("仓位选错", "变成笑话"),
        "title": "仓位选错判断变笑话",
        "assets": [
            _A(
                "wrong",
                "ch_s16_wrong_size",
                "character",
                "海绵宝宝拿着错档仓位旋钮一脸尴尬",
                "Embarrassed SpongeBob SquarePants holding a wrong-position-size knob looking like a joke, "
                "full body, single character only.",
            ),
            _A(
                "joke",
                "pr_s16_joke_stamp",
                "prop",
                "盖着笑话印章的判断书",
                "A judgment paper stamped with a cartoon JOKE seal, single prop only, no character.",
                printed=True,
            ),
        ],
    },
    {
        "match": ("看错方向", "押得太满", "真正让人出局"),
        "title": "出局因为押太满",
        "assets": [
            _A(
                "full",
                "ch_s16b_too_full",
                "character",
                "海绵宝宝推着过满的金币车翻倒出局",
                "SpongeBob SquarePants pushing an overfilled coin cart that tips over knocking him out of the game, "
                "startled pose, full body, single character only.",
            ),
            _A(
                "overflow",
                "pr_s16b_overflow",
                "prop",
                "装得太满溢出的仓位桶",
                "An overflowing position-size barrel spilling coins, cartoon, single prop only, no character.",
            ),
        ],
    },
    {
        "match": ("一小袋金币", "每次只拿"),
        "title": "每次只拿一小袋试",
        "assets": [
            _A(
                "try",
                "ch_s17_small_bag",
                "character",
                "海绵宝宝提着一小袋金币去试（小仓位）",
                "SpongeBob SquarePants carrying a small coin bag going to try carefully, "
                "calm confident walk, full body, single character only.",
            ),
            _A(
                "bag",
                "pr_s17_trial_bag",
                "prop",
                "系绳的小金币袋",
                "A small tied cartoon coin bag, modest size, single prop only, no character.",
            ),
        ],
    },
    {
        "match": ("袋子慢慢变大", "吃泡面", "赢了就让"),
        "title": "赢则长大，输也不垮",
        "assets": [
            _A(
                "grow",
                "ch_s18_bag_grows",
                "character",
                "海绵宝宝看着袋子慢慢鼓起来（赢了变大）",
                "Happy SpongeBob SquarePants watching his coin bag slowly grow bigger, "
                "relieved smile, full body, single character only.",
                phrase_match=("赢了", "变大"),
                swap_group="bag",
                swap_order=0,
            ),
            _A(
                "safe",
                "ch_s18_no_noodles",
                "character",
                "海绵宝宝即使输了也还能吃饭不慌",
                "Calm SpongeBob SquarePants sitting safely with a small meal after a loss, not ruined, "
                "full body, single character only.",
                phrase_match=("泡面", "输了"),
                swap_group="bag",
                swap_order=1,
            ),
            _A(
                "grow_bag",
                "pr_s18_growing_bag",
                "prop",
                "从小到大的金币袋序列",
                "Three cartoon coin bags growing from small to large in a row, single prop cluster, no character.",
                phrase_match=("变大",),
            ),
        ],
    },
    {
        "match": ("不再追", "看得懂的局", "每一场热闹"),
        "title": "只盯看得懂的局",
        "assets": [
            _A(
                "focus",
                "ch_s19_focus_board",
                "character",
                "海绵宝宝盯着自己懂的棋盘不追热闹",
                "Focused SpongeBob SquarePants studying a board he understands while ignoring noisy crowd lights, "
                "disciplined pose, full body, single character only.",
            ),
            _A(
                "noise",
                "pr_s19_noisy_crowd",
                "prop",
                "远处嘈杂的热闹招牌被划掉",
                "A crossed-out noisy carnival sign in the distance, cartoon, single prop only, no character.",
            ),
        ],
    },
    {
        "match": ("笑他慢", "走得远", "慢一点"),
        "title": "慢一点才能走得远",
        "assets": [
            _A(
                "slow",
                "ch_s20_slow_far",
                "character",
                "海绵宝宝稳步长跑不理嘲笑",
                "Steady SpongeBob SquarePants jogging a long path calmly ignoring laugh lines, "
                "patient smile, full body, single character only.",
            ),
            _A(
                "path",
                "pr_s20_long_path",
                "prop",
                "通向远方的小路路标",
                "A cartoon road sign pointing FAR ahead on a long path, single prop only, no character.",
            ),
        ],
    },
    {
        "match": ("惊心动魄", "睡得着的夜晚", "日子一天天"),
        "title": "少惊险，多睡得着",
        "assets": [
            _A(
                "sleep",
                "ch_s21_sleep_well",
                "character",
                "海绵宝宝安稳睡着微笑",
                "Peaceful SpongeBob SquarePants sleeping calmly with a small smile, "
                "full body resting pose, single character only.",
            ),
            _A(
                "storm",
                "pr_s21_faded_storm",
                "prop",
                "淡去的惊险闪电符号",
                "Fading cartoon lightning bolts of thrill crossed out, single prop only, no character.",
            ),
        ],
    },
    {
        "match": ("还能再玩", "真正的勇气是", "留下明天"),
        "title": "勇气是留下还能再玩的本金",
        "card": True,
        "assets": [
            _A(
                "figure",
                "ch_s21b_keep_playing",
                "figure",
                "海绵宝宝护着明天还能再玩的本金罐",
                "Wise SpongeBob SquarePants protecting a tomorrow bankroll jar, "
                "calm guardian pose, full body, single character only.",
            ),
            _A(
                "icon",
                "pr_s21b_reserve_jar",
                "icon",
                "贴着明天标签的本金罐",
                "A cartoon reserve jar labeled TOMORROW, single prop only.",
                printed=True,
            ),
        ],
    },
    {
        "match": ("稳赚神话", "可带走的结果", "一次次兑现"),
        "title": "别人追神话，他兑现结果",
        "assets": [
            _A(
                "myth",
                "ch_s22_chase_myth",
                "character",
                "派大星追着稳赚神话气泡跑",
                "Patrick Star chasing a glowing GET RICH myth bubble, frantic pose, "
                "full body, single character only. Not SpongeBob.",
                phrase_match=("稳赚神话", "神话"),
                swap_group="result",
                swap_order=0,
            ),
            _A(
                "result",
                "ch_s22_take_result",
                "character",
                "海绵宝宝提着装金币的布袋微笑",
                "SpongeBob SquarePants calmly carrying a small cloth bag of coins he earned, "
                "content pose, full body, single character only.",
                phrase_match=("可带走", "兑现"),
                swap_group="result",
                swap_order=1,
            ),
        ],
    },
    {
        "match": ("一年后", "稳赚的内幕", "打听"),
        "title": "一年后派大星还在打听内幕",
        "assets": [
            _A(
                "rumor",
                "ch_s23_patrick_rumor",
                "character",
                "派大星竖耳打听下一次稳赚内幕",
                "Patrick Star cupping ear listening for insider tips looking naive, "
                "full body, single character only. Not SpongeBob.",
            ),
            _A(
                "whisper",
                "pr_s23_rumor_bubble",
                "prop",
                "写着内幕的八卦气泡",
                "A cartoon gossip speech bubble with TIP lettering, single prop only, no character.",
                printed=True,
            ),
        ],
    },
    {
        "match": ("滚出一座小山", "罐子却已经"),
        "title": "罐子滚出一座小山",
        "assets": [
            _A(
                "rich",
                "ch_s24_bob_mountain",
                "character",
                "海绵宝宝站在金币小山前满足微笑",
                "Proud SpongeBob SquarePants standing beside a small mountain of coin jars, "
                "content smile, full body, single character only.",
            ),
            _A(
                "hill",
                "pr_s24_coin_hill",
                "prop",
                "金币罐子堆成的小山",
                "A cute hill made of stacked coin jars and gold coins, cartoon, single prop only, no character.",
            ),
        ],
    },
    {
        "match": ("一夜暴富", "活得够久", "慢慢兑现"),
        "title": "不是暴富，是活得够久",
        "assets": [
            _A(
                "flash",
                "ch_s25_get_rich_fast",
                "character",
                "幻想暴富的派大星被划掉（一夜暴富）",
                "Patrick Star posing like overnight rich with sparkles looking unrealistic, "
                "full body, single character only. Not SpongeBob.",
                phrase_match=("一夜暴富",),
                swap_group="long",
                swap_order=0,
            ),
            _A(
                "long",
                "ch_s25_live_long",
                "character",
                "海绵宝宝稳健走路让优势慢慢兑现",
                "Steady SpongeBob SquarePants walking a long path with a growing edge glowing beside him, "
                "patient confident stride, full body, single character only.",
                phrase_match=("活得够久", "慢慢兑现"),
                swap_group="long",
                swap_order=1,
            ),
            _A(
                "clock",
                "pr_s25_long_game",
                "prop",
                "长跑路线上的时钟",
                "A cartoon clock on a long winding path, thick outline, single prop only, no character.",
                phrase_match=("活得够久",),
            ),
        ],
    },
    {
        "match": ("控制仓位", "时间就越", "站在你这一边"),
        "title": "会控仓，时间站你这边",
        "card": True,
        "assets": [
            _A(
                "figure",
                "ch_s26_time_ally",
                "figure",
                "海绵宝宝与时间握手同盟",
                "SpongeBob SquarePants shaking hands with a friendly cartoon clock as an ally, "
                "full body combined cutout subject.",
            ),
            _A(
                "icon",
                "pr_s26_position_knob",
                "icon",
                "仓位旋钮拧在合适档位",
                "A cartoon position-size knob set to a moderate safe level, single prop only.",
            ),
        ],
    },
    {
        "match": ("下次再有人", "先问一句"),
        "title": "收束：先问该押多少",
        "assets": [
            _A(
                "ask",
                "ch_s27_ask_back",
                "character",
                "海绵宝宝举手反问该押多少",
                "SpongeBob SquarePants raising a hand to ask back how much should you bet, "
                "wise friendly expression, full body, single character only.",
            ),
            _A(
                "q",
                "pr_s27_final_question",
                "prop",
                "大大的问号金币",
                "A large gold coin engraved with a question mark, cartoon, single prop only, no character.",
            ),
        ],
    },
]

# 运行时可注入（LLM 逐句 brief）；None 则走 SCRIPT_BRIEFS 关键词匹配
_ACTIVE_BRIEFS: list[dict[str, Any]] | None = None


def set_active_briefs(briefs: list[dict[str, Any]] | None) -> None:
    global _ACTIVE_BRIEFS
    _ACTIVE_BRIEFS = briefs


def classify(
    sentence_index: int,
    text: str,
    duration: float,
    prefer: str | None = None,
    *,
    used_stamp: bool = False,
    phrase_count: int = 1,
) -> str:
    if prefer:
        vis = normalize_visual(prefer, shot_idx=sentence_index)
        if sentence_index == 0:
            return VIS_INTRO
        return vis
    return rule_classify(
        sentence_index,
        text,
        duration,
        used_stamp=used_stamp,
        phrase_count=phrase_count,
    )


def _intro_lines(text: str, forced: list[str] | None = None) -> list[str]:
    """红字标题：按语义断行，禁止「为什么说搞钱要｜趁年轻…」这种拦腰斩。"""
    if forced:
        lines = [re.sub(r"\s+", "", str(x))[:10] for x in forced if str(x).strip()]
        if lines:
            return lines[:4]
    # 示例：第一屏一行 ≤6 字（为什么说搞钱），第二屏两行（要趁年轻时 / 研究复利）。
    body = re.sub(r"[，。！？；,\s]", "", text)
    if not body:
        return []
    if len(body) <= 6:
        return [body]
    # 本片开题：第一屏一句钩子，第二屏两行补完
    if body.startswith("为什么说凯莉公式") or (
        "凯莉公式" in body[:16] and body.startswith("为什么说")
    ):
        return ["為什麼説凱莉公式", "聽起來像賭場偏方", "其實管著你該押多少"]
    if body.startswith("为什么说下注之前") and "凯莉公式" in body:
        # 开场红字用繁体（AmezumiGothic 覆盖）；「说」取字体有的「説」
        return ["為什麼説下注", "之前先算", "凱莉公式"]
    if body.startswith("为什么说金本位") and "口袋" in body:
        return ["為什麼説金本位", "聽起來像博物館規矩", "其實管著你口袋的錢"]
    if body.startswith("为什么说存钱不够") and "让钱开工" in body:
        return ["为什么说存钱不够", "还得早点", "让钱开工"]
    if body.startswith("为什么说搞钱要趁年轻") and "研究复利" in body:
        return ["为什么说搞钱", "要趁年轻", "研究复利"]
    # 不依赖分词库：先按标点切成小句（中文口播稿的语义边界就是逗句），再按长度折行。
    # 这里原来 import jieba —— 那既不在扩展包内、也不在 TODO 的 python 运行时里，
    # 是一条**从没跑通过的死路径**（旧运行都走 forced=LLM 给的行）。
    # 按"一切都在包中发生"的原则，正确做法是不引入新依赖。
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "kit"))
    from kit import typo

    clauses = [c.strip() for c in re.split(r"[，。！？；,]", text) if c.strip()]
    if not clauses:
        return []
    head = clauses[0]
    rest = "".join(clauses[1:])
    lines = typo.wrap_card(head, 8) if len(head) > 8 else [head]
    if rest:
        lines += typo.wrap_card(rest, 6)
    return [ln for ln in lines if ln][:4]


def _card_text(text: str) -> list[str]:
    """黄字：按逗句拆成多行金句，不只截第一句前 9 字。"""
    parts = [p.strip() for p in re.split(r"[，。！？；,]", text) if p.strip()]
    if not parts:
        return [text.strip()[:12] or ""]
    lines: list[str] = []
    for p in parts[:3]:
        if len(p) <= 10:
            lines.append(p)
        else:
            lines.append(p[:10])
            if len(p) > 10:
                lines.append(p[10:20])
        if len(lines) >= 3:
            break
    return lines[:3]


def _card_phrase_line(text: str) -> list[str]:
    """单句短语上屏：清标点，过长则两行。"""
    body = re.sub(r"[，。！？；,]", "", (text or "").strip())
    if not body:
        return [""]
    if len(body) <= 10:
        return [body]
    return [body[:10], body[10:20]]


def _score_brief(text: str, brief: dict) -> int:
    score = 0
    for key in brief.get("match") or ():
        if key in text:
            score = max(score, len(key))
    return score


def pick_brief(text: str, shot_idx: int | None = None) -> dict[str, Any]:
    if _ACTIVE_BRIEFS is not None and shot_idx is not None and 0 <= shot_idx < len(_ACTIVE_BRIEFS):
        brief = _ACTIVE_BRIEFS[shot_idx]
        return {**brief, "_hit": f"idx:{shot_idx}"}
    best = None
    best_score = 0
    for brief in SCRIPT_BRIEFS:
        sc = _score_brief(text, brief)
        if sc > best_score:
            best_score = sc
            best = brief
    if best is None:
        # 兜底也给本句专用名，仍禁止复用旧库存
        safe = re.sub(r"\W+", "_", text)[:12] or "line"
        return {
            "title": "未匹配专用规则（需补规则）",
            "match": (),
            "assets": [
                _A(
                    "host",
                    f"ch_fallback_{safe}",
                    "character",
                    f"与口播对应的角色：{text[:24]}",
                    "SpongeBob SquarePants explaining a finance idea, full body, single character only.",
                ),
            ],
            "_hit": "",
        }
    return {**best, "_hit": max((k for k in best["match"] if k in text), key=len, default="")}


def _cut_dir() -> Path:
    return paths.KIT_ASSETS / "cut"


def resolve_asset(spec: AssetSpec, cut_names: set[str]) -> AssetSpec:
    name = spec["name"]
    out = dict(spec)
    if name in cut_names:
        out["resolved"] = name
        out["status"] = "ok"
    else:
        out["resolved"] = None
        out["status"] = "need_generate"
    return out


def _phrase_hint_for_asset(text: str, phrases: list[dict], asset: AssetSpec) -> str:
    """用本镜短语给素材定口播锚点；无 match 则用整句。"""
    keys = asset.get("phrase_match") or []
    for p in phrases:
        pt = str(p.get("text") or "")
        if any(k in pt for k in keys):
            return pt
    if keys and any(k in text for k in keys):
        # 整句里命中但短语未切开：用关键词所在半句粗切
        for k in keys:
            i = text.find(k)
            if i >= 0:
                left = max(0, i - 8)
                right = min(len(text), i + len(k) + 8)
                return text[left:right]
    return text


def build_beat_assets(
    text: str,
    visual: str,
    cut_names: set[str],
    phrases: list[dict] | None = None,
    *,
    shot_idx: int | None = None,
) -> dict[str, Any]:
    brief = pick_brief(text, shot_idx=shot_idx)
    phrases = phrases or []
    assets = []
    for raw in brief["assets"]:
        # LLM brief 已是 dict；规则 brief 经 _A 也是 dict
        a = resolve_asset(dict(raw), cut_names)
        hint = _phrase_hint_for_asset(text, phrases, a)
        a["line_phrase"] = hint
        a["prompt"] = _ground_prompt(
            text,
            hint,
            a.get("depict") or "",
            a.get("prompt") or "",
            role=a.get("role"),
        )
        assets.append(a)
    figure = icon = None
    if visual == VIS_CARD or brief.get("card"):
        for a in assets:
            if a["role"] in ("figure", "character") and figure is None:
                figure = a.get("resolved")
            if a["role"] == "icon":
                icon = a.get("resolved")
    return {
        "brief_title": brief.get("title", ""),
        "hit_key": brief.get("_hit", ""),
        "assets": assets,
        "figure": figure,
        "icon": icon,
        "intro_lines": brief.get("intro_lines"),
        "visual_prefer": brief.get("visual_prefer"),
    }


def design_beats(
    sentences: list[dict],
    available_names: list[str],
    *,
    seed: int = 20260408,
) -> list[dict[str, Any]]:
    del seed
    cut_names = set(available_names)
    # 也扫 cut 目录，避免 stub 列表干扰
    cut = _cut_dir()
    if cut.is_dir():
        cut_names |= {p.stem for p in cut.glob("*.png")}

    beats = []
    used_stamp = False
    for i, s in enumerate(sentences):
        text = s["text"]
        dur = float(s["end"]) - float(s["start"])
        prefer = None
        brief_text = None
        if _ACTIVE_BRIEFS is not None and i < len(_ACTIVE_BRIEFS):
            prefer = _ACTIVE_BRIEFS[i].get("visual_prefer")
            if _ACTIVE_BRIEFS[i].get("card"):
                prefer = VIS_CARD
            brief_text = _ACTIVE_BRIEFS[i].get("text")
        nph = len(s.get("phrases") or [])
        visual = classify(
            i,
            text,
            dur,
            prefer=prefer,
            used_stamp=used_stamp,
            phrase_count=nph,
        )
        if visual == VIS_STAMP:
            used_stamp = True
        packed = build_beat_assets(
            text, visual, cut_names, phrases=s.get("phrases") or [], shot_idx=i
        )
        assets = packed["assets"]
        # dialogue：补 say
        if visual == VIS_DIALOGUE:
            says = synthesize_say(text, list(s.get("phrases") or []))
            chars = [a for a in assets if a.get("role") == "character"]
            for a, sy in zip(chars, says):
                if not a.get("say"):
                    a.update(sy)
        text_overlay = None
        if visual == VIS_EMPHASIS:
            text_overlay = (
                brief_text
                if isinstance(brief_text, dict) and brief_text.get("content")
                else synthesize_emphasis_text(text)
            )
        elif visual == VIS_STAMP:
            text_overlay = (
                brief_text
                if isinstance(brief_text, dict) and brief_text.get("content")
                else synthesize_stamp_text(text)
            )
        beach = visual in (
            VIS_SCENE,
            VIS_DIALOGUE,
            VIS_DUO,
            VIS_EMPHASIS,
            VIS_STAMP,
            VIS_REVEAL,
            VIS_REACTION,
            VIS_INTRO,
        )
        if beach and visual != VIS_INTRO:
            count = min(
                4,
                len([a for a in assets if a["role"] in ("character", "prop", "figure", "icon")]),
            )
        else:
            count = 0
        missing = [a for a in assets if a["status"] != "ok"]
        beats.append(
            {
                "idx": i,
                "start": s["start"],
                "end": s["end"],
                "text": text,
                "visual": visual,
                "element_count": count,
                "phrases": len(s.get("phrases") or []),
                "brief_title": packed["brief_title"],
                "hit_key": packed["hit_key"],
                "assets": assets,
                "figure": packed.get("figure"),
                "icon": packed.get("icon"),
                "text_overlay": text_overlay,
                "missing_count": len(missing),
                "intro_lines": packed.get("intro_lines"),
            }
        )
    from shot_kinds import enforce_diversity

    visuals = enforce_diversity([b["visual"] for b in beats])
    for i, b in enumerate(beats):
        b["visual"] = visuals[i]
        spoken = sentences[i]["text"]
        if b["visual"] == VIS_EMPHASIS and not (
            isinstance(b.get("text_overlay"), dict) and b["text_overlay"].get("content")
        ):
            b["text_overlay"] = synthesize_emphasis_text(spoken)
        if b["visual"] == VIS_STAMP and not (
            isinstance(b.get("text_overlay"), dict) and b["text_overlay"].get("content")
        ):
            b["text_overlay"] = synthesize_stamp_text(spoken)
        if b["visual"] == VIS_DIALOGUE:
            says = synthesize_say(spoken, list(sentences[i].get("phrases") or []))
            chars = [a for a in (b.get("assets") or []) if a.get("role") == "character"]
            for a, sy in zip(chars, says):
                if not a.get("say"):
                    a.update(sy)
        if b["visual"] in (
            VIS_SCENE,
            VIS_DIALOGUE,
            VIS_DUO,
            VIS_EMPHASIS,
            VIS_STAMP,
            VIS_REVEAL,
            VIS_REACTION,
        ):
            b["element_count"] = min(
                4,
                len(
                    [
                        a
                        for a in (b.get("assets") or [])
                        if a.get("role") in ("character", "prop", "figure", "icon")
                    ]
                ),
            )
        elif b["visual"] in (VIS_CARD, VIS_INTRO):
            b["element_count"] = 0
    return beats


def beats_to_kit_plan(
    sentences: list[dict],
    beats: list[dict],
    available_names: list[str],
    *,
    seed: int = 20260408,
) -> dict[str, Any]:
    """只绑定本镜专用且已生成的素材；绝不拿其它库存名填充。"""
    del available_names
    shots = []
    intro_lines: list[str] = []

    def _retime_layers_by_phrase(layers: list[dict], chars: list[dict], phrases: list[dict] | None = None) -> None:
        """按每层自带的短语文本，用**逐字时间戳**校正 enter_at（就地修改）。

        为什么需要：入场时刻原本靠"关键词命中 phrases[].text"（见 _phrase_index_for），
        一旦 phrases 没带 text 或切分不同，就会**静默退回"按槽位摊"**——而槽位枚举顺序
        常与口播语序相反。实测 shot8「穷人存钱，富人存资产，而聪明人早就换了赛道」：
        三个元素被摊成完全倒序（章鱼哥 29.95 / 蟹老板 31.00 / 海绵宝宝 32.47），
        看片就是"元素出场顺序和念到的顺序对不上"。
        逐字时间戳就在同一句里、且与文本一一对应，按文本定位即可自愈。
        """
        def norm(s: str) -> str:
            return re.sub(r"[，。！？；、,.!?\"'\s]", "", str(s or ""))

        seq, at = "", []
        for c in chars:
            t = norm(c.get("text") or "")
            if not t:
                continue
            seq += t
            at.append((len(seq), float(c.get("start") or 0)))
        if not seq:
            return

        def start_of(needle: str) -> float | None:
            n = norm(needle)
            if len(n) < 2:
                return None
            # 由长到短取前缀：短语尾部的语气词/标点常与逐字切分不一致
            for cut in range(min(len(n), 8), 1, -1):
                i = seq.find(n[:cut])
                if i >= 0:
                    for end, t in at:
                        if end > i:
                            return t
            return None

        for L in layers:
            t = start_of(L.get("_phrase") or "")
            if t is not None:
                L["enter_at"] = t
                # ⚠️ 必须把 enter 一起拉回来对齐。上面只改 enter_at，就出现
                # "enter 说短语1、enter_at 却是短语0的时刻"——两者互相矛盾，
                # 验收门 validate_phrase_sync 直接判失败（整条管线停在验收），
                # 而且报错看不出是这里。enter_at 是按**真实逐字时间戳**定位出来的，
                # 以它为准反查最近短语，让两个字段重新自洽。
                if phrases:
                    nearest = min(
                        range(len(phrases)),
                        key=lambda k: abs(float(phrases[k].get("start") or 0) - t),
                    )
                    L["enter"] = nearest

    def _phrase_index_for(a: dict, phrases: list[dict], slot_i: int, n_layers: int) -> int:
        """绑入口播短语下标。

        - 有 phrase_match：按最长关键词命中
        - 无锚点 / 未命中：按槽位摊到短语上（渐进入场），禁止全挤 enter=0
        """
        nph = max(1, len(phrases))
        keys = [
            k
            for k in (a.get("phrase_match") or [])
            if isinstance(k, str) and len(k.strip()) >= 2
        ]
        if keys and phrases:
            best_i = -1
            best_score = 0
            for i, p in enumerate(phrases):
                pt = str(p.get("text") or "")
                for k in keys:
                    if k in pt and len(k) > best_score:
                        best_score = len(k)
                        best_i = i
            if best_i >= 0:
                return best_i
        # 无可靠锚点：槽位均匀摊到短语（1 层→0；多层级联）
        if n_layers <= 1 or nph <= 1:
            return 0
        return int(round(slot_i * (nph - 1) / max(1, n_layers - 1)))

    def _enter_at_for(
        phrases: list[dict],
        enter: int,
        chars: list[dict],
        slot_i: int,
        n_layers: int,
        *,
        sent_start: float | None = None,
        sent_end: float | None = None,
    ) -> float | None:
        if phrases and 0 <= enter < len(phrases):
            return float(phrases[enter]["start"])
        if chars and n_layers > 1:
            ci = int(round(slot_i * (len(chars) - 1) / max(1, n_layers - 1)))
            return float(chars[ci]["start"])
        if chars:
            return float(chars[0]["start"])
        if sent_start is not None:
            return float(sent_start)
        return None

    def _layers_from(
        b: dict,
        s: dict,
        *,
        rng: random.Random,
        prev_recipe: str | None = None,
        recent_recipes: list[str] | None = None,
    ) -> tuple[list[dict], str]:
        phrases = s.get("phrases") or []
        nph = max(1, len(phrases))
        # scene：character/prop；若 LLM 把角色标成 figure/icon，也纳入，避免只剩一个小道具
        # card 仍单独走 figure/icon 字段
        # 缺图的槽位直接跳过，绝不用「另一半句」的图顶替
        allowed = ("character", "prop", "figure", "icon")
        layer_assets = [
            a
            for a in b["assets"]
            if a.get("resolved") and a.get("role") in allowed
        ]
        chars: list[dict] = []
        for p in phrases:
            chars.extend(p.get("chars") or [])

        n_layers = min(4, len(layer_assets))
        bound: list[tuple[dict, int]] = []
        for i, a in enumerate(layer_assets[:4]):
            pi = _phrase_index_for(a, phrases, i, n_layers)
            if not phrases:
                pi = 0
            bound.append((a, min(max(0, pi), nph - 1)))
        if not bound and layer_assets:
            # 最后兜底：已有 resolved 素材必须上镜，仍按槽位摊 enter
            for i, a in enumerate(layer_assets[:4]):
                pi = 0 if nph <= 1 else int(round(i * (nph - 1) / max(1, min(4, len(layer_assets)) - 1)))
                bound.append((a, pi))
        if not bound:
            return [], "empty"

        # 同 swap_group：共用站位，先出场的设 exit=后出场短语
        swap_zone: dict[str, tuple[str, float]] = {}
        spots = spots_for_count(len(bound))
        spot_i = 0
        # 预分配 swap 站位（按 swap_order）
        groups: dict[str, list[tuple[dict, int]]] = {}
        for a, pi in bound:
            g = a.get("swap_group")
            if g:
                groups.setdefault(str(g), []).append((a, pi))
        for g, members in groups.items():
            members.sort(key=lambda x: int(x[0].get("swap_order") or 0))
            zone, ground = spots[min(spot_i, len(spots) - 1)]
            spot_i += 1
            swap_zone[g] = (zone, ground)

        layers = []
        next_spot = spot_i  # swap 站位已占；其余元素顺延
        for slot_i, (a, enter) in enumerate(bound):
            g = a.get("swap_group")
            if g and str(g) in swap_zone:
                zone, ground = swap_zone[str(g)]
            else:
                zone, ground = spots[min(next_spot, len(spots) - 1)]
                next_spot += 1
            enter_at = _enter_at_for(
                phrases,
                enter,
                chars,
                slot_i,
                len(bound),
                sent_start=float(s.get("start") or 0),
                sent_end=float(s.get("end") or 0),
            )
            layer = {
                "name": a["resolved"],
                "zone": zone,
                "ground": ground,
                "fx": pick_layer_fx(a, int(b["idx"]), enter, zone, rng=rng),
                "idle": rng.choice(LAYER_IDLE),
                "enter": enter,
                "enter_at": enter_at,
                "_why": a.get("depict") or a.get("why", ""),
                "_slot": a.get("id"),
                "_phrase": a.get("line_phrase") or "",
                "phrase_match": list(a.get("phrase_match") or []),
            }
            say = _speech_only(a.get("say"))
            if say:
                layer["say"] = say
                layer["say_at"] = int(a.get("say_at") if a.get("say_at") is not None else enter)
                layer["say_side"] = str(a.get("say_side") or "auto")
                if a.get("say_until") is not None:
                    layer["say_until"] = int(a["say_until"])
            if g and str(g) in groups:
                members = sorted(groups[str(g)], key=lambda x: int(x[0].get("swap_order") or 0))
                my_ord = int(a.get("swap_order") or 0)
                later = [m for m in members if int(m[0].get("swap_order") or 0) > my_ord]
                if later:
                    layer["exit"] = later[0][1]
            layers.append(layer)
        # duo：强制左右两槽
        vis = normalize_visual(b.get("visual"))
        if vis == VIS_DUO and len(layers) >= 2:
            layers[0]["zone"], layers[0]["ground"] = "mid_left", 0.72
            layers[1]["zone"], layers[1]["ground"] = "mid_right", 0.74
        # emphasis：主体偏左，花字走 text.zone=right（渲染侧）
        if vis == VIS_EMPHASIS and layers:
            layers[0]["zone"], layers[0]["ground"] = "left", 0.72
        # reveal：按短语摊开（recipe 池内轮换，避免镜间全 cascade）
        recipe = apply_entrance_recipe(
            layers,
            phrases,
            s,
            rng=rng,
            visual=vis,
            prev_recipe=prev_recipe,
            recent_recipes=recent_recipes,
            forced_recipe=None,
        )
        for L in layers:
            if L.get("say") is not None:
                # 气泡跟着「念台词的那几个短语」出现，而不是元素入场（常是旁白引导语）
                text_fit, p0, p1 = _align_say(L["say"], phrases)
                L["say"] = text_fit
                enter = int(L.get("enter") or 0)
                if p0 is None:
                    L["say_at"] = enter
                    L.pop("say_until", None)
                else:
                    L["say_at"] = max(enter, p0)
                    L["say_until"] = max(L["say_at"] + 1, p1)
                # 气泡只挂角色，禁止挂到道具
                name = str(L.get("name") or "")
                if name.startswith("pr_"):
                    L.pop("say", None)
                    L.pop("say_at", None)
                    L.pop("say_side", None)
                    L.pop("say_until", None)
        _retime_layers_by_phrase(layers, chars, phrases)
        return layers, recipe

    prev_recipe: str | None = None
    recent_recipes: list[str] = []
    for s, b in zip(sentences, beats):
        text = s["text"]
        vis = normalize_visual(b.get("visual"), shot_idx=int(b.get("idx") or 0))
        shot_rng = recipe_rng(seed, int(b.get("idx") or 0))
        if vis == VIS_INTRO:
            # 开场红字**由口播稿确定性推导**，不用模型给的 intro_lines：
            # 实测模型会给出丢字/繁简错配的版本（「錢越來越／不錢了／這不是覺」，
            # 原句是「钱越来越不值钱了，这不是错觉」）。开场是观众第一眼看到的东西，
            # 必须与原稿逐字一致，所以这里固定走 jieba 断词切分（forced=None）。
            intro_lines = _intro_lines(text, forced=None)
            layers, recipe = _layers_from(
                b, s, rng=shot_rng, prev_recipe=prev_recipe, recent_recipes=recent_recipes
            )
            prev_recipe = recipe
            if recipe:
                recent_recipes.append(recipe)
            shots.append(
                {
                    "mode": "scene",
                    "camera": {"zoom": 0.022, "pan": [0.008, 0.002]},
                    "layers": layers,
                    "_visual": VIS_INTRO,
                    "_entrance": recipe,
                    "_element_count": len(layers),
                    "_brief": b.get("brief_title"),
                }
            )
            continue
        if vis == VIS_CARD:
            shots.append(
                {
                    "mode": "card",
                    "text": _card_text(text),
                    "figure": b.get("figure"),
                    "icon": b.get("icon"),
                    "cue": "hit",
                    "_visual": VIS_CARD,
                    "_entrance": "card",
                    "_brief": b.get("brief_title"),
                }
            )
            prev_recipe = "card"
            recent_recipes.append("card")
            continue
        layers, recipe = _layers_from(
            b, s, rng=shot_rng, prev_recipe=prev_recipe, recent_recipes=recent_recipes
        )
        prev_recipe = recipe
        if recipe:
            recent_recipes.append(recipe)
        shot: dict[str, Any] = {
            "mode": plan_mode(vis),
            "camera": {"zoom": 0.022, "pan": [0.008, 0.002]},
            "layers": layers,
            "_visual": vis,
            "_entrance": recipe,
            "_element_count": len(layers),
            "_brief": b.get("brief_title"),
        }
        if vis in (VIS_EMPHASIS, VIS_STAMP) and isinstance(b.get("text_overlay"), dict):
            shot["text"] = b["text_overlay"]
        shots.append(shot)

    return {"intro": {"lines": intro_lines}, "shots": shots}


def write_review(path: Path, beats: list[dict]) -> None:
    lines = [
        "# 镜头设计表",
        "",
        "> **禁止库存乱复用。** 每槽只有一个专用素材名；未生成则 `need_generate`，渲染不得换图顶替。",
        "> 种类：`intro_red` / `scene` / `card` / `dialogue` / `duo` / `emphasis` / `stamp` / `reveal` / `reaction`",
        "",
    ]
    for b in beats:
        vis = normalize_visual(b.get("visual"), shot_idx=int(b.get("idx") or 0))
        label = VIS_LABELS.get(vis, vis)
        beach = vis in (VIS_SCENE, VIS_DIALOGUE, VIS_DUO, VIS_EMPHASIS, VIS_STAMP)
        extra = f"，元素 {b['element_count']} 个" if beach else ""
        lines.append(f"## [{b['idx']}] {b['start']:.1f}s–{b['end']:.1f}s `{vis}` {label}{extra}")
        lines.append("")
        lines.append(f"**口播：** {b['text']}")
        lines.append("")
        lines.append(f"**镜头意图：** {b.get('brief_title') or '—'}（关键词：`{b.get('hit_key') or '—'}`）")
        lines.append("")
        # 出场准则在 plan 里；此处只提示种类，具体 recipe 见 plan._entrance
        if isinstance(b.get("text_overlay"), dict) and b["text_overlay"].get("content"):
            lines.append(
                f"**花字：** {b['text_overlay'].get('content')}（zone={b['text_overlay'].get('zone')}）"
            )
            lines.append("")
        lines.append("| 槽位 | 专用名 | 画面必须是 | 气泡 | 状态 |")
        lines.append("|---|---|---|---|---|")
        for a in b.get("assets") or []:
            say = a.get("say") or ""
            lines.append(
                f"| `{a.get('id')}` | `{a.get('name')}` | {a.get('depict')} | {say or '—'} | **{a.get('status')}** |"
            )
        need = [a for a in (b.get("assets") or []) if a.get("status") == "need_generate"]
        if need:
            lines.append("")
            lines.append("**待生图 prompt：**")
            for a in need:
                lines.append(f"- `{a['name']}`: {a.get('prompt')}")
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


def write_assets_brief(path_md: Path, path_json: Path, beats: list[dict]) -> dict[str, Any]:
    must_have = []
    for b in beats:
        for a in b.get("assets") or []:
            must_have.append(
                {
                    "shot": b["idx"],
                    "slot": a.get("id"),
                    "name": a.get("name"),
                    "role": a.get("role"),
                    "depict": a.get("depict"),
                    "prompt": a.get("prompt"),
                    "printed": bool(a.get("printed")),
                    "status": a.get("status"),
                    "line_text": b["text"],
                    "line_phrase": a.get("line_phrase") or b["text"],
                    "phrase_match": a.get("phrase_match") or [],
                }
            )
    payload = {
        "version": 3,
        "policy": "shot_unique_no_reuse",
        "must_have": must_have,
        "missing": [m for m in must_have if m["status"] != "ok"],
    }
    path_json.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = [
        "# 素材需求清单",
        "",
        "每条都是**本镜专用图**，禁止拿旧库存替代。",
        "",
        f"- 合计：{len(must_have)}",
        f"- 待生成：{len(payload['missing'])}",
        "",
        "## 清单",
        "",
        "| 镜 | 专用名 | 口播要点 | 画面必须是 | 状态 |",
        "|---|---|---|---|---|",
    ]
    for m in must_have:
        lt = str(m.get("line_text") or "")[:18]
        lines.append(
            f"| {m['shot']} | `{m['name']}` | {lt} | {m['depict']} | {m['status']} |"
        )
    lines.extend(["", "## 待生成（03 只生这些）", ""])
    if not payload["missing"]:
        lines.append("（无）")
    else:
        for m in payload["missing"]:
            lines.append(f"### `{m['name']}` — 镜 {m['shot']} / {m['depict']}")
            lines.append("")
            lines.append(f"- 口播整句：{m['line_text']}")
            lines.append(f"- 本槽短语：{m.get('line_phrase') or m['line_text']}")
            lines.append(f"- prompt: {m['prompt']}")
            lines.append("")
    path_md.write_text("\n".join(lines), encoding="utf-8")
    return payload


def _load_sentences(timing_path: Path) -> list[dict]:
    """保留 01 的句 / 短语 / 字三级时间戳，供设计与渲染对齐口播。"""
    data = json.loads(timing_path.read_text(encoding="utf-8"))
    raw = data.get("sentences") or []
    sentences = []
    for s in raw:
        phrases = []
        for p in s.get("phrases") or []:
            chars = [
                {
                    "text": c.get("text", ""),
                    "start": float(c["start"]),
                    "end": float(c["end"]),
                    **({"confidence": c["confidence"]} if "confidence" in c else {}),
                }
                for c in (p.get("chars") or [])
                if c.get("start") is not None and c.get("end") is not None
            ]
            phrases.append(
                {
                    "text": p["text"],
                    "start": p["start"],
                    "end": p["end"],
                    "chars": chars,
                }
            )
        sentences.append(
            {
                "text": s["text"],
                "start": s["start"],
                "end": s["end"],
                "phrases": phrases,
            }
        )
    return sentences


def run(
    timing_path: Path,
    out_dir: Path,
    *,
    seed: int = 20260408,
    available_names: list[str] | None = None,
    briefs: list[dict[str, Any]] | None = None,
    bgm_plan: dict[str, Any] | None = None,
) -> dict[str, Any]:
    sentences = _load_sentences(timing_path)
    if not sentences:
        raise RuntimeError("timing.json 无 sentences")

    available_names = available_names or []
    set_active_briefs(briefs)
    try:
        beats = design_beats(sentences, available_names, seed=seed)
        plan = beats_to_kit_plan(sentences, beats, available_names, seed=seed)
        assets_brief = write_assets_brief(out_dir / "素材需求.md", out_dir / "assets_brief.json", beats)
    finally:
        set_active_briefs(None)

    if bgm_plan:
        plan["bgm"] = bgm_plan
        (out_dir / "bgm_plan.json").write_text(
            json.dumps(bgm_plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

    payload = {
        "version": 4,
        "seed": seed,
        "policy": "shot_unique_no_reuse",
        "source_timing": str(timing_path.resolve()),
        "design_source": "llm" if briefs else "rules",
        "bgm": bgm_plan,
        "summary": {
            "intro_red": sum(1 for b in beats if b["visual"] == VIS_INTRO),
            "scene": sum(1 for b in beats if b["visual"] == VIS_SCENE),
            "scene_blur": sum(1 for b in beats if b["visual"] == VIS_SCENE),  # 兼容旧验收
            "card": sum(1 for b in beats if b["visual"] == VIS_CARD),
            "card_black": sum(1 for b in beats if b["visual"] == VIS_CARD),
            "dialogue": sum(1 for b in beats if b["visual"] == VIS_DIALOGUE),
            "duo": sum(1 for b in beats if b["visual"] == VIS_DUO),
            "emphasis": sum(1 for b in beats if b["visual"] == VIS_EMPHASIS),
            "stamp": sum(1 for b in beats if b["visual"] == VIS_STAMP),
            "reveal": sum(1 for b in beats if b["visual"] == VIS_REVEAL),
            "reaction": sum(1 for b in beats if b["visual"] == VIS_REACTION),
            "asset_slots": sum(len(b.get("assets") or []) for b in beats),
            "missing_assets": len(assets_brief.get("missing") or []),
        },
        "beats": beats,
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "shots_design.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (out_dir / "plan.json").write_text(
        json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    write_review(out_dir / "镜头表.md", beats)
    # 时间戳贯通自检：01 句/短语/字 → plan.enter_at
    sync = []
    for i, s in enumerate(sentences):
        phrases = s.get("phrases") or []
        nch = sum(len(p.get("chars") or []) for p in phrases)
        shot = (plan.get("shots") or [None])[i] if i < len(plan.get("shots") or []) else None
        layers = (shot or {}).get("layers") or []
        sync.append(
            {
                "idx": i,
                "text": s["text"],
                "sentence_start": s["start"],
                "sentence_end": s["end"],
                "phrases": len(phrases),
                "chars": nch,
                "layers": [
                    {
                        "name": L.get("name"),
                        "slot": L.get("_slot"),
                        "enter": L.get("enter"),
                        "enter_at": L.get("enter_at"),
                        "exit": L.get("exit"),
                        "phrase": L.get("_phrase"),
                    }
                    for L in layers
                ],
            }
        )
    (out_dir / "timing_sync.json").write_text(
        json.dumps(
            {
                "source": str(timing_path.resolve()),
                "ok": all(row["chars"] > 0 or row["phrases"] == 0 for row in sync),
                "shots": sync,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return payload
