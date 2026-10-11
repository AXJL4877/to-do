"""BGM 源硬锁：按用户规定曲目叠轨，并禁止叠入「含旧口播」的脏拆轨。

用户规定（LLM 设计阶段即写死，禁止模型自创文件名）：
  片头 = 跨越大洋的飞机 - Holding Court.mp3
  中段 = 眠舸 - 精卫（降调）.mp3
  后段升华 = TRA$H - Memories.mp3

脏轨（示例片直拆、仍带旧旁白）禁止：根目录 intro_0_25.wav 等。
"""
from __future__ import annotations

import shutil
from pathlib import Path

import os
KOUBO = Path(os.environ.get("KOUBO_CODE") or Path(__file__).resolve().parent)
REF_BGM = KOUBO / "ref_bgm"

# 用户规定的成片 BGM（文件名，相对 ref_bgm/）
BGM_DEFAULT_SOURCES = {
    "intro": "跨越大洋的飞机 - Holding Court.mp3",
    "mid": "眠舸 - 精卫（降调）.mp3",
    "outro": "TRA$H - Memories.mp3",
}

# demucs 干净伴奏 → 历史落盘名（仅兜底；主路径用 mp3）
_BGM_MATERIALIZE = {
    "中段_示例BGM_精卫降调向.wav": REF_BGM
    / "demucs"
    / "htdemucs"
    / "mid_90_120"
    / "no_vocals.wav",
    "后段_BGM.wav": REF_BGM / "demucs" / "htdemucs" / "end_150_190" / "no_vocals.wav",
}

# 根目录脏拆轨（含旧口播）——禁止直接作 BGM
BGM_VOCAL_BLOCKLIST = frozenset(
    {
        "intro_0_25",
        "mid_90_120",
        "end_150_190",
        "_chk",
        "_lvl",
        "full",
        "复利_BGM_bed",
        "seg_t20",
        "seg_t30",
        "seg_t40",
        "seg_t60",
        "seg_t80",
        "seg_t110",
        "seg_t120",
        "seg_t140",
        "seg_t170",
        "jingwei_preview",
        "开头_疑似精卫_伴奏",
    }
)

# 旧/错名 → 规定源
BGM_SAFE_ALIASES = {
    "intro_0_25.wav": BGM_DEFAULT_SOURCES["intro"],
    "intro_0_25": BGM_DEFAULT_SOURCES["intro"],
    "jingwei_preview.wav": BGM_DEFAULT_SOURCES["intro"],
    "jingwei_preview": BGM_DEFAULT_SOURCES["intro"],
    "开头_疑似精卫_伴奏.wav": BGM_DEFAULT_SOURCES["intro"],
    "开头_疑似精卫_伴奏": BGM_DEFAULT_SOURCES["intro"],
    "mid_90_120.wav": BGM_DEFAULT_SOURCES["mid"],
    "mid_90_120": BGM_DEFAULT_SOURCES["mid"],
    "中段_示例BGM_精卫降调向.wav": BGM_DEFAULT_SOURCES["mid"],
    "中段_示例BGM_精卫降调向": BGM_DEFAULT_SOURCES["mid"],
    "end_150_190.wav": BGM_DEFAULT_SOURCES["outro"],
    "end_150_190": BGM_DEFAULT_SOURCES["outro"],
    "后段_BGM.wav": BGM_DEFAULT_SOURCES["outro"],
    "后段_BGM": BGM_DEFAULT_SOURCES["outro"],
}


def ensure_prescribed_bgm_files() -> list[str]:
    """确认规定曲目存在；可选把 demucs 干净轨落到历史文件名。"""
    done: list[str] = []
    REF_BGM.mkdir(parents=True, exist_ok=True)
    for key in ("intro", "mid", "outro"):
        dest = REF_BGM / BGM_DEFAULT_SOURCES[key]
        if not dest.is_file() or dest.stat().st_size < 1000:
            raise FileNotFoundError(f"missing prescribed BGM: {dest}")
    for dest_name, src in _BGM_MATERIALIZE.items():
        dest = REF_BGM / dest_name
        if dest.is_file() and dest.stat().st_size > 1000:
            continue
        if src.is_file():
            shutil.copy2(src, dest)
            done.append(dest_name)
    return done


def _stem_key(name: str) -> str:
    return Path(name).stem


def is_vocal_stem(name: str) -> bool:
    stem = _stem_key(name)
    if stem in BGM_VOCAL_BLOCKLIST:
        return True
    if stem.startswith("seg_t"):
        return True
    if stem == "vocals":
        return True
    return False


def safe_source_name(name: str) -> str:
    """把计划里的 source 解析成允许的文件名（仍相对 ref_bgm）。"""
    ensure_prescribed_bgm_files()
    raw = str(name or "").strip()
    if not raw:
        return BGM_DEFAULT_SOURCES["mid"]
    if raw in BGM_SAFE_ALIASES:
        return BGM_SAFE_ALIASES[raw]
    key = Path(raw).name
    if key in BGM_SAFE_ALIASES:
        return BGM_SAFE_ALIASES[key]
    if is_vocal_stem(raw):
        return BGM_DEFAULT_SOURCES["intro"]
    return key


def _ok_outro_names() -> set[str]:
    return {
        BGM_DEFAULT_SOURCES["outro"],
        Path(BGM_DEFAULT_SOURCES["outro"]).stem,
    }


def _ok_intro_names() -> set[str]:
    return {
        BGM_DEFAULT_SOURCES["intro"],
        Path(BGM_DEFAULT_SOURCES["intro"]).stem,
        "Holding Court.mp3",
        "Holding Court",
    }


def _ok_mid_names() -> set[str]:
    return {
        BGM_DEFAULT_SOURCES["mid"],
        Path(BGM_DEFAULT_SOURCES["mid"]).stem,
    }


def ensure_outro_segment(plan: dict) -> dict:
    """短片缓存若只有 intro+mid，按时长补 Memories 后段。"""
    duration = float(plan.get("duration") or 0)
    segs = list(plan.get("segments") or [])
    if duration < 28 or not segs:
        return plan
    if any(str(s.get("id") or "") == "outro" for s in segs):
        return plan
    intro_end = 0.0
    mid = None
    for s in segs:
        if s.get("id") == "intro":
            intro_end = float(s.get("end") or 0)
        if s.get("id") == "mid":
            mid = s
    if duration > 70:
        outro_start = max(intro_end + 8.0, duration - 40.0)
    else:
        outro_len = min(18.0, max(10.0, duration * 0.28))
        outro_start = max(intro_end + 6.0, duration - outro_len)
    if outro_start >= duration - 1.0:
        return plan
    if mid is not None:
        mid["end"] = round(outro_start, 3)
        mid["fade_out"] = float(mid.get("fade_out") or 2.0)
    segs.append(
        {
            "id": "outro",
            "start": round(outro_start, 3),
            "end": round(duration, 3),
            "source": BGM_DEFAULT_SOURCES["outro"],
            "trim_start": 0.0,
            "trim_dur": None,
            "volume": 0.45,
            "fade_in": 2.0,
            "fade_out": 2.2,
            "loop": True,
        }
    )
    plan["segments"] = segs
    return plan


def normalize_bgm_plan(plan: dict) -> dict:
    ensure_prescribed_bgm_files()
    plan = ensure_outro_segment(plan)
    for seg in plan.get("segments") or []:
        seg["source"] = safe_source_name(str(seg.get("source") or ""))
        sid = str(seg.get("id") or "")
        name = Path(str(seg.get("source") or "")).name
        if sid == "intro":
            if name not in _ok_intro_names() and "Holding" not in name:
                seg["source"] = BGM_DEFAULT_SOURCES["intro"]
        elif sid == "mid":
            if name in _ok_outro_names() or "Holding" in name or "Memories" in name:
                seg["source"] = BGM_DEFAULT_SOURCES["mid"]
            elif name not in _ok_mid_names() and "精卫" not in name:
                seg["source"] = BGM_DEFAULT_SOURCES["mid"]
        elif sid == "outro":
            if name not in _ok_outro_names() and "Memories" not in name:
                seg["source"] = BGM_DEFAULT_SOURCES["outro"]
    plan["notes"] = (
        "片头=跨越大洋的飞机 Holding Court；"
        "中段=眠舸精卫降调；后段升华=TRA$H Memories。"
    )
    plan["policy"] = "prescribed_holding_jingwei_memories_v2"
    return plan


def validate_sources(plan: dict) -> list[str]:
    errs: list[str] = []
    duration = float(plan.get("duration") or 0)
    has_outro = False
    for seg in plan.get("segments") or []:
        src = str(seg.get("source") or "")
        if is_vocal_stem(src):
            errs.append(f"bgm seg {seg.get('id')} uses blocked stem {src!r}")
        name = Path(src).name
        if seg.get("id") == "intro":
            if name not in _ok_intro_names() and "Holding Court" not in name:
                errs.append(
                    f"intro BGM must be {BGM_DEFAULT_SOURCES['intro']!r}, got {src!r}"
                )
        if seg.get("id") == "mid":
            if name not in _ok_mid_names() and "精卫" not in name:
                errs.append(
                    f"mid BGM must be {BGM_DEFAULT_SOURCES['mid']!r}, got {src!r}"
                )
        if seg.get("id") == "outro":
            has_outro = True
            if name not in _ok_outro_names() and "Memories" not in name:
                errs.append(
                    f"outro BGM must be {BGM_DEFAULT_SOURCES['outro']!r}, got {src!r}"
                )
    if duration >= 28 and not has_outro:
        errs.append("bgm_plan missing outro segment (TRA$H Memories)")
    return errs
