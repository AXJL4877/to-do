"""用 Gemini 3.8 Flash 为任意口播生成逐句素材 brief + BGM 计划。

输出与 design.SCRIPT_BRIEFS 同构的 briefs 列表（按句序对齐），并写 bgm_plan。
校验失败自动重试；最终失败由调用方回退规则 brief。
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
KOUBO = HERE.parent
sys.path.insert(0, str(KOUBO))
# 注意：必须是 workflow/kit（它里面才有 llm.py 等模块）。写成 KOUBO.parent / "kit" 会让
# `from kit import llm` 命中一个命名空间包（无 kit/llm.py），accept_run 直接 ImportError。
sys.path.insert(0, str(HERE.parent / "kit"))

import paths
from bgm_policy import BGM_DEFAULT_SOURCES, normalize_bgm_plan, validate_sources
from kit import llm
from shot_kinds import (
    VIS_ALL,
    VIS_CARD,
    VIS_DIALOGUE,
    VIS_DUO,
    VIS_EMPHASIS,
    VIS_INTRO,
    VIS_REACTION,
    VIS_REVEAL,
    VIS_SCENE,
    VIS_STAMP,
    enforce_card_stamp_budget,
    enforce_diversity,
    normalize_visual,
    rule_classify,
    synthesize_emphasis_text,
    synthesize_say,
    synthesize_stamp_text,
)

DESIGN_MODEL = "gemini-3.8-flash"
MAX_ATTEMPTS = 3
BATCH = 4  # 更小批：降 JSON 截断率 + 配合 prompt-file
# 单次 chat 的墙钟上限。默认 600 是历史值，**故意不在本轮下调**：
# 实测正常一遍 _classify_and_bgm 只要 16s、assets 批次 24s，600s 对它们确实过长，
# 但"卡顿是否真的发生"还没有观测到（`design_report.json` 的 `timeouts` 字段就是为它准备的），
# 没有观测就调参属于"见慢就改数字"。先做成可配置，等一次带计时的全量跑再定默认值。
# 覆盖：设 KOUBO_CHAT_TIMEOUT=180 即可（单位秒，下限 30）。
CHAT_TIMEOUT = max(30, int(os.environ.get("KOUBO_CHAT_TIMEOUT", "600") or "600"))

VIS_OK = set(VIS_ALL)
ROLE_OK = {"character", "prop", "figure", "icon", "hero", "support"}

SYSTEM = (
    "You are a shot designer for SpongeBob-style Chinese finance shorts. "
    "Reply with JSON only. No markdown fences unless necessary."
)

CARD_MAX_RATIO = 0.25  # card + stamp 合计时长上限


def build_rule_briefs(sentences: list[dict]) -> list[dict[str, Any]]:
    """LLM 失败时：按句 rule_classify 生成与 timing 等长的 briefs（可生图）。"""
    briefs: list[dict[str, Any]] = []
    used_stamp = False
    for i, s in enumerate(sentences):
        text = str(s.get("text") or "")
        dur = max(0.05, float(s["end"]) - float(s["start"]))
        nph = len(s.get("phrases") or [])
        vis = rule_classify(i, text, dur, used_stamp=used_stamp, phrase_count=nph)
        if vis == VIS_STAMP:
            used_stamp = True
        tip = re.sub(r"[，。！？；,\s]", "", text)[:10] or f"shot{i}"
        assets: list[dict[str, Any]] = [
            {
                "slot": "host",
                "role": "character",
                "name_suffix": f"s{i}_host",
                "depict": f"与口播对应的角色：{text[:28]}",
                "prompt": (
                    "SpongeBob SquarePants or Bikini Bottom character illustrating "
                    f"「{tip}」, full body, single character only, thick black outline."
                ),
            }
        ]
        if vis not in (VIS_CARD, VIS_REACTION, VIS_INTRO) and nph >= 1:
            assets.append(
                {
                    "slot": "prop",
                    "role": "prop",
                    "name_suffix": f"s{i}_prop",
                    "depict": f"衬托本句的道具：{text[:24]}",
                    "prompt": (
                        f"A single cartoon prop for 「{tip}」, thick black outline, "
                        "no character, transparent-ready."
                    ),
                }
            )
        if vis == VIS_DUO:
            assets = [
                {
                    "slot": "left",
                    "role": "character",
                    "name_suffix": f"s{i}_left",
                    "depict": f"对照左侧角色：{text[:20]}",
                    "prompt": (
                        "Patrick Star on the left side of a contrast beat, full body, "
                        "single character only. Not SpongeBob."
                    ),
                },
                {
                    "slot": "right",
                    "role": "character",
                    "name_suffix": f"s{i}_right",
                    "depict": f"对照右侧角色：{text[:20]}",
                    "prompt": (
                        "SpongeBob SquarePants on the right side of a contrast beat, "
                        "full body, single character only."
                    ),
                },
            ]
        brief: dict[str, Any] = {
            "idx": i,
            "visual_prefer": vis,
            "card": vis == VIS_CARD,
            "title": tip,
            "assets": assets,
        }
        if i == 0:
            brief["intro_lines"] = sanitize_intro_lines(
                None, source_text=text
            )
            brief["visual_prefer"] = VIS_INTRO
        if vis == VIS_EMPHASIS:
            brief["text"] = synthesize_emphasis_text(text)
        if vis == VIS_STAMP:
            brief["text"] = synthesize_stamp_text(text)
        if vis == VIS_DIALOGUE:
            says = synthesize_say(text, list(s.get("phrases") or []))
            for a, sy in zip(
                [x for x in assets if x.get("role") == "character"], says
            ):
                a.update(sy)
        brief["assets"] = [
            _normalize_asset(a, i, j) for j, a in enumerate(brief["assets"])
        ]
        briefs.append(brief)
    return enforce_card_budget(briefs, sentences)


def _sentence_time(sentences: list[dict], idx: Any) -> float | None:
    """句子下标 → 该句起点秒；下标非法返回 None（交给时长兜底）。"""
    try:
        i = int(idx)
    except (TypeError, ValueError):
        return None
    if 0 <= i < len(sentences):
        return float((sentences[i] or {}).get("start") or 0.0)
    return None


def _default_bgm(
    duration: float,
    *,
    turn_time: float | None = None,
    outro_time: float | None = None,
) -> dict[str, Any]:
    """片头 Holding Court（事件未反转）→ 中段精卫（开始反转）→ 后段 Memories（升华讲道理）。

    分段优先用叙事边界：设计阶段让 LLM 标出「反转起点句 / 升华起点句」，这里换算成秒。
    拿不到叙事边界才退回按时长比例切——三段对应故事结构，不是把秒数三等分。
    短片只要标出了升华句，也照样给后段（原来 duration<28 直接不出后段）。
    """
    duration = max(1.0, float(duration))
    # 时长兜底（仅在缺叙事边界时生效）
    intro_end = min(25.0, max(5.0, duration * 0.18))
    if duration > 70:
        outro_start = max(intro_end + 8.0, duration - 40.0)
    elif duration >= 28:
        outro_len = min(18.0, max(10.0, duration * 0.28))
        outro_start = max(intro_end + 6.0, duration - outro_len)
    else:
        outro_start = duration  # 没有任何叙事依据的极短片：无后段
    # 两个边界成对给出但顺序/区间不对 → 整对丢弃（模型没读准阶段时，宁可退回时长兜底）
    turn_t = float(turn_time) if turn_time is not None else None
    outro_t = float(outro_time) if outro_time is not None else None
    if turn_t is not None and outro_t is not None and not (0.5 <= turn_t < outro_t <= duration - 0.5):
        turn_t = outro_t = None
    if turn_t is not None and 0.5 <= turn_t <= duration - 0.5:
        intro_end = turn_t
    if outro_t is not None and intro_end + 0.5 <= outro_t <= duration - 0.5:
        outro_start = outro_t
    mid_end = min(outro_start, duration)
    segs: list[dict[str, Any]] = [
        {
            "id": "intro",
            "start": 0.0,
            "end": round(intro_end, 3),
            "source": BGM_DEFAULT_SOURCES["intro"],
            "trim_start": 0.0,
            "trim_dur": round(intro_end, 3),
            "volume": 0.55,
            "fade_in": 0.3,
            "fade_out": 2.0,
            "loop": False,
        },
        {
            "id": "mid",
            "start": round(intro_end, 3),
            "end": round(mid_end, 3),
            "source": BGM_DEFAULT_SOURCES["mid"],
            "trim_start": 0.0,
            "trim_dur": None,
            "volume": 0.35,
            "fade_in": 2.2,
            "fade_out": 2.0,
            "loop": True,
        },
    ]
    if outro_start < duration - 1.0:
        segs[-1]["fade_out"] = 2.0
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
    else:
        segs[-1]["end"] = round(duration, 3)
        segs[-1]["fade_out"] = 2.2
    return normalize_bgm_plan(
        {
            "version": 2,
            "duration": round(duration, 3),
            "policy": "prescribed_holding_jingwei_memories_v2",
            "segments": segs,
            "notes": "",
        }
    )


def _sentence_block(sentences: list[dict], start: int = 0) -> str:
    lines = []
    for i, s in enumerate(sentences):
        idx = start + i
        dur = float(s["end"]) - float(s["start"])
        ph = " | ".join(str(p.get("text") or "") for p in (s.get("phrases") or [])[:6])
        lines.append(f"[{idx}] {dur:.2f}s {s['text']}\n    phrases: {ph}")
    return "\n".join(lines)


def _safe_log(log, msg: str) -> None:
    """Windows GBK 控制台遇替换符时不炸。"""
    try:
        log(msg)
    except UnicodeEncodeError:
        log(msg.encode("ascii", "replace").decode("ascii"))


def _loads_json_lenient(text: str) -> dict[str, Any]:
    """容忍模型常见的非法反斜杠转义。"""
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("no JSON object")
    blob = text[start : end + 1]
    try:
        return json.loads(blob)
    except json.JSONDecodeError:
        pass
    # 非法 \X → 保留 X（保留已合法的 \\ \" \/ \b \f \n \r \t \uXXXX）
    fixed = re.sub(r'\\(?!["\\/bfnrtu])', r"\\\\", blob)
    # 换行处漏逗号 / 结尾多逗号（模型长 JSON 最常见的两类错）
    fixed = re.sub(r'([}\]"\d]|true|false|null)(\s*\n\s*)(["{\[])', r"\1,\2\3", fixed)
    fixed = re.sub(r",(\s*[}\]])", r"\1", fixed)
    return json.loads(fixed)


class BillingError(RuntimeError):
    """账户余额不足：重试无意义，整条管线应急停。"""


_BILLING = re.compile(r"402|insufficient|余额|balance insufficient", re.I)


class LlmTimeout(RuntimeError):
    """上游 chat 调用超时。

    单独成类的原因：`_ask` 以前把所有异常都 `continue` 重试 3 轮，最后统一
    `raise RuntimeError(f"LLM JSON failed: {last_err}")` —— **异常类型被抹掉**，
    于是超时和"返回坏 JSON"在报告里长得一模一样。而超时是**不会被后续重试修好**的，
    重试等于把 CHAT_TIMEOUT 成倍放大：
        3 轮(_ask) × 3 轮(generate_briefs) × 600s ≈ 5400s 上限。
    实测 design 阶段 980s 就是这条放大链的一次实现（1 次卡顿 + 1 轮重试）。
    所以这里既保留类型，也让 _ask 对超时不再重试。
    """

    def __init__(self, message: str, *, timeout_s: float | None = None):
        super().__init__(message)
        self.timeout_s = timeout_s


def _ask(prompt: str, *, max_tokens: int = 8192) -> dict[str, Any]:
    last_err: Exception | None = None
    for round_i in range(3):
        try:
            reply = _chat_once(prompt, round_i, max_tokens)
        except subprocess.TimeoutExpired as exc:
            # 超时立刻上报，不在 _ask 内重试：同一个 600s 墙钟再等一遍没有意义，
            # 只会把耗时翻倍。是否重试交给上层（外层有 attempt 预算）。
            raise LlmTimeout(
                f"chat timed out after {exc.timeout}s", timeout_s=exc.timeout
            ) from exc
        except Exception as exc:  # noqa: BLE001
            if _BILLING.search(str(exc)):
                raise BillingError(str(exc)[:300]) from exc
            last_err = exc
            continue
        try:
            return llm.extract_json(reply)
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            try:
                return _loads_json_lenient(reply)
            except Exception as exc2:  # noqa: BLE001
                last_err = exc2
    if isinstance(last_err, subprocess.TimeoutExpired):
        raise LlmTimeout(f"chat timed out after {last_err.timeout}s", timeout_s=last_err.timeout)
    raise RuntimeError(f"LLM JSON failed: {last_err}")


def _chat_once(prompt: str, round_i: int, max_tokens: int) -> str:
    return llm.chat(
        prompt if round_i == 0 else (
            prompt
            + "\n\nIMPORTANT: previous reply was truncated or invalid JSON. "
            "Return ONE complete JSON object only, no markdown fences. "
            "Do not use raw backslashes except JSON escapes."
        ),
        system=SYSTEM,
        kind="gpt6",
        model=DESIGN_MODEL,
        max_tokens=max_tokens,
        temperature=0.35 if round_i == 0 else 0.2,
        timeout=CHAT_TIMEOUT,
    )


def _slug(text: str, n: int = 12) -> str:
    s = re.sub(r"[^\w\u4e00-\u9fff]+", "", text)[:n] or "shot"
    # ASCII-ish for filenames: keep Chinese, strip weird
    return s


def _normalize_asset(raw: dict, shot_idx: int, slot_i: int) -> dict[str, Any]:
    role = str(raw.get("role") or "character").lower()
    if role not in ROLE_OK:
        role = "character"
    slot = str(raw.get("slot") or raw.get("id") or f"a{slot_i}")
    slot = re.sub(r"\W+", "_", slot)[:16] or f"a{slot_i}"
    suffix = str(raw.get("name_suffix") or raw.get("suffix") or slot)
    suffix = re.sub(r"[^\w]+", "_", suffix, flags=re.UNICODE).strip("_")[:24] or slot
    prefix = "ch_" if role in ("character", "figure") else "pr_"
    name = str(raw.get("name") or "")
    if not re.match(r"^(ch|pr)_s\d+_", name):
        name = f"{prefix}s{shot_idx}_{suffix}"
    depict = str(raw.get("depict") or "").strip() or f"画面对应口播要点（镜{shot_idx}）"
    prompt = str(raw.get("prompt") or "").strip()
    if not prompt:
        prompt = (
            f"Cartoon cutout for narration beat {shot_idx}: {depict}. "
            "Flat 2D SpongeBob TV style, full body or clear prop, single subject only."
        )
    # hero/support → character（渲染仍认 character/prop/figure/icon）
    if role in ("hero", "support"):
        role = "character"
    out = {
        "id": slot,
        "name": name,
        "role": role,
        "depict": depict,
        "prompt": prompt,
        "printed": bool(raw.get("printed")),
        "phrase_match": _coerce_phrase_match(raw.get("phrase_match")),
        "swap_group": raw.get("swap_group"),
        "swap_order": int(raw.get("swap_order") or 0),
        "want": [name],
    }
    # dialogue 气泡字段（不进生图）
    if raw.get("say"):
        out["say"] = str(raw.get("say") or "").strip()[:14]
        out["say_at"] = int(raw.get("say_at") if raw.get("say_at") is not None else 0)
        out["say_side"] = str(raw.get("say_side") or "auto")
        if raw.get("say_until") is not None:
            out["say_until"] = int(raw["say_until"])
    return out


def _coerce_phrase_match(raw) -> list[str]:
    """phrase_match 必须是词列表。若模型返回整段 str，list(str) 会拆成单字导致全镜绑不上变空镜。"""
    if raw is None:
        return []
    if isinstance(raw, str):
        parts = [p.strip() for p in re.split(r"[,，、|/]+", raw) if p.strip()]
        return [p for p in parts if len(p) >= 2][:8]
    if isinstance(raw, (list, tuple)):
        out: list[str] = []
        for x in raw:
            if not isinstance(x, str):
                continue
            s = x.strip()
            if len(s) < 2:
                continue  # 丢弃单字碎片
            out.append(s)
        return out[:8]
    return []


def _normalize_text_overlay(raw, visual: str, text: str) -> dict | None:
    if visual == VIS_EMPHASIS:
        base = synthesize_emphasis_text(text)
    elif visual == VIS_STAMP:
        base = synthesize_stamp_text(text)
    else:
        return None
    if isinstance(raw, dict) and str(raw.get("content") or "").strip():
        content = re.sub(r"\s+", "", str(raw["content"]))[: (6 if visual == VIS_EMPHASIS else 10)]
        base["content"] = content or base["content"]
        if raw.get("zone"):
            base["zone"] = str(raw["zone"])
        if raw.get("style"):
            base["style"] = str(raw["style"])
        if raw.get("enter") is not None:
            base["enter"] = int(raw["enter"])
        if raw.get("fx"):
            base["fx"] = str(raw["fx"])
        if raw.get("z"):
            base["z"] = str(raw["z"])
    return base


def _normalize_brief(raw: dict, shot_idx: int, text: str) -> dict[str, Any]:
    visual = normalize_visual(
        str(raw.get("visual") or raw.get("mode") or raw.get("visual_prefer") or VIS_SCENE),
        shot_idx=shot_idx,
    )
    assets_raw = list(raw.get("assets") or [])
    if not assets_raw:
        assets_raw = [
            {
                "slot": "host",
                "role": "figure" if visual == VIS_CARD else "character",
                "name_suffix": _slug(text, 10),
                "depict": f"与「{text[:20]}」对应的角色姿态",
                "prompt": "SpongeBob SquarePants acting out the narration beat, full body, single character only.",
            }
        ]
    # card 至少 figure；duo 尽量 2 主体；dialogue ≥1 角色
    if visual == VIS_CARD and not any(
        str(a.get("role")) in ("figure", "character", "hero", "support") for a in assets_raw
    ):
        assets_raw.insert(
            0,
            {
                "slot": "figure",
                "role": "figure",
                "name_suffix": "card_fig",
                "depict": f"压在黄字下的角色：{text[:16]}",
                "prompt": "SpongeBob SquarePants serious pose for title card, full body, single character only.",
            },
        )
    n_cap = 2 if visual in (VIS_DUO, VIS_DIALOGUE, VIS_EMPHASIS, VIS_STAMP) else 4
    if visual == VIS_DUO:
        n_cap = 2
    if visual == VIS_REVEAL:
        n_cap = 4
    if visual == VIS_REACTION:
        n_cap = 2
    if visual == VIS_INTRO:
        n_cap = 2
    assets = [_normalize_asset(a, shot_idx, i) for i, a in enumerate(assets_raw[:n_cap])]
    # dialogue：无 say 时后面 design 还会再补；此处保留 LLM 已给的
    text_overlay = _normalize_text_overlay(raw.get("text"), visual, text)
    brief = {
        "match": (text[:12],),
        "title": str(raw.get("title") or text[:18]),
        "visual_prefer": visual,
        "card": visual == VIS_CARD,
        "assets": assets,
        "text": text_overlay,
        "intro_lines": raw.get("intro_lines"),
        "_llm": True,
        "_idx": shot_idx,
    }
    return brief


def validate_briefs(briefs: list[dict], sentences: list[dict]) -> list[str]:
    errs: list[str] = []
    if len(briefs) != len(sentences):
        errs.append(f"brief count {len(briefs)} != sentences {len(sentences)}")
        return errs
    names: set[str] = set()
    stamp_n = 0
    for i, (b, s) in enumerate(zip(briefs, sentences)):
        vis = normalize_visual(
            b.get("visual_prefer") or (VIS_CARD if b.get("card") else VIS_SCENE),
            shot_idx=i,
        )
        b["visual_prefer"] = vis
        if i == 0 and vis != VIS_INTRO:
            errs.append("shot0 must be intro_red")
        assets = b.get("assets") or []
        if not assets and vis != VIS_INTRO:
            errs.append(f"shot{i} empty assets")
        if vis in (VIS_SCENE, VIS_DIALOGUE, VIS_DUO) and assets and not (1 <= len(assets) <= 4):
            errs.append(f"shot{i} {vis} assets={len(assets)} not in 1..4")
        if vis == VIS_DUO and len(assets) < 2:
            errs.append(f"shot{i} duo needs ≥2 assets")
        if vis == VIS_EMPHASIS:
            tx = b.get("text") or {}
            if not str(tx.get("content") or "").strip():
                errs.append(f"shot{i} emphasis missing text.content")
        if vis == VIS_STAMP:
            stamp_n += 1
            tx = b.get("text") or {}
            if not str(tx.get("content") or "").strip():
                errs.append(f"shot{i} stamp missing text.content")
        for a in assets:
            name = a.get("name") or ""
            if name in names:
                errs.append(f"duplicate asset name {name}")
            names.add(name)
            if not a.get("depict") or not a.get("prompt"):
                errs.append(f"{name} missing depict/prompt")
            role = a.get("role")
            if role not in ROLE_OK and role not in ("character", "prop", "figure", "icon"):
                errs.append(f"{name} bad role")
            # 气泡/花字不得进生图 prompt 当主内容——只警告结构：say 不算资产
        if i > 0 and i < len(briefs):
            prev = normalize_visual(briefs[i - 1].get("visual_prefer"), shot_idx=i - 1)
            if vis == prev and vis != VIS_INTRO:
                errs.append(f"shot{i} visual {vis} adjacent duplicate")
    if stamp_n > 1:
        errs.append(f"stamp count {stamp_n} > 1")
    if briefs and sentences:
        errs.extend(
            validate_intro_vs_script(
                briefs[0].get("intro_lines"),
                str((sentences[0] or {}).get("text") or ""),
            )
        )
    return errs


def validate_bgm(plan: dict, duration: float) -> list[str]:
    errs = []
    segs = plan.get("segments") or []
    if not segs:
        errs.append("bgm segments empty")
        return errs
    for seg in segs:
        if not seg.get("source"):
            errs.append(f"seg {seg.get('id')} missing source")
        if float(seg.get("volume") or 0) <= 0 or float(seg.get("volume") or 0) > 1.0:
            errs.append(f"seg {seg.get('id')} bad volume")
        if float(seg.get("start") or 0) >= float(seg.get("end") or 0):
            errs.append(f"seg {seg.get('id')} start>=end")
    last_end = float(segs[-1].get("end") or 0)
    if last_end + 1.5 < duration:
        errs.append(f"bgm ends early {last_end} < duration {duration}")
    errs.extend(validate_sources(plan))
    return errs


def validate_intro_vs_script(
    intro_lines: list[str] | None,
    first_text: str,
) -> list[str]:
    """红字必须跟口播首句同题，禁止旧片标题串台。"""
    errs: list[str] = []
    src = re.sub(r"[，。！？；,\s]", "", first_text or "")
    joined = re.sub(r"\s+", "", "".join(intro_lines or []))
    if not joined:
        errs.append("intro_lines empty")
        return errs
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "kit"))
        from kit import typo

        src_t = typo.title_resolved(src)
        intro_t = typo.title_resolved(joined)
    except Exception:
        src_t, intro_t = src, joined
    body = src_t
    for prefix in ("為什麼説", "为什么说", "為什麼說"):
        if body.startswith(prefix):
            body = body[len(prefix) :]
            break
    # 取首个实义词 2–3 字（避开「听起来」等连接）；简繁混用不逐字对齐整段
    anchor = body[:3]
    # 听/說 等常见简繁差：只要求锚点主体落在 intro
    if "金本位" in src or "金本位" in src_t:
        if "金本位" not in intro_t:
            errs.append(f"intro_lines missing 金本位 (got {intro_t[:24]!r})")
    elif len(anchor) >= 2 and anchor not in intro_t and anchor[:2] not in intro_t:
        errs.append(f"intro_lines missing script anchor {anchor!r} (got {intro_t[:24]!r})")
    # 旧片标志：仅当口播本身不含时判串台
    stale = ("隔壁出事", "淹到你家", "搞錢要趁年輕", "研究複利", "研究复利")
    for mark in stale:
        try:
            from kit import typo

            mt = typo.title_trad(mark)
        except Exception:
            mt = mark
        if mt in intro_t and mt not in src_t and mark not in src:
            errs.append(f"intro_lines stale marker {mark!r}")
    return errs


# 道理/判断句 → card（黑底 + 模糊压暗的元素图 + 黄字）。
# 这是原版就有的设计规则：「纯判断/转折/警告且无可演物件 → card」（镜头种类设计.md 第 4 条）。
# 但种类是 LLM 挑的，短片经常整片判成 scene（实测 6 句的片子 card=0，而原版 41 句里有 3 个），
# 所以这里补一条确定性规则：句中带判断标记、又不含对话引号的，提成 card；
# 仍然受 CARD_MAX_RATIO(25%) 约束——超了会自动降级，所以短片通常只会有一个 card（就是升华句）。
_REASON_MARK = (
    "才是", "才叫", "才算", "不是", "而是", "其实", "说到底", "从来不", "永远",
    "真正", "记住", "道理", "不值", "唯一", "只能", "只要", "全凭", "终究",
)
_REASON_SKIP = ("「", "」", "“", "”", "？", "?")


def _is_reason_line(text: str) -> bool:
    t = re.sub(r"[，。！？；：、,.!?;:…—\s「」“”\"'『』]", "", str(text or ""))
    if not t or len(t) > 30:
        return False
    if any(ch in str(text) for ch in _REASON_SKIP):
        return False
    return any(m in t for m in _REASON_MARK)


def promote_reason_cards(
    briefs: list[dict],
    sentences: list[dict],
    *,
    max_ratio: float = CARD_MAX_RATIO,
) -> list[dict]:
    """把道理句提成 card；从片尾往前挑（升华句优先），合计不超 25%。

    只在【全片一个 card 都没有】时动手：已有 card 说明 LLM 的分类有效，不去覆盖它的选择
    （否则会把原版那种「scene + 花字」的道理句也改成 card，见原版 41 句的回归）。
    """
    if not briefs or not sentences:
        return briefs
    total = sum(max(0.05, float(s["end"]) - float(s["start"])) for s in sentences)
    budget = total * max_ratio

    def _heavy(i: int) -> bool:
        v = normalize_visual(briefs[i].get("visual_prefer"), shot_idx=i)
        return v in (VIS_CARD, VIS_STAMP) or bool(briefs[i].get("card"))

    def _card(i: int) -> bool:
        return normalize_visual(briefs[i].get("visual_prefer"), shot_idx=i) == VIS_CARD or bool(briefs[i].get("card"))

    # 保险只看 card：已经有 card 说明 LLM 的分类有效，不去覆盖它的选择。
    # （不能把 stamp 也算进来——升华句本身常常就是 stamp，那样规则永远不会触发。）
    if any(_card(i) for i in range(min(len(briefs), len(sentences)))):
        return briefs

    def _dur(i: int) -> float:
        return max(0.05, float(sentences[i]["end"]) - float(sentences[i]["start"]))

    used = sum(_dur(i) for i in range(len(briefs)) if _heavy(i))
    for i in range(min(len(briefs), len(sentences)) - 1, -1, -1):
        if _card(i):  # 已经是 card 就跳过
            continue
        if not _is_reason_line(str(sentences[i].get("text") or "")):
            continue
        # stamp → card 不额外占预算（两者都算 heavy），只有从 scene/reveal 等改过来才加时长
        add = 0.0 if _heavy(i) else _dur(i)
        if used + add > budget + 0.05:
            continue
        briefs[i]["visual_prefer"] = VIS_CARD
        briefs[i]["card"] = True
        used += add
    return briefs


def enforce_card_budget(
    briefs: list[dict],
    sentences: list[dict],
    *,
    max_ratio: float = CARD_MAX_RATIO,
) -> list[dict]:
    """card + stamp 合计 ≤ max_ratio；并做相邻种类去重；道理句提成 card。"""
    briefs = enforce_card_stamp_budget(briefs, sentences, max_ratio=max_ratio)
    visuals = [
        normalize_visual(b.get("visual_prefer"), shot_idx=i) for i, b in enumerate(briefs)
    ]
    visuals = enforce_diversity(visuals)
    for i, v in enumerate(visuals):
        briefs[i]["visual_prefer"] = v
        briefs[i]["card"] = v == VIS_CARD
        if v == VIS_EMPHASIS and not (briefs[i].get("text") or {}).get("content"):
            briefs[i]["text"] = synthesize_emphasis_text(str((sentences[i] or {}).get("text") or ""))
        if v == VIS_STAMP and not (briefs[i].get("text") or {}).get("content"):
            briefs[i]["text"] = synthesize_stamp_text(str((sentences[i] or {}).get("text") or ""))
        if v == VIS_DIALOGUE:
            # 给角色层补气泡
            says = synthesize_say(
                str((sentences[i] or {}).get("text") or ""),
                list((sentences[i] or {}).get("phrases") or []),
            )
            chars = [a for a in (briefs[i].get("assets") or []) if a.get("role") == "character"]
            for a, sy in zip(chars, says):
                if not a.get("say"):
                    a.update(sy)
    # 道理句提成 card，再守一次 25% 预算（提升后可能超额）
    briefs = promote_reason_cards(briefs, sentences, max_ratio=max_ratio)
    briefs = enforce_card_stamp_budget(briefs, sentences, max_ratio=max_ratio)
    return briefs
    # scene 至少保留现有 assets；若只有 figure 也允许，靠放大补偿
    return briefs


_TITLE_PUNCT = set("，。！？；：、,.!?;:…—·~～「」『』“”\"'《》（）()[]【】 \t")


def _t2s(text: str) -> str:
    if not text:
        return text
    try:
        from opencc import OpenCC

        return OpenCC("t2s").convert(text)
    except Exception:
        return text


def _title_chain():
    """开场红字实际使用的字体链（首选字魂剑气手书）。拿不到就退回单字体。"""
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "kit"))
    from kit import typo

    return typo, typo.TITLE_FONT_CHAIN


def _title_body(text: str) -> str:
    return re.sub(r"\s+", "", "".join(ch for ch in str(text or "") if ch not in _TITLE_PUNCT))


def _title_renderable(text: str) -> bool:
    """链上（剑气手书 → AmezumiGothic → 系统宋体）是否每个字都排得出来。

    只要链没断，这里恒为真——渲染侧逐字换字体，不再丢字。
    """
    body = _title_body(text)
    if not body:
        return False
    try:
        typo, chain = _title_chain()

        return not typo.missing_glyphs(typo.title_resolved(body), chain)
    except Exception:
        return True


def _title_line_ok(text: str) -> bool:
    body = _title_body(text)
    return bool(body) and _title_renderable(body)


def intro_lines_valid(lines: list[str] | None) -> bool:
    """开场红字是否逐字都能排出来（外部入口：design 侧也要用同一把尺）。"""
    return bool(lines) and all(_title_line_ok(x) for x in lines)


def align_intro_to_source(shown: list[str] | None, source_text: str | None) -> list[str]:
    """红字显示字序必须是口播首句的前缀；对不上就判为不全，返回空。

    只查「排得出来」不够：旧缓存里的「最錢的」排得出来，但它是被砍掉尾巴的那一行，
    照样会让开头缺字。显示字经 title_resolved 取形（可能简繁混用），口播是简体，逐字比。
    """
    if not shown or not source_text:
        return list(shown or [])
    try:
        seq = _t2s(_title_body("".join(str(x) for x in shown)))
        want = _t2s(_title_body(source_text))
        resolved = _t2s(_title_resolved_text(seq))
        src = _t2s(_title_resolved_text(want))
    except Exception:
        return list(shown)
    if not resolved or not src:
        return list(shown)
    return list(shown) if src.startswith(resolved) else []


def _title_resolved_text(text: str) -> str:
    typo, _chain = _title_chain()

    return typo.title_resolved(text)


def _intro_from_source(source_text: str) -> list[str]:
    """从口播首句拆 2–3 行红字（保留简体，渲染时按字体逐字取形）。"""
    body = re.sub(r"[，。！？；,\s]", "", source_text or "")
    if not body:
        return []
    # 语义断行优先，贴近口播节奏
    if body.startswith("为什么说金本位") and "口袋" in body:
        lines = ["为什么说金本位", "听起来像博物馆规矩", "其实管着你口袋的钱"]
    elif body.startswith("为什么说危机") or "次贷" in body or "隔壁出事" in body:
        lines = ["为什么说危机", "听起来像隔壁出事", "其实会淹到你家"]
    else:
        # 通用：首行钩子 ≤7 字，其余 wrap
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "kit"))
        from kit import typo

        head_n = 7 if body.startswith("为什么说") else 6
        head = body[: min(head_n, max(4, len(body) // 3))]
        rest = body[len(head) :]
        lines = [head] + typo.wrap_card(rest, 7)[:2]
    return [re.sub(r"\s+", "", x) for x in lines if x][:4]


def sanitize_intro_lines(
    lines: list[str] | None,
    source_text: str | None = None,
) -> list[str]:
    """开场红字：贴近口播首句、逐字排得出来，禁止缩成短口号。

    判据从「单字体够不够黑」换成「字体链排不排得出」——剑气手书缺的字由
    AmezumiGothic / 系统宋体逐字补上，所以不再有「只保留能显示的字」这种丢字分支。
    绝不回落到与当前口播无关的旧片默认文案。
    """
    try:
        if lines:
            cleaned = [_title_body(x) for x in lines if str(x).strip()]
            cleaned = [x for x in cleaned if x]
            # 模型/旧缓存可能给繁体：先转简体，渲染侧再按字体逐字还原
            cleaned = [_t2s(x) for x in cleaned]
            # 显示字序必须是口播首句的前缀：旧缓存里被砍掉尾巴的行（如「最錢的」）在这里出局
            cleaned = align_intro_to_source(cleaned, source_text)
            if intro_lines_valid(cleaned) and sum(len(x) for x in cleaned) >= 14:
                # 若提供了口播首句，拒绝与首句完全无关的旧默认（含「隔壁出事」等）
                if source_text:
                    src = re.sub(r"[，。！？；,\s]", "", _t2s(source_text))
                    joined = "".join(cleaned)
                    # 金本位口播却仍是危机默认 → 丢弃
                    if "金本位" in src and "金本位" not in joined and "危机" in joined:
                        cleaned = []
                    elif "金本位" in src and "隔壁" in joined:
                        cleaned = []
                if cleaned:
                    return cleaned[:4]

        fallback = _intro_from_source(source_text or "")
        if intro_lines_valid(fallback):
            return fallback
        if fallback:
            # 字序对不上口播首句时，按逐字对齐把首句的字换进去（字数不变，只换字形）
            seq = "".join(_title_body(x) for x in fallback)
            try:
                src = _title_resolved_text(_title_body(source_text or ""))
                if seq and src and len(seq) <= len(src) and src[: len(seq)] != seq:
                    fixed, i = [], 0
                    for line in fallback:
                        n = len(_title_body(line))
                        fixed.append(src[i : i + n])
                        i += n
                    if intro_lines_valid(fixed) and len("".join(fixed)) == len(seq):
                        return fixed[:4]
            except Exception:
                pass
            # 只在字体链真断（保底字体也缺字）时才留能排的字，正常永远走不到
            kept = ["".join(ch for ch in x if _title_renderable(ch)) for x in fallback]
            kept = [x for x in kept if x]
            if kept:
                return kept[:4]
    except Exception:
        pass
    return _intro_from_source(source_text or "") or ["为什么说", "先听清楚", "再下结论"]


def _classify_and_bgm(sentences: list[dict], duration: float) -> dict[str, Any]:
    first = re.sub(r"\s+", "", str((sentences[0] or {}).get("text") or ""))[:40]
    prompt = f"""Design visuals for this narration.

BGM is FIXED by pipeline (do NOT invent or change BGM files; the plan is written in code):
  intro = {BGM_DEFAULT_SOURCES['intro']}   <- 故事线前半段：事件还没反转
  mid   = {BGM_DEFAULT_SOURCES['mid']}     <- 事件开始反转
  outro = {BGM_DEFAULT_SOURCES['outro']}   <- 升华、讲道理

Mark WHERE the three phases change, by SENTENCE INDEX (never by seconds):
  turn_sentence  = first sentence where the story turns (反转 / 意外 / 代价出现)
  outro_sentence = first sentence that moves to the 结论 / 道理 / 提醒
turn_sentence must be >= 1 and < outro_sentence; outro_sentence must be < {len(sentences)}.
If the narration has no real turn, omit both keys.

Choose EXACTLY one visual per sentence from these 9 kinds:
1. intro_red — ONLY shot 0 (red cracked title on black)
2. dialogue — someone speaking / quoted line / 「说：」「冷笑」 → beach + characters; bubbles in code
3. emphasis — short must-read keyword (≤6 chars) + prop; flower-text overlay
4. card — short claim / twist, no showable object (yellow on black); keep rare
5. stamp — one slogan over subject (≤1 per film); flower-text overlay
6. duo — two-sided contrast (left vs right)
7. reveal — multi-phrase narrative (≥3 phrases): elements unveil on each phrase beat
8. reaction — short reaction / shock line; usually 1 character
9. scene — default narrative action / props on beach

Decision order: intro → dialogue → emphasis → card → stamp → duo → reaction → reveal → scene.
HARD rules:
- Adjacent shots MUST NOT share the same visual (except intro_red only on shot 0).
- card + stamp total duration ≤ 25% of film; when unsure prefer scene/reveal.
- dialogue/duo: do not stack three in a row.
- Element entrances will be locked to narration phrase starts in code — still give phrase_match when possible.
- intro_lines: Simplified Chinese (简体), close to first sentence 「{first}」 (~18–24 chars, 2–3 lines).

Total duration seconds: {duration:.2f}

Narration:
{_sentence_block(sentences)}

Return JSON:
{{
  "intro_lines": ["简体行1", "简体行2", "简体行3"],
  "bgm": {{"turn_sentence": 3, "outro_sentence": 7}},
  "shots": [
    {{"idx":0,"visual":"intro_red","title":"..."}},
    {{"idx":1,"visual":"dialogue","title":"..."}},
    {{"idx":2,"visual":"scene","title":"..."}}
  ]
}}
Exactly one shots[] entry per sentence index 0..{len(sentences)-1}.
"""
    data = _ask(prompt, max_tokens=4096)
    # BGM 文件硬锁，不采用模型胡写的源文件；但分段用模型标出的叙事边界（拿不到才按时长兜底）
    bgm_meta = data.get("bgm") if isinstance(data.get("bgm"), dict) else {}
    bgm = _default_bgm(
        duration,
        turn_time=_sentence_time(sentences, bgm_meta.get("turn_sentence")),
        outro_time=_sentence_time(sentences, bgm_meta.get("outro_sentence")),
    )
    shots_meta = {int(s.get("idx", i)): s for i, s in enumerate(data.get("shots") or [])}
    intro_lines = sanitize_intro_lines(data.get("intro_lines"), source_text=first)
    return {"bgm": bgm, "shots_meta": shots_meta, "intro_lines": intro_lines}


def _assets_batch(
    sentences: list[dict],
    offset: int,
    shots_meta: dict[int, dict],
    feedback: str = "",
) -> list[dict]:
    block = []
    for i, s in enumerate(sentences):
        idx = offset + i
        meta = shots_meta.get(idx) or {}
        visual = meta.get("visual") or (VIS_INTRO if idx == 0 else VIS_SCENE)
        title = meta.get("title") or ""
        block.append(f"[{idx}] visual={visual} title={title}\n  text={s['text']}")
    prompt = f"""For each shot below, invent UNIQUE cutout assets (SpongeBob cast OK).

Hard rules:
- Each asset needs: slot, role (character|prop|figure|icon|hero|support), name_suffix, depict (Chinese), prompt (English), optional phrase_match, printed(bool), swap_group/swap_order.
- visual=scene: 2-3 assets (character + prop). visual=duo: exactly 2 subjects (left/right). visual=dialogue: 1-2 characters; add say/say_at/say_side on speakers (say = the character's spoken words copied as WHOLE phrases from narration, ≤18 chars, never cut mid-phrase, never the narrator lead-in like 「X叹气：」; NOT painted into PNG).
- visual=emphasis: 1 subject/prop + top-level text{{content = one COMPLETE key clause copied from narration (2–12 chars, no punctuation, never a truncated half-clause), zone left|right, style:white_soft}}.
- visual=stamp: 1 subject + top-level text{{content = one COMPLETE slogan clause from narration (2–12 chars), zone:center_full, style:white_soft}}.
- visual=reveal: 2-4 assets unveiled across phrases. visual=reaction: 1-2 assets. visual=card / intro_red: 1-2 assets (figure/character). NEVER put bubble or flower-text into prompt/PNG.
- Names become ch_s{{idx}}_{{suffix}} or pr_s{{idx}}_{{suffix}} — unique across ALL shots.
- prompt: ONLY that asset; single subject; no scenery; full body / full prop.
{feedback}

Shots:
{chr(10).join(block)}

Return JSON:
{{"shots":[{{"idx":0,"visual":"intro_red","title":"...","assets":[{{"slot":"host","role":"character","name_suffix":"host","depict":"...","prompt":"..."}}]}},{{"idx":1,"visual":"dialogue","assets":[{{"slot":"hero","role":"character","name_suffix":"patrick","depict":"...","prompt":"...","say":"零首付稳了","say_at":0,"say_side":"right"}}]}},{{"idx":3,"visual":"emphasis","text":{{"content":"杠杆","zone":"right","style":"white_soft"}},"assets":[{{"slot":"prop","role":"prop","name_suffix":"lever","depict":"...","prompt":"..."}}]}}]}}
Include every idx listed above.
"""
    data = _ask(prompt, max_tokens=8192)
    by_idx = {int(s.get("idx", -1)): s for s in (data.get("shots") or [])}
    out = []
    for i, s in enumerate(sentences):
        idx = offset + i
        raw = by_idx.get(idx) or shots_meta.get(idx) or {}
        if "visual" not in raw and idx in shots_meta:
            raw = {**shots_meta[idx], **raw}
        brief = _normalize_brief(raw, idx, s["text"])
        out.append(brief)
    return out


LLM_WORKERS = 8


def _assets_parallel(sentences, shots_meta, feedback, log, report):
    """所有批次并发问模型；单批内部已有 3 轮重试，仍失败的批次只就地用规则补。"""
    import time
    from concurrent.futures import ThreadPoolExecutor

    starts = list(range(0, len(sentences), BATCH))
    t0 = time.time()
    results: dict[int, list[dict]] = {}
    failed: list[int] = []

    def one(start):
        chunk = sentences[start : start + BATCH]
        _safe_log(log, f"llm_design assets batch {start}-{start + len(chunk) - 1}")
        return start, _assets_batch(chunk, start, shots_meta, feedback=feedback)

    with ThreadPoolExecutor(max_workers=min(LLM_WORKERS, len(starts) or 1)) as pool:
        futs = {pool.submit(one, s): s for s in starts}
        for fut in futs:
            s = futs[fut]
            try:
                _, out = fut.result()
                results[s] = out
            except BillingError:
                for f in futs:
                    f.cancel()
                raise
            except Exception as exc:  # noqa: BLE001
                _safe_log(log, f"llm_design batch fail@{s}: {str(exc)[:160]} → rule fill")
                failed.append(s)
    rules = None
    briefs: list[dict] = []
    rule_filled: list[int] = []
    for s in starts:
        if s in results:
            briefs.extend(results[s])
            continue
        rules = rules or build_rule_briefs(sentences)
        n = len(sentences[s : s + BATCH])
        briefs.extend(rules[s : s + n])
        rule_filled.extend(range(s, s + n))
    report["llm_parallel"] = {
        "workers": min(LLM_WORKERS, len(starts) or 1),
        "batches": len(starts),
        "failed_batches": sorted(failed),
        "elapsed_s": round(time.time() - t0, 1),
    }
    return briefs, rule_filled


def generate_briefs(
    sentences: list[dict],
    *,
    max_attempts: int = MAX_ATTEMPTS,
    log=print,
) -> tuple[list[dict], dict[str, Any], dict[str, Any]]:
    """返回 (briefs, bgm_plan, report)。"""
    duration = float(sentences[-1]["end"]) if sentences else 1.0
    report: dict[str, Any] = {
        "model": DESIGN_MODEL,
        "attempts": [],
        "ok": False,
        "source": "llm",
        # 把生效的配置写进报告：否则事后无法判断那次跑用的是 600s 还是别的值
        "chat_timeout_s": CHAT_TIMEOUT,
        "max_attempts": max_attempts,
    }
    last_errs: list[str] = []
    t_all = time.time()
    for attempt in range(1, max_attempts + 1):
        t_attempt = time.time()
        try:
            _safe_log(log, f"llm_design attempt {attempt}/{max_attempts} model={DESIGN_MODEL}")
            t_head = time.time()
            head = _classify_and_bgm(sentences, duration)
            # 这里以前没有计时：设计阶段实测 980s，而 _assets_parallel 自报只有 31s，
            # 剩下的时间全落在这个"看不见"的调用上（每次最多 CHAT_TIMEOUT=600s，
            # 外层还有 max_attempts=3 轮）。把每步耗时记进报告，别再靠猜。
            head_s = round(time.time() - t_head, 1)
            bgm = head["bgm"]
            shots_meta = head["shots_meta"]
            intro_lines = head.get("intro_lines")
            feedback = ""
            if last_errs:
                feedback = "Previous errors to fix:\n- " + "\n- ".join(
                    e.encode("ascii", "replace").decode("ascii") for e in last_errs[:12]
                )
            t_par = time.time()
            briefs, rule_filled = _assets_parallel(sentences, shots_meta, feedback, log, report)
            parallel_s = round(time.time() - t_par, 1)
            report["timing_per_attempt"] = [
                *report.get("timing_per_attempt", []),
                {
                    "n": attempt,
                    "classify_bgm_s": head_s,
                    "assets_parallel_s": parallel_s,
                    "attempt_s": round(time.time() - t_attempt, 1),
                },
            ]
            if briefs:
                first_txt = str((sentences[0] or {}).get("text") or "")
                briefs[0]["intro_lines"] = sanitize_intro_lines(
                    intro_lines or (briefs[0].get("intro_lines") if briefs else None),
                    source_text=first_txt,
                )
            briefs = enforce_card_budget(briefs, sentences)
            # 再强制 BGM 源文件（文件硬锁）；分段沿用上面按叙事边界算好的 plan
            bgm = head.get("bgm") or _default_bgm(duration)
            errs = validate_briefs(briefs, sentences) + validate_bgm(bgm, duration)
            report["attempts"].append({"n": attempt, "errors": errs, "rule_filled": rule_filled})
            report["rule_filled"] = rule_filled
            if rule_filled and attempt < max_attempts:
                last_errs = errs + [f"batch failed, shots {rule_filled} fell back to rules"]
                _safe_log(log, f"llm_design rule-filled shots {rule_filled}; retry attempt")
                continue
            if not errs:
                report["ok"] = True
                report["total_s"] = round(time.time() - t_all, 1)
                _safe_log(
                    log,
                    f"llm_design ok shots={len(briefs)} bgm_segs={len(bgm.get('segments') or [])}"
                    f" total={report['total_s']}s",
                )
                return briefs, bgm, report
            # 校验失败但已有完整 briefs：仍可用（比整段 rules 好）
            if len(briefs) == len(sentences):
                report["ok"] = True
                report["soft_ok"] = True
                report["total_s"] = round(time.time() - t_all, 1)
                _safe_log(log, f"llm_design soft-ok with errs={errs[:4]}")
                return briefs, bgm, report
            last_errs = errs
            _safe_log(log, f"llm_design validate fail: {errs[:6]}")
        except BillingError as exc:
            report["billing_error"] = str(exc)[:300]
            write_design_report(report)
            raise
        except Exception as exc:  # noqa: BLE001
            # 超时必须能一眼认出来。超时可能以两种形态到达：
            #   · subprocess.TimeoutExpired —— 直接来自 subprocess.run(timeout=)
            #   · LlmTimeout —— _ask 已经识别并保留类型（它不再把类型抹成 RuntimeError）
            # 以前两者都被压成 "llm_design exception" 文本，于是一次长达 CHAT_TIMEOUT 的
            # 卡顿在报告里和"返回了个坏 JSON"长得一模一样 —— 这是 980s 无法归因的直接原因。
            if isinstance(exc, LlmTimeout):
                is_timeout, to_s = True, (exc.timeout_s or CHAT_TIMEOUT)
            elif isinstance(exc, subprocess.TimeoutExpired):
                is_timeout, to_s = True, (exc.timeout or CHAT_TIMEOUT)
            else:
                is_timeout, to_s = False, None
            err_s = (f"TIMEOUT after {to_s}s: {exc}" if is_timeout else str(exc))
            err_s = err_s.encode("ascii", "replace").decode("ascii")
            report.setdefault("timeouts", [])
            if is_timeout:
                report["timeouts"].append({"n": attempt, "timeout_s": to_s})
            report["attempts"].append({"n": attempt, "errors": [err_s[:500]], "timeout": is_timeout})
            last_errs = [err_s[:200]]
            _safe_log(log, f"llm_design exception: {err_s[:300]}")

    # 失败：规则 briefs（等长可生图）
    report["ok"] = False
    report["fallback"] = "rules"
    report["total_s"] = round(time.time() - t_all, 1)
    # 关键：失败路径也要把诊断**落盘**。
    # 以前这里只 return，不写盘；调用方 run_design.py 随后用
    # {"source":"rules_fallback","ok":true} 覆盖了 design_report.json ——
    # 于是"哪些 attempt 失败、有没有超时"这些唯一能解释耗时的信息，
    # 恰好在最需要它的时候被丢掉了（设计阶段 980s 无法归因的直接原因）。
    try:
        write_design_report(report)
    except Exception:  # noqa: BLE001
        pass
    return build_rule_briefs(sentences), _default_bgm(duration), report


def write_bgm_plan(plan: dict, out_dir: Path | None = None) -> Path:
    out_dir = out_dir or paths.DESIGN
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "bgm_plan.json"
    plan = normalize_bgm_plan(dict(plan or {}))
    text = json.dumps(plan, ensure_ascii=False, indent=2) + "\n"
    path.write_text(text, encoding="utf-8")
    # 备份到 04，防止长渲染期间 02 产物被误清导致叠轨失败
    try:
        bak_dir = paths.RENDER_OUT
        bak_dir.mkdir(parents=True, exist_ok=True)
        (bak_dir / "bgm_plan.json").write_text(text, encoding="utf-8")
    except OSError:
        pass
    return path


def write_design_report(report: dict, out_dir: Path | None = None) -> Path:
    out_dir = out_dir or (paths.DESIGN / "logs")
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "design_report.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path
