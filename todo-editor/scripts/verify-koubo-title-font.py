"""校验海绵宝宝开场红字换字体：语法 → 字体链 → 逐字覆盖 → 出图。

用法（用包内自带 python，装了 cv2/PIL/numpy）：
    D:\\desktop\\to_do\\todo-editor\\runtime\\python\\python.exe ^
        D:\\desktop\\to_do\\todo-editor\\scripts\\verify-koubo-title-font.py

输出：
- 每个被改文件的 py_compile 结果
- 开场红字用的字体链，以及链上首选字体缺、要靠后备补的字
- demo30 的开场红字渲染预览 PNG（可直接看有没有缺字/混排出戏）
"""
from __future__ import annotations

import compileall
import json
import re
import sys
import traceback
from pathlib import Path

try:  # 控制台是 GBK 时也要能看中文
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parents[1]
PKG = ROOT / "examples" / "extensions" / "spongebob-koubo"
KIT_PARENT = PKG / "workflow" / "kit"
PREVIEW = ROOT / "native" / "test-output" / "koubo-title-font-preview.png"

TOUCHED = [
    KIT_PARENT / "kit" / "typo.py",
    KIT_PARENT / "kit" / "render.py",
    KIT_PARENT / "kit" / "layers_export.py",
    PKG / "workflow" / "02_镜头设计" / "design.py",
    PKG / "workflow" / "02_镜头设计" / "llm_briefs.py",
    PKG / "workflow" / "accept_run.py",
]

# 复现 demo30 那一版的开场红字：第三行原本被砍成「最錢的」，现在必须整行画出来
LINES = ["蟹堡王的秘密", "配方是全比奇堡", "最值钱的一张纸"]

ok = True


def step(title: str, passed: bool, detail: str = "") -> None:
    global ok
    ok = ok and passed
    print(f"[{'ok' if passed else 'FAIL'}] {title}" + (f" — {detail}" if detail else ""))


print("== 1. 语法 ==")
for path in TOUCHED:
    if not path.is_file():
        step(path.name, False, "文件不存在")
        continue
    passed = compileall.compile_file(str(path), quiet=2, force=True)
    step(str(path.relative_to(ROOT)), bool(passed))

print("\n== 2. 字体链与逐字覆盖 ==")
try:
    sys.path.insert(0, str(KIT_PARENT))
    import numpy as np
    from PIL import Image

    from kit import typo

    chain = typo.TITLE_FONT_CHAIN
    print(f"首选: {typo.TITLE_FONT}")
    for i, font in enumerate(chain):
        print(f"  链[{i}] 正在读字形表… {font}", flush=True)
        nib = len(typo.font_cmap(font))
        print(f"  链[{i}] {'ok ' if font.is_file() else 'MISS'} {font}  (cmap {nib} 码位)", flush=True)

    step("首选字体存在", typo.TITLE_FONT.is_file(), str(typo.TITLE_FONT))

    for line in LINES:
        resolved = typo.title_resolved(line)
        gaps = typo.title_chain_gaps(line)
        miss = typo.missing_glyphs(resolved, chain)
        print(f"  {line!r} → 画成 {resolved!r}" + (f"  后备补字={gaps!r}" if gaps else "  (全部首选字体)"))
        step(f"整行排得出: {line}", not miss, f"缺 {miss}" if miss else "")
        step(f"没被砍字: {line}", len(resolved) == len(re.sub(r"\s+", "", line)), f"{len(line)}→{len(resolved)}")

    print("\n== 3. 出图 ==")
    plate = typo.title_plate(LINES, [330, 640, 900])
    alpha = plate[:, :, 3]
    ys, xs = np.where(alpha > 20)
    if xs.size == 0:
        step("红字画出来了", False, "plate 全透明")
    else:
        step(
            "红字画出来了",
            True,
            f"ink box x[{xs.min()},{xs.max()}] y[{ys.min()},{ys.max()}] 覆盖 {xs.size} px",
        )
        # 逐行给出墨迹列区间：行与行之间的空白说明有整行没画出来
        for i, y in enumerate([330, 640, 900]):
            band = alpha[max(0, y - 140) : y + 140]
            cols = np.where(band.max(axis=0) > 20)[0]
            state = "有字" if cols.size else "空行(缺字)"
            print(f"  第{i + 1}行 y≈{y}: {state}" + (f" 宽 {cols.max() - cols.min()} px" if cols.size else ""))
            step(f"第{i + 1}行有字: {LINES[i]}", cols.size > 0)

        PREVIEW.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(plate, "RGBA").save(PREVIEW)
        print(f"  预览已写: {PREVIEW}")
except Exception:
    ok = False
    traceback.print_exc()

print("\n== 4. 开头缺字门禁判据 ==")
try:
    sys.path.insert(0, str(PKG / "workflow" / "02_镜头设计"))
    from llm_briefs import align_intro_to_source, intro_lines_valid, sanitize_intro_lines

    demo_first = "蟹堡王的秘密配方，是全比奇堡最值钱的一张纸。"
    truncated = ["蟹堡王的秘密", "配方是全比奇堡", "最錢的"]  # demo30 缓存里那一行
    got = sanitize_intro_lines(truncated, source_text=demo_first)
    print(f"  传入口播首句 → {got}")
    step("被砍过尾巴的旧缓存行会被重建", got != truncated, str(got))
    step("重建后逐字排得出", intro_lines_valid(got), str(got))

    got2 = sanitize_intro_lines(["最錢的"], source_text=demo_first)
    print(f"  只传 ['最錢的'] → {got2}")
    step("短口号也会重建", got2 != ["最錢的"], str(got2))

    whole = sanitize_intro_lines(["蟹堡王的秘密配方", "是全比奇堡最值钱"], source_text=demo_first)
    step("贴住口播的整段候选被保留", whole == ["蟹堡王的秘密配方", "是全比奇堡最值钱"], str(whole))

    step("与口播无关的行被判为不齐", align_intro_to_source(["隔壁出事"], demo_first) == [], "")
    step("整段判据通过", intro_lines_valid(LINES), "")
except Exception:
    ok = False
    traceback.print_exc()

print("\nRESULT: " + json.dumps({"ok": bool(ok)}, ensure_ascii=False))
raise SystemExit(0 if ok else 1)
