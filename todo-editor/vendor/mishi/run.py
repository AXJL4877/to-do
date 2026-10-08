#!/usr/bin/env python3
"""密匙 toolkit CLI — 生图 / 生视频 / 配音 / 视觉 / 文案（密钥只读本目录 .env）

对外契约：同目录 CONTRACT.md
stdout：仅一行 JSON（ok / mode / file / error …）
stderr：轮询进度等人话（job: processing …）——脚本只解析 stdout，勿把 stderr 拼进 JSON。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from media import env as menv  # noqa: E402
from media import cleanup as cleanup_mod  # noqa: E402
from media import chat as chat_mod  # noqa: E402
from media import host as host_mod  # noqa: E402
from media import image as image_mod  # noqa: E402
from media import tts as tts_mod  # noqa: E402
from media import video as video_mod  # noqa: E402
from media import vision as vision_mod  # noqa: E402
from media import key_bg as key_bg_mod  # noqa: E402


def _emit(obj: dict) -> int:
    """Machine-readable result: exactly one JSON object on stdout."""
    print(json.dumps(obj, ensure_ascii=False), flush=True)
    return 0 if obj.get("ok") else 1


def cmd_check(_: argparse.Namespace) -> int:
    menv.load_dotenv()
    lec = bool(menv.lec_api_key())
    huniu = bool(menv.huniu_api_key())
    sp = menv.speech()
    tts = bool(sp["api_key"])
    inbox = menv.publish_inbox()
    return _emit(
        {
            "ok": huniu and tts,
            "mode": "check",
            "root": str(ROOT),
            "env": str(menv.ENV_PATH),
            "keys": {
                "LEC_API_KEY": lec,
                "HUNIU_API_KEY": huniu,
                "VOLC_SPEECH_API_KEY": tts,
                "VOLC_SPEECH_RESOURCE_ID": sp["resource_id"],
                "VOLC_SPEECH_SPEAKER": sp["speaker"],
                "DOUYIN_PUBLISH_INBOX": bool(inbox),
            },
            "defaults": {
                "image_provider": menv.image_provider(),
                "video_kind": menv.default_video_kind(),
                "chat_kind": menv.default_chat_kind(),
            },
            "models": {
                "image": menv.image_model(),
                "image_paipu": menv.image_model("paipu"),
                "video_seedance": menv.video_model("seedance"),
                "video_h3": menv.video_model("h3"),
                "video_grok": menv.video_model("grok"),
                "vision": menv.huniu_vision_model(),
                "chat_gpt6": menv.chat_model(kind="gpt6")[1],
                "chat_fable5": menv.chat_model(kind="fable5")[1],
            },
            "huniu": {
                "base": menv.huniu_base(),
                "strategy": menv.huniu_video_strategy(),
            },
            "publish_inbox": inbox or None,
        }
    )


def cmd_image(ns: argparse.Namespace) -> int:
    try:
        if ns.run_job:
            result = image_mod.run_job(ns.run_job)
            return _emit(result)
        if ns.poll:
            result = image_mod.wait(ns.poll, out=Path(ns.out) if ns.out else None)
            return _emit(result)
        result = image_mod.generate(
            ns.prompt,
            out=Path(ns.out) if ns.out else None,
            images=ns.image or None,
            model=ns.model,
            size=ns.size,
            quality=ns.quality,
            name=ns.name,
            wait_done=not ns.no_wait,
            provider=ns.provider,
            transparent=bool(ns.transparent),
        )
        return _emit(result)
    except Exception as e:
        return _emit({"ok": False, "mode": "image", "error": str(e)})


def cmd_video(ns: argparse.Namespace) -> int:
    try:
        if ns.poll:
            result = video_mod.wait(ns.poll, out=Path(ns.out) if ns.out else None)
            return _emit(result)
        result = video_mod.generate(
            ns.prompt,
            name=ns.name,
            kind=ns.kind,
            model=ns.model,
            aspect_ratio=ns.aspect,
            duration=ns.duration,
            images=ns.image or None,
            audios=ns.audio or None,
            wait_done=not ns.no_wait,
            out=Path(ns.out) if ns.out else None,
        )
        return _emit(result)
    except Exception as e:
        return _emit({"ok": False, "mode": "video", "error": str(e)})


def cmd_host(ns: argparse.Namespace) -> int:
    try:
        result = host_mod.upload(Path(ns.file), repo_path=ns.path)
        return _emit(result)
    except Exception as e:
        return _emit({"ok": False, "mode": "host", "error": str(e)})


def cmd_tts(ns: argparse.Namespace) -> int:
    try:
        result = tts_mod.synthesize(
            ns.prompt,
            out=Path(ns.out) if ns.out else None,
            speaker=ns.speaker,
            resource_id=ns.resource_id,
            format=ns.format,
            sample_rate=ns.sample_rate,
            enable_subtitle=bool(ns.subtitle or ns.timing),
            timing_out=Path(ns.timing) if ns.timing else None,
        )
        # CLI 契约：stdout 一行 JSON；原始 sentence 可能很大，默认不塞全文
        slim = {k: v for k, v in result.items() if k != "sentences_raw"}
        if not ns.include_raw_sentences:
            slim.pop("sentences_raw", None)
        return _emit(slim)
    except Exception as e:
        return _emit({"ok": False, "mode": "tts", "error": str(e)})


def cmd_vision(ns: argparse.Namespace) -> int:
    try:
        result = vision_mod.analyze(
            ns.prompt,
            images=ns.image or None,
            model=ns.model,
            max_tokens=ns.max_tokens,
            system=ns.system,
        )
        return _emit(result)
    except Exception as e:
        return _emit({"ok": False, "mode": "vision", "error": str(e)})


def cmd_chat(ns: argparse.Namespace) -> int:
    try:
        result = chat_mod.generate(
            ns.prompt,
            kind=ns.kind,
            model=ns.model,
            system=ns.system,
            max_tokens=ns.max_tokens,
            temperature=ns.temperature,
            out=Path(ns.out) if ns.out else None,
        )
        return _emit(result)
    except Exception as e:
        return _emit({"ok": False, "mode": "chat", "error": str(e)})


def cmd_clean(_: argparse.Namespace) -> int:
    """Wipe jobs/ outputs/ and legacy out|refs|root smoke media."""
    try:
        return _emit(cleanup_mod.wipe_ephemeral())
    except Exception as e:
        return _emit({"ok": False, "mode": "clean", "error": str(e)})


def cmd_key_bg(ns: argparse.Namespace) -> int:
    """Edge-flood solid-bg key → RGBA. Interior same-color stays if not border-connected."""
    try:
        bg = key_bg_mod.parse_rgb(ns.bg)
        path = key_bg_mod.key_file(
            ns.file,
            ns.out or ns.file,
            bg=bg,
            thresh=int(ns.thresh),
            soft=int(ns.soft),
        )
        return _emit(
            {
                "ok": True,
                "mode": "key-bg",
                "file": str(path),
                "bg": list(bg),
                "thresh": int(ns.thresh),
                "soft": int(ns.soft),
            }
        )
    except Exception as e:
        return _emit({"ok": False, "mode": "key-bg", "error": str(e)})


def main() -> int:
    p = argparse.ArgumentParser(description="桌面密匙工具模块：生图/生视频/配音/视觉")
    sub = p.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("check", help="检查密钥与默认模型（不花钱）")
    c.set_defaults(func=cmd_check)

    g = sub.add_parser("image", help="生图（默认虎妞 gpt-image-2 4K；可 --provider paipu）")
    g.add_argument("--prompt", default="")
    g.add_argument("--out")
    g.add_argument("--model")
    g.add_argument("--size", default=None, help="默认 3840x2160（可用 .env HUNIU_IMAGE_SIZE）")
    g.add_argument("--quality", default="low", help="仅派谱 TinySnow 用")
    g.add_argument(
        "--transparent",
        action="store_true",
        help="透明底 PNG：虎妞请求 background=transparent + output_format=png（原生 alpha，不要纯色底再抠）",
    )
    g.add_argument(
        "--provider",
        default=None,
        choices=["huniu", "paipu"],
        help="默认 huniu；派谱 TinySnow 用 --provider paipu",
    )
    g.add_argument("--image", action="append", help="参考图 URL 或 data URL，可多次")
    g.add_argument("--name", help="任务名；同名只提交一次")
    g.add_argument("--no-wait", action="store_true", help="本机后台跑，立刻返回，稍后 --poll")
    g.add_argument("--poll", help="按已有生图任务名等待完成")
    g.add_argument("--run-job", help=argparse.SUPPRESS)
    g.set_defaults(func=cmd_image)

    v = sub.add_parser("video", help="生视频（默认 grok=虎妞；seedance/h3=派谱）")
    v.add_argument("--prompt", default="")
    v.add_argument("--name", help="任务名；同名只提交一次")
    v.add_argument(
        "--kind",
        default=None,
        choices=["seedance", "h3", "grok"],
        help="默认 grok（虎妞）；seedance|h3 → 派谱",
    )
    v.add_argument("--model")
    v.add_argument("--aspect", default="16:9")
    v.add_argument("--duration", type=int)
    v.add_argument("--image", action="append")
    v.add_argument("--audio", action="append")
    v.add_argument("--out")
    v.add_argument("--no-wait", action="store_true", help="只提交不轮询")
    v.add_argument("--poll", help="按已有任务名轮询下载")
    v.set_defaults(func=cmd_video)

    t = sub.add_parser("tts", help="火山配音（可开字幕时间戳）")
    t.add_argument("--prompt", required=True)
    t.add_argument("--out")
    t.add_argument("--speaker")
    t.add_argument("--resource-id")
    t.add_argument("--format", default="mp3", help="mp3|wav|pcm|ogg_opus，默认 mp3")
    t.add_argument("--sample-rate", type=int, default=24000)
    t.add_argument("--subtitle", action="store_true", help="TTS2.0 enable_subtitle，返回 words")
    t.add_argument("--timing", help="把原始 words/sentences 写成 JSON 路径")
    t.add_argument(
        "--include-raw-sentences",
        action="store_true",
        help="stdout JSON 里保留 sentences_raw（默认去掉以保持一行精简）",
    )
    t.set_defaults(func=cmd_tts)

    h = sub.add_parser("host", help="本地图/音频上传到公网 HTTPS（fuli-paipu-frames）")
    h.add_argument("--file", required=True, help="本地文件路径")
    h.add_argument(
        "--path",
        required=True,
        help="仓库内路径，如 mishi-smoke/foo/ref.png",
    )
    h.set_defaults(func=cmd_host)

    vis = sub.add_parser("vision", help="视觉理解（默认虎妞 gemini-3.8-flash / GM-3.8 Flash）")
    vis.add_argument("--prompt", required=True, help="对图的问题 / 指令")
    vis.add_argument("--image", action="append", help="本地路径或 https URL，可多次")
    vis.add_argument("--model", default=None, help="默认 HUNIU_VISION_MODEL=gemini-3.8-flash")
    vis.add_argument("--system", default=None, help="可选 system prompt")
    vis.add_argument("--max-tokens", type=int, default=2048)
    vis.set_defaults(func=cmd_vision)

    ch = sub.add_parser("chat", help="文案 / 纯文本（默认 GPT-6 Astra；--kind fable5 → Claude Fable5）")
    ch.add_argument("--prompt", required=True, help="文案指令 / 用户消息")
    ch.add_argument(
        "--kind",
        default=None,
        choices=["gpt6", "fable5"],
        help="默认 gpt6（.env CHAT_KIND）；fable5 → claude-fable-5",
    )
    ch.add_argument(
        "--model",
        default=None,
        help="完整模型 ID 或别名 gpt6/fable5/fable5.1；覆盖 --kind",
    )
    ch.add_argument("--system", default=None, help="可选 system prompt")
    ch.add_argument("--max-tokens", type=int, default=4096)
    ch.add_argument("--temperature", type=float, default=None)
    ch.add_argument("--out", help="把正文写入文件（业务项目路径）")
    ch.set_defaults(func=cmd_chat)

    cl = sub.add_parser("clean", help="清空 jobs/outputs 与遗留 out|refs|根目录烟测媒体")
    cl.set_defaults(func=cmd_clean)

    kb = sub.add_parser(
        "key-bg",
        help="纯色底边缘连通抠图→RGBA（只抠与边框连通的底色，不抠主体内部同色）",
    )
    kb.add_argument("--file", required=True, help="输入图（白底/灰底 RGB 或 RGBA）")
    kb.add_argument("--out", help="输出路径，默认覆盖 --file")
    kb.add_argument("--bg", default="255,255,255", help="底色 R,G,B，默认纯白")
    kb.add_argument("--thresh", type=int, default=28, help="与底色的通道差阈值")
    kb.add_argument("--soft", type=int, default=18, help="边缘软化宽度（色差）")
    kb.set_defaults(func=cmd_key_bg)

    ns = p.parse_args()
    if ns.cmd == "image" and not ns.poll and not ns.run_job and not ns.prompt:
        return _emit({"ok": False, "mode": "image", "error": "need --prompt or --poll"})
    if ns.cmd == "video" and not ns.poll and not ns.prompt:
        return _emit({"ok": False, "mode": "video", "error": "need --prompt or --poll"})
    if ns.cmd == "vision" and not ns.image:
        return _emit({"ok": False, "mode": "vision", "error": "need at least one --image"})
    return int(ns.func(ns))


if __name__ == "__main__":
    raise SystemExit(main())
