# 密匙 — 本机 AI 资产生成工具模块

统一密钥与上游客户端：**生图 · 生视频 · 配音 · 视觉 · 文案 · 本地文件上公网**。  
其它项目**只调用本模块**，不要复制 Key，不要在业务仓库重写生成脚本。

**调用契约（必读）：** [`CONTRACT.md`](CONTRACT.md)  
**Agent 硬锁：** [`AGENTS.md`](AGENTS.md) · Cursor Skill `ai-media-mishi`

## 其它项目怎么调（固定）

**CLI（推荐）**

```bat
python d:\Desktop\密匙\run.py check
python d:\Desktop\密匙\run.py image --prompt "..." --out D:\proj\a.png --name img_a --no-wait
python d:\Desktop\密匙\run.py image --transparent --prompt "..." --out D:\proj\cut.png --name img_cut --no-wait
python d:\Desktop\密匙\run.py image --poll img_a --out D:\proj\a.png
python d:\Desktop\密匙\run.py host --file D:\proj\ref.png --path mishi-smoke/proj/ref.png
python d:\Desktop\密匙\run.py video --prompt "..." --image https://... --name vid1 --no-wait
python d:\Desktop\密匙\run.py video --poll vid1 --out D:\proj\a.mp4
python d:\Desktop\密匙\run.py tts --prompt "旁白" --out D:\proj\a.mp3
python d:\Desktop\密匙\run.py vision --prompt "描述画面" --image D:\proj\a.png
python d:\Desktop\密匙\run.py chat --prompt "写一段口播开场" --kind gpt6 --out D:\proj\draft.md
python d:\Desktop\密匙\run.py chat --prompt "..." --kind fable5 --out D:\proj\draft.md
```

**Python**

```python
import sys
sys.path.insert(0, r"d:\Desktop\密匙")
from media import (
    generate_image, wait_image,
    generate_video, wait_video,
    synthesize_speech, analyze_vision, generate_chat, host_upload,
)

generate_image("场景A", name="img_a", wait_done=False, out=r"D:\proj\a.png")
wait_image("img_a", out=r"D:\proj\a.png")
u = host_upload(r"D:\proj\ref.png", repo_path="mishi-smoke/proj/ref.png")["url"]
generate_chat("写一段口播开场", kind="gpt6", out=r"D:\proj\draft.md")
```

stdout **仅一行 JSON**（`ok` / `mode` / `file` / `url` / `error`）；进度在 **stderr**。脚本只解析 stdout。细则见 `CONTRACT.md` §4。

## 目录

| 路径 | 作用 |
|------|------|
| `CONTRACT.md` | **对外契约**（其它项目只认这份） |
| `AGENTS.md` | Agent 行为硬锁 |
| `run.py` | CLI 唯一入口 |
| `media/` | Python 公开 API（见 `media.__all__`） |
| `.env` / `.env.example` | 密钥与默认模型 |
| `jobs/` | 进行中任务缓存；交付成功后自动删 |
| `outputs/` | 本目录烟测暂存（业务请 `--out`） |
| `prompts/minimax-h3/` | H3 结构化提示词模板 |

业务项目用 `--out` 落到自己的目录；密匙在成功后自动清掉对应 job / outputs 残留。手动清空：`python run.py clean`。

## 默认上游

| 能力 | 默认 | 备选 |
|------|------|------|
| 生图 | 虎妞 `gpt-image-2` · `3840x2160` | `--model gpt-image-2.5-sunburst\|flare`；`--provider paipu` |
| 生视频 | 虎妞 grok · `price_first` | `--kind seedance\|h3` |
| 配音 | 火山 `seed-tts-2.0` | `--speaker` |
| 视觉 | `gemini-3.8-flash` | `--model` |

## 本目录烟测

```bat
cd /d d:\Desktop\密匙
python run.py check
python run.py tts --prompt "你好，这是配音测试。"
python run.py image --prompt "一张像素风格小猫，简洁背景" --name smoke_cat --no-wait
python run.py image --poll smoke_cat
```

## 硬锁摘要

- 视频参考图/音频：**公网 HTTPS only** → 本地先 `host`。
- 多张独立图/多段独立视频：全部 `--no-wait` 再 `--poll`；同名只 POST 一次。
- 失败未确认退费前禁止换名重提。
- H3（`--kind h3`）须按 Skill `minimax-h3-prompt` 写结构化 prompt。
