"""Load secrets from this module's .env only (never from caller project)."""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = ROOT / ".env"
OUTPUTS = ROOT / "outputs"
JOBS = ROOT / "jobs"

# aliases (lower) → canonical env name
_ALIASES: dict[str, str] = {
    "lec_api_key": "LEC_API_KEY",
    "lec_api_Key": "LEC_API_KEY",
    "Lec_api_Key": "LEC_API_KEY",
    "NEW_API_KEY": "LEC_API_KEY",
    "new_api_key": "LEC_API_KEY",
    "huniu_api_key": "HUNIU_API_KEY",
    "huniuai_api_key": "HUNIU_API_KEY",
    "发布文件路径": "DOUYIN_PUBLISH_INBOX",
}


def load_dotenv(path: Path | None = None) -> dict[str, str]:
    """Parse KEY=value; ignore curl/docs noise; normalize known aliases."""
    path = path or ENV_PATH
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    for raw in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        # skip curl / json example debris
        if line.startswith(("-", "'", '"', "{", "}", "[", "]")) or line.endswith("\\"):
            continue
        k, _, v = line.partition("=")
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if not k or not v:
            continue
        if " " in k or ":" in k:
            continue
        canon = _ALIASES.get(k) or _ALIASES.get(k.lower()) or k
        out[canon] = v
        if canon not in os.environ:
            os.environ[canon] = v
        # also keep original for debugging
        if k != canon and k not in os.environ:
            os.environ[k] = v
    return out


def get(*names: str, default: str = "") -> str:
    load_dotenv()
    for name in names:
        canon = _ALIASES.get(name) or _ALIASES.get(name.lower()) or name
        for key in (canon, name):
            v = (os.environ.get(key) or "").strip()
            if v:
                return v
        # case-insensitive scan
        want = name.lower()
        for ek, ev in os.environ.items():
            if ek.lower() == want and ev.strip():
                return ev.strip()
    return default


def lec_api_key() -> str:
    return get("LEC_API_KEY", "lec_api_key", "lec_api_Key", "Lec_api_Key", "NEW_API_KEY")


def paipu_base() -> str:
    return get("PAIPU_BASE_URL", default="https://api.paipu.net/v1").rstrip("/")


def image_provider(provider: str | None = None) -> str:
    """Default image gateway: huniu | paipu."""
    raw = (provider or get("IMAGE_PROVIDER", default="huniu")).strip().lower()
    if raw in {"paipu", "lec", "tinysnow"}:
        return "paipu"
    return "huniu"


def image_model(provider: str | None = None) -> str:
    prov = image_provider(provider)
    if prov == "paipu":
        return get("PAIPU_IMAGE_MODEL", default="lec-tinysnow-image-2")
    return get("HUNIU_IMAGE_MODEL", default="gpt-image-2")


def image_default_size() -> str:
    return get(
        "HUNIU_IMAGE_SIZE",
        "PAIPU_IMAGE_SIZE",
        "IMAGE_SIZE",
        default="3840x2160",
    )


def default_video_kind() -> str:
    """CLI / API default video kind (grok = huniu)."""
    raw = get("VIDEO_KIND", default="grok").strip().lower() or "grok"
    if raw in {"seedance", "h3", "grok"}:
        return raw
    if raw in {"huniu", "grok15", "grok1.5"}:
        return "grok"
    return "grok"


def huniu_api_key() -> str:
    return get("HUNIU_API_KEY", "huniu_api_key", "huniuai_api_key")


def huniu_base() -> str:
    return get("HUNIU_BASE_URL", default="https://huniuai.com/v1").rstrip("/")


def huniu_video_strategy() -> str:
    """Channel routing: price_first | balanced | performance_first | latency_first."""
    return get("HUNIU_VIDEO_STRATEGY", default="price_first").strip() or "price_first"


def video_provider(kind: str = "seedance") -> str:
    """Which gateway a video kind uses: paipu | huniu."""
    kind = (kind or "seedance").lower()
    if kind in {
        "grok",
        "grok15",
        "grok1.5",
        "grok-1.5",
        "grok1.5pro",
        "grok-1.5-pro",
        "huniu",
    }:
        return "huniu"
    return "paipu"


def video_model(kind: str = "seedance") -> str:
    kind = (kind or "seedance").lower()
    if kind in {"h3", "minimax", "minimax-h3", "minimax_h3"}:
        return get("PAIPU_VIDEO_MODEL_H3", default="lec-minimax-h3-768p")
    if video_provider(kind) == "huniu":
        # 默认 omni_4（固定 10s）；旧多图档可显式 --model grok-imagine-1-5-7tu-special
        return get("HUNIU_VIDEO_MODEL_GROK", default="omni_4")
    return get("PAIPU_VIDEO_MODEL_SEEDANCE", default="lec-ac-seedance-2-5-900")


def huniu_video_duration_default() -> int:
    """虎妞默认提交时长；omni_4 固定 10。"""
    raw = get("HUNIU_VIDEO_DURATION", default="10").strip() or "10"
    try:
        return int(raw)
    except ValueError:
        return 10


def huniu_vision_model() -> str:
    """默认 GM-3.8 Flash → 虎妞模型 ID gemini-3.8-flash。"""
    return get("HUNIU_VISION_MODEL", default="gemini-3.8-flash").strip() or "gemini-3.8-flash"


# 文案 chat：口语 / 短别名 → 虎妞完整模型 ID
_CHAT_ALIASES: dict[str, str] = {
    "gpt6": "gpt-6-astra",
    "gpt-6": "gpt-6-astra",
    "gpt_6": "gpt-6-astra",
    "astra": "gpt-6-astra",
    "gpt-6-astra": "gpt-6-astra",
    "fable5": "claude-fable-5",
    "fable": "claude-fable-5",
    "fable-5": "claude-fable-5",
    "claude-fable-5": "claude-fable-5",
    "fable5.1": "claude-fable-5-1",
    "fable51": "claude-fable-5-1",
    "fable-5.1": "claude-fable-5-1",
    "claude-fable-5-1": "claude-fable-5-1",
}


def default_chat_kind() -> str:
    """默认文案 kind：gpt6 | fable5。"""
    raw = get("CHAT_KIND", "HUNIU_CHAT_KIND", default="gpt6").strip().lower() or "gpt6"
    if raw in {"fable5", "fable", "fable-5"}:
        return "fable5"
    return "gpt6"


def resolve_chat_model_id(raw: str | None) -> str | None:
    """别名或完整 ID → 虎妞模型 ID；空则 None。"""
    s = (raw or "").strip()
    if not s:
        return None
    low = s.lower()
    if low in _CHAT_ALIASES:
        return _CHAT_ALIASES[low]
    return s


def chat_model(*, kind: str | None = None, model: str | None = None) -> tuple[str, str]:
    """返回 (kind, model_id)。--model 优先；否则按 kind / .env 默认。"""
    explicit = resolve_chat_model_id(model)
    if explicit:
        low = explicit.lower()
        if "fable" in low:
            k = "fable5"
        elif "gpt-6" in low or low in {"gpt6", "astra"}:
            k = "gpt6"
        else:
            k = (kind or default_chat_kind()).strip().lower() or "gpt6"
            if k in {"fable", "fable-5"}:
                k = "fable5"
        return k, explicit

    k = (kind or default_chat_kind()).strip().lower() or "gpt6"
    if k in {"fable", "fable-5"}:
        k = "fable5"
    if k == "fable5":
        mid = get("HUNIU_CHAT_MODEL_FABLE5", default="claude-fable-5").strip() or "claude-fable-5"
        return "fable5", resolve_chat_model_id(mid) or mid
    mid = get("HUNIU_CHAT_MODEL", "HUNIU_CHAT_MODEL_GPT6", default="gpt-6-astra").strip() or "gpt-6-astra"
    return "gpt6", resolve_chat_model_id(mid) or mid


def speech() -> dict[str, str]:
    """TTS 默认配置。克隆音优先读 VOLC_SPEECH_CLONE_SPEAKER + seed-icl-2.0。"""
    clone = get("VOLC_SPEECH_CLONE_SPEAKER")
    if clone:
        return {
            "api_key": get("VOLC_SPEECH_API_KEY", "DOUBAO_SPEECH_API_KEY"),
            "resource_id": get(
                "VOLC_SPEECH_CLONE_RESOURCE_ID",
                default="seed-icl-2.0",
            ),
            "speaker": clone,
        }
    speaker = get("VOLC_SPEECH_SPEAKER", default="zh_female_vv_uranus_bigtts")
    rid = get("VOLC_SPEECH_RESOURCE_ID", default="seed-tts-2.0")
    if speaker.startswith("S_") and rid == "seed-tts-2.0":
        rid = "seed-icl-2.0"
    return {
        "api_key": get("VOLC_SPEECH_API_KEY", "DOUBAO_SPEECH_API_KEY"),
        "resource_id": rid,
        "speaker": speaker,
    }


def publish_inbox() -> str:
    return get("DOUYIN_PUBLISH_INBOX", "发布文件路径")


def ensure_dirs() -> None:
    OUTPUTS.mkdir(parents=True, exist_ok=True)
    JOBS.mkdir(parents=True, exist_ok=True)
