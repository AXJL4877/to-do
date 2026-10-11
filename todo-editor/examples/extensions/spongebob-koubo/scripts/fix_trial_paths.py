from pathlib import Path

root = Path(__file__).resolve().parents[1] / "workflow"
repls = [
    ('paths.TRIAL.parent / "kit" / "assets" / "cut"', 'paths.KIT_ASSETS / "cut"'),
    ('paths.TRIAL.parent / "kit" / "assets" / "raw"', 'paths.KIT_ASSETS / "raw"'),
]
for p in root.rglob("*.py"):
    t = p.read_text(encoding="utf-8")
    n = t
    for a, b in repls:
        n = n.replace(a, b)
    if n != t:
        p.write_text(n, encoding="utf-8")
        print("fixed", p.relative_to(root))
