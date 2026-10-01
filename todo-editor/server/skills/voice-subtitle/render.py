#!/usr/bin/env python3
"""字幕渲染端（todo-skill-render/1 · subtitle 管线）。

mode=script：文案 + 配音的 TTS 逐字时间戳；mode=asr：没有文案，用 burn-subtitles 的 ASR 识别逐字文本和时间（转简体、按停顿补标点）；
mode=cues：同 script，但只输出对好时的字幕条 JSON，不编码视频。
→ burn-subtitles（气口切窗 + 关键词 ASS）→ 透明画布硬烧 → VP9 alpha WebM（不带音频）。
切条 / 对齐 / 识别只调用 burn-subtitles 本体，位置由 BURN_SUBTITLES_DIR 指定。

stdout 协议：@progress {"phase","pct"} / @result {...} / @error {"message"}；其余行都是日志。
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import traceback
from pathlib import Path

BURN_SUBTITLES_DIR = Path(os.environ.get(
    "BURN_SUBTITLES_DIR",
    str(Path.home() / ".cursor" / "skills" / "burn-subtitles" / "scripts"),
))

# 字号按画面短边 1080 换算、底边距按画面高度百分比，横竖屏观感一致
# v2.0 的档位参数（fontSize / position）仍认，重试旧任务时用
LEGACY_FONT_SCALE = {"s": 0.04, "m": 0.05, "l": 0.062}
LEGACY_MARGIN_SCALE = {"bottom": 0.06, "raised": 0.16}
_WIN_FONTS = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"
_USER_FONTS = Path.home() / "AppData" / "Local" / "Microsoft" / "Windows" / "Fonts"


def _smiley_font() -> tuple[Path, str]:
    """得意黑：用户字体 / 环境变量 / 应用 public/fonts。"""
    cands: list[Path | None] = [
        Path(os.environ["SUB_FONT_FILE"]) if os.environ.get("SUB_FONT_FILE") else None,
        _USER_FONTS / "SmileySans-Oblique.otf",
        _WIN_FONTS / "SmileySans-Oblique.otf",
    ]
    try:
        cands.insert(2, Path(__file__).resolve().parents[3] / "public" / "fonts" / "SmileySans-Oblique.otf")
    except Exception:
        pass
    for p in cands:
        if p and p.exists():
            return p, "Smiley Sans Oblique"
    return _USER_FONTS / "SmileySans-Oblique.otf", "Smiley Sans Oblique"


# 字体 key → (文件, ASS Fontname)；smiley 必须显式 set_font，避免进程内残留上一任务的字体
FONTS = {
    "smiley": _smiley_font(),
    "yahei": (_WIN_FONTS / "msyhbd.ttc", "Microsoft YaHei"),
    "heiti": (_WIN_FONTS / "simhei.ttf", "SimHei"),
    "kaiti": (_WIN_FONTS / "simkai.ttf", "KaiTi"),
    "xingkai": (_WIN_FONTS / "STXINGKA.TTF", "STXingkai"),
    "lishu": (_WIN_FONTS / "SIMLI.TTF", "LiSu"),
    "hupo": (_WIN_FONTS / "STHUPO.TTF", "STHupo"),
}


def font_px(p: dict, W: int, H: int) -> int:
    if p.get("fontPx") is not None:
        return max(16, round(min(W, H) * float(p["fontPx"]) / 1080))
    return max(16, round(min(W, H) * LEGACY_FONT_SCALE.get(str(p.get("fontSize", "m")), 0.05)))


def margin_px(p: dict, H: int) -> int:
    if p.get("bottomPct") is not None:
        return round(H * float(p["bottomPct"]) / 100)
    return round(H * LEGACY_MARGIN_SCALE.get(str(p.get("position", "bottom")), 0.06))


CRF = 28
# 识别结果按字间停顿（秒）补标点
ASR_COMMA_GAP = 0.35
ASR_PERIOD_GAP = 0.8


def emit(tag: str, payload: dict) -> None:
    print(f"@{tag} {json.dumps(payload, ensure_ascii=False)}", flush=True)


def progress(phase: str, pct: float) -> None:
    emit("progress", {"phase": phase, "pct": round(max(0.0, min(1.0, pct)), 3)})


def log(msg: str) -> None:
    print(msg, flush=True)


def load_burner():
    if not (BURN_SUBTITLES_DIR / "burn_subtitles.py").exists():
        raise FileNotFoundError(f"找不到 burn-subtitles（{BURN_SUBTITLES_DIR}，可设 BURN_SUBTITLES_DIR）")
    sys.path.insert(0, str(BURN_SUBTITLES_DIR))
    import burn_subtitles as bs  # noqa: E402

    return bs


def retime_tts(timing: dict, audio: Path) -> None:
    """老配音的 timing 可能是修复前生成的（时长偏短、尾句压扁），用 TTS_timeline 自己的校正在内存里修一遍"""
    root = Path(os.environ.get("TTS_TIMELINE_ROOT", r"d:\video_Tools\TTS_timeline"))
    if not (root / "tts_timeline" / "retime.py").exists():
        log(f"找不到 TTS_timeline 的尾句校正（{root}），按原时间戳对时")
        return
    sys.path.insert(0, str(root))
    from tts_timeline.retime import retime  # noqa: E402

    try:
        retime(timing, audio)
    except Exception as e:  # noqa: BLE001
        log(f"尾句校正跳过：{e}")


def to_simplified(chars: list[tuple[str, float, float]]) -> list[tuple[str, float, float]]:
    """Whisper 中文常出繁体；有 zhconv 就转简体，没有就原样"""
    try:
        import warnings

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            from zhconv import convert
    except ImportError:
        log("未安装 zhconv，识别结果保持原样（可能是繁体）")
        return chars
    whole = convert("".join(c for c, _, _ in chars), "zh-cn")
    if len(whole) == sum(len(c) for c, _, _ in chars):
        out, i = [], 0
        for c, a, b in chars:
            out.append((whole[i:i + len(c)], a, b))
            i += len(c)
        return out
    return [(convert(c, "zh-cn"), a, b) for c, a, b in chars]


def asr_script(chars: list[tuple[str, float, float]]) -> str:
    """识别结果没有标点：按字间停顿补逗号 / 句号，给切条当气口"""
    parts: list[str] = []
    for i, (c, a, _) in enumerate(chars):
        if i:
            gap = a - chars[i - 1][2]
            if gap >= ASR_PERIOD_GAP:
                parts.append("。")
            elif gap >= ASR_COMMA_GAP:
                parts.append("，")
        parts.append(c)
    return "".join(parts) + "。"


def filter_path(p: Path) -> str:
    return p.resolve().as_posix().replace(":", "\\:")


def encode(cmd: list[str], duration: float) -> None:
    """跑 ffmpeg 并把 -progress 的 out_time 折成进度"""
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")
    assert proc.stdout is not None
    for line in proc.stdout:
        if line.startswith("out_time_us="):
            try:
                progress("编码", int(line.split("=", 1)[1]) / 1e6 / duration)
            except ValueError:
                pass
    err = proc.stderr.read() if proc.stderr else ""
    if proc.wait() != 0:
        raise RuntimeError(f"ffmpeg 编码失败: {err[-400:]}")


def render(req: dict) -> dict:
    p = req["params"]
    W, H = (int(v) for v in str(p["size"]).split("x"))
    fps = int(p.get("fps", 30))
    out_dir = Path(req["outDir"])
    outputs = req["outputs"]
    prefix = str(outputs["prefix"])
    ffmpeg = req.get("ffmpeg") or "ffmpeg"
    asr = req.get("mode") == "asr"
    script = str(req.get("script") or "").strip()
    audio = Path(req["audio"])
    if not audio.exists():
        raise FileNotFoundError(f"读不到音频: {audio}")
    timing = None
    if not asr:
        if not script:
            raise ValueError("文案为空")
        timing_file = Path(req["timing"])
        if not timing_file.exists():
            raise FileNotFoundError(f"读不到配音时间戳: {timing_file}")
        timing = json.loads(timing_file.read_text(encoding="utf-8"))
    work = out_dir / f"{prefix}_work"
    work.mkdir(parents=True, exist_ok=True)

    bs = load_burner()
    font_key = str(p.get("font") or "smiley")
    font = FONTS.get(font_key) or FONTS["smiley"]
    if not font[0].exists():
        raise FileNotFoundError(
            f"找不到字体文件 {font[0]}（选「{font_key}」）。"
            f"得意黑请安装 SmileySans-Oblique.otf 到用户字体目录，或设 SUB_FONT_FILE。"
        )
    bs.set_font(font[0], font[1])
    log(f"字幕字体：{font[1]} ← {font[0]}")
    fs = font_px(p, W, H)
    bs.apply_options(bs.BurnOptions(
        band_h=0,
        font_size=fs,
        outline=max(2, round(fs / 18)),
        margin_v=margin_px(p, H),
        max_chars=int(p.get("maxChars", 18)),
        no_keywords=p.get("keywords") == "off",
    ))

    # 1. 对时：有文案时正文只用文案、时间取 TTS 逐字时间戳；没有文案就语音识别出逐字文本和时间。静音段只用来判断气口
    if asr:
        progress("语音识别", 0.02)
        wav = work / "asr.wav"
        subprocess.run([
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(audio), "-vn", "-ac", "1", "-ar", "16000", str(wav),
        ], check=True, capture_output=True)
        chars = to_simplified(bs.asr_char_timeline(wav, work))
        if not chars:
            raise RuntimeError("没有识别出语音，这段音频可能是纯音乐或静音")
        script = asr_script(chars)
        audio_dur = bs.ffprobe_duration(wav)
        silences = bs.detect_silences(wav, work)
        progress("语音识别", 1.0)
    else:
        progress("字幕对时", 0.05)
        retime_tts(timing, audio)
        chars = [(str(c["text"]), float(c["start"]), float(c["end"])) for c in timing.get("chars") or []]
        audio_dur = float(timing.get("duration") or 0) or bs.ffprobe_duration(audio)
        silences = bs.detect_silences(audio, work)
        # TTS 逐字时间戳和文案同源，直接逐字对齐；burn-subtitles 按气口分窗重分文案、把末尾十几个字拉到音频尾，
        # 是给 ASR 纠偏用的，用在 TTS 上反而会让后半段和尾句漂移
        bs.align_chars_to_times_smart = lambda narr, asr, dur, _silences=None: bs.align_chars_to_times(narr, asr, dur)
    events = bs.align_chunks(script, chars, audio_dur, silences)
    no_kw = bs.NO_KEYWORDS or bs.MAX_KEYWORDS_PER_CUE <= 0
    cues = [
        bs.Cue(text=t, start=a, end=b, keywords=[] if no_kw else bs.pick_keywords(t), style_idx=i)
        for i, (a, b, t) in enumerate(events)
    ]
    if not cues:
        raise RuntimeError("没有切出任何字幕")
    progress("字幕对时", 1.0)
    duration = round(max(audio_dur, cues[-1].end), 3)

    ass = out_dir / str(outputs.get("ass") or f"{prefix}.ass")
    bs.write_ass(cues, ass, W, H, band_h=0, font_size=fs)
    subs_name = str(outputs.get("subtitles") or f"{prefix}_subtitles.json")
    (out_dir / subs_name).write_text(json.dumps(
        [{"text": c.text, "start": round(c.start, 3), "end": round(c.end, 3), "keywords": c.keywords} for c in cues],
        ensure_ascii=False, indent=2,
    ), encoding="utf-8")

    # mode=cues：只要对好时的字幕条（成片宿主做成编辑器里可改的文字片段），不烧录
    if req.get("mode") == "cues":
        if not req.get("keepWork"):
            shutil.rmtree(work, ignore_errors=True)
        return {
            "subtitles": subs_name, "ass": ass.name, "width": W, "height": H, "fps": fps,
            "duration": duration, "cues": len(cues), "font": bs.FONT, "fontSize": fs, "text": script,
        }

    # 2. 透明画布硬烧：libass 直接画进 alpha，VP9 保留透明通道；配音在时间轴上单独一轨，这里不带音频
    subs_vf = f"ass='{filter_path(ass)}:fontsdir={filter_path(bs.FONTS_DIR)}:alpha=1'"
    canvas = f"color=c=black@0.0:s={W}x{H}:r={fps}:d={duration},format=rgba"
    video_name = str(outputs.get("video") or f"{prefix}.webm")
    encode([
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1",
        "-f", "lavfi", "-i", canvas,
        "-vf", f"{subs_vf},format=yuva420p", "-t", f"{duration}",
        "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", str(CRF),
        "-row-mt", "1", "-deadline", "good", "-cpu-used", "4", "-auto-alt-ref", "0",
        "-an", str(out_dir / video_name),
    ], duration)
    progress("编码", 1.0)

    # 3. 静帧：取前几条里最长那条的中点，透明 PNG
    pick = max(cues[:5], key=lambda c: len(c.text))
    at = round((pick.start + pick.end) / 2, 3)
    still_name = str(outputs.get("still") or f"{prefix}_still.png")
    subprocess.run([
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", f"color=c=black@0.0:s={W}x{H}:r={fps}:d={at + 0.2},format=rgba",
        "-vf", subs_vf, "-ss", f"{at}", "-frames:v", "1", str(out_dir / still_name),
    ], check=True, capture_output=True)

    if not req.get("keepWork"):
        shutil.rmtree(work, ignore_errors=True)
    return {
        "video": video_name,
        "still": still_name,
        "subtitles": subs_name,
        "ass": ass.name,
        "alpha": True,
        "audio": False,
        "width": W,
        "height": H,
        "fps": fps,
        "frames": round(duration * fps),
        "duration": duration,
        "cues": len(cues),
        "font": bs.FONT,
        "fontSize": fs,
        "audioDuration": round(audio_dur, 3),
        "text": script,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="口播字幕渲染端（todo-skill-render/1）")
    ap.add_argument("--request", type=Path, required=True)
    ns = ap.parse_args()
    try:
        req = json.loads(ns.request.read_text(encoding="utf-8"))
        emit("result", render(req))
        return 0
    except Exception as e:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        emit("error", {"message": f"{e.__class__.__name__}: {e}"})
        return 1


if __name__ == "__main__":
    sys.exit(main())
