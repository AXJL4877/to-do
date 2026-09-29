# 技能包接入协议 v1（以「黑板手绘」为例）

一句话输入 → WebM 输出。协议分三层，各自独立版本化：

| 规范 | 谁写 | 谁读 | 文件 |
|---|---|---|---|
| `todo-skill-pack/1` | 技能作者 | 宿主 | `skill.json` |
| `todo-skill-render/1` | 宿主 | 渲染端（`render.py`） | `<jobId>_request.json` + stdout 协议行 |
| `todo-skill-output/1` | 宿主 | 调用方（UI / CLI / 其它 agent） | `<jobId>.json` |

本包走 `elements` 管线，宿主执行三段：**规划**（LLM 把提示词拆成元素）→ **素材**（每个元素生一张黑底粉笔图）→ **渲染**（本地进程按蒙版逐元素书写，输出 WebM）。另一种 `voice` 管线（文案 → 配音 → 字幕）见 [`../voice-subtitle/PROTOCOL.md`](../voice-subtitle/PROTOCOL.md)。

---

## 1. 调用方接口

### 1.1 HTTP（`npm run dev` 后，默认 `http://127.0.0.1:5173`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/ai-skills` | 列出技能包公开描述（参数表、预览图），不含提示词模板 |
| GET | `/api/ai-skills/<id>/previews/<n>` | 预览图 |
| POST | `/api/ai-skill-plan` | 只做规划，返回 `{ ok, plan }`，供用户编辑后再提交 |
| POST | `/api/ai-jobs` | 入队，返回 `{ ok, job }` |
| GET | `/api/ai-jobs/<jobId>` | 状态：`queued / running / done / error`，`phase` 为带百分比的中文阶段 |
| GET | `/api/ai-jobs/<jobId>/output` | 完成后返回 `todo-skill-output/1` 清单 |
| POST | `/api/ai-jobs/<jobId>/retry` | 失败重试：复用已生成的规划和元素图，不重复扣费 |

入队请求体：

```json
{
  "kind": "skill",
  "skillId": "builtin.chalk-hand",
  "prompt": "一个小人把工资分成三份，一份存银行，一份买基金，一份留作生活费",
  "params": { "background": "transparent", "duration": 10 },
  "plan": null,
  "images": null,
  "autoTimeline": false
}
```

- `prompt`：必填，≤ `input.maxLength`（本包 400 字）。花括号会被清掉。
- `params`：可省略任意项（取默认）；**未声明的键、越界数值、不存在的选项一律 400 拒绝**；数值按 `step` 吸附。
- `plan`：可选。给了就跳过 AI 规划（格式见 §3.1）；元素数须与 `params.elements` 一致（`elements=0` 时不限）。
- `images`：可选，与 `plan.elements` 对齐的 dataUrl 数组（png/jpg/webp，可含 `null`）；给了的元素不再生图。必须同时给 `plan`。
- `autoTimeline`：前端完成后自动放上时间线。

### 1.2 CLI（每条命令 stdout 一行 JSON）

```bash
npm run skill -- list
npm run skill -- plan  --skill builtin.chalk-hand --prompt "……" --set elements=3
npm run skill -- start --skill builtin.chalk-hand --prompt "……" --set background=transparent --set duration=10 \
                       [--plan plan.json] [--image 1=a.png --image 2=b.png]
npm run skill -- status <jobId>
npm run skill -- fetch  <jobId> --out ./out --wait
```

`fetch` 下载 webm、成品静帧、全部蒙版，并在输出目录写一份带本地路径的清单。

---

## 2. 可调参数（`builtin.chalk-hand`）

| 分组 | id | 类型 | 取值 | 默认 | 说明 |
|---|---|---|---|---|---|
| 画面 | `elements` | number | 0~6，步长 1 | 0 | 元素数；0 = AI 决定（通常 2~4） |
| 画面 | `layout` | select | `auto` `hero_left` `diagonal_fall` `conveyor_wave` `fork_right` `stack_rise` `climax_right` `grid` | auto | 叙事版式；竖屏自动退化为网格 |
| 画面 | `size` | select | `1280x720` `1920x1080` `1080x1920` `1080x1080` | 1280x720 | 画幅 |
| 画面 | `background` | select | `board` `transparent` `black` | board | 黑板纹理 / 透明（带 alpha）/ 纯黑 |
| 画面 | `tone` | select | `chalk` `ink` | chalk | 仅 `background=transparent`：白粉笔或深色墨线（叠浅色画面用） |
| 画面 | `palette` | select | `color` `mono` | color | 彩色粉笔点缀 / 纯白；影响生图提示词 |
| 节奏 | `duration` | number | 3~30 秒，步长 0.5 | 8 | 总时长（含停留） |
| 节奏 | `hold` | number | 0~5 秒，步长 0.5 | 1.5 | 写完后停在成品画面 |
| 节奏 | `fps` | select | `24` `30` | 30 | 帧率 |
| 笔触 | `hand` | select | `chalk` `none` | chalk | 是否显示粉笔手 |
| 笔触 | `handSize` | number | 0.6~1.4，步长 0.1 | 1 | 仅 `hand=chalk`；相对画面短边 |
| 笔触 | `stroke` | select | `skeleton` `grid` | skeleton | 沿线条骨架书写 / 块状扫写 |
| 笔触 | `fill` | select | `wipe` `brush` `none` | wipe | 轮廓扫色 / 沿笔刷色 / 只描线 |
| 输出 | `quality` | select | `high` `standard` `draft` | standard | VP9 CRF 24 / 31 / 38 |

`when`：参数只在依赖参数取指定值时显示（UI 隐藏，但服务端仍接受并按默认补齐）。

输出带透明通道的条件由 `output.alphaWhen` 声明：本包为 `background=transparent`。

---

## 3. 数据结构

### 3.1 规划 plan

```json
{
  "title": "工资三分法",
  "notes": "先主角后分支，最后点题",
  "elements": [
    { "label": "拿工资的小人", "draw": "a stick figure holding a paycheck ...", "role": "hero", "weight": 1.5 },
    { "label": "银行", "draw": "a small bank building with a piggy bank ...", "role": "support", "weight": 1 },
    { "label": "三分法", "draw": "chalk lettering \"三分法\"", "role": "accent", "weight": 0.6 }
  ]
}
```

| 字段 | 约束 |
|---|---|
| `elements` | 1~`planner.maxElements`（本包 6），**顺序即书写顺序** |
| `label` | ≤12 字，缺省为「元素 N」 |
| `draw` | 必填，≤240 字符，英文画面描述，进生图模板 `{{draw}}` |
| `role` | `hero`（主视觉，版式里占最大区域）/ `support` / `accent`（只写短字） |
| `weight` | 0.5~3，书写时长权重；实际时长 ∝ weight × 墨迹面积 |

### 3.2 渲染请求 `todo-skill-render/1`（宿主 → 渲染端）

```json
{
  "spec": "todo-skill-render/1",
  "jobId": "s_mfx1_ab12",
  "outDir": "D:/…/.data/ai-generated",
  "ffmpeg": "C:/…/ffmpeg.exe",
  "params": { "size": "1280x720", "fps": "30", "duration": 8, "…": "已解析的完整参数" },
  "elements": [
    { "id": "e1", "label": "拿工资的小人", "role": "hero", "weight": 1.5, "image": "D:/…/s_mfx1_ab12_el1.png" }
  ],
  "outputs": { "prefix": "s_mfx1_ab12", "video": "s_mfx1_ab12.webm", "still": "s_mfx1_ab12_still.png" },
  "keepWork": false
}
```

- `image`：**纯黑底上的粉笔画**（亮度即墨迹）。渲染端用 soft_cutout 抠透明并裁到内容框，不要求透明 PNG。
- 调用：`python render.py --request <file>`，工作目录为技能包目录。Python 可用 `TODO_PYTHON` 指定；黑板报核心路径用 `BLACKBOARD_ROOT`（默认 `D:\desktop\黑板报`）。
- `keepWork=true` 保留 `_<prefix>_work/`（annotation.json、masks/ 等中间件）便于排查。

### 3.3 stdout 协议行（渲染端 → 宿主）

每行一条；不以 `@` 开头的都是日志。

```
@progress {"phase": "抠图|排版|书写渲染|编码", "pct": 0.42}
@result   { …见下… }          退出码 0
@error    {"message": "…"}    退出码 1
```

宿主把进度折算为整体百分比：规划 0~5%，生图 5~40%，渲染 40~100%（抠图+排版 10%、书写 85%、编码 5%）。超时 `runtime.timeoutSec`（本包 1800s）后强杀。

`@result`（文件名均相对 `outDir`）：

```json
{
  "video": "s_…webm", "still": "s_…_still.png", "alpha": false,
  "width": 1280, "height": 720, "fps": 30, "frames": 240, "duration": 8.0, "layout": "hero_left",
  "elements": [
    { "id": "e1", "label": "…", "role": "hero", "box": [x, y, w, h], "startMs": 0, "durationMs": 2600,
      "mask": "s_…_mask_e1.png", "cut": "s_…_cut_e1.png" }
  ]
}
```

### 3.4 输出清单 `todo-skill-output/1`（宿主 → 调用方）

`@result` 的全部字段，文件改为 `/ai-generated/…` URL，另加：

| 字段 | 说明 |
|---|---|
| `spec` / `jobId` / `manifest` | 规范名、任务 id、清单自身 URL |
| `skill` | `{ id, version, name }` |
| `prompt` / `params` | 实际执行的输入（已解析） |
| `plan` | `{ title, notes, source }`，`source` = `ai` / `user` / `fallback`（规划失败时整句当一个元素） |
| `elements[i]` | 追加 `draw`、`weight`、`image`（原始元素图 URL）；`mask` 为该元素白色蒙版，`cut` 为抠好的透明元素 |

### 3.5 WebM 格式

- VP9（libvpx-vp9），`-row-mt 1`，CRF 见 `quality`。
- `alpha=false`：`yuv420p`。
- `alpha=true`：`yuva420p`，**直通 alpha（非预乘）**；alpha 取粉笔亮度，粉笔手整只不透明。浏览器 `<video>` / Chrome / Premiere（带 VP9 插件）/ ffmpeg `-c:v libvpx-vp9` 解码均可读到透明；**ffmpeg 默认的 vp9 解码器会丢 alpha，叠加时须显式 `-c:v libvpx-vp9` 放在 `-i` 前。**

---

## 4. 写一个新的技能包

放到 `$TODO_DATA_DIR/skills/<name>/`（同 id 覆盖内置），包含 `skill.json` + 入口脚本 + 可选 `previews/`。宿主加载时严格校验，任何错误在 `/api/ai-skills` 的 `errors` 中列出且该包不可用：

- 顶层只允许：`spec id name version author description tags previews pipeline input output params quick planner assets runtime`。
- `quick`（可选）：0~6 个 `params` 里的 id，编辑器 Skill 侧栏直接露出这些参数，其余进工作台；省略时侧栏取前几个可见参数。
- `pipeline`：`elements`（默认，本包）或 `voice`（见口播字幕协议）。`elements` 必须有 `planner` + `assets`，`input.maxLength` ≤1000；`voice` 不许带这两项，`input.maxLength` ≤5000。
- `id` 形如 `author.skill-name`；`version` 为 `x.y.z`。
- `params[]`：`select`（1~16 个选项，值 `[a-zA-Z0-9_.:-]{1,32}`，可带 `prompt` 片段）或 `number`（`min max step default`，可带 `unit`）；`group` ∈ `scene text timing stroke output`；`when` 只能依赖其它 select。
- `planner.countParam`：须是 `min=0 step=1 max≤maxElements` 的 number 参数。
- `assets.template`：必须含 `{{draw}}`；占位符只能是 `draw label role` 或「每个选项都有 prompt」的 select 参数 id。
- `runtime`：v1 只支持 `python`，`entry` 须为包内 `.py` 相对路径，`timeoutSec` 30~7200。
- 渲染端只需实现 §3.2 输入和 §3.3 输出。

自检：`npm run skills:check`（加 `-- --render` 跑离线端到端，约 2 分钟）。
