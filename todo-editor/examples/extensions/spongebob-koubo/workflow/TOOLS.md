# 扩展包运行契约（tools.json 的人类可读版）

> **原则：一切都在包中发生。** 这个包不依赖机器的 PATH、不依赖 `C:\Windows\Fonts`、
> 不依赖桌面上散落的字体或工具。下面这些"外部路径"都是**宿主注入的包外依赖**——
> 它们由 APP（`server/production/sourceWorkflow.mjs`）在启动包内工作流时注入。
>
> ⚠️ 直接用命令行跑 `run_pipeline.py` 时**必须自己补齐这些变量**，否则会以很难查的方式失败。
> 下面每一项都注明"漏了会怎样"——那都是真实踩过的。

## 必需的环境变量

| 变量 | 应指向 | 漏了会怎样 |
|---|---|---|
| `KOUBO_WORK` | 本次运行的工作目录（= 包内 `workflow/`） | 产物散落到别处，导入时找不到 |
| `KOUBO_CODE` | 包内 `workflow/` | 子步骤定位不到代码 |
| **`KOUBO_KIT_ASSETS`** | `<work>/kit_assets` | **最隐蔽**：生成的素材找不到 → `assets: missing <名字>` → **时间轴里只有背景，没有角色/道具**（"空层"） |
| `KOUBO_EMIT_LAYERS` | `1` | 不产出分层清单，时间轴无法逐元素入轨 |
| `TTS_TIMELINE_ROOT` | `vendor/tts-timeline`（TODO 内嵌） | 配音步骤直接失败：`找不到 TTS_timeline` |
| `MISHI_ROOT` | `vendor/mishi`（TODO 内嵌） | 生图接口不可用 |
| `FFMPEG` / `FFPROBE` | TODO 自带的 ffmpeg | 退回去碰机器 PATH |
| `PYTHONPATH` | `vendor; <workflow>; <workflow>/kit` | 找不到 `kit` / `mishi` 模块 |

## 关于 ffmpeg 的一个坑（Windows + 沙箱）

若 ffmpeg 可执行文件位于**受限工作区之内**，某些环境下它**只能写工作区内的路径**；
而本流水线的输出在 `%APPDATA%/todo-editor/...`（区外）→ ffmpeg 一启动就死，
Python 侧表现为 `BrokenPipeError: [Errno 32] Broken pipe`（**看不出是 ffmpeg 的问题**）。
对策：把 ffmpeg 复制到工作区外（例如 `C:\todo-ffmpeg`）再通过 `FFMPEG` 指过去。

## 字体（全部在包内）

`kit/fonts/` 下自带，代码一律**包内优先**，机器路径只作兜底：

| 用途 | 包内字体 | 说明 |
|---|---|---|
| 开场红字 | `字魂剑气手书(商用需授权).ttf` | 用户指定。**商用需授权**，分发前请确认授权 |
| 卡片黄字 | `Source Han Serif SC Heavy (TrueType).ttf` | 思源宋，OFL 可自由分发 |
| 字幕 / 气泡 | `Noto Sans SC Bold (TrueType).otf` | 原用微软雅黑 `msyhbd.ttc`，**授权上不能随包分发**，故换 OFL 的 Noto |
| 后备（缺字补） | `AmezumiGothic.ttf` | 开场字体缺某字时自动用它补，不丢字 |

## 音效

- 泡泡遮罩转场的音效来自 **`kit/assets/fx/bubble_wipe.mp4` 自带的音轨**，
  由 `layers_export._wipe_sfx()` 在生成期用 `atempo` 压到墙钟 2s 并 `volume=5.0`
  （与 `kit/render.py` 第 732-763 行的权威混音同参），输出成 `<stem>_sfx.wav`。
- 分层清单里带上元素级 `"sfx": "<stem>_sfx.wav"`，宿主 `bindLayerBoards` 把它复制进
  产物目录、`publicProduction` 换成 `/ai-generated/...` URL，最终落到**独立音轨**。
- `kit/assets/fx/bubble_wipe.wav` 是**兜底**：只有抽轨失败时才用（原速 4.01s，
  不做压速）。它保证不会静默没声音，抽轨成功时不参与。
- ⚠️ 同一个元素的 `sfx` 键只能由一个地方写。历史上 `_stitch_boards` 之后又复制了一份
  `bubble_wipe.mp4` 覆盖它，导致时间轴拿到裸 mp4 当音效 —— 这正是"气泡转场音效缺失"的成因。

## 一次性验证（不跑全流程）

```powershell
# 1) 契约齐全？
foreach ($v in 'KOUBO_KIT_ASSETS','TTS_TIMELINE_ROOT','MISHI_ROOT','FFMPEG') { "$v -> $([bool](Get-Item env:$v -ErrorAction SilentlyContinue))" }
# 2) 字体是否都落在包内？
python -c "import sys;sys.path.insert(0,r'kit');from kit import typo,bubble;print(typo.TITLE_FONT, typo.CARD_FONT, typo.SUB_FONT, bubble.FONT)"
```
