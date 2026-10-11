from pathlib import Path

root = Path(__file__).resolve().parents[1] / "workflow"
repls = [
    (
        'Path(__file__).resolve().parents[3] / "kit" / "assets" / "cut"',
        'paths.KIT_ASSETS / "cut"',
    ),
    (
        'Path(__file__).resolve().parents[3] / "kit"',
        'Path(__file__).resolve().parents[1] / "kit"',
    ),
    (
        'Path(__file__).resolve().parents[2] / "kit"',
        'Path(__file__).resolve().parents[1] / "kit"',
    ),
]
for p in root.rglob("*.py"):
    t = p.read_text(encoding="utf-8")
    n = t
    for a, b in repls:
        n = n.replace(a, b)
    if n != t:
        p.write_text(n, encoding="utf-8")
        print("fixed", p.relative_to(root))
