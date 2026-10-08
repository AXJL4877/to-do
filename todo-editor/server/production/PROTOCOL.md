# 成片框架 `todo-production/1`

长口播 → 可局部修改的成片。宿主负责分段、配音、分镜、生图、字幕、调度、缓存和入轨；技能包只提供 **提示词 + 参数 + 渲染端**。黑板手绘（`builtin.chalk-hand` 3.x）是第一个接入的包，以后的「边讲边画」类扩展照本文接入，不需要改宿主代码。

```
长文案 ──分段层──▶ 口播段[] ──配音层──▶ wav + 逐字时间 ──分镜层(LLM)──▶ 镜头[] ─┬─▶ 元素 ──素材层──▶ 候选图[]
                                                    └──字幕层──▶ 字幕条          └─▶ 渲染层（技能包渲染端）──▶ 书写 WebM + 定格 PNG
整片 ──底板层──▶ 底板图                         编辑器合成层（src/lib/productionTimeline.ts）把以上产物对账到时间轴
```

| 模块 | 文件 | 职责 |
|---|---|---|
| 文档 | `doc.mjs` | 文档结构、存取、指纹 `stableHash`、编辑操作 `applyEdits`、局部范围 `scopeTester` |
| 分段层 | `segment.mjs` | 长文案切成口播段（LLM 只给切点，不改写原文） |
| 生成层 | `layers.mjs` | `voice` `storyboard` `asset` `render` `subtitles` `plate`，接口一致：`hash` / `dirty` / `run` |
| 运行器 | `runner.mjs` | 只跑脏节点；各层并发闸、取消、加权进度、失败汇总 |
| 任务 | `job.mjs` | 新建 / 编辑 / 上传 / 作为后台任务执行（接 `aiJobs` 队列） |
| 合成层 | `src/lib/productionTimeline.ts` | 前端：把文档产物按「产物键 + 版本」对账到时间轴 |
| 工作台 | `src/components/ProductionStudio.tsx` | 前端：分段 / 镜头 / 元素 / 候选图的编辑界面 |

---

## 1. 文档

存于 `$TODO_DATA_DIR/productions/<id>.json`，id 形如 `p_<时间36进制>_<4位随机>`，产物文件在 `ai-generated/`，文件名都以 id 开头。

```
production { id, skillId, title, titleLocked?, script, params, cast[], rev, status, lock, plate?, hand?, segments[] }
└─ segment { id, title, text, voice?, plan?, subtitles?, boards[] }
   ├─ voice     { hash, audio, timing, duration, speaker, phrases[{ text, start, end, sentence }] }
   ├─ plan      { hash, voiceHash, source: ai|user|fallback, notes }
   ├─ subtitles { hash, params, cues[{ text, start, end, keywords[] }] }
   └─ board { id, start(短语编号), render?{ hash, result }, elements[] }
      └─ element { id, label, draw, role, weight, at(短语编号), pick, variants[] }
         └─ variant { id, source: ai|upload, hash, file, locked?, error? }
```

- **短语编号是时间锚点**：镜头 `start`、元素 `at` 都是本段 `voice.phrases` 的下标，换配音后由分镜层重新对齐，渲染时才换算成毫秒。
- **指纹即缓存**：每层节点记下生成时输入的 `hash`；输入没变、文件还在就直接复用，从不重复扣费。哪些节点「待生成」完全由指纹算出，前端看到的 `dirty` 也是这样来的。
- `rev` 每次存盘 +1；编辑器只在 `rev` 变化时才拉整份文档。
- `cast`：分段时 LLM 识别的反复出现的角色及英文外观，分镜层要求画到这些角色时带上原样外观，保证全片同一个人长得一样。

## 2. 分段层（`segment.mjs`）

1. **切句**：句号 / 问号 / 叹号 / 分号 / 换行处断开；超过约 0.9 × 目标字数的句子再按逗号拆分句。
2. **边界**：空行是段落边界（优先切）；单独一行的 `---` 是**硬边界**（一定切，且不进配音）。
3. **决定切点**（参数 `split`）：
   - `semantic`：句子表（`[编号] (字数) 句子`）发给 LLM，只回切点、全片标题、小标题、角色设定；失败自动退化成 `paragraph`；
   - `paragraph`：按空行切，过长再按字数；
   - `length`：只按字数。
4. **兜底规则 `enforceLimits`**（三种模式都过）：每段尽量接近 `segmentChars`、绝不超过上限；硬边界一定切且不跨越合并；不在承接句（「于是 / 所以 / 因为 / 这叫 / 也就是说…」开头）前切开。
5. 各段文本按顺序拼起来就是原文（段内保留换行）。

## 3. 生成层（`layers.mjs`）

| 层 | 粒度 | 指纹输入 | 产出 | 并发 |
|---|---|---|---|---|
| `voice` | 段 | 文案 + 音色 | wav、timing.json、短语表 | 2 |
| `storyboard` | 段 | 配音指纹、`boardSec`、角色、规划提示词 | 镜头 + 元素（LLM；失败按句兜底） | 2 |
| `asset` | 元素 | 生图提示词（技能包模板 + 参数）、模型、清晰度 | 候选图 | `TODO_AI_CONCURRENCY`（默认 4） |
| `render` | 镜头 | 时间表、`RENDER_PARAM_KEYS`、包版本、各元素选中图 | 每元素进场 WebM（手写 / 盖章扬尘 / 渐显）+ 定格 PNG + 笔尖轨迹（手写才有） | 1 |
| `subtitles` | 段 | 配音指纹、画幅、每条字数 | 字幕条（只对时不烧录） | 1 |
| `plate` | 整片 | 画幅、包版本 | 底板图 | — |

保护用户改动的规则：

- 分镜被人改过（`plan.source = 'user'`）后，只要配音没变就不让 AI 重拆；改了文案才会重拆。
- 重拆分镜时，画面描述没变的元素沿用原有候选图和选择。
- 选定（`pickVariant`）或上传的候选图被锁定，参数改了也不会被自动重画；未锁定的 AI 图过期时新开一张候选，旧图保留可选回。
- 同一提示词的第一张图按指纹命名，跨段 / 重拆复用。

## 4. 运行器（`runner.mjs`）

```
（文档无段时）分段 → 每段：配音 → 分镜 → 字幕 ∥ 每个镜头：元素候选图 → 渲染     整片：底板
```

- 每层一个先进先出并发闸，靠前的段先拿名额：第 1 段在渲染时后面的段还在配音 / 生图，产物一出来就存盘（节流 400ms），编辑器流式入轨。
- **局部范围 `scope`** `{ segments?, boards?, elements? }`（空 = 全部）：节点自身或祖先被点名才处理；点名元素会连带重渲它的镜头；上游没准备好的依赖（例如改了文案的那段配音）自动补上。配音和分镜只在整段被点名时重做。
- `stopAfter: 'plan'`：只做到分镜（先审分镜，再生成）。
- 单个节点失败不牵连别的节点，错误记进 `status.failed[]`，最后整体报错；重试只跑失败和没做完的。
- 停止：已开始的那一步做完（等待在途步骤收尾），排队的不再开始，任务以 `done`、阶段「已停止」结束。
- 进度按层加权（配音 1、分镜 1、生图 2、渲染 3、字幕 0.5）。

## 5. 任务与接口

成片运行是 `aiJobs` 里 `kind = 'skill'`、`request.productionId` 有值的任务，独占 `production` 车道（并发 1）。同一份成片已有排队中的运行时，新请求的范围**合并**进去，不重复排队。

| 方法 | 路径 | 请求体 | 说明 |
|---|---|---|---|
| GET | `/api/ai-productions?ids=a,b` | — | 摘要列表 |
| POST | `/api/ai-productions` | `{ skillId, script, params?, title?, run?, stopAfter? }` | 新建（文案 ≤ 包的 `input.maxLength`，黑板手绘 12000 字），可同时排队运行 |
| GET | `/api/ai-productions/<id>` | — | 整份文档（带各节点 `dirty`、`queuedJobId`、`runningJobId`） |
| DELETE | `/api/ai-productions/<id>` | — | 删除文档（运行中拒绝） |
| POST | `…/<id>/edit` | `{ ops: Op[] }` | 编辑，见 §6；运行中拒绝 |
| POST | `…/<id>/run` | `{ scope?, stopAfter? }` | 排队运行 |
| POST | `…/<id>/cancel` | — | 停止 |
| POST | `…/<id>/upload` | `{ element, dataUrl }` | 上传一张图作为元素候选并选中 |

也可以走旧入口：`POST /api/ai-jobs` 提交 `pipeline: production` 的技能包时，宿主自动新建成片并排队运行。

## 6. 编辑操作

`POST …/edit` 的 `ops` 按顺序执行，全部成功才存盘；改完哪些节点要重做由指纹自动算出，下次 `run` 只补这些。

| op | 字段 | 效果 |
|---|---|---|
| `setTitle` | `title` | 改标题并锁定（AI 分段不再覆盖） |
| `setParams` | `params` | 按技能包校验后整体替换参数 |
| `setSegmentText` | `segment, text` | 改文案 → 该段重配音、重拆分镜 |
| `splitSegment` | `segment, at` | 在第 `at` 个字处切成两段 |
| `mergeSegment` | `segment` | 与下一段合并 |
| `removeSegment` | `segment` | 删段（至少留一段） |
| `replanSegment` | `segment` | 丢掉分镜，下次让 AI 重拆 |
| `addBoard` / `removeBoard` | `segment, start, element` / `board` | 加 / 删镜头 |
| `addElement` / `removeElement` | `board, element` / `element` | 加 / 删元素 |
| `moveElement` | `element, delta` | 镜头内前后挪（交换起笔点） |
| `setElement` | `element, patch{label,draw,role,weight,at}` | 改 `draw` 会新开一张候选 |
| `addVariant` / `removeVariant` / `pickVariant` | `element[, variant]` | 再来一张 / 删候选 / 选定并锁定 |
| `uploadVariant` | `element, file` | 用已上传文件作候选（一般走 `/upload`） |

## 7. 编辑器合成层（`productionTimeline.ts`）

每份成片在工程设置里记一条 `settings.aiProductions[id] = { t0, auto, placed, createdAt }`。主窗每 2 秒轮询（与口播任务同一个 tick），`rev` 变化时拉文档并对账：

| 产物键 `meta.source.key` | 轨道 | 版本 `meta.source.rev` |
|---|---|---|
| `<seg>/voice` | 音频轨 | 配音指纹 |
| `<seg>/<el>/draw`、`<seg>/<el>/hold` | 第 j+1 层视频轨（元素位 j） | 镜头渲染指纹 |
| `<seg>/subs` | 字幕轨 | 字幕指纹 |
| `plate` | 最底层视频轨 | 底板指纹 |

- **原位替换**：版本变了就换成新片段；用户挪 / 缩放过的元素保留其变换（以入轨时的排版签名 `source.layout` 判断是否被动过）。
- **不复活**：用户删掉的片段，版本没变就不放回；版本变了（重新生成过）才再放。
- **涟漪**：各段按其配音片段的实际位置首尾相接，从 `t0` 开始；某段配音变长 / 插入新段时后面整体顺移，删段时收回。画面和字幕都 `linkedId` 链接本段配音，按配音片段当前位置换算。
- **底板**跟随整片长度；`auto = false` 时只更新记录不碰时间轴。
- 回归：`npm run production:test`（隐藏 Electron 窗口里在真实 store 上跑）。

## 8. 接入一个新扩展

1. `skill.json` 写 `"pipeline": "production"`，带 `planner`（分镜 system 提示词、`maxElements`）和 `assets`（含 `{{draw}}` 的生图模板），`input.maxLength` ≤ 20000。参数可用分组 `story`（`split` `segmentChars` `boardSec` `variants`）和 `output`（`plate` `subtitles` `subtitleChars`）复用宿主行为，其余参数由你的渲染端解释；影响渲染的参数须列入 `RENDER_PARAM_KEYS`（或沿用同名参数）。
2. 渲染端实现 `todo-skill-render/1` 的两个模式：
   - `mode: "scene-clips"`：一次一个镜头，输入 `scene{ id, startMs, endMs, elements[{ id, role, weight, image, atMs, windowEndMs }] }`，`@result.scene.elements[]` 给出 `box crop startMs durationMs frames video hold tip`（格式见 [`../skills/chalk-hand/PROTOCOL.md`](../skills/chalk-hand/PROTOCOL.md) §5.3）；
   - `mode: "plate"`（可选，`plate` 参数为 `board` 时调用）：写出 `outputs.plate`，`@result` 带 `{ plate, width, height }`。
3. 自检：在 `scripts/skill-pack-selfcheck.mjs` §6c 的写法上把服务换成假实现，跑一遍整片 + 局部修改；`npm run skills:check`。

不需要渲染端处理的事：分段、配音、对时、分镜、生图、缓存、局部重做、字幕、入轨，这些都在宿主。
