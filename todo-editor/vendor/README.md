# 内嵌工具

| 目录 | 用途 |
|------|------|
| `tts-timeline/` | 配音 + 三级时间戳（`run.py synth`） |
| `mishi/` | 虎妞/火山密钥与 CLI（含 `.env`） |
| `blackboard/` | 黑板手绘渲染脚本 + 粉笔手/黑板底图 |
| `burn-subtitles/` | 字幕对时/气口切窗（`burn_subtitles.py`） |

默认由 `server/toolRoots.mjs` 解析。本地 H3（ComfyUI）体积过大，不内嵌，需自备并设 `H3_COMFY_DIR` / `H3_STUDIO_DIR`。

勿把含 `.env` 的仓库改公开。
