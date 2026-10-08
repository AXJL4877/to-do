"""把火山 TTS 字/词时间戳聚合成 句子 / 短语 / 字 三级。"""
from __future__ import annotations

from typing import Any

# 句末：切开「句子」
_SENT_END = set("。！？!?…\n")
# 句内停顿：切开「短语」（保留标点挂在前一 token 上，与上游一致）
_PHRASE_END = set("，、；：,;")


def _flat_words(
    sentences_raw: list[dict[str, Any]] | None,
    words: list[dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    """统一成 [{text, start, end, confidence}, ...]。"""
    out: list[dict[str, Any]] = []
    if words:
        for w in words:
            text = str(w.get("word") or w.get("text") or "")
            if not text:
                continue
            out.append(
                {
                    "text": text,
                    "start": float(w.get("start") if w.get("start") is not None else w.get("startTime") or 0.0),
                    "end": float(w.get("end") if w.get("end") is not None else w.get("endTime") or 0.0),
                    "confidence": w.get("confidence"),
                }
            )
        if out:
            return out
    for sent in sentences_raw or []:
        for w in sent.get("words") or []:
            text = str(w.get("word") or "")
            if not text:
                continue
            out.append(
                {
                    "text": text,
                    "start": float(w.get("startTime") or 0.0),
                    "end": float(w.get("endTime") or 0.0),
                    "confidence": w.get("confidence"),
                }
            )
    return out


def expand_chars(tokens: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """字级：多字符 token 按时长均分（数字/英文词也会拆开）。"""
    chars: list[dict[str, Any]] = []
    idx = 0
    for tok in tokens:
        text = tok["text"]
        start = float(tok["start"])
        end = float(tok["end"])
        conf = tok.get("confidence")
        units = list(text)
        if not units:
            continue
        if len(units) == 1:
            chars.append(
                {
                    "id": idx,
                    "text": units[0],
                    "start": round(start, 4),
                    "end": round(end, 4),
                    "confidence": conf,
                }
            )
            idx += 1
            continue
        dur = max(end - start, 0.0)
        step = dur / len(units) if dur > 0 else 0.0
        for i, ch in enumerate(units):
            c0 = start + step * i
            c1 = end if i == len(units) - 1 else start + step * (i + 1)
            chars.append(
                {
                    "id": idx,
                    "text": ch,
                    "start": round(c0, 4),
                    "end": round(c1, 4),
                    "confidence": conf,
                }
            )
            idx += 1
    return chars


def _ends_with_any(text: str, marks: set[str]) -> bool:
    return bool(text) and text[-1] in marks


def build_hierarchy(
    *,
    text: str,
    sentences_raw: list[dict[str, Any]] | None,
    words: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    """生成 sentences / phrases / chars（嵌套 + 顶层扁平副本）。"""
    # 优先用上游按句切好的 subtitle；否则整段当一句再按标点切
    raw_groups: list[list[dict[str, Any]]] = []
    if sentences_raw:
        for sent in sentences_raw:
            local: list[dict[str, Any]] = []
            for w in sent.get("words") or []:
                t = str(w.get("word") or "")
                if not t:
                    continue
                local.append(
                    {
                        "text": t,
                        "start": float(w.get("startTime") or 0.0),
                        "end": float(w.get("endTime") or 0.0),
                        "confidence": w.get("confidence"),
                    }
                )
            if local:
                raw_groups.append(local)
    if not raw_groups:
        flat = _flat_words(sentences_raw, words)
        if not flat:
            return {
                "text": text,
                "duration": 0.0,
                "sentences": [],
                "phrases": [],
                "chars": [],
            }
        # 按句末标点把 flat 切成句组
        cur: list[dict[str, Any]] = []
        for tok in flat:
            cur.append(tok)
            if _ends_with_any(tok["text"], _SENT_END):
                raw_groups.append(cur)
                cur = []
        if cur:
            raw_groups.append(cur)

    sentences: list[dict[str, Any]] = []
    phrases_flat: list[dict[str, Any]] = []
    chars_flat: list[dict[str, Any]] = []
    phrase_id = 0
    char_id = 0

    for si, group in enumerate(raw_groups):
        # 短语
        phrase_bufs: list[list[dict[str, Any]]] = []
        buf: list[dict[str, Any]] = []
        for tok in group:
            buf.append(tok)
            if _ends_with_any(tok["text"], _PHRASE_END) or _ends_with_any(tok["text"], _SENT_END):
                phrase_bufs.append(buf)
                buf = []
        if buf:
            phrase_bufs.append(buf)

        phrase_objs: list[dict[str, Any]] = []
        for pb in phrase_bufs:
            p_chars = expand_chars(pb)
            for c in p_chars:
                c["id"] = char_id
                char_id += 1
                chars_flat.append(dict(c))
            p_text = "".join(t["text"] for t in pb)
            p_start = pb[0]["start"]
            p_end = pb[-1]["end"]
            pobj = {
                "id": phrase_id,
                "text": p_text,
                "start": round(p_start, 4),
                "end": round(p_end, 4),
                "chars": p_chars,
            }
            phrase_id += 1
            phrase_objs.append(pobj)
            phrases_flat.append(
                {
                    "id": pobj["id"],
                    "text": pobj["text"],
                    "start": pobj["start"],
                    "end": pobj["end"],
                    "char_ids": [c["id"] for c in p_chars],
                }
            )

        s_text = "".join(t["text"] for t in group) or (sentences_raw[si].get("text") if sentences_raw and si < len(sentences_raw) else "")
        s_start = group[0]["start"]
        s_end = group[-1]["end"]
        sentences.append(
            {
                "id": si,
                "text": s_text,
                "start": round(s_start, 4),
                "end": round(s_end, 4),
                "phrases": phrase_objs,
            }
        )

    duration = 0.0
    if chars_flat:
        duration = float(chars_flat[-1]["end"])
    elif phrases_flat:
        duration = float(phrases_flat[-1]["end"])
    elif sentences:
        duration = float(sentences[-1]["end"])

    return {
        "text": text,
        "duration": round(duration, 4),
        "sentences": sentences,
        "phrases": phrases_flat,
        "chars": chars_flat,
    }
