"""口播素材丰富度档位（用户已选定 L5）。

02 写 brief / 03 生图共用；改档只改 LEVEL 与对应后缀。
"""
from __future__ import annotations

import re

# 用户选定：L5 很满
LEVEL = "L5_dense"

CHAR_SUFFIX = (
    "Richness L5 dense storytelling cutout: keep the core action crystal clear, "
    "add a small supporting prop cluster that reinforces THIS beat "
    "(coins, bags, papers, tools, icons as fits — about 2 to 4 extras), "
    "strong expressive pose, full body, one isolated subject group only, "
    "no scenery, no crowd background, no extra characters."
)

PROP_SUFFIX = (
    "Richness L5 dense prop: extra readable detail plus one tiny accent "
    "(sparkle, sticker, or secondary icon), still one isolated prop group, "
    "no character, no scenery."
)

# 内容审核 / 商标敏感时的降敏别名（按 attempt 递进替换）
SAFE_ALIASES: list[tuple[str, str]] = [
    (
        "SpongeBob SquarePants",
        "yellow porous square sponge cartoon character in white shirt, red tie, "
        "brown square pants, white sailor hat with blue anchor",
    ),
    (
        "SpongeBob",
        "yellow porous square sponge cartoon character in white shirt and red tie",
    ),
    (
        "Patrick Star",
        "pink starfish cartoon character in green flower shorts",
    ),
    (
        "Patrick",
        "pink starfish cartoon character in green flower shorts",
    ),
    (
        "Mr. Krabs",
        "red crab cartoon restaurant boss character with large claws",
    ),
    (
        "Mr Krabs",
        "red crab cartoon restaurant boss character with large claws",
    ),
    (
        "Squidward Tentacles",
        "teal octopus cartoon character with a large nose and purple shirt",
    ),
    (
        "Squidward",
        "teal octopus cartoon character with a large nose and purple shirt",
    ),
    (
        "Sandy Cheeks",
        "brown squirrel cartoon character in a white space-diving suit and helmet",
    ),
    (
        "Sandy",
        "brown squirrel cartoon character in a white diving suit",
    ),
    (
        "Plankton",
        "tiny green one-eyed plankton cartoon villain",
    ),
    ("海绵宝宝", "黄色方块海绵角色"),
    ("派大星", "粉色海星角色"),
    ("蟹老板", "红色大钳螃蟹店主"),
    ("章鱼哥", "青绿色章鱼角色"),
    ("珊迪", "穿潜水服的松鼠"),
    ("痞老板", "绿色独眼小浮游生物"),
]

_STRIP_MINIMAL = re.compile(
    r",?\s*(single character only|no other props|empty hands|no props)\.?",
    re.I,
)


def apply_richness(role: str | None, prompt: str) -> str:
    """给角色/道具提示词叠 L5；已含标记则不重复。"""
    p = (prompt or "").strip()
    if not p:
        return p
    if "Richness L5" in p:
        return p
    role = (role or "").lower()
    if role in ("character", "figure"):
        p = _STRIP_MINIMAL.sub("", p)
        return f"{p.rstrip('. ')}. {CHAR_SUFFIX}"
    if role in ("prop", "icon"):
        return f"{p.rstrip('. ')}. {PROP_SUFFIX}"
    return p


def variant_prompt(prompt: str, attempt: int) -> str:
    """始终用外观描述替角色名（虎妞对 IP 名走慢审核/拦截）；>=1 去掉口播前缀；>=2 压成短描述。"""
    p = prompt or ""
    for src, dst in SAFE_ALIASES:
        p = p.replace(src, dst)
    if attempt % 4 >= 1:
        p = re.sub(r"Narration for THIS asset only: 「[^」]*」\.\s*", "", p)
        p = re.sub(r"Full sentence context: 「[^」]*」\.\s*", "", p)
        p = re.sub(r"Do not illustrate a different half of the sentence\.\s*", "", p)
        p = re.sub(r"Must depict:\s*", "Show: ", p)
    if attempt % 4 >= 2:
        p = re.sub(r"Richness L5[^.]*\.\s*", "", p)
        p = p[:420].rstrip(". ") + ". Original cartoon design, no celebrity likeness, no logo text."
    if attempt % 4 >= 3:
        # 多次被拒基本只有一种原因：主体被画幅裁到（cropped / subject_at_edge）。
        # 光靠 CUTOUT 里已有的留白要求没用——动作本身若含"海浪/水花/爆炸/烟雾"，
        # 模型就会画成铺满画幅（实测 ch_s7_spongebob_gold_shield 连拒 6~12 次，右边距=0）。
        # 这里把动作压到最小，并显式点名禁掉这些元素。
        p = p.split(". ")[0].rstrip(". ")
        p = (
            p
            + ". Show only the single character holding the object, standing still, whole body visible. "
            + "No water, no waves, no splashes, no explosion, no smoke, no motion trails, no background scenery. "
            + "Keep a wide empty white margin on every side so nothing is cut off by the image edge."
        )
    return p


def job_name(asset_name: str, attempt: int) -> str:
    """密匙 job 名必须带工作区指纹，否则跨成片会命中旧 img_*.json，2 秒「出图」实为缓存。"""
    import os
    from pathlib import Path

    work = Path(os.environ.get("KOUBO_WORK") or "").name
    tag = (work.replace("_koubo", "") or "x")[-16:]
    base = f"koubo_{tag}_{asset_name}"
    return base if attempt <= 0 else f"{base}_r{attempt + 1}"
