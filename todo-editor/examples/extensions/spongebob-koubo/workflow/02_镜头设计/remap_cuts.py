"""把 briefs 素材名 remap 到已有 cut（按镜号+角色前缀），避免 rebind 空层。"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import paths

CUT = paths.KIT_ASSETS / "cut"


def _shot_idx(name: str) -> int | None:
    m = re.match(r"^(?:ch|pr)_s(\d+)_", name or "")
    return int(m.group(1)) if m else None


def _pool(cut_names: set[str]) -> dict[tuple[str, int], list[str]]:
    pools: dict[tuple[str, int], list[str]] = {}
    for n in sorted(cut_names):
        m = re.match(r"^(ch|pr)_s(\d+)_", n)
        if not m:
            continue
        key = (m.group(1), int(m.group(2)))
        pools.setdefault(key, []).append(n)
    return pools


def remap(briefs: list[dict]) -> tuple[list[dict], list[str]]:
    cut_names = {p.stem for p in CUT.glob("*.png")} if CUT.is_dir() else set()
    pools = _pool(cut_names)
    used: set[str] = set()
    notes: list[str] = []
    for i, b in enumerate(briefs):
        for a in b.get("assets") or []:
            name = str(a.get("name") or "")
            if name in cut_names:
                used.add(name)
                continue
            role = str(a.get("role") or "character")
            pref = "ch" if role in ("character", "figure", "hero", "support") else "pr"
            si = _shot_idx(name)
            if si is None:
                si = i
            cands = [n for n in pools.get((pref, si), []) if n not in used]
            if not cands:
                # 放宽：同镜任意前缀
                cands = [
                    n
                    for (p, s), ns in pools.items()
                    if s == si
                    for n in ns
                    if n not in used
                ]
            if not cands:
                notes.append(f"shot{i}:{name}:no_cut")
                continue
            pick = cands[0]
            notes.append(f"shot{i}:{name}→{pick}")
            a["name"] = pick
            a["want"] = [pick]
            used.add(pick)
    return briefs, notes


def main() -> None:
    lock = paths.DESIGN / "briefs_locked.json"
    active = paths.DESIGN / "briefs_active.json"
    src = lock if lock.is_file() else active
    if not src.is_file():
        raise SystemExit("missing briefs")
    data = json.loads(src.read_text(encoding="utf-8"))
    briefs, notes = remap(list(data.get("briefs") or []))
    data["briefs"] = briefs
    active.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if lock.is_file():
        lock.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("remapped", len(notes))
    for n in notes[:40]:
        print(" ", n)
    if len(notes) > 40:
        print(f"  ... +{len(notes) - 40}")


if __name__ == "__main__":
    main()
