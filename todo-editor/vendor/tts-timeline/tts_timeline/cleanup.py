"""工具层临时产物清理：本仓库不备份业务 wav/json。"""
from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

TOOL_ROOT = Path(__file__).resolve().parents[1]
OUTPUTS = TOOL_ROOT / "outputs"


def is_under_tool(path: Path | str) -> bool:
    try:
        Path(path).resolve().relative_to(TOOL_ROOT.resolve())
        return True
    except ValueError:
        return False


def is_under_outputs(path: Path | str) -> bool:
    try:
        Path(path).resolve().relative_to(OUTPUTS.resolve())
        return True
    except ValueError:
        return False


def require_module_out(out_dir: Path | str) -> Path:
    """阶段产物必须落在本模块 outputs/ 下。"""
    out = Path(out_dir).resolve()
    OUTPUTS.mkdir(parents=True, exist_ok=True)
    if not is_under_outputs(out):
        raise RuntimeError(
            f"--out 必须落在本模块 outputs/ 下，例如 {OUTPUTS / '<作业>'}。"
            f"收到: {out}"
        )
    out.mkdir(parents=True, exist_ok=True)
    return out


def wipe_outputs(*, keep: Path | None = None) -> dict[str, Any]:
    """清空 TOOL_ROOT/outputs/。keep 若在 outputs 下则保留该目录。"""
    removed: list[str] = []
    if not OUTPUTS.exists():
        return {"ok": True, "mode": "clean", "removed": removed}
    keep_res = keep.resolve() if keep is not None else None
    for child in list(OUTPUTS.iterdir()):
        if keep_res is not None:
            try:
                child.resolve().relative_to(keep_res)
                continue
            except ValueError:
                pass
            if child.resolve() == keep_res:
                continue
        if child.is_dir():
            shutil.rmtree(child, ignore_errors=True)
        else:
            try:
                child.unlink()
            except OSError:
                pass
        removed.append(str(child))
    return {"ok": True, "mode": "clean", "removed": removed, "outputs": str(OUTPUTS)}
