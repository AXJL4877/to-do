"""设计定稿后冻结 briefs → briefs_locked.json；rebind 只准用锁内素材名。"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import paths

SRC = paths.DESIGN / "briefs_active.json"
LOCK = paths.DESIGN / "briefs_locked.json"


def main() -> None:
    if not SRC.is_file():
        raise SystemExit(f"missing {SRC}")
    shutil.copy2(SRC, LOCK)
    data = json.loads(LOCK.read_text(encoding="utf-8"))
    n = sum(len(b.get("assets") or []) for b in (data.get("briefs") or []))
    print("locked", LOCK, "assets", n)


if __name__ == "__main__":
    main()
