"""Re-export layers_manifest from an existing koubo work dir."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

work = Path(os.environ.get("KOUBO_WORK") or sys.argv[1])
wf = Path(__file__).resolve().parents[1] / "workflow"
sys.path[:0] = [str(wf), str(wf / "kit")]

from kit.layers_export import export_editable_layers  # noqa: E402

timing = json.loads((work / "01_口播试听" / "timing.json").read_text(encoding="utf-8"))
plan = json.loads((work / "02_镜头设计" / "plan.json").read_text(encoding="utf-8"))
out = work / "04_动画渲染" / "output"
path = export_editable_layers(timing, plan, out)
m = json.loads(path.read_text(encoding="utf-8"))
print("boards", len(m["boards"]), "elements", sum(len(b["elements"]) for b in m["boards"]))
for b in m["boards"]:
    labels = [e["label"] for e in b["elements"]]
    print(f"  shot{b['shot']} {b['startMs']}-{b['endMs']} {b['mode']} {labels}")
bs = m["boards"]
gaps = [bs[i]["startMs"] - bs[i - 1]["endMs"] for i in range(1, len(bs))]
print("start", bs[0]["startMs"], "end", bs[-1]["endMs"], "durMs", m.get("durationMs"), "gaps", gaps)
print("abs startMs sample", [e["startMs"] for e in bs[0]["elements"][:2]])
