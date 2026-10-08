# 内嵌工具

| 目录 | 用途 |
|------|------|
| `tts-timeline/` | 配音 + 三级时间戳（唯一入口 `run.py synth`） |
| `mishi/` | 虎妞/火山密钥与 CLI（配音经其 `media.tts`；云端生视频/host） |

默认由 `server/toolRoots.mjs` 解析。勿把含 `.env` 的仓库改公开。
