"""Upload local media to the public GitHub refs repo for Paipu --image/--audio."""
from __future__ import annotations

import base64
import json
import subprocess
from pathlib import Path
from typing import Any

REPO = "AXJL4877/fuli-paipu-frames"
RAW_BASE = f"https://raw.githubusercontent.com/{REPO}/main"


def _gh_api(method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    cmd = ["gh", "api", "--method", method, path]
    if body is not None:
        raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
        cmd.extend(["--input", "-"])
        proc = subprocess.run(cmd, input=raw, capture_output=True)
    else:
        proc = subprocess.run(cmd, capture_output=True)
    text = (proc.stdout or b"").decode("utf-8", "replace")
    if proc.returncode != 0:
        err = (proc.stderr or b"").decode("utf-8", "replace")
        raise RuntimeError(f"gh api {method} {path} failed: {err or text}"[:800])
    return json.loads(text) if text.strip() else {}


def upload(local: Path, *, repo_path: str) -> dict[str, Any]:
    """Put a local file onto fuli-paipu-frames; return public raw HTTPS URL."""
    local = Path(local)
    if not local.is_file():
        raise FileNotFoundError(str(local))
    repo_path = repo_path.replace("\\", "/").lstrip("/")
    api_path = f"repos/{REPO}/contents/{repo_path}"

    sha = None
    try:
        existing = _gh_api("GET", api_path)
        sha = existing.get("sha")
    except RuntimeError:
        sha = None

    payload: dict[str, Any] = {
        "message": f"host {repo_path}",
        "content": base64.b64encode(local.read_bytes()).decode("ascii"),
        "branch": "main",
    }
    if sha:
        payload["sha"] = sha

    _gh_api("PUT", api_path, payload)
    url = f"{RAW_BASE}/{repo_path}"
    return {
        "ok": True,
        "mode": "host",
        "file": str(local.resolve()),
        "repo_path": repo_path,
        "url": url,
    }
