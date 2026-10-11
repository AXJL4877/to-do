"""素材生成：只按 02/assets_brief.json 新生本片镜头专用图（不复用旧库存）。"""
import subprocess
import sys
from pathlib import Path

here = Path(__file__).resolve().parent
py = sys.executable
p = subprocess.run([py, str(here / "gen_from_brief.py"), *sys.argv[1:]])
raise SystemExit(p.returncode)
