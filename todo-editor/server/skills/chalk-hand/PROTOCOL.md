# 技能包接入协议 v1（以「黑板手绘」为例）

自然语言输入 → WebM 输出。协议分三层，各自独立版本化：

| 规范 | 谁写 | 谁读 | 文件 |
|---|---|---|---|
| `todo-skill-pack/1` | 技能作者 | 宿主 | `skill.json` |
| `todo-skill-render/1` | 宿主 | 渲染端（`render.py`） | `<jobId>_request.json` + stdout 协议行 |
| `todo-skill-output/1` | 宿主 | 调用方（UI / CLI / 其它 agent） | `<jobId>.json` |

黑板手绘（`builtin.chalk-hand` 2.x）走 `narrated` 管线：**输入口播** → 配音拿逐字时间 → LLM 按语句分板、拆元素 → 元素生图 → 渲染端说到哪画到哪并混入配音，见 **§5**；本包参数见 §2。

§1、§3 以 `elements` 管线（一句话 → 单幅黑板，黑板手绘 1.x 的形态）讲通用协议：宿主执行 **规划**（LLM 把提示词拆成元素）→ **素材**（每个元素生一张黑底粉笔图）→ **渲染**（本地进程按蒙版逐元素书写）。写这类包可以照 [`scripts/fixtures/chalk-elements.skill.json`](../../../scripts/fixtures/chalk-elements.skill.json)（自检夹具，参数 `elements` `duration` `hold` 等），渲染端同样是本目录的 `render.py`。下文 elements 示例里的 `author.my-chalk` 指这样一个包。配音 / 字幕管线见 [`../tts-voice/PROTOCOL.md`](../tts-voice/PROTOCOL.md)、[`../voice-subtitle/PROTOCOL.md`](../voice-subtitle/PROTOCOL.md)。

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
  "skillId": "author.my-chalk",
  "prompt": "一个小人把工资分成三份，一份存银行，一份买基金，一份留作生活费",
  "params": { "background": "transparent", "duration": 10 },
  "plan": null,
  "images": null,
  "autoTimeline": false
}
```

- `prompt`：必填，≤ `input.maxLength`（夹具 400 字；黑板手绘口播 3000 字）。花括号会被清掉。
- `params`：可省略任意项（取默认）；**未声明的键、越界数值、不存在的选项一律 400 拒绝**；数值按 `step` 吸附。
- `plan`：可选。给了就跳过 AI 规划（格式见 §3.1）；元素数须与 `params.elements` 一致（`elements=0` 时不限）。
- `images`：可选，与 `plan.elements` 对齐的 dataUrl 数组（png/jpg/webp，可含 `null`）；给了的元素不再生图。必须同时给 `plan`。
- `autoTimeline`：前端完成后自动放上时间线。
- `placement`：可选，自动入轨位置。`"playhead"` 从 `placeAt`（秒，提交时的播放头）开始，那里被占的层换到空轨、整组不挪；`"end"` 接在整条时间线最后一个片段后面。省略时沿用旧规则：播放头处这组要占的轨都空就从播放头放，否则接在这几条轨末尾。

### 1.2 CLI（每条命令 stdout 一行 JSON）

```bash
npm run skill -- list
npm run skill -- plan  --skill author.my-chalk --prompt "……" --set elements=3
npm run skill -- start --skill author.my-chalk --prompt "……" --set background=transparent --set duration=10 \
                       [--plan plan.json] [--image 1=a.png --image 2=b.png]
npm run skill -- start --skill builtin.chalk-hand --prompt "整段口播……" --set drawSpeed=1.5
npm run skill -- status <jobId>
npm run skill -- fetch  <jobId> --out ./out --wait
```

`fetch` 下载 webm、成品静帧、全部蒙版，并在输出目录写一份带本地路径的清单。

---

## 2. 可调参数（`builtin.chalk-hand`）

| 分组 | id | 类型 | 取值 | 默认 | 说明 |
|---|---|---|---|---|---|
| 配音 | `voice` | select | `mizai` `clone` | mizai | 咪仔 / 火山声音复刻 2.0 |
| 配音 | `cloneId` | text | `S_…` | — | 仅 `voice=clone` |
| 画面 | `scenes` | number | 0~80，步长 1 | 0 | 黑板数；0 = AI 按话题换板（约每 8~15 秒一块） |
| 画面 | `layout` | select | `auto` `hero_left` `diagonal_fall` `conveyor_wave` `fork_right` `stack_rise` `climax_right` `grid` | auto | 元素的默认排版（入轨后可随意拖动缩放）；竖屏自动退化为网格 |
| 画面 | `size` | select | `1280x720` `1920x1080` `1080x1920` `1080x1080` | 1280x720 | 画幅 |
| 画面 | `tone` | select | `chalk` `ink` | chalk | 白粉笔或深色墨线（叠浅色画面用）；产物一律透明底 |
| 画面 | `palette` | select | `color` `mono` | color | 彩色粉笔点缀 / 纯白；影响生图提示词 |
| 节奏 | `drawSpeed` | number | 0.5~3×，步长 0.25 | 1 | 书写速度（§5.3）；总时长跟随配音 |
| 节奏 | `tail` | number | 0~3 秒，步长 0.5 | 0 | 配音结束后停在最后一块黑板；0 = 画面和配音同时结束 |
| 节奏 | `fps` | select | `24` `30` | 30 | 帧率 |
| 笔触 | `hand` | select | `chalk` `none` | chalk | 入轨时是否自动给每个元素套「粉笔手书写」入场动画（元素素材本身不带手） |
| 笔触 | `handSize` | number | 0.6~1.4，步长 0.1 | 1 | 粉笔手图的大小，相对画面短边 |
| 笔触 | `stroke` | select | `skeleton` `grid` | skeleton | 沿线条骨架书写 / 块状扫写 |
| 笔触 | `fill` | select | `wipe` `none` | wipe | 写完淡入颜色 / 只描线。淡入占元素书写时长的 1/10，这段不落笔尖、不出手 |
| 输出 | `quality` | select | `high` `standard` `draft` | standard | VP9 CRF 24 / 31 / 38 |

elements 夹具没有配音 / `scenes` / `drawSpeed` / `tail`，换成 `elements`（0~6，0 = AI 决定）、`duration`（3~30 秒）、`hold`（写完停留 0~5 秒）。

`when`：参数只在依赖参数取指定值时显示（UI 隐藏，但服务端仍接受并按默认补齐）。

输出带透明通道的条件由 `output.alphaWhen` 声明：本包为 `{}`（始终透明）。elements 夹具仍有 `background`（`board` `transparent` `black`），`transparent` 时才带 alpha。

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
| `elements` | 1~`planner.maxElements`（夹具 6），**顺序即书写顺序** |
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

宿主把进度折算为整体百分比：规划 0~5%，生图 5~40%，渲染 40~100%（抠图+排版 10%、书写 85%、编码 5%）。超时 `runtime.timeoutSec`（夹具 1800s，黑板手绘 3600s）后强杀。

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
- `pipeline`：`elements`（默认）、`narrated`（本包，§5）、`tts`、`subtitle`。`elements` 必须有 `planner` + `assets`，`input.maxLength` ≤1000；`narrated` 同样要 `planner` + `assets`，`input.maxLength` ≤3000，不许带 `countParam`；`tts` / `subtitle` 不许带这两项，`input.maxLength` ≤5000。
- `id` 形如 `author.skill-name`；`version` 为 `x.y.z`。
- `params[]`：`select`（1~16 个选项，值 `[a-zA-Z0-9_.:-]{1,32}`，可带 `prompt` 片段）或 `number`（`min max step default`，可带 `unit`）；`group` ∈ `scene voice text timing stroke output`；`when` 只能依赖其它 select。
- `planner.countParam`：须是 `min=0 step=1 max≤maxElements` 的 number 参数。
- `assets.template`：必须含 `{{draw}}`；占位符只能是 `draw label role` 或「每个选项都有 prompt」的 select 参数 id。
- `runtime`：v1 只支持 `python`，`entry` 须为包内 `.py` 相对路径，`timeoutSec` 30~7200。
- 渲染端只需实现 §3.2 输入和 §3.3 输出。

自检：`npm run skills:check`（加 `-- --render` 跑离线端到端，约 2 分钟）。

---

## 5. 黑板手绘：口播管线（`narrated`）

口播文案（最长 3600 字，约 10 分钟）→ 配音 + 一块块黑板，**边生成边上时间轴**。HTTP / CLI、参数校验、元素生图模板、WebM 格式同上，这里只写不同的部分。

**这是有阶段产物的技能的标准做法**，以后的扩展照此接入：宿主每出一份可用的产物就写进任务的 `params.partial` 并落库，编辑器主窗每 2 秒轮询一次，把新产物放上时间轴（`autoTimeline` 为 false 时只收进媒体库）。不再合成一条成片。

### 5.1 宿主流程

| 步骤 | 做什么 | 产物（落盘后重试复用） | 发布到 `partial` | 整体进度 |
|---|---|---|---|---|
| 配音 | `TTS_timeline synth`，音色同「配音」技能（咪仔 / 克隆音） | `<id>_voice.wav` `<id>_timing.json` `<id>_script.txt` | `voice` | 0~10% |
| 拆分 | 短语表喂给规划模型（默认 `gemini-3.8-flash`，`TODO_AI_SKILL_MODEL` 可改），按语句分板、每板 1~4 个元素并给出起笔短语 | 写回任务 `request.plan` | `total` | 10~15% |
| 生图 | 每个元素一张 1:1 黑底粉笔图，全篇并发（`TODO_AI_CONCURRENCY`，默认 4） | `<id>_el<N>.png`（全篇扁平编号） | — | 15~100% 的 40% |
| 渲染 | 某块黑板的图齐了就排进渲染队列（一次渲一块），每个元素出一份裁到自身框的透明素材：书写 WebM + 定格 PNG + 笔尖轨迹 | `<id>_<sid>_<eid>.webm` `…_hold.png` `<id>_<sid>_clips.json` `<id>_hand.png` | `hand` `scenes[]` 追加 | 15~100% 的 60% |

生图和渲染流水线并行：第 1 块在渲染时后面的块还在生图。任何一步失败都会停掉尚未开始的工作并报错；已经渲好的黑板（`clips.json` 和文件都在）重试时直接复用。

入队 **不接受 `plan` / `images`**，`/api/ai-skill-plan` 也不支持本包（拆分依赖配音时间戳）。黑板手绘 1.x 留下的老任务（请求里带 `plan.elements`）重试时仍按 elements 流程执行。

**短语表**：`timing.json` 的 `sentences[].phrases[]` 展开成扁平列表，编号即时间锚点；没有 `phrases` 的句子整句算一个短语。发给模型的格式（句间空行）：

```
[0] 0.3s | 就像推着小雪球下坡，
[1] 2.3s | 随着不断向前滚动，

[2] 4.2s | 微小的体积最终会累积成惊人的大雪球。
```

### 5.2 分板规划与时间表

```json
{
  "title": "理财三步",
  "notes": "……",
  "scenes": [
    { "start": 0, "elements": [ { "at": 0, "label": "记账本", "draw": "…", "role": "hero", "weight": 1.5 } ] },
    { "start": 8, "elements": [ … ] }
  ]
}
```

整理规则（`sanitizeNarrationPlan`）：

- 没有有效 `draw` 的元素、没有元素的黑板先剔除；
- `start` 吸附到所在句的句首，同一句首的黑板合并，第一块强制为 0；超过 `scenes`（0 = 上限 80）时尾部并入前一块；
- `at` 夹进本块短语范围并按时间排序；每块最多 `planner.maxElements`（4）个，全篇最多 200 个；
- 规划失败时兜底：每句一块黑板（超过 80 句时相邻句合并），整句当主视觉。

时间表（`narrationSchedule`）：

- 黑板 k 从换板短语开口时切入（第一块从 0 开始），一直留到下一块第一个元素起笔（两板硬切，中间不空屏）；最后一块留到配音结束后 `tail` 秒。
- 元素从 `at` 短语开口时起笔（同板相邻元素至少隔 400ms；第一块黑板的第一个元素从第一句开口时起笔，片头不空屏），书写窗口到下一个元素起笔前 150ms（最后一个到本板结束前 150ms）。

### 5.3 渲染请求（`mode: "scene-clips"`，一次一块黑板）

```json
{
  "spec": "todo-skill-render/1", "jobId": "s_…", "mode": "scene-clips",
  "outDir": "…", "ffmpeg": "…", "params": { "drawSpeed": 1, "tone": "chalk", "…": "…" },
  "scene": { "id": "s1", "startMs": 0, "endMs": 7705, "elements": [
    { "id": "s1e1", "label": "…", "role": "hero", "weight": 1.5, "image": "…_el1.png", "atMs": 305, "windowEndMs": 4060 }
  ] },
  "outputs": { "prefix": "s_…" }
}
```

- 本块抠图后按 `layout` 排出默认位置，每个元素在整幅画布上单独书写，但写帧时**裁到元素自己的框**（`box` 外扩 8px、宽高取偶数，记为 `crop`）：一条透明 WebM（VP9 + alpha，只有笔画、不带手），时长 = 书写时长 + 200ms；写完存一张同尺寸的透明定格 PNG。
- 逐帧记下笔尖位置，按每秒最多 15 个点输出 `tip: [[素材秒, u, v], …]`（u/v 为 `crop` 内 0~1 坐标，只覆盖落笔区间）。
- 粉笔手单独写一张透明 PNG `<prefix>_hand.png`（尺寸按画幅短边 × `handSize`，已存在不重写），`@result.hand` 带 `width height tipX tipY`（笔尖在图里的 0~1 位置）。
- **书写速度**：元素书写时长 = 角色基准（hero 3.2s / support 2.4s / accent 1.5s）× 墨量系数（本板面积比的平方根，夹在 0.7~1.5）÷ `drawSpeed`，再夹进书写窗口（最短 0.6s）。速度越大画得越快，画完停在画面上；无论多慢都不会拖到下一个元素。

`@result`：

```json
{ "alpha": true, "width": 1280, "height": 720, "fps": 30,
  "hand": { "file": "s_…_hand.png", "width": 480, "height": 720, "tipX": 0.0104, "tipY": 0.0501 },
  "scene": { "id": "s1", "startMs": 0, "endMs": 7705, "layout": "…", "elements": [
    { "id": "s1e1", "label": "…", "role": "hero", "box": [x, y, w, h], "crop": [x, y, w, h], "startMs": 305, "durationMs": 3200, "frames": 102,
      "video": "s_…_s1_s1e1.webm", "hold": "s_…_s1_s1e1_hold.png", "tip": [[0.1, 0.21, 0.3], "…"], "mask": "…", "cut": "…" }
  ] } }
```

时间为相对配音 0 秒的绝对毫秒。

### 5.4 阶段产物 `params.partial` 与输出清单

运行中任务的 `params.partial`（完成后的清单字段相同，配音在 `narration`）：

```json
{
  "voice": { "text": "口播原文", "duration": 32.8, "speaker": "…", "audio": "/ai-generated/s_…_voice.wav", "timing": "/ai-generated/s_…_timing.json" },
  "tail": 1,
  "total": { "scenes": 6, "elements": 14 },
  "hand": { "url": "/ai-generated/s_…_hand.png", "width": 480, "height": 720, "tipX": 0.0104, "tipY": 0.0501 },
  "scenes": [ { "id": "s1", "index": 0, "fps": 30, "startMs": 0, "endMs": 7705, "elements": [ { "…": "同 @result，文件改为 URL，追加 draw、image" } ] } ]
}
```

编辑器入轨规则（`src/lib/narratedTimeline.ts`）：

| 产物 | 放到哪 | 时间 |
|---|---|---|
| `voice` | 音频轨 | 首次看到时的播放头处 |
| 元素 j 的书写 WebM | 第 j+1 层视频轨（同一元素位共用一条轨），变换按 `crop` 放回默认排版位置 | `startMs` 起，长 `frames / fps` |
| 元素 j 的定格 PNG | 同上 | 写完 ~ 本块 `endMs` |
- 画面片段都 `linkedId` 链接到配音片段，位置按配音片段当前的 `start / inPoint / speed` 换算，所以先把配音挪走、后到的黑板也会跟过去。
- 每个片段在 `meta.source.key` 记产物键（`voice`、`s1/s1e1/draw`、`s1/s1e1/hold`），本机另记一份已入轨清单；重启、刷新、重复轮询都不会重复放，用户删掉的也不会被放回来。
- 同一元素的书写片段和定格片段是一个整体：拖动 / 缩放 / 旋转其中一段，另一段自动跟着改。
- 粉笔手是书写片段自己的入场动画，**不是时间轴上的片段**：开关和大小记在 `meta.source.chalk.on / scale`（`hand` 参数不是 `none` 时入轨即打开）。动效模块「入场 → 粉笔手书写」预设（`src/lib/chalkHand.ts`）对选中的书写片段加上 / 改大小，同一处可移除。预览和导出在渲染时（`src/lib/chalkHandLayers.ts`，`renderProgramFrame` 与 `buildEditGraph` 都经过它）按 `tip` 和元素当下的时间、位置、大小、关键帧现算手的位置，画在元素所在轨正上方。老版本留在时间轴上的独立手片段（`meta.source.handFor`）打开项目时自动并回元素并删除。
- 素材收进媒体库的「黑板手绘 <标题>」文件夹。

完成清单在 §3.4 基础上去掉 `video still`，带 `audio`（配音 URL）、`tail`、`total`、`hand`、`scenes`、`narration`。配音是时间轴上独立的片段，对它右键「烧字幕」会直接按文案和逐字时间戳对时，不走语音识别。
