"""按 02/bgm_plan.json 把 BGM 叠进成片（人声+已有 sfx 为主，BGM 为床）。"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

KOUBO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(KOUBO))
import paths
from bgm_policy import is_vocal_stem, normalize_bgm_plan, safe_source_name, validate_sources

REF_BGM = paths.REF_BGM


def _ffprobe_dur(path: Path) -> float:
    p = subprocess.run(
        [
            paths.ffprobe_bin(),
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    try:
        return float((p.stdout or "").strip())
    except ValueError:
        return 0.0


def _resolve_source(name: str) -> Path:
    """解析 BGM 路径；含口播拆轨一律改写到无人声源，禁止因文件存在而直通。"""
    safe = safe_source_name(name)
    if is_vocal_stem(safe):
        raise SystemExit(
            f"BGM source still vocal after remap: {name!r} → {safe!r}. "
            f"Update bgm_policy.BGM_SAFE_ALIASES."
        )
    p = Path(safe)
    if p.is_file():
        return p
    cand = REF_BGM / safe
    if cand.is_file():
        return cand
    stem = Path(safe).stem
    for ext in (".wav", ".mp3", ".m4a"):
        c = REF_BGM / f"{stem}{ext}"
        if c.is_file():
            return c
    raise FileNotFoundError(f"BGM source not found: {name} → {safe} under {REF_BGM}")


def _rebuild_default_plan() -> dict:
    """设计产物被清掉时，按 timing 时长重建规定三截 BGM（不改曲目策略）。"""
    sys.path.insert(0, str(paths.DESIGN))
    from llm_briefs import _default_bgm, write_bgm_plan  # noqa: E402

    dur = 60.0
    if paths.TTS_TIMING.is_file():
        timing = json.loads(paths.TTS_TIMING.read_text(encoding="utf-8"))
        sents = timing.get("sentences") or []
        if sents:
            dur = float(sents[-1]["end"])
    elif paths.OUTPUT_VIDEO.is_file():
        dur = _ffprobe_dur(paths.OUTPUT_VIDEO) or dur
    plan = _default_bgm(dur)
    write_bgm_plan(plan)
    # 备份到渲染目录，避免 02 被误清后再次丢失
    backup = paths.RENDER_OUT / "bgm_plan.json"
    backup.write_text(
        json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print("bgm_plan rebuilt →", paths.DESIGN / "bgm_plan.json", "dur", round(dur, 2))
    return plan


def load_plan(path: Path | None = None) -> dict:
    candidates = [
        path,
        paths.DESIGN / "bgm_plan.json",
        paths.RENDER_OUT / "bgm_plan.json",
    ]
    for cand in candidates:
        if cand is None or not Path(cand).is_file():
            continue
        data = json.loads(Path(cand).read_text(encoding="utf-8"))
        return normalize_bgm_plan(data)
    # 从 plan.json 取
    plan = paths.DESIGN_PLAN
    if plan.is_file():
        data = json.loads(plan.read_text(encoding="utf-8"))
        if isinstance(data.get("bgm"), dict):
            return normalize_bgm_plan(data["bgm"])
    return normalize_bgm_plan(_rebuild_default_plan())


def mix(
    video: Path | None = None,
    *,
    plan: dict | None = None,
    out: Path | None = None,
    voice_weight: float = 1.8,
) -> Path:
    """叠 BGM：永远只从「无 BGM」源叠一次。

    管线约定：
    - render 写出含口播的成片后，首次 mix 前冻结为 `成片_无BGM前.mp4`
    - 之后任何重混都只读该备份，禁止用已叠过 BGM 的成片当输入（防 Holding Court 残留）
    - 禁止用叠完后的成片回写污染 bare
    """
    out = out or paths.OUTPUT_VIDEO
    bare = paths.RENDER_OUT / "成片_无BGM前.mp4"

    if video is not None:
        src = Path(video)
    elif bare.is_file():
        src = bare
    elif out.is_file():
        # 首次：把当前成片（应为 render 直出）冻结为无 BGM 备份
        bare.write_bytes(out.read_bytes())
        src = bare
        print("bgm_freeze_bare", bare)
    else:
        raise SystemExit(f"缺少成片：{out}")

    if not src.is_file():
        raise SystemExit(f"缺少成片：{src}")
    # 显式传入成片.mp4 且已有 bare → 强制改用 bare，杜绝二次叠床
    if bare.is_file() and src.resolve() == out.resolve() and src.resolve() != bare.resolve():
        print("bgm_refuse_remixed_input → use bare", bare.name)
        src = bare

    video = src
    plan = normalize_bgm_plan(plan or load_plan())
    bad = validate_sources(plan)
    if bad:
        raise SystemExit("BGM plan blocked: " + "; ".join(bad))
    duration = _ffprobe_dur(video) or float(plan.get("duration") or 0) or 60.0
    work = paths.RENDER_OUT / "_bgm_mix"
    work.mkdir(parents=True, exist_ok=True)

    segs = list(plan.get("segments") or [])
    if not segs:
        raise SystemExit("bgm_plan.segments empty")

    # 输入：0=成片(含口播+sfx)，其后为各 BGM 源
    inputs = ["-i", str(video)]
    src_paths: list[Path] = []
    for seg in segs:
        sp = _resolve_source(str(seg["source"]))
        # 二次保险：解析后的真实文件名也不得是禁轨
        if is_vocal_stem(sp.name):
            raise SystemExit(f"refused vocal BGM file on disk: {sp.name}")
        src_paths.append(sp)
        inputs += ["-i", str(sp)]

    filters: list[str] = []
    labels: list[str] = []
    for i, seg in enumerate(segs):
        inp = i + 1
        start = float(seg.get("start") or 0)
        end = float(seg.get("end") or duration)
        span = max(0.2, end - start)
        trim_start = float(seg.get("trim_start") or 0)
        trim_dur = seg.get("trim_dur")
        if trim_dur is None:
            trim_dur = span + 1.0
        else:
            trim_dur = float(trim_dur)
        vol = float(seg.get("volume") or 0.3)
        fade_in = float(seg.get("fade_in") or 0.5)
        fade_out = float(seg.get("fade_out") or 1.5)
        fade_out_st = max(0.0, float(trim_dur) - fade_out)
        lab = f"b{i}"
        loop = bool(seg.get("loop"))
        # 源短于时段时：aloop 铺满再裁；否则直接 atrim
        if loop:
            # 先整段规范化，再循环到够长，再取 trim 窗
            chain = (
                f"[{inp}:a]aformat=sample_rates=48000:channel_layouts=stereo,"
                f"aloop=loop=-1:size=2000000000,asetpts=PTS-STARTPTS,"
                f"atrim=0:{float(trim_dur):.3f},asetpts=PTS-STARTPTS,"
            )
        else:
            chain = (
                f"[{inp}:a]aformat=sample_rates=48000:channel_layouts=stereo,"
                f"atrim={trim_start}:{trim_start + float(trim_dur)},asetpts=PTS-STARTPTS,"
            )
        filters.append(
            chain
            + f"afade=t=in:st=0:d={fade_in},afade=t=out:st={fade_out_st}:d={fade_out},"
            f"volume={vol},adelay={int(start * 1000)}|{int(start * 1000)},"
            f"apad=whole_dur={duration:.3f},atrim=0:{duration:.3f},asetpts=PTS-STARTPTS[{lab}]"
        )
        labels.append(f"[{lab}]")

    n = 1 + len(labels)
    weights = f"{voice_weight} " + " ".join("1" for _ in labels)
    filters.append(f"[0:a]aformat=sample_rates=48000:channel_layouts=stereo[nar]")
    filters.append(
        f"[nar]{''.join(labels)}amix=inputs={n}:duration=first:dropout_transition=0:"
        f"normalize=0:weights={weights}[aout]"
    )
    fc = ";\n".join(filters)
    fc_path = paths.RENDER_OUT / "_bgm_fc.txt"
    fc_path.write_text(fc + "\n", encoding="utf-8")

    tmp = work / "with_bgm.mp4"
    bed = paths.RENDER_OUT / "bgm_bed.wav"
    # 成片混音（口播+BGM）—— 不在同一次命令里抽 bed：Windows ffmpeg 双 map 曾把口播放大当 bed
    cmd = [
        paths.ffmpeg_bin(),
        "-y",
        *inputs,
        "-filter_complex",
        fc,
        "-map", "0:v", "-map", "[aout]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest",
        str(tmp),
    ]
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    (work / "ffmpeg_bgm.txt").write_text((p.stderr or "")[-8000:], encoding="utf-8")
    if p.returncode != 0 or not tmp.is_file():
        raise SystemExit(f"BGM mix failed; see {work / 'ffmpeg_bgm.txt'}")

    # 纯 BGM 床轨：第二次只喂 BGM 源，绝不碰成片音轨
    bed_inputs: list[str] = []
    bed_filters: list[str] = []
    bed_labels: list[str] = []
    for i, seg in enumerate(segs):
        sp = src_paths[i]
        bed_inputs += ["-i", str(sp)]
        start = float(seg.get("start") or 0)
        end = float(seg.get("end") or duration)
        span = max(0.2, end - start)
        trim_start = float(seg.get("trim_start") or 0)
        trim_dur = seg.get("trim_dur")
        trim_dur = float(span + 1.0 if trim_dur is None else trim_dur)
        vol = float(seg.get("volume") or 0.3)
        fade_in = float(seg.get("fade_in") or 0.5)
        fade_out = float(seg.get("fade_out") or 1.5)
        fade_out_st = max(0.0, trim_dur - fade_out)
        lab = f"bb{i}"
        if bool(seg.get("loop")):
            chain = (
                f"[{i}:a]aformat=sample_rates=48000:channel_layouts=stereo,"
                f"aloop=loop=-1:size=2000000000,asetpts=PTS-STARTPTS,"
                f"atrim=0:{trim_dur:.3f},asetpts=PTS-STARTPTS,"
            )
        else:
            chain = (
                f"[{i}:a]aformat=sample_rates=48000:channel_layouts=stereo,"
                f"atrim={trim_start}:{trim_start + trim_dur},asetpts=PTS-STARTPTS,"
            )
        bed_filters.append(
            chain
            + f"afade=t=in:st=0:d={fade_in},afade=t=out:st={fade_out_st}:d={fade_out},"
            f"volume={vol},adelay={int(start * 1000)}|{int(start * 1000)},"
            f"apad=whole_dur={duration:.3f},atrim=0:{duration:.3f},asetpts=PTS-STARTPTS[{lab}]"
        )
        bed_labels.append(f"[{lab}]")
    if len(bed_labels) == 1:
        bed_filters.append(f"{bed_labels[0]}anull[bgm]")
    else:
        bed_filters.append(
            f"{''.join(bed_labels)}amix=inputs={len(bed_labels)}:duration=longest:"
            f"dropout_transition=0:normalize=0[bgm]"
        )
    bed_fc = ";\n".join(bed_filters)
    (paths.RENDER_OUT / "_bgm_bed_fc.txt").write_text(bed_fc + "\n", encoding="utf-8")
    bed_cmd = [
        paths.ffmpeg_bin(), "-y", *bed_inputs,
        "-filter_complex", bed_fc,
        "-map", "[bgm]", "-c:a", "pcm_s16le", str(bed),
    ]
    pb = subprocess.run(bed_cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    (work / "ffmpeg_bgm_bed.txt").write_text((pb.stderr or "")[-8000:], encoding="utf-8")
    if pb.returncode != 0 or not bed.is_file():
        raise SystemExit(f"BGM bed failed; see {work / 'ffmpeg_bgm_bed.txt'}")

    # 只写最终成片；绝不回写 bare（bare 只在上方「首次冻结」时创建）
    out.write_bytes(tmp.read_bytes())
    print("bgm_mixed", out, "segs", len(segs), "dur", round(duration, 2), "from", video.name, "bed", bed.is_file())
    for seg in segs:
        print("  seg", seg.get("id"), "→", seg.get("source"), f"{seg.get('start')}-{seg.get('end')}")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", type=Path, default=None)
    ap.add_argument("--plan", type=Path, default=None)
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()
    paths.ensure()
    plan = load_plan(args.plan) if args.plan or (paths.DESIGN / "bgm_plan.json").is_file() else load_plan()
    mix(args.video, plan=plan, out=args.out)


if __name__ == "__main__":
    main()
