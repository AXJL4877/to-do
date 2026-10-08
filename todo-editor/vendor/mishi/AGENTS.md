# AGENTS.md — 密匙工具模块

> 本机唯一「生图 / 生视频 / 配音 / 视觉 / 文案」工具根目录：`d:\Desktop\密匙`  
> 密钥只读本目录 `.env`。禁止把 Key 写进其它项目仓库或 Rule/Skill 正文。  
> **对外契约（入口 / I/O / 公开 API）：先 Read [`CONTRACT.md`](CONTRACT.md)。** 本文件是 Agent 行为硬锁，叠在契约之上。

## 何时使用

用户或任务涉及：生图、图生图、生视频、Seedance、MiniMax H3、Grok、虎妞、配音、TTS、旁白、口播音频、视觉理解、看图、VLM、GM-3.8、gemini-3.8-flash、文案、口播稿、GPT-6、Astra、Fable5、claude-fable → **先调用本模块**，不要在新项目里重写客户端。

## 调用方式（按优先级）

1. CLI：`python d:\Desktop\密匙\run.py <image|video|tts|vision|chat|host|check> ...`
2. Import：`sys.path.insert(0, r"d:\Desktop\密匙")` 后  
   `from media import generate_image, wait_image, generate_video, wait_video, synthesize_speech, analyze_vision, generate_chat, host_upload, ROOT`
3. 改密钥 / 默认模型：只编辑 `d:\Desktop\密匙\.env`

## 命令速查

```bat
python d:\Desktop\密匙\run.py check
python d:\Desktop\密匙\run.py clean
python d:\Desktop\密匙\run.py host --file local.png --path mishi-smoke/foo/ref.png
python d:\Desktop\密匙\run.py image --prompt "..." [--out path] [--size 3840x2160|1024x1024] [--name job] [--no-wait]
python d:\Desktop\密匙\run.py image --transparent --prompt "..." [--out path] [--name job] [--no-wait]
python d:\Desktop\密匙\run.py image --provider paipu --prompt "..." 
python d:\Desktop\密匙\run.py image --poll job_name
python d:\Desktop\密匙\run.py video --prompt "..." [--kind grok|seedance|h3] [--image url] [--audio url] [--name job] [--no-wait]
python d:\Desktop\密匙\run.py video --poll job_name
python d:\Desktop\密匙\run.py tts --prompt "..." [--out path] [--speaker id] [--format mp3|wav] [--subtitle] [--timing path]
python d:\Desktop\密匙\run.py vision --prompt "..." --image local.png [--image more.png] [--model gemini-3.8-flash]
python d:\Desktop\密匙\run.py chat --prompt "..." [--kind gpt6|fable5] [--out path] [--system "..."]
```

**CLI I/O 硬锁：** stdout = 仅一行 JSON；stderr = 轮询进度。跨项目脚本只 `json.loads` **stdout**，勿合并 stderr。详见 `CONTRACT.md` §4 与 Skill `ai-media-mishi`「CLI 输出约定」。

## 约定

- **默认网关是虎妞**：生图 `IMAGE_PROVIDER=huniu` → `gpt-image-2`；生视频 `VIDEO_KIND=grok` → `.env` `HUNIU_VIDEO_MODEL_GROK`（默认 **`omni_4`，固定 10s**）。派谱仍可用：`--provider paipu` / `--kind seedance|h3`。
- **生图 Image 2.5（备选，勿改默认）：** 用户提到「image2.5 / 2.5 / 高端版 / sunburst / flare」时直接 `--model`，禁止再查模型 ID。高端 → `gpt-image-2.5-sunburst`；快/日常 → `gpt-image-2.5-flare`。未点名 2.5 时继续默认 `gpt-image-2`。虎妞按次价约 sunburst `$0.085` / flare `$0.075`（远高于 image-2 的 `$0.0075`）。
- **透明底素材硬锁：** 用户要透明底 / 透明 PNG / 带 alpha 的元素素材时，必须 `--transparent`（或 `generate_image(..., transparent=True)`）。请求体带 `background: transparent` 与 `output_format: png`，由虎妞 gpt-image **直接出透明通道**。禁止再写品红/紫色纯色底提示词、禁止本地色键抠图。未提透明底时不要加此参数。仅虎妞；`--provider paipu` 不要加 `--transparent`。
- **文案 chat 硬锁：** 写口播/标题/旁白等纯文本走 `run.py chat`（或 `generate_chat`）。默认 `--kind gpt6` → `gpt-6-astra`；用户点名 Fable5 / fable → `--kind fable5` → `claude-fable-5`。点名 fable5.1 → `--model fable5.1`（`claude-fable-5-1`）。禁止再查模型 ID；未点名 fable 时用默认 GPT-6。业务正文用 `--out` 落到项目路径；stdout 仍是一行 JSON（含 `text`）。看图继续用 `vision`，不要用 chat 塞图。
- **视频模型硬锁：** 默认 `omni_4`（固定提交 `duration=10`，见 `HUNIU_VIDEO_DURATION`）。用户点名 7tu / 多图时才 `--model grok-imagine-1-5-7tu-special`。`grok-imagine-1.5-special` 只适合单首帧。未获用户当场给出的其它完整 ID 时，不要传 `--model` 乱换名。
- 生图默认 `--size 3840x2160`（4K 16:9，可用 `.env` `HUNIU_IMAGE_SIZE` 或 `--size` 覆盖）。
- **虎妞渠道策略硬锁默认「经济优先」**（`HUNIU_VIDEO_STRATEGY=price_first`，即控制台「价格优先」）。请求体会带 `strategy: price_first`；控制台该模型也请保持经济优先，避免落到贵的按次渠道（如 DPW）。
- **视频参考图/音频：** 必须公网 HTTPS。本地文件先 `run.py host` 上传到 `AXJL4877/fuli-paipu-frames`，再用返回的 `raw.githubusercontent.com/...` URL。若派谱 H3 拉 GitHub raw 不稳，可套国内免费加速镜像：`https://ghfast.top/` + 完整 raw URL（免注册第三方；非官方，可能失效）。禁止本地路径 / data URL。详见 Skill `ai-media-mishi`「本地文件 → 公网 HTTPS」。
- **同时多发 / 智能异步（硬锁）：** 任务间**无产物依赖**时，生图与生视频都必须 `--name` + `--no-wait`（或 `wait_done=False`）先全部提交，再分别 `--poll`，**禁止**默认同步一张张 wait。视频=上游异步；生图=本机后台并行打同步请求。同名只提交一次。
- **禁止空等：** 同回合 ≥2 张独立生图却串行 `image --prompt`（无 `--no-wait`）= 违规。
- **必须串行：** 下一段要用上一段成片/尾帧/抽帧、视频要等生图或 TTS 出完再 `host`、图生图要等参考图、用户要求看完再决定——必须等前序 `ok` 且 URL/文件就绪后再提交下游。详见 Skill `ai-media-mishi`「智能异步 / 串行」。
- **速率限制：** 派谱生图 TinySnow 更紧（约 50 RPM）；虎妞按渠道策略走。打满易 429/502。
- **502 说明：** 多为上游瞬时不可用，不是密匙密钥写错。已提交有 `task_id` 时：只 `--poll`，勿当失败重提。提交阶段 502 且无 task_id：确认退费后再重试。
- **生图落盘 SSL/EOF：** 虎妞常先出图再返回 URL；本机拉 4K 时可能 `UNEXPECTED_EOF`。现已：分块下载 + 最多 5 次重试；成功返回 URL 后先写入 job（`remote_ready`），下载失败标 `download_failed` 并保留 `url`，`--poll` 会优先只重拉、不重生成。
- **API 回包 IncompleteRead / 环回代理：** `http_json` 对 IncompleteRead、SSL EOF、连接重置自动重试；系统代理指向 `127.0.0.1`/`localhost` 时默认直连上游（可用 `MISHI_USE_SYSTEM_PROXY=1` 强制走代理，或 `MISHI_DIRECT=1` 显式直连）。job `failed` 且无 `url` 时**同名可再 submit**（废单续跑）；故意换图才换 `--name`。有 `url` 的 `download_failed` 只重拉。
- **MiniMax H3（`--kind h3` / `lec-minimax-h3-768p`）提示词硬锁：** 先按 Cursor Skill `minimax-h3-prompt`（官方 `h3-prompt-writing`）写结构化 prompt；指南在 `prompts/minimax-h3/base-en.txt` 与 `ref-en.txt`。有图+音频用 Ref2VA 六段；禁止口语短句直接提交。
- H3 单段最长 15s；**不要**用「上一段尾帧 → 下一段首帧」做多段硬衔接（效果差，已取消）。
- 视频：**同 `--name` 只 POST 一次**；未知结果先 `--poll`，勿重复提交。
- **失败 / 异常 / 502 等：所有模型（生图、视频、配音）都可能生成失败。未向用户确认「该次计费已退费 / 可重试」前，禁止换名重提或再次 POST；确认退费后再重试。**
- 产物默认 `密匙/outputs/`（仅烟测）；**跨项目必须 `--out` 到业务项目路径**。成功后密匙自动删除对应 `jobs/<name>.json` 与 `outputs/` 同名残留。
- 手动清空暂存：`python d:\Desktop\密匙\run.py clean`（jobs + outputs + 遗留 out/refs/根目录烟测媒体）。
- 成片发布 inbox：环境变量 `DOUYIN_PUBLISH_INBOX`（见 `.env`）。
- 在本目录做能力烟测；业务项目只消费 CLI/API 结果，**勿把密匙当素材库**。

## 默认模型（可被 .env / --model 覆盖）

| 能力 | 模型 | 备注 |
|------|------|------|
| 生图（默认） | `gpt-image-2` | 虎妞；默认 `3840x2160` |
| 生图 2.5 高端 | `gpt-image-2.5-sunburst` | 虎妞备选；用户点名 2.5/高端时 `--model` |
| 生图 2.5 快速 | `gpt-image-2.5-flare` | 虎妞备选；用户点名 flare/快速时 `--model` |
| 生图（备选） | `lec-tinysnow-image-2` | 派谱；`--provider paipu` |
| 视频（默认） | `omni_4` | 虎妞；固定 10s；`--kind grok`；`price_first`；见 `HUNIU_VIDEO_MODEL_GROK` |
| 视频 Grok 多图 | `grok-imagine-1-5-7tu-special` | 用户点名 7tu / 多图时 `--model` |
| 视频 Grok 单帧 | `grok-imagine-1.5-special` | 仅首帧单图；需用户明确才用 `--model` |
| 视频 Seedance | `lec-ac-seedance-2-5-900` | 派谱；`--kind seedance` |
| 视频 H3 | `lec-minimax-h3-768p` | 派谱；提示词 → Skill `minimax-h3-prompt` |
| 配音 | `seed-tts-2.0` + `VOLC_SPEECH_SPEAKER` | |
| 视觉（默认） | `gemini-3.8-flash` | 虎妞；口称 GM-3.8 Flash；`run.py vision` |
| 文案（默认） | `gpt-6-astra` | 虎妞；`--kind gpt6`；`run.py chat` |
| 文案 Fable5 | `claude-fable-5` | 虎妞；用户点名 fable → `--kind fable5` |
| 文案 Fable5.1 | `claude-fable-5-1` | 虎妞；点名 5.1 → `--model fable5.1` |
