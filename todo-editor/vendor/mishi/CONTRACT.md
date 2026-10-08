# 密匙工具层契约（CONTRACT）

> 本文件是**其它项目 / Agent 调用密匙的唯一契约**。  
> 本仓库是工具层，不是业务成片流水线：只提供原子能力（生图 / 生视频 / 配音 / 视觉 / 文案 / 本地文件上公网）。

## 1. 边界

| 做 | 不做 |
|----|------|
| 统一密钥（仅本目录 `.env`） | 不把 Key 复制到业务仓库 / Skill / Rule |
| 统一上游客户端与默认模型 | 不在业务项目重写生图/视频/TTS 脚本 |
| 统一 CLI / Python 返回形状 | 不编排选题、分镜、发布等业务步骤 |
| 本目录内烟测与能力变更 | 业务产物应 `--out` 到业务项目路径 |

**工具根目录（硬锁）：** `d:\Desktop\密匙`

## 2. 调用优先级

1. **CLI（推荐，跨语言/脚本最稳）**  
   `python d:\Desktop\密匙\run.py <cmd> ...`
2. **Python import**  
   ```python
   import sys
   sys.path.insert(0, r"d:\Desktop\密匙")
   from media import (
       generate_image, wait_image,
       generate_video, wait_video,
       synthesize_speech, analyze_vision, generate_chat, host_upload,
       ROOT,
   )
   ```
3. **改默认模型 / 密钥** → 只改 `d:\Desktop\密匙\.env`（模板见 `.env.example`）

禁止：在业务项目新建 `generate_*.py` / 自建 HTTP 客户端去打虎妞/派谱。

## 3. CLI 命令面（固定）

| 命令 | 作用 |
|------|------|
| `check` | 检查密钥与默认模型（不花钱） |
| `clean` | 清空 jobs/outputs 与遗留烟测媒体 |
| `host` | 本地文件 → 公网 HTTPS（视频参考用） |
| `image` | 生图 / `--poll` |
| `video` | 生视频 / `--poll` |
| `tts` | 配音 |
| `vision` | 视觉理解 |
| `chat` | 文案 / 纯文本（GPT-6 / Fable5） |

```bat
python d:\Desktop\密匙\run.py check
python d:\Desktop\密匙\run.py host --file local.png --path mishi-smoke/proj/ref.png
python d:\Desktop\密匙\run.py image --prompt "..." --out D:\proj\a.png --name img_a --no-wait
python d:\Desktop\密匙\run.py image --transparent --prompt "..." --out D:\proj\a.png --name img_a --no-wait
python d:\Desktop\密匙\run.py image --poll img_a --out D:\proj\a.png
python d:\Desktop\密匙\run.py video --prompt "..." --name vid_1 --no-wait
python d:\Desktop\密匙\run.py video --poll vid_1 --out D:\proj\a.mp4
python d:\Desktop\密匙\run.py tts --prompt "..." --out D:\proj\a.mp3
python d:\Desktop\密匙\run.py tts --prompt "..." --format wav --subtitle --timing D:\proj\timing_raw.json --out D:\proj\a.wav
python d:\Desktop\密匙\run.py vision --prompt "..." --image local.png
python d:\Desktop\密匙\run.py chat --prompt "..." --kind gpt6 --out D:\proj\draft.md
python d:\Desktop\密匙\run.py chat --prompt "..." --kind fable5 --out D:\proj\draft.md
```

## 4. I/O 契约（硬锁）

| 流 | 内容 | 调用方 |
|----|------|--------|
| **stdout** | 恰好一行 JSON：`ok` / `mode` / `file` / `url` / `job` / `error` … | **只** `json.loads(stdout)` |
| **stderr** | 轮询进度等人话 | 可打日志；**禁止**拼进 JSON |

退出码：`ok=true` → 0；否则非 0。

跨项目脚本若合并 stdout+stderr 再解析 → 会误判「未完成」。正确示例：

```python
import json, subprocess
p = subprocess.run(
    [r"python", r"d:\Desktop\密匙\run.py", "image", "--poll", "img_a"],
    capture_output=True, text=True, encoding="utf-8",
)
data = json.loads(p.stdout.strip())
```

## 5. 默认能力（可被 `.env` / flag 覆盖）

| 能力 | 默认 | 常用覆盖 |
|------|------|----------|
| 生图 | 虎妞 `gpt-image-2`，`3840x2160` | `--provider paipu`；2.5 高端 `--model gpt-image-2.5-sunburst`；快速 `--model gpt-image-2.5-flare`；透明底 `--transparent`（`background=transparent` + `output_format=png`，仅虎妞） |
| 生视频 | 虎妞 `grok` → `.env` 默认 **`omni_4`（固定 10s）**，策略 `price_first` | 用户点名 7tu 时 `--model grok-imagine-1-5-7tu-special`；`--kind seedance\|h3` |
| 配音 | `seed-tts-2.0` + `VOLC_SPEECH_SPEAKER` | `--speaker`；`--format wav`；`--subtitle` / `--timing` 拿字词时间戳 |
| 视觉 | `gemini-3.8-flash`（GM-3.8 Flash） | `--model` |
| 文案 | 虎妞 `gpt-6-astra`（`--kind gpt6`） | `--kind fable5` → `claude-fable-5`；`--model fable5.1` → `claude-fable-5-1` |
| 参考素材 | 必须公网 HTTPS | 本地先 `host`，再用返回 `url` |

## 6. 异步与同名（硬锁摘要）

- 同批**无依赖**的多图/多视频：全部 `--name` + `--no-wait`（或 `wait_done=False`）提交，再分别 `--poll` / `wait_*`。
- **同 `--name` 只提交一次**；未知结果先 poll，勿重复 POST。
- 失败 / 502：有 `task_id` 只 poll；无 task_id 须确认退费后再重提。
- 详细依赖判断见 Skill `ai-media-mishi`「智能异步 / 串行」与 `AGENTS.md`。

## 7. Python 公开面（`media` 包）

| 符号 | 含义 |
|------|------|
| `ROOT` | 工具根目录 Path |
| `generate_image` / `wait_image` | 生图提交与等待 |
| `generate_video` / `wait_video` | 生视频提交与等待 |
| `synthesize_speech` | 配音 |
| `analyze_vision` | 视觉理解 |
| `generate_chat` | 文案 / 纯文本（GPT-6 / Fable5） |
| `host_upload` | 本地 → 公网 URL（同 CLI `host`） |

内部模块（`media.env` / `media.util` / 各 `_*`）不构成对外契约，业务方勿依赖。

## 8. 目录约定

| 路径 | 作用 |
|------|------|
| `run.py` | CLI 唯一入口 |
| `media/` | Python API |
| `.env` / `.env.example` | 密钥与默认 |
| `jobs/` | 任务缓存（进行中）；**成功交付后自动删除** |
| `outputs/` | **仅本目录烟测暂存**；业务必须 `--out` 到业务目录 |
| `prompts/minimax-h3/` | H3 提示词模板 |
| `AGENTS.md` | Agent 行为硬锁（在本契约之上） |
| `CONTRACT.md` | 本文件 |

### 产物归属（硬锁）

1. 业务项目生成时**必须**传 `--out`（或 API `out=`）到**该项目自己的目录**。
2. 密匙在 `--poll` / 同步完成后：若最终文件已在密匙根目录外 → **自动删除**对应 `jobs/<name>.json` 以及 `outputs/` 里同名残留（不会删业务目录文件）。
3. 本目录烟测未传 `--out` 时，文件可暂留 `outputs/`；可随时 `python run.py clean` 清空 `jobs/`、`outputs/` 与遗留 `out/`、`refs/`、根目录烟测媒体。
4. **禁止**把密匙当作业务素材库长期存放成片。

## 9. 变更规则

- 改默认模型 / 网关 / CLI 形状 → 同步改：`.env.example`、本文件、`AGENTS.md`、Skill `ai-media-mishi`。
- 能力烟测只在本目录跑；业务项目只消费 CLI/API 结果（并自管 `--out` 路径）。
