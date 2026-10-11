"""按 02/assets_brief.json 全量新生镜头专用素材（禁止复用旧库存）。

生图调度全部交给密匙 generate_images（限速提交、全局在途上限、慢单对冲、
挂死补发、失败换稿、断图补拉、余额不足急停），这里只负责 prompt 与抠图质检：
抠图被拒（裁切 / 空图）同样视为失败，由密匙换下一版降敏 prompt 重发。
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "kit"))
sys.path.insert(0, __import__("os").environ.get("MISHI_ROOT", ""))
import paths
from richness import apply_richness, job_name, variant_prompt

from kit import assets as A
from kit import imaging as I
from generate_images import generate_images

MISHI = Path(__import__("os").environ.get("MISHI_ROOT", "")) / "run.py"
CUT = paths.KIT_ASSETS / "cut"
RAW = paths.KIT_ASSETS / "raw"
STYLE = A.STYLE
CUTOUT = A.CUTOUT
CUTOUT_PRINTED = A.CUTOUT_PRINTED

# 抠图约束放在 prompt 前部；超长只裁口播描述，不能裁掉约束
PROMPT_CAP = 1000
# 虎妞对同秒突发会排队（76 单同秒中位 356s，错峰后 ~45s）
SUBMIT_PER_SEC = 2.0
MAX_GLOBAL_INFLIGHT = 40
HEDGE_MIN_SEC = 90
# 正常单 p90≈100s，超过即视为挂死并补发
JOB_STALE_SEC = 150
ASSET_DEADLINE_SEC = 840
# 每个资产**默认只提交一次**。
# 原来这里是 12（配合已删除的对冲/换稿/质检重发），结果是：一个画不好的素材
# （例如"举盾挡海浪"那种必然溢出画幅的构图）会连发 12 单、每单 ~40s，
# 白烧十几分钟，还挡住后面的镜头 ✗
# 现在：失败就直接留给人工——在拓展里点「重试」/「只生成这个元素」再发一次即可。
# 需要自动重试时用 KOUBO_ASSET_ATTEMPTS=3 之类的环境变量显式打开。
ATTEMPTS = max(1, int(os.environ.get("KOUBO_ASSET_ATTEMPTS", "1") or "1"))
# 风格板图生图：统一手绘风（密匙 images 参考图）
STYLEBOARD_CACHE = paths.ASSETS / "styleboard_url.txt"
STYLEBOARD_CANDIDATES = [
    paths.ASSETS / "richness_samples" / "L5_char.png",
    paths.CAST / "cheer.png",
    CUT / "ch_s0_intro_spongewarning.png",
]
# 透明切条不需 4K；1024 更快更省，抠图够用
IMAGE_SIZE = "1024x1024"
_STYLE_URL: str | None = None
_STYLE_LOCK = threading.Lock()


def _run(args: list[str], timeout: int | None = None) -> subprocess.CompletedProcess:
    env = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}
    return subprocess.run(
        [sys.executable, "-X", "utf8", str(MISHI), *args],
        capture_output=True,
        timeout=timeout,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
    )


def _parse_stdout(text: str) -> dict:
    line = (text or "").strip().splitlines()
    if not line:
        return {"ok": False, "error": "empty stdout"}
    try:
        return json.loads(line[-1])
    except json.JSONDecodeError:
        return {"ok": False, "error": "bad json", "raw": line[-1][:200]}


def _key_to_cut(src: Path, name: str) -> Path | None:
    if not src.exists():
        return None
    keyed, report = I.remove_background(Image.open(src))
    # 抠图被裁（主体贴边）原本一律拒收。但实测这会**卡死整条流水线**：
    # 某些构图（例如"举盾挡海浪"）模型总会画出铺满画幅的元素，重试 12 次全被拒，
    # 结果那一镜永远缺元素、还白白烧掉十几分钟。
    # 放宽为：
    #   · 只有一边贴边（mild）→ 接受，打警告（贴边那侧在合成时本来就常被画幅裁掉）
    #   · 两边及以上贴边，或用 KOUBO_ACCEPT_CROPPED=1 → 也接受，打更明显的警告
    # 真正该挡的是"抠出来是空图/主体几乎不可见"，那些仍由下面的 blank_subject 挡着。
    if report.get("cropped"):
        edges = report.get("subject_at_edge") or []
        touched = sum(1 for v in edges if v)
        relax = os.environ.get("KOUBO_ACCEPT_CROPPED", "").strip().lower() in ("1", "true", "yes")
        if touched >= 2 and not relax:
            print(f"  {name}: reject cropped ({touched} 边贴边 {edges}；要放行设 KOUBO_ACCEPT_CROPPED=1)", flush=True)
            return None
        print(f"  {name}: accept cropped ({touched} 边贴边 {edges}，已放宽)", flush=True)
    arr = np.array(A.trim_rgba(keyed))
    blank, _ratio, detail = A.blank_subject(keyed)
    if blank:
        print(f"  {name}: reject blank ({detail})", flush=True)
        return None
    CUT.mkdir(parents=True, exist_ok=True)
    paths.ELEMENTS.mkdir(parents=True, exist_ok=True)
    out_cut = CUT / f"{name}.png"
    out_el = paths.ELEMENTS / f"{name}.png"
    Image.fromarray(arr).save(out_cut)
    Image.fromarray(arr).save(out_el)
    A._cut_cache.pop(name, None)
    print(f"  {name}: cut ok  bg={report.get('bg_rgb')}", flush=True)
    return out_cut


def _placeholder_marker(name: str) -> Path:
    return CUT / f"{name}.placeholder"


def _is_placeholder(name: str) -> bool:
    return _placeholder_marker(name).is_file()


def write_placeholder(name: str, why: str = "") -> None:
    """生图失败时留一张占位图，而不是让这个元素凭空消失。

    为什么必须留：素材一旦缺席，这一镜的构图就塌了（少一个人/道具），
    而且时间轴上压根没有这个片段——重试成功后也无法"原地替换"，只能重铺一遍 ✗
    占位图占住**同一个文件名**（cut/<name>.png），重试成功时 _key_to_cut 直接覆盖同名文件，
    重新绑定即时替换 ✓ 同时留下 .placeholder 标记，让跳过逻辑知道它还没真生成。
    """
    from PIL import Image as _Im, ImageDraw as _Dr, ImageFont as _Ft

    PW = PH = 512
    im = _Im.new("RGBA", (PW, PH), (0, 0, 0, 0))
    d = _Dr.Draw(im)
    line = (255, 255, 255, 190)
    for x in range(18, PW - 18, 26):
        d.line([(x, 18), (min(x + 14, PW - 18), 18)], fill=line, width=5)
        d.line([(x, PH - 18), (min(x + 14, PW - 18), PH - 18)], fill=line, width=5)
    for y in range(18, PH - 18, 26):
        d.line([(18, y), (18, min(y + 14, PH - 18))], fill=line, width=5)
        d.line([(PW - 18, y), (PW - 18, min(y + 14, PH - 18))], fill=line, width=5)

    f_big = f_small = None
    for cand in ("SUB_FONT", "CARD_FONT", "TITLE_FONT"):
        try:
            f_big = _Ft.truetype(str(getattr(typo, cand)), 190)
            f_small = _Ft.truetype(str(getattr(typo, cand)), 46)
            break
        except Exception:
            f_big = f_small = None
    if f_big is None:
        f_big = f_small = _Ft.load_default()

    def center(txt: str, font, y: int) -> None:
        box = d.textbbox((0, 0), txt, font=font)
        d.text(((PW - (box[2] - box[0])) / 2 - box[0], y), txt, font=font, fill=(255, 255, 255, 225))

    center("?", f_big, 90)
    center("待生成", f_small, 330)
    CUT.mkdir(parents=True, exist_ok=True)
    paths.ELEMENTS.mkdir(parents=True, exist_ok=True)
    im.save(CUT / f"{name}.png")
    im.save(paths.ELEMENTS / f"{name}.png")
    _placeholder_marker(name).write_text(why or "failed", encoding="utf-8")
    print(f"  {name}: 已留占位图（重试成功后原地替换）", flush=True)


def _compose_prompt(it: dict, attempt: int) -> str:
    printed = bool(it.get("printed"))
    suffix = CUTOUT_PRINTED if printed else CUTOUT
    head = f"{STYLE.strip()} {suffix.strip()} Subject: "
    body = apply_richness(it.get("role"), it.get("prompt") or it.get("depict") or it["name"])
    body = variant_prompt(body, attempt)
    room = PROMPT_CAP - len(head)
    if len(body) > room:
        body = re.sub(r"Full sentence context: 「[^」]*」\.\s*", "", body)
    if len(body) > room:
        body = re.sub(r"Narration for THIS asset only: 「[^」]*」\.\s*", "", body)
    if len(body) > room:
        body = body[:room].rsplit(" ", 1)[0]
    return head + body


def _ensure_styleboard_url() -> str | None:
    """准备风格板公网 URL，供图生图参考；失败则退回纯文生图。"""
    global _STYLE_URL
    with _STYLE_LOCK:
        if _STYLE_URL:
            return _STYLE_URL
        if STYLEBOARD_CACHE.is_file():
            url = STYLEBOARD_CACHE.read_text(encoding="utf-8").strip()
            if url.startswith("http"):
                _STYLE_URL = url
                return _STYLE_URL
        local = None
        for p in STYLEBOARD_CANDIDATES:
            if p.is_file() and p.stat().st_size > 1000:
                local = p
                break
        if local is None and CUT.is_dir():
            cands = sorted(CUT.glob("ch_s*.png"))
            if cands:
                local = cands[0]
        if local is None:
            return None
        host = _run(
            [
                "host",
                "--file",
                str(local),
                "--path",
                f"koubo-styleboard/{local.stem}.png",
            ],
            timeout=120,
        )
        meta = _parse_stdout(host.stdout)
        url = meta.get("url") or meta.get("raw") or meta.get("href")
        if not url and isinstance(meta.get("file"), str) and str(meta["file"]).startswith("http"):
            url = meta["file"]
        if not url:
            for tok in (host.stdout or "").split():
                if tok.startswith("http") and ("raw.githubusercontent" in tok or tok.endswith(".png")):
                    url = tok.strip().strip('"')
                    break
        if url:
            STYLEBOARD_CACHE.parent.mkdir(parents=True, exist_ok=True)
            STYLEBOARD_CACHE.write_text(str(url).strip() + "\n", encoding="utf-8")
            _STYLE_URL = str(url).strip()
            print(f"styleboard {local.name} → {_STYLE_URL}", flush=True)
            return _STYLE_URL
        print(f"styleboard host failed: {meta}", flush=True)
        return None


def _write_progress(*, done: int, total: int, note: str = "") -> None:
    paths.ASSETS_LOGS.mkdir(parents=True, exist_ok=True)
    (paths.ASSETS_LOGS / "gen_progress.json").write_text(
        json.dumps({"done": done, "total": total, "note": note, "ts": time.time()}, ensure_ascii=False, indent=2)
        + "\n",
        encoding="utf-8",
    )


def _cut_ok(name: str) -> bool:
    p = CUT / f"{name}.png"
    return p.exists() and p.stat().st_size > 1000


def _write_report(report: dict) -> None:
    (paths.ASSETS_LOGS / "gen_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _accept(path: Path, item: dict) -> bool:
    """抠图质检即验收：被拒的图由密匙换下一版 prompt 重发。"""
    name = item["asset"]
    raw_path = RAW / f"{name}.png"
    shutil.copy2(path, raw_path)
    return _key_to_cut(raw_path, name) is not None


def generate_all(*, force: bool = True) -> int:
    brief_path = paths.DESIGN / "assets_brief.json"
    if not brief_path.is_file():
        raise SystemExit(f"缺少 {brief_path}，请先跑 02_镜头设计/run_design.py")

    brief = json.loads(brief_path.read_text(encoding="utf-8"))
    items = brief.get("must_have") or []
    if not items:
        print("brief empty")
        return 0

    by_name: dict[str, dict] = {it["name"]: it for it in items}

    paths.ensure()
    RAW.mkdir(parents=True, exist_ok=True)
    paths.ASSETS_LOGS.mkdir(parents=True, exist_ok=True)
    t0 = time.time()

    missing_only = "--missing-only" in sys.argv or "--keep" in sys.argv
    pending: list[str] = []
    skipped = 0
    for name in by_name:
        cut_path = CUT / f"{name}.png"
        # 占位图不算"已完成"：否则生图失败留下的占位会把它永久跳过，重试再也提交不了 ✗
        if _cut_ok(name) and not _is_placeholder(name) and (missing_only or not force):
            skipped += 1
            continue
        # force 也不提前删旧图：新图通过质检时 _key_to_cut 原地覆盖，失败则旧图仍可用
        pending.append(name)

    if skipped:
        print(f"skip existing {skipped}", flush=True)
    print(f"queue {len(pending)} assets (force={force})", flush=True)
    if not pending:
        _write_report(
            {"ok": 0, "total": 0, "failed": [], "attempts": {}, "parallel": True,
             "elapsed_sec": round(time.time() - t0, 3), "skipped_existing": skipped}
        )
        print("generated 0/0")
        return 0

    # 角色图审核/生成更慢，先发
    pending.sort(key=lambda n: 0 if n.startswith("ch_") else 1)
    style = _ensure_styleboard_url()
    batch = [{"name": job_name(n, 0), "asset": n, "src": by_name[n]} for n in pending]
    done = [0]

    def on_done(_item: dict, _res: dict) -> None:
        done[0] += 1
        print(f"progress {done[0]}/{len(batch)} elapsed={time.time() - t0:.0f}s", flush=True)
        _write_progress(done=done[0], total=len(batch))

    res = generate_images(
        batch,
        size=IMAGE_SIZE,
        transparent=True,
        images=[style] if style else None,
        rate=SUBMIT_PER_SEC,
        max_inflight=MAX_GLOBAL_INFLIGHT,
        hedge_min_s=HEDGE_MIN_SEC,
        stale_s=JOB_STALE_SEC,
        max_jobs_per_item=ATTEMPTS,
        deadline_s=ASSET_DEADLINE_SEC,
        prompt_fn=lambda item, attempt: _compose_prompt(item["src"], attempt),
        accept=_accept,
        on_done=on_done,
        reuse=not force,
    )

    elapsed = round(time.time() - t0, 3)
    by_job = {r["name"]: r for r in res["items"]}
    def _done(n: str) -> bool:
        return bool(by_job[job_name(n, 0)].get("ok")) and _cut_ok(n)

    ok_n = sum(1 for n in pending if _done(n))
    failed_final = [n for n in pending if not _done(n)]
    # 失败的素材留占位图：镜头里位置不塌、时间轴上有片段，重试成功即原地替换 ✓
    for n in failed_final:
        if _is_placeholder(n):
            continue
        try:
            write_placeholder(n, why=f"attempts={by_job[job_name(n, 0)].get('jobs', 0)}")
        except Exception as _e:
            print("placeholder skip", n, _e, flush=True)
    report = {
        "ok": ok_n,
        "total": len(pending),
        "failed": failed_final,
        "attempts": {n: by_job[job_name(n, 0)].get("jobs", 0) for n in pending},
        "jobs_launched": res["jobs_launched"],
        "latency_p50": res["latency_p50"],
        # 尾部才是总耗时的决定项：p90/max 一并记下来，别只留中位数
        "latency_p90": res.get("latency_p90"),
        "latency_max": res.get("latency_max"),
        "latency_n": res.get("latency_n"),
        "parallel": True,
        "submit_per_sec": SUBMIT_PER_SEC,
        "max_global_inflight": MAX_GLOBAL_INFLIGHT,
        "elapsed_sec": elapsed,
        "skipped_existing": skipped,
    }
    if res["billing"]:
        report["error"] = "insufficient_funds"
        _write_report(report)
        print(f"STOP billing: {res['error']}", flush=True)
        return 2
    _write_report(report)
    print(
        f"generated {ok_n}/{len(pending)} elapsed_sec={elapsed} jobs={report['jobs_launched']}",
        flush=True,
    )
    for n in failed_final:
        print(f"FAILED {n}: {by_job[job_name(n, 0)].get('error')}", flush=True)
    return 0 if ok_n == len(pending) else 1


def main():
    missing_only = "--missing-only" in sys.argv or "--keep" in sys.argv
    force = (not missing_only) and ("--keep" not in sys.argv)
    if "--force" in sys.argv:
        force = True
    raise SystemExit(generate_all(force=force))


if __name__ == "__main__":
    main()

