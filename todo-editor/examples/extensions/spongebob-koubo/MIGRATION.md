# 海绵宝宝口播迁移报告

## 基本资料

- 原工作流：`d:\Desktop\手绘风格\trial\koubo`，入口 `python run_pipeline.py --all`。
- 宿主：`d:\Desktop\to_do\todo-editor`（2026-10-09 production / scene-clips）。
- 扩展：`studio.spongebob-koubo` 1.0.0，包 `deliverables/spongebob-koubo.todoext`。
- 路线 A。编辑等级 E1：每贴纸独立透明层，位置/缩放/旋转/透明度走宿主。角色内部动作、红字碎裂、气泡转场仍在原整片渲染里，扩展入场只做淡入/升起时长。
- 基线：同一张纯色贴纸，`SB_RENDER=python` 逐帧 与 `SB_RENDER=ffmpeg` 滤镜，元素 ID 同为 hero/prop。

## 阶段归属

| 原阶段 | 输入 → 输出 | 归属 | 理由 |
|---|---|---|---|
| 口播/TTS | 文案 → wav + timing | 宿主 | 避免重复配音 |
| 镜头设计 | 文案 → 元素 label/draw | 宿主 planner | 扩展只提供海绵贴纸提示词 |
| 生图 | draw → 透明 PNG | 宿主 assets | 不把密钥打进包 |
| 贴纸入场 | PNG → webm + hold | 本包 render.py | E1 可编辑层 |
| 整片海滩/红字/BGM | 成片 mp4 | 原工作流 | 宿主没有这套 BGM 切点；不烘焙进单视频冒充可编辑 |
| 最终入轨合成 | 图层 → 工程 | 宿主 | crop 经 elementTransform |

## 参数映射

| 原参数 | params.id | 默认 | 消费 | 缓存 |
|---|---|---|---|---|
| 画幅 | size | 1920x1080 | parse_size | RENDER_PARAM_KEYS |
| 帧率 | fps | 30 | 入场帧数 | 同上 |
| 入场 | enter | fade | 结果 enter 标签 | 同上 |
| 速度 | drawSpeed | 1 | frames = fps*0.8/speed | 同上 |

改 `drawSpeed` 1→2 时 hero 帧数变少（runtime 断言）。

## 元素

| 对象 | ID | 产物 | 可编辑 |
|---|---|---|---|
| 角色贴纸 | 请求里的 element.id | `{prefix}_{scene}_{id}.webm` + `_hold.png` | 位置缩放旋转透明度 |
| 道具 | 同上 | 同上 | 同上 |

声音、字幕、背景不写进元素视频。crop 含 8px 边。tip 为空，不跟粉笔手。

## 性能

瓶颈是原整片 Python/PIL 逐帧叠 1080p。扩展入场改为 FFmpeg 滤镜，元素之间最多 2 路并行。基线是同请求的 PIL 逐帧串行。冷/热各测 3 次，见自检 `PERFORMANCE.json`。

未并行的部分：同一条 webm 的编码必须按帧顺序；配音必须先于分镜。

## 已知边界

- 扩展不包含 BGM 混音、红字碎裂、气泡遮罩。那些仍用原 `mix_bgm.py` / `kit/render.py`。
- 自检导出是 FFmpeg 叠透明层，不是编辑器里点导出按钮的那一次人工操作。
- 真实 TTS / 生图未在自检中调用。
