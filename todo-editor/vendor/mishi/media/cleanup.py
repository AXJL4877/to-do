"""Ephemeral cleanup: 密匙只暂存，业务 --out 交付成功后自动删本地残留。"""
from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

from media.env import JOBS, OUTPUTS, ROOT, ensure_dirs

_MEDIA_SUFFIX = {".png", ".jpg", ".jpeg", ".webp", ".mp4", ".mp3", ".part", ".json"}


def under_root(path: Path | str | None) -> bool:
    if path is None:
        return False
    try:
        p = Path(path).resolve()
        root = ROOT.resolve()
        return p == root or root in p.parents
    except OSError:
        return False


def is_external_delivery(path: Path | str | None) -> bool:
    """True when the final artifact lives outside the 密匙 toolkit root."""
    if path is None:
        return False
    return not under_root(path)


def _job_candidates(name: str) -> list[Path]:
    """Video: {name}.json；生图: img_{name}.json（与 media.image._job_path 一致）。"""
    raw = str(name).strip()
    if not raw:
        return []
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in raw)[:80]
    cands = [JOBS / f"{safe}.json", JOBS / f"img_{safe}.json"]
    # 去重但保序
    seen: set[str] = set()
    out: list[Path] = []
    for p in cands:
        key = str(p)
        if key not in seen:
            seen.add(key)
            out.append(p)
    return out


def job_path(name: str) -> Path:
    """首选路径（视频同名）；生图实际多为 img_ 前缀，见 forget_job。"""
    cands = _job_candidates(name)
    return cands[0] if cands else JOBS / f"{name}.json"


def forget_job(name: str | None) -> bool:
    if not name:
        return False
    deleted = False
    for p in _job_candidates(str(name)):
        if p.is_file():
            try:
                p.unlink()
                deleted = True
            except OSError:
                pass
    return deleted


def _allowed_toolkit_path(resolved: Path) -> bool:
    """Only delete ephemeral paths under 密匙 — never media/ prompts/ .env / docs."""
    try:
        rel = resolved.relative_to(ROOT.resolve())
    except ValueError:
        return False
    if not rel.parts:
        return False
    top = rel.parts[0]
    if top in {"outputs", "jobs", "out", "refs"}:
        return True
    # root-level smoke leftovers only
    if len(rel.parts) == 1 and resolved.suffix.lower() in _MEDIA_SUFFIX:
        return True
    return False


def remove_if_under_toolkit(path: Path | str | None) -> bool:
    """Delete a file only if it sits under allowed 密匙 ephemeral dirs."""
    if path is None:
        return False
    try:
        resolved = Path(path).resolve()
    except OSError:
        return False
    if not resolved.is_file() or not _allowed_toolkit_path(resolved):
        return False
    try:
        resolved.unlink()
        return True
    except OSError:
        return False


def discard_after_delivery(
    *,
    job: str | None = None,
    delivered_file: Path | str | None = None,
    toolkit_file: Path | str | None = None,
) -> dict[str, Any]:
    """After success: if业务目录拿到文件，删密匙侧副本与 job 记录。

    - delivered outside ROOT → forget job + delete toolkit copy / outputs/{job}.*
    - delivered under outputs (本目录烟测) → forget job only（烟测文件可留到下次 clean）
    """
    ensure_dirs()
    deleted: list[str] = []
    external = is_external_delivery(delivered_file)

    if toolkit_file:
        try:
            tf = Path(str(toolkit_file)).resolve()
        except OSError:
            tf = None
        df = None
        if delivered_file:
            try:
                df = Path(str(delivered_file)).resolve()
            except OSError:
                df = None
        if tf and (df is None or tf != df):
            if remove_if_under_toolkit(tf):
                deleted.append(str(tf))

    if external and job:
        for ext in (".png", ".jpg", ".jpeg", ".webp", ".mp4", ".mp3"):
            cand = OUTPUTS / f"{job}{ext}"
            if cand.is_file() and remove_if_under_toolkit(cand):
                deleted.append(str(cand.resolve()))
        for part_name in (f"{job}.mp4.part", f"{job}.png.part"):
            part = OUTPUTS / part_name
            if part.is_file() and remove_if_under_toolkit(part):
                deleted.append(str(part.resolve()))

    # Drop job once caller has a completed file (external or smoke).
    if job and delivered_file:
        before = [str(p) for p in _job_candidates(job) if p.is_file()]
        if forget_job(job):
            deleted.extend(before)

    return {"external": external, "deleted": deleted}


def wipe_ephemeral(*, jobs: bool = True, outputs: bool = True, stray: bool = True) -> dict[str, Any]:
    """Manual / CLI clean: wipe jobs + outputs + legacy out/refs smoke dirs."""
    ensure_dirs()
    removed: list[str] = []

    def _clear_dir(d: Path, *, keep_gitkeep: bool = True) -> None:
        if not d.is_dir():
            return
        for p in d.iterdir():
            if keep_gitkeep and p.name == ".gitkeep":
                continue
            try:
                if p.is_dir():
                    shutil.rmtree(p)
                else:
                    p.unlink()
                removed.append(str(p))
            except OSError:
                continue

    if jobs:
        _clear_dir(JOBS)
    if outputs:
        _clear_dir(OUTPUTS)
    if stray:
        for name in ("out", "refs"):
            d = ROOT / name
            if d.is_dir():
                try:
                    shutil.rmtree(d)
                    removed.append(str(d))
                except OSError:
                    pass
        for pattern in ("*.png", "*.jpg", "*.jpeg", "*.webp", "*.mp4", "*.mp3"):
            for p in ROOT.glob(pattern):
                try:
                    p.unlink()
                    removed.append(str(p))
                except OSError:
                    pass

    return {
        "ok": True,
        "mode": "clean",
        "removed_count": len(removed),
        "removed_sample": removed[:40],
    }
