"""一键验收：成片存在、时长、非黑场、音轨、设计/生图报告、BGM 计划、开头字体。

门禁重点（防串台）：
- 红字须跟口播首句同题
- BGM 不得使用含旧口播的示例拆轨
- timing 文案须跟 口播.txt 一致
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import paths
from bgm_policy import is_vocal_stem, normalize_bgm_plan, validate_sources

# 开场红字字体链：**包内优先**，桌面路径只作兜底（与 kit/typo.py:TITLE_FONT_CHAIN 同序）。
# 之前这里把 D:\Desktop\TTF 写在最前，于是换机器/把包发给别人时，验收会误报"首选字体缺失"——
# 明明包内就带着同一款字（kit/fonts/字魂剑气手书(商用需授权).ttf）。
TITLE_FONT_BUNDLED = paths.FONTS / "字魂剑气手书(商用需授权).ttf"
TITLE_FONT_AMBIENT = Path(r"D:\Desktop\TTF\字魂剑气手书(商用需授权).ttf")
TITLE_FALLBACK_FONT = paths.FONTS / "AmezumiGothic.ttf"
TITLE_FONT = TITLE_FONT_BUNDLED if TITLE_FONT_BUNDLED.is_file() else TITLE_FONT_AMBIENT
sys.path.insert(0, str(paths.DESIGN_CODE))
sys.path.insert(0, str(paths.DESIGN))
from entrance_recipes import validate_phrase_sync  # noqa: E402
from llm_briefs import validate_intro_vs_script  # noqa: E402


def _ffprobe(path: Path) -> dict:
    p = subprocess.run(
        [
            paths.ffprobe_bin(),
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_type,codec_name",
            "-of",
            "json",
            str(path),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    try:
        return json.loads(p.stdout or "{}")
    except json.JSONDecodeError:
        return {}


def _frame_mean(video: Path, t: float) -> float:
    import numpy as np
    from PIL import Image
    import io

    p = subprocess.run(
        [
            paths.ffmpeg_bin(),
            "-v",
            "error",
            "-ss",
            str(t),
            "-i",
            str(video),
            "-frames:v",
            "1",
            "-f",
            "image2pipe",
            "-vcodec",
            "mjpeg",
            "pipe:1",
        ],
        capture_output=True,
    )
    if p.returncode != 0 or not p.stdout:
        return -1.0
    im = Image.open(io.BytesIO(p.stdout)).convert("RGB")
    return float(np.asarray(im).mean())


def accept() -> dict:
    paths.ensure()
    checks: list[dict] = []
    ok = True

    def add(name: str, passed: bool, detail: str):
        nonlocal ok
        checks.append({"name": name, "ok": passed, "detail": detail})
        if not passed:
            ok = False

    video = paths.OUTPUT_VIDEO
    add("final_exists", video.is_file(), str(video))

    meta = _ffprobe(video) if video.is_file() else {}
    dur = float((meta.get("format") or {}).get("duration") or 0)
    streams = meta.get("streams") or []
    has_v = any(s.get("codec_type") == "video" for s in streams)
    has_a = any(s.get("codec_type") == "audio" for s in streams)
    add("duration_gt_20", dur >= 20.0, f"duration={dur:.2f}")
    add("has_video", has_v, "video stream")
    add("has_audio", has_a, "audio stream")

    if video.is_file() and dur > 5:
        # 采样点别落在开场黑场/碎裂场上：短片 时长×15% 可能正好是 4s 黑场（设计内）。
        # 多点取最亮的一帧——三处都黑才算真黑片。
        m8 = max(
            _frame_mean(video, min(8.0, dur * 0.15)),
            _frame_mean(video, dur * 0.35),
            _frame_mean(video, dur * 0.60),
        )
        m_mid = _frame_mean(video, dur * 0.45)
        add("not_black_t8", m8 > 12.0, f"mean={m8:.1f}")
        add("not_black_mid", m_mid > 12.0, f"mean={m_mid:.1f}")

    design = paths.DESIGN / "shots_design.json"
    add("shots_design", design.is_file(), str(design))
    if design.is_file():
        data = json.loads(design.read_text(encoding="utf-8"))
        summary = data.get("summary") or {}
        add("has_intro", int(summary.get("intro_red") or 0) >= 1, str(summary))
        add("missing_assets_zero", int(summary.get("missing_assets") or 0) == 0, str(summary))

    # 口播 ↔ timing ↔ 红字
    script = ""
    if paths.TTS_SCRIPT.is_file():
        script = paths.TTS_SCRIPT.read_text(encoding="utf-8").strip()
    timing_text = ""
    first_sent = ""
    if paths.TTS_TIMING.is_file():
        timing = json.loads(paths.TTS_TIMING.read_text(encoding="utf-8"))
        timing_text = str(timing.get("text") or "").strip()
        sents = timing.get("sentences") or []
        first_sent = str((sents[0] or {}).get("text") or "") if sents else ""
    if script and timing_text:
        a = re.sub(r"\s+", "", script)[:40]
        b = re.sub(r"\s+", "", timing_text)[:40]
        add("script_timing_match", a == b, f"script[:40]={a!r} timing[:40]={b!r}")
    else:
        add("script_timing_match", bool(script and timing_text), "missing script or timing")

    plan_path = paths.DESIGN / "plan.json"
    intro_lines: list[str] = []
    empty_scenes: list[int] = []
    phrase_sync_errs: list[str] = []
    if plan_path.is_file():
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
        intro_lines = list((plan.get("intro") or {}).get("lines") or [])
        timing_ph = (
            json.loads(paths.TTS_TIMING.read_text(encoding="utf-8"))
            if paths.TTS_TIMING.is_file()
            else {}
        )
        sents_ph = timing_ph.get("sentences") or []
        for i, sh in enumerate(plan.get("shots") or []):
            if sh.get("mode") == "scene" and not (sh.get("layers") or []):
                empty_scenes.append(i)
            layers = sh.get("layers") or []
            if not layers or i >= len(sents_ph):
                continue
            phrases = sents_ph[i].get("phrases") or []
            for e in validate_phrase_sync(layers, phrases):
                phrase_sync_errs.append(f"shot{i}:{e}")
    intro_errs = validate_intro_vs_script(intro_lines, first_sent or script[:80])
    add("intro_matches_script", not intro_errs, "; ".join(intro_errs) or "ok")
    add("no_empty_scene_layers", not empty_scenes, f"empty_shots={empty_scenes}")
    add(
        "phrase_sync_enter_at",
        not phrase_sync_errs,
        "; ".join(phrase_sync_errs[:8]) or "ok",
    )

    bgm = paths.DESIGN / "bgm_plan.json"
    add("bgm_plan", bgm.is_file(), str(bgm))
    if bgm.is_file():
        raw = json.loads(bgm.read_text(encoding="utf-8"))
        raw_hits = [
            str(seg.get("source"))
            for seg in (raw.get("segments") or [])
            if is_vocal_stem(str(seg.get("source") or ""))
        ]
        bp = normalize_bgm_plan(raw)
        # 归一后写回，避免下次 mix 再读到禁名
        bgm.write_text(json.dumps(bp, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        add("bgm_segments", len(bp.get("segments") or []) >= 1, str(len(bp.get("segments") or [])))
        vocal_errs = validate_sources(bp)
        add(
            "bgm_no_vocal_stems",
            not vocal_errs,
            f"errs={vocal_errs} remapped_from={raw_hits or '-'}",
        )

    gen_rep = paths.ASSETS_LOGS / "gen_report.json"
    if gen_rep.is_file():
        gr = json.loads(gen_rep.read_text(encoding="utf-8"))
        failed = gr.get("failed") or []
        add("gen_no_failed", len(failed) == 0, f"failed={failed}")
    else:
        add("gen_report", False, "missing gen_report.json")

    design_rep = paths.DESIGN / "logs" / "design_report.json"
    if design_rep.is_file():
        dr = json.loads(design_rep.read_text(encoding="utf-8"))
        add("design_report", True, f"source={dr.get('source')} ok={dr.get('ok')}")
    else:
        add("design_report", True, "optional missing (rules-only ok)")

    title_font_ok = TITLE_FONT.is_file() or TITLE_FALLBACK_FONT.is_file()
    add(
        "title_font",
        title_font_ok,
        f"preferred={'ok' if TITLE_FONT.is_file() else 'missing'} {TITLE_FONT}; "
        f"fallback={'ok' if TITLE_FALLBACK_FONT.is_file() else 'missing'} {TITLE_FALLBACK_FONT}",
    )

    cut = paths.KIT_ASSETS / "cut"
    n_cut = (
        len(list(cut.glob("ch_s*.png"))) + len(list(cut.glob("pr_s*.png")))
        if cut.is_dir()
        else 0
    )
    add("shot_cuts", n_cut >= 1, f"n={n_cut}")

    # 渲染 layout：scene 取样点不得长期空层。
    # 出场 recipe 可能故意晚进，故对照 plan：仅当取样时刻已过该镜最早 enter_at 仍空才判失败。
    layout_path = paths.RENDER_OUT / "layout_check.json"
    plan_path = paths.DESIGN / "plan.json"
    if layout_path.is_file() and plan_path.is_file():
        layout = json.loads(layout_path.read_text(encoding="utf-8"))
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
        timing = (
            json.loads(paths.TTS_TIMING.read_text(encoding="utf-8"))
            if paths.TTS_TIMING.is_file()
            else {}
        )
        sents = timing.get("sentences") or []
        empty_layout = []
        for row in layout:
            if row.get("mode") != "scene":
                continue
            if row.get("layers"):
                continue
            t = float(row.get("t") or 0)
            # 找到所属句子
            si = 0
            for i, s in enumerate(sents):
                if float(s["start"]) <= t < float(s["end"]) + 0.05:
                    si = i
                    break
            shot = (plan.get("shots") or [None])[si] if si < len(plan.get("shots") or []) else None
            layers = (shot or {}).get("layers") or []
            if not layers:
                empty_layout.append(round(t, 2))
                continue
            earliest = min(float(L.get("enter_at") or sents[si]["start"]) for L in layers)
            if t >= earliest + 0.35:
                empty_layout.append(round(t, 2))
        add("layout_no_empty_scene", not empty_layout, f"empty_t={empty_layout}")
    elif layout_path.is_file():
        layout = json.loads(layout_path.read_text(encoding="utf-8"))
        empty_layout = [
            round(float(row.get("t") or 0), 2)
            for row in layout
            if row.get("mode") == "scene" and not (row.get("layers") or [])
        ]
        add("layout_no_empty_scene", not empty_layout, f"empty_t={empty_layout}")
    else:
        add("layout_check", False, "missing layout_check.json")

    # 实际叠轨不得再吃 jingwei_preview / 脏拆轨
    mix_log = paths.RENDER_OUT / "_bgm_mix" / "ffmpeg_bgm.txt"
    if mix_log.is_file():
        log = mix_log.read_text(encoding="utf-8", errors="replace")
        bad_hits = [
            name
            for name in (
                "jingwei_preview",
                "intro_0_25.wav",
                "mid_90_120.wav",
                "end_150_190.wav",
            )
            if name in log
        ]
        good_intro = "Holding Court" in log
        good_mid = "精卫" in log
        good_outro = ("Memories" in log) or ("TRA$H" in log)
        # 短片也必须叠后段硬床（与 bgm_policy 一致）
        need_outro = dur >= 28.0
        add(
            "bgm_mix_uses_prescribed_intro",
            good_intro and not bad_hits,
            f"good={good_intro} bad={bad_hits or '-'}",
        )
        add(
            "bgm_mix_uses_prescribed_mid",
            good_mid and not bad_hits,
            f"mid={good_mid}",
        )
        add(
            "bgm_mix_uses_prescribed_outro",
            (good_outro if need_outro else True) and not bad_hits,
            f"outro={good_outro} need={need_outro}",
        )
    else:
        add("bgm_mix_log", False, "missing ffmpeg_bgm.txt")

    report = {"ok": ok, "checks": checks, "video": str(video), "duration": dur}
    out = paths.RENDER_OUT / "accept_report.json"
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("accept", "PASS" if ok else "FAIL", out)
    for c in checks:
        print(("OK" if c["ok"] else "NG"), c["name"], c["detail"])
    return report


def main():
    rep = accept()
    raise SystemExit(0 if rep["ok"] else 1)


if __name__ == "__main__":
    main()
