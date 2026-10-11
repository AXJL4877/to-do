"""验收门公共工具。"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "02_镜头设计"))

import paths  # noqa: E402


def load_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def report(gate: str, checks: list[dict], *, extra: dict | None = None) -> dict:
    ok = all(bool(c.get("ok")) for c in checks)
    payload = {"gate": gate, "ok": ok, "checks": checks}
    if extra:
        payload.update(extra)
    out_dir = paths.RENDER_OUT / "accept_gates"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{gate}.json"
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[{gate}] {'PASS' if ok else 'FAIL'} → {out}")
    for c in checks:
        print(("  OK" if c["ok"] else "  NG"), c["name"], c.get("detail", ""))
    return payload


def add(checks: list[dict], name: str, passed: bool, detail: str = "") -> None:
    checks.append({"name": name, "ok": bool(passed), "detail": detail})
