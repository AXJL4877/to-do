# TO DO · AI 原生改造：交付现状与纠正记录

> 这份文档写给**接手的人（或智能体）**，不是写给项目作者的。
> 目的：你不用读 22 轮对话，也能知道现在有什么、怎么验证、哪些话**不能**照着信。
>
> 生成时间：2026-10-11（第 23 轮）。配套设计文档：`docs/superpowers/specs/2026-10-11-ai-native-editor.md`。

---

## 1. 一句话现状

TO DO 现在是一个**本地可被任意进程驱动**的剪辑器：外部程序可以读它的机械可读工程规范、用同一批命令改**运行中**的活文档、渲一帧看图、撤销回退；三条接入面（CLI / MCP / HTTP）与打包版的进程内桥共用**同一份命令层、同一道写入闸门、同一份校验器**。

---

## 2. 怎么自己验证（照抄即可）

```powershell
cd <repo>/todo-editor

# 全量测试：148 个用例 + 主进程桥冒烟(6) + MCP 冒烟(13)
npm run spec:test

# 类型检查（注意：必须先存变量再看退出码，见 §4 假绿）
$out = npx tsc --noEmit 2>&1; $out; $LASTEXITCODE

# 能力清单（智能体读的第一个端点）
npm run todo -- capabilities --catalog

# 命令表：24 条
npm run todo -- commands --catalog

# 真实工程的机读验收（5 项检查）
npm run todo -- verify "<工程>.todo.json" --human

# 渲染一帧（确定性：同输入同 sha256）
node scripts/render-frame.mjs "<工程>.todo.json" --at 12 --edge 480 --out f.png

# 驱动**运行中**的应用（需开发模式启动：node scripts/open-todo-app.mjs --debug-port 9222）
npm run todo -- app inspect
npm run todo -- app run marker.add --args '{"t":5,"label":"外部驱动"}'
npm run todo -- app preview timeline.split_clip --args '{"clipId":"<id>","at":3}'

# OTIO 互操作（注意参数布局是 <sub> <file>）
npm run todo -- otio export "<工程>.todo.json" --out out.otio --human

# 崩溃恢复预演 / 环形备份
npm run todo -- recover "<工程>.todo.json" --human
npm run todo -- snapshots "<工程>.todo.json" --human
```

---

## 3. 已经建成的东西（按层）

### 3.1 规范层（纯模块，浏览器可用）

| 文件 | 作用 |
|---|---|
| `shared/spec/project-v2.schema.json` | 工程 JSON Schema（每个数值字段的 description 写明单位） |
| `shared/spec/README.md` | 规范索引 + **权威字段表**（哪些是派生镜像）+ 规范债 |
| `server/spec/projectSpec.mjs` | 校验器（交叉引用/悬空 id/派生漂移）+ 摘要器 |
| `server/spec/params.mjs` | 参数 DSL → JSON Schema + 入参校验（能力清单与命令表**同源**） |
| `server/spec/capabilities.mjs` | 能力清单（38 条操作 / 10 个错误码常量 / `CONTROL_INTERFACE` 部署形态） |
| `server/spec/migrations.mjs` | 迁移框架（相邻单步边 + 静态目录 + 拒绝未来版本）。**EDGES 目前为空** |
| `server/spec/ticks.mjs` | 整数 tick 精确算术（有理帧率、帧号往返、时码）。**尚未成为权威表示** |

### 3.2 命令层（纯模块，浏览器可用）

`server/core/commands.mjs`：**24 条命令**，每条有 `enabled()`（返回人话的不可用原因）与纯函数 `run()`。
`server/core/session.mjs`：`DocumentSession`（快照历史 / undo / redo / 批量全成功或全回滚 / 原子保存）。
`server/core/projectStore.mjs`：写锁 + 环形备份（`.history/`，默认 20 份）+ 崩溃恢复日志（重放命令 + 逐条文档哈希校验）。

**四条硬保证**（都有测试）：
1. 一次编辑 = 一条命令 = 一次撤销
2. **写入闸门**：命令不得引入新的规范错误，引入即拒绝且文档不变
3. 失败不留痕（命令是纯函数；失败不进历史、不落盘）
4. 批量执行全成功或全回滚

### 3.3 接入面（四条，共用一份实现）

| 面 | 入口 | 作用域 |
|---|---|---|
| CLI | `npm run todo -- <capabilities\|validate\|summary\|clips\|verify\|migrate\|commands\|exec\|frame\|snapshots\|recover\|app\|otio\|mcp>` | 磁盘工程 **或** 运行中的应用 |
| MCP | 13 个工具（其中 `todo_app_command` 是唯一会改文档的，已如实声明 `destructiveHint`）+ 3 个资源 | 磁盘工程 + 运行中的应用 |
| HTTP（开发） | `/api/capabilities`、`/api/app/status`、`/api/timeline/command`、`/api/timeline/undo|redo` | Vite 插件；写操作**首选进程内桥** |
| **控制端口（打包版）** | `GET /status`、`POST /command`、`POST /renderer`，token 在 `userData/ai-control.json` | 主进程 → IPC → 渲染进程命令层 |

后两条的区别很重要：调试协议（CDP）**只在开发模式存在**；打包版靠主进程控制端口（随机端口 + Bearer token，无 token 一律 401）。

### 3.4 渲染与验收

- `scripts/render-frame.mjs` + `scripts/render-frame-entry.ts`：渲一帧，走**监视器同一条** `renderProgramFrame`；返回 `meanLuma / nonBlackPct / blank / sha256`。**同输入同字节**（已实测两次 sha256 相同）。
- MCP `todo_render_frame` 直接把 PNG 作为 image content 回给智能体。
- `npm run todo -- verify`：5 项机读检查（`spec.valid / media.reachable / media.portable / refs.integrity / media.unused`）。
- `server/interchange/otio.mjs`：OTIO 导入导出，**两个方向都返回 lossy 清单**。

### 3.5 债务棘轮（防止绕过命令层）

`server/spec/migrationRatchet.test.mjs`：`src/store.ts` 里绕过命令层直接改序列的处数 **不得超过 50**（组件 4）。
已迁移的关键 UI 动作：`razorAtTime` / `deleteSelected`（含波纹）/ `moveClips` / `trimClip`。
**规矩：迁移完成一处就必须把基线调小**（只能减，不能增）。

---

## 4. 纠正记录（**这些说法曾经是错的，别再照抄**）

会话过程中我有若干断言后来被实测推翻。它们曾经写进过代码注释或进度报告，所以在此集中更正：

| 曾经的错误说法 | 实测/查证结果 | 正确说法 |
|---|---|---|
| 「规范校验器把**同轨重叠**判为错误，所以写入闸门会拒绝」 | `server/spec/projectSpec.mjs:174` 明确写着「同轨重叠：允许（叠化/覆盖），但值得提醒」，走的是 `warnings` | 同轨重叠在规范里是**警告**。`set_clip_starts` / `trim_to` 的 `reject` 是**命令策略**，不是规范强制；策略必须显式且可关（传 `clamp`/`push`） |
| 「浮点秒用久了会**漂**，所以必须迁到整数 tick」 | 30fps 与 29.97fps 下按帧累加 **200 万步（≈18.5 小时）没有出现帧号偏差**（双精度累积误差 ~1e-12 秒） | 迁移理由是：**精确是保证而非估计**、**有理帧率**（29.97 = 30000/1001）、**帧号一等公民**、**与 OTIO/其他 NLE 互操作**。不是"会漂" |
| 「`1/30 * 30 !== 1` 可作为浮点反例」 | IEEE754 下它**恰好等于 1** | 举浮点反例要用实测统计（如 `0.1+0.2 !== 0.3`、`1..1000` 中 `(k/30)*30 !== k` 的实际计数），不要凭印象 |
| 「`node --check` 通过就说明文件没问题」 | `return { sequence, lossy }`（简写属性引用不存在的绑定）语法合法、`node --check` 通过，运行时才炸 `ReferenceError` | 语法检查 ≠ 引用检查。**测试必须真的调用代码**，不能只 import |
| 「迁移后棘轮数字没动，说明迁移没生效」 | 是**度量口径漏了**：原正则只匹配 `clips: x.clips`，而 store 里真正的漏斗是 `patchSeq(` | 度量口径本身要验证。改口径后 56 → 54 → 52 → 50 |
| `$LASTEXITCODE` 在管道后取值 | 拿到的是**管道**的退出码，不是 tsc 的；曾因此漏报 2 个类型错误 | 先把输出存变量，再单独读退出码 |

**还有两次"看起来是环境问题、其实是自己引入的 bug"**：

1. 应用白屏 → 我一度归因为"渲染进程 NetworkService 抖动"。真因是**循环导入**（`store.ts → commandBridge.ts → store.ts`）里模块顶层读取 `useApp` 撞上 TDZ。修法：延迟安装（`queueMicrotask`）。
2. CDP 拿到的 store 是"干净初始实例" → 我一度归因为"测量 artifact"。部分是（Vite HMR 版本查询会新建模块实例），但更重要的是**开发模式入口当时根本没挂上**（因为 #1）。修法：在桥里暴露**应用自己的** store 实例（仅开发模式）。

**教训**：不要把"我不理解的现象"归给环境。这次的正确顺序是：现象 → 查日志/复现 → 定位到自己刚改的代码。

### 4.1 成片管线从未接入执行器（已修）

`server/production/job.mjs` 写好了 `executeProductionJob`（成片执行器），但
`server/skillJobs.mjs` 的分流表里**没有 `production`**，于是成片任务掉进 `executeElementsJob`，
而它的 `req.prompt` 对成片永远是 `undefined`：

```
TypeError: Cannot read properties of undefined (reading 'slice')
    at fallbackPlan (server/skillPacks.mjs:589)
    at executeElementsJob (server/skillJobs.mjs:130)
```

任务 ~58ms 失败、阶段停在「待生成」。**影响面**：`POST /api/ai-productions/<id>/run`
（即界面上的"生成/重试"）一直不可用；已有成片记录都标着「命令行导入」，说明历史上绕过了这条路由。

修法：在 `executeSkillJob` 里按 `request.productionId` 分流到 `executeProductionJob`
（动态 import，避免与 `SKILL_OUTPUT_SPEC` 形成初始化顺序依赖）。
回归测试：`npm run production:dispatch`（零 AI 调用；去掉分流即复现上面的 TypeError）。

### 4.2 验收门会否决已经做好的产物（已修）

`workflow/run_pipeline.py` 拿到门的退出码后直接 `raise SystemExit(rc)`。
后果：**质量门失败 → 进程非 0 → 宿主判定整个生成失败 → 已经产出的分层全部丢弃，
时间轴一片空白**。实拍记录：口播、音效、字幕、成片、69 个分层文件全都做好了，
用户在界面上只看到「失败」和空时间轴 —— 也就是"连 TTS 和字幕都没入轨"。

受影响最大的恰恰是最需要产物的场景：**短口播**（g2/g4 按 ≥1000 字标定，短稿必红）。

修法（`run_pipeline.py`）：把「产物是否产出」与「质量门是否通过」分开判定。
成片存在即视为生成成功，门的结果写进 `output/gate_status.json` 并 `WARN` 大声打印；
只有连成片都没有时才算失败。质量信号不隐藏，但不再否决产物交付。

### 4.3 四道门查的是不存在的东西 / 不成立的判据（已修）

| 门 | 问题 | 修法 |
|---|---|---|
| `g2.mishi_batch_parallel` | 找 `${MISHI_ROOT}/media/image_batch.py` —— 那是**作者机密匙**里的批 API；TO DO 内嵌的 vendor/mishi 只有单图接口，批调度由扩展自带。取不到 `MISHI_ROOT` 时还退化成 `Path(".")`，结果随 CWD 漂移 | 有上游批驱动就查上游，否则查**扩展自带**的调度器 |
| `g2/g4.script_chars_ge_1000` | 「样本够不够长」被当成「片子对不对」判失败 → 短稿永远过不了门 | 短稿标 `N/A`，不判失败 |
| `g4.pipeline_end_to_end` | 判据是 `not --skip-clean`，而 `skill.json` **固定传 `--skip-clean`**（为保留 TTS/素材、重试不重复计费）→ 该标志恒 False，连带 `no_reused`/`total_le_20min` 三项**恒红** | 判据改成「五个关键阶段都在且 rc=0」，语义更强；并容忍旧 timing 文件 |
| `g6.assets_failure_soft_continue` | 读 `src` 时用的是 `paths.ROOT`（= 产物目录），而 `run_pipeline.py` 在**代码目录** → 恒读空串 → 恒 False | 从 `paths.CODE` 读，并加 `pipeline_source_readable` 诊断 |

### 4.4 `enter` 与 `enter_at` 互相矛盾（已修）

`design._retime_layers_by_phrase()` 用**真实逐字时间戳**重算 `enter_at`（这是对的），
但没有同步 `enter`。于是出现「`enter` 说短语1、`enter_at` 却是短语0的时刻」，
`validate_phrase_sync` 判失败 → 整条管线停在验收，报错还只显示前一条检查。

修法：以 `enter_at`（来自真实字级时间戳）为准，反查最近短语写回 `enter`，让两者自洽。
实测：修复前 5 处对不上 → 修复后 0 处；真机 `phrase_sync_enter_at ok`。

### 4.5 沙箱环境下的两个入口（不是应用缺陷）

- 工作区内的 `native/bin/ffmpeg.exe` 只能写工作区，而包内管线写用户在区外的目录 →
  Python 侧只看到 `BrokenPipeError`，完全看不出是 ffmpeg。
  `scripts/open-todo-app.mjs` 现在会把 ffmpeg/ffprobe 复制到工作区外并用 `FFMPEG` 指过去
  （与既有的 `TODO_PYTHON` 处理同构）。
- `scripts/todo-ctl.mjs` 提供"控制实例"：把数据目录放到工作区内，便于外部 agent 驱动。
  注意 `env` 里给键赋 `undefined` **不等于删除**（Node 会继承父进程值），必须显式 `delete`。


---

## 5. 哪些还没做（别把地基当成完成）

| 项 | 现状 | 还差什么 |
|---|---|---|
| **整数 tick 成为权威表示** | 精确算术已就位并通过 15 个测试 | 要改 store / 渲染 / 导出 / AI 服务的全部时间字段；需要 `todo-project/3` 规范 + 第一条真实迁移边 + 金样帧比对。**当前 EDGES 为空，工程仍是 v2 浮点秒** |
| **I4「预览 = 导出」** | 渲帧走 `renderProgramFrame`（与编辑窗一致） | 导出走 ffmpeg/原生引擎，两者**未做严格 parity 证明**。这是"部分达成" |
| **UI 写操作全部走命令层** | 4 个关键动作已迁移，棘轮 50 | 其余约 50 处（`rateStretchClip`、`addEffect`、`closeGaps` 等）仍在直接改 store |
| **HTTP 面在打包版** | 打包版走主进程控制端口（已实现并实测） | Vite 插件那条 `/api/*` 仍需开发服务器；两条路的**响应形状已统一**，但文档尚未把它写成对外契约 |
| **崩溃恢复自动应用** | 有预演（`recover`）与备份（`snapshots`），应用内保存走锁+环形备份 | 应用启动时**不会自动提示**"上次是崩溃退出、要不要恢复"；`desktop:project-recovery` IPC 已就绪但没有 UI |
| **extensions 规范** | 现有扩展（如 koubo）是文件包 + `validateXxxPack` | 无 manifest 规范、无版本契约、无权限声明 |
| **`render.preview` / `render.export` / `verify.run` 端点** | 能力清单里仍是 `planned` | 未实现 |

---

## 6. 仍未决的问题（需要人拍板）

1. **P4 整数 tick 何时做**：它动全库时间数学，回归面大（要金样帧比对）。不做也能上线，但 OTIO 交换与 29.97 项目会依赖"我们内部仍是浮点"这个事实。
2. **重叠策略是否要成为规范的一部分**：现在同轨重叠是警告（合法）。如果将来把 `push` 语义写进规范，会影响所有既有工程。
3. **写入口的鉴权边界**：控制端口用 `userData/ai-control.json` 里的 token。任何能读该文件的本地进程都能驱动编辑器——对本地应用可接受，但要不要加 ACL/按会话轮换，需要决定。
4. **OTIO 的有损是否可接受**：同轨重叠、标记、转场目前丢失。要不要推动"标记挂到 item 上"（OTIO 原生支持）以减少损失？
5. **扩展的权限模型**：koubo 这类扩展会写工程与素材，是否需要声明式权限（读/写/网络）。

---

## 7. 数字快照（第 23 轮）

```
测试：148 通过 / 0 失败（+ 主进程桥冒烟 6 项 + MCP 冒烟 13 项）
tsc ：0 错误
命令：24 条        能力清单：38 条操作（7 条 beta）
CLI ：14 个子命令  MCP：13 个工具 / 3 个资源
棘轮：store.ts 50 / 组件 4
真实工程：verify 5 项全绿；渲帧确定性（两次 sha256 相同）
```

> 如果这里的数字与你实测不符，**以实测为准**——这份文档的记录错误率不是零（见 §4）。
