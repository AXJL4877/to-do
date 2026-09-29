# 字幕技能包协议 v2.2（`builtin.voice-subtitle`）

给一段音频生成字幕。有来源配音（[`builtin.tts-voice`](../tts-voice/PROTOCOL.md)）时按它的文案和逐字时间戳；没有文案时对素材做语音识别。走 `subtitle` 管线，和黑板手绘共用同一套三层协议（`todo-skill-pack/1` / `todo-skill-render/1` / `todo-skill-output/1`）、同一个任务队列和 HTTP / CLI 入口，通用部分见 [`../chalk-hand/PROTOCOL.md`](../chalk-hand/PROTOCOL.md)，这里只写差异。

- 文案模式（`script`）：字幕正文只取自配音的文案；时间只取配音 `timing.json` 里的 `chars`（TTS 逐字时间戳），不跑 ASR。
- 识别模式（`asr`）：素材没有配音文案时，用 burn-subtitles 的 `asr_char_timeline`（faster-whisper，本机 CPU）识别逐字文本和时间，转简体（装了 `zhconv` 时），按字间停顿补标点（≥0.35s 逗号、≥0.8s 句号）后照常切条。识别可能认错字，约为音频时长的 3~5 倍耗时。
- 切条、对齐、关键词、识别都调用 burn-subtitles 本体（`align_chunks` / `pick_keywords` / `write_ass` / `asr_char_timeline`），不复制它的逻辑。
- 产物：字幕条目（进时间轴成为可编辑文字片段）+ ASS + 透明底 WebM（不带音频，备用）。

---

## 1. 调用

```json
{
  "kind": "skill",
  "skillId": "builtin.voice-subtitle",
  "sourceJobId": "s_mum8c4uo_y1g2",
  "sourceMedia": { "url": "file:///D:/素材/采访.mp4", "path": "D:/素材/采访.mp4", "name": "采访.mp4" },
  "params": { "size": "1080x1920", "font": "kaiti", "fontPx": 64, "bottomPct": 16 },
  "autoTimeline": true,
  "anchorClipId": "c_abc123"
}
```

- 来源二选一，服务端按顺序判断：
  1. `sourceJobId` 是一条完成 / 已入库、带文案和逐字时间戳的配音任务 → 文案模式；`prompt` 忽略。
  2. 否则看 `sourceMedia` → 识别模式。`url` 形如 `/ai-generated/<文件>` 时读 AI 输出目录里的该文件；否则用 `path`（须为绝对路径，只有桌面版导入的素材有）。只接受常见音视频扩展名（wav / mp3 / m4a / aac / flac / ogg / opus / mp4 / mov / mkv / webm / avi / m4v）。任务标题为 `语音识别 · <素材名>`。
  3. 都没有时入队失败：「这段音频没有配音文案和时间戳，也没有给出素材文件，烧不了字幕」。
- `anchorClipId` 可选，时间线上发起烧录的那段音频片段；服务端只透传（最多 64 字），编辑器入轨时优先对齐它。
- `plan` / `images` 不接受。`/api/ai-skill-plan` 对本包返回「不需要规划」。
- 来源文件被删掉时任务失败。

CLI（文案模式）：

```bash
npm run skill -- start --skill builtin.voice-subtitle --source <配音 jobId> --set font=kaiti --set fontPx=64
npm run skill -- fetch <jobId> --out ./out --wait
```

## 2. 可调参数

| 分组 | id | 类型 | 取值 | 默认 | 说明 |
|---|---|---|---|---|---|
| 输出 | `size` | select | `1920x1080` `1280x720` `1080x1920` `1080x1080` | 1920x1080 | 画幅；编辑器默认取当前工程画幅 |
| 输出 | `fps` | select | `25` `30` `60` | 30 | WebM 帧率 |
| 字幕 | `font` | select | `smiley` `yahei` `heiti` `kaiti` `xingkai` `lishu` `hupo` | smiley | 得意黑（burn-subtitles 自带）/ 微软雅黑 Bold / 黑体 / 楷体 / 华文行楷 / 隶书 / 华文琥珀（系统字体，缺文件时任务报错） |
| 字幕 | `fontPx` | number | 28~120，步长 2 | 54 | 字号 = 画面短边 × fontPx / 1080，描边 = 字号 / 18 |
| 字幕 | `bottomPct` | number | 2~90，步长 1 | 6 | 字幕底边离画面底部 = 画面高度 × bottomPct% |
| 字幕 | `keywords` | select | `on` `off` | on | 关键词放大变色，只在 WebM / ASS 里生效 |
| 节奏 | `maxChars` | number | 8~30，步长 1 | 18 | 单条字幕最多几个字 |

输出恒为透明底；时长 = max(音频时长, 末条字幕结束)。运行超时 3600 秒（识别长素材较慢）。

## 3. 渲染请求（宿主 → `render.py`）

```json
{
  "spec": "todo-skill-render/1",
  "jobId": "s_mfx2_cd34",
  "outDir": "D:/…/.data/ai-generated",
  "ffmpeg": "C:/…/ffmpeg.exe",
  "params": { "size": "1920x1080", "fontPx": 54, "…": "已解析的完整参数" },
  "mode": "script",
  "script": "配音的文案",
  "audio": "D:/…/s_mfx1_ab12_voice.wav",
  "timing": "D:/…/s_mfx1_ab12_timing.json",
  "outputs": {
    "prefix": "s_mfx2_cd34", "video": "s_mfx2_cd34.webm", "still": "s_mfx2_cd34_still.png",
    "subtitles": "s_mfx2_cd34_subtitles.json", "ass": "s_mfx2_cd34.ass"
  },
  "keepWork": false
}
```

- `mode: "script"`：`audio` / `timing` 指向来源配音的文件，`audio` 只用来做静音检测（判断气口）。阶段为 `字幕对时`（占 20%）和 `编码`（占 80%）。
- `mode: "asr"`：`script` 为空、`timing` 为 null，`audio` 是素材文件（可以是视频）。先用 ffmpeg 抽 16k 单声道 wav 再识别。阶段为 `语音识别`（占 60%）和 `编码`（占 40%）。没识别出语音时报错。
- 音频都不进 WebM。

`@result`：

```json
{
  "video": "s_…webm", "still": "s_…_still.png", "subtitles": "s_…_subtitles.json", "ass": "s_….ass",
  "alpha": true, "audio": false, "width": 1920, "height": 1080, "fps": 30, "frames": 139, "duration": 4.62,
  "cues": 3, "font": "Smiley Sans Oblique", "fontSize": 54, "audioDuration": 4.6, "text": "切条用的正文（识别模式为补过标点的识别结果）"
}
```

## 4. 输出清单

| 字段 | 说明 |
|---|---|
| `video` / `still` | 透明底字幕 WebM（无音频）/ 透明 PNG 静帧 |
| `source` | `{ mode, jobId, audio, name, duration }`；文案模式 `jobId` 为来源配音，识别模式为 null、`audio` 为素材 url |
| `transcript` | 仅识别模式：补过标点的识别全文 |
| `subtitles` | `{ url, ass, cues: [{ text, start, end }] }`。时间相对音频开头；`url` 为完整 JSON（含 `keywords`） |

## 5. 进时间轴

- 入口：在时间轴选中片段后右键。选中里有音频轨片段时才出现「烧录字幕」。每段音频：
  - 由技能任务生成（`<jobId>_voice.wav` / `<jobId>.webm` / `<jobId>.mp4`）且该任务有配音文案 → 文案模式；
  - 否则只要服务端读得到文件（AI 生成的，或桌面版导入、带本机路径的素材）→ 识别模式；
  - 浏览器里拖进来的素材（只有 blob URL）读不到，跳过并提示；都烧不了时该项置灰。
- 支持多选，每段各发一个任务，`anchorClipId` 为该片段。参数在「烧录字幕」弹窗里选（字体 / 字号 / 距底 + 底部·偏下·居中·顶部预设 / 每条字数 / 关键词，右侧实时预览，背景取节目画面当前帧；选择记在本机，下次沿用），弹窗标题会注明其中几段走语音识别。画幅取当前工程（不在选项里时取同比例的一档），`autoTimeline` 为 true。完成后自动入轨，失败时弹出提示。
- WebM 进媒体库 AI 文件夹备用，不自动上轨。
- 入轨时优先对齐 `anchorClipId` 那段音频片段（本机素材的 url 和服务端记下的对不上，所以按片段 id 直接认），其次是来源配音在当前序列里选中的片段、再次第一段，按它的起点、入点和速度把 cue 换算到时间线：`片段起点 + (cue 时间 − 入点) / 速度`，入出点以外的 cue 丢掉或裁短。每条 cue 成为字幕轨上一个文字片段，并链接到该音频片段。音频不在时间轴上时，从播放头开始放。
- 文字片段样式按参数换算，无入场 / 出场动画。文字片段只能单色，关键词高亮只保留在 WebM 里。

## 6. 依赖与约束

| 依赖 | 位置 | 约束 |
|---|---|---|
| burn-subtitles | `BURN_SUBTITLES_DIR`，默认 `~/.cursor/skills/burn-subtitles/scripts` | 只 import `burn_subtitles`，调用 `apply_options` / `set_font` / `detect_silences` / `align_chunks` / `pick_keywords` / `write_ass` / `asr_char_timeline` / `ffprobe_duration` |
| faster-whisper | burn-subtitles 的 Python 环境 | 仅识别模式；首次会加载模型 |
| zhconv | 同上，可选 | 识别结果繁转简；没装时保持原样 |
| ffmpeg | 宿主解析的 ffmpeg | 需要 libass 的 `alpha` 选项（ffmpeg ≥ 6）和 libvpx-vp9 |

用 ffmpeg 叠加 WebM 时，须在 `-i` 前写 `-c:v libvpx-vp9` 才能读到透明通道。
