# TO DO × AI 原生改造设计（商用标准）

日期：2026-10-11 ｜ 状态：**待评审** ｜ 参考：FilmCraft（Rust NLE 洁净室实现）、DeepSeek Harness（本机 agent 运行时）

---

## 0. 一句话

把 TO DO 从「一个带 AI 功能的剪辑器」改造成「**一个能被智能体当作引擎来驱动的剪辑引擎，附带一个给人用的界面**」。
判定标准不是"能不能用自然语言剪片"，而是：**智能体不读源码就能发现能力、调用、读懂失败、验证结果、回滚**。

## 1. 目标与非目标

**目标**
1. 工程/成片文档：机器可读、显式版本、可迁移、有 schema、有校验器。
2. 唯一写入口：命令注册表，UI / HTTP / CLI / MCP 共用同一批 id；不可用要能说人话。
3. 发现能力：`/api/capabilities` 端点 + 清单文件，智能体读它而不是读源码。
4. 失败可机读：统一错误契约（code/message/hint/retryable/path）。
5. 结果可验证：渲染单帧、跑硬验收门、返回结构化结果。
6. 时间正确：整数 tick + 有理帧率，消除浮点秒漂移。
7. 互操作：导出/导入 OpenTimelineIO（行业事实标准），不发明私有时间轴。
8. 无 UI 核心：引擎层不依赖 Electron/React，可在 Node/CI 里跑。

**非目标（明确不做）**
- 不重写编解码器（继续用 ffmpeg / native-tools / vendor）。
- 不做编译期插件 ABI（保留并强化现有运行时 packs：extension/style/skill/anim）。
- 不做云化改造（引擎本地优先；Web 客户端只是又一个消费者）。
- 不追求"自然语言即剪辑"的表演性功能；先把契约做对。

## 2. 现状审计

| 已有（应保留并复用） | 缺口（本期要补） |
|---|---|
| `todo-xxx/N` 规范字符串约定 + `validateXxxPack()` 校验器（extension/skill/style/anim） | **工程文档没有规范**：只有裸 `PROJECT_FILE_VERSION = 2` |
| `todo-production/1` 成片文档 + hash/dirty 指纹 + `rev` 递增 + 产物去重 | 工程文档**无迁移链、无 fixture、无 JSON Schema** |
| ~25 条 `/api/ai-*` 路由 + `sendJson` 响应壳 + 任务队列 + 进度 | 错误是**裸字符串**；无 code/hint/retryable |
| 扩展包安装/校验/版本比较（同版本不同内容会被拒） | **没有命令层**：前端直接改 store，智能体拿不到"能做什么/为什么不能" |
| `accept_gates/*` 硬验收门（已经是机器可读的质量判据） | 验收门只在扩展工作目录里跑，**没有对外端点** |
| `scripts/*.mjs` 一批自动化脚本 + CDP 调试通道（`--debug-port`） | 没有 CLI、没有 MCP、没有 capabilities |
| undo 靠 `pushHistory`（整 store 快照） | 编辑无事务边界，智能体无法"一次编辑 = 一条命令 = 一次撤销" |
| `media.relPath` + 主进程原子写（tmp→rename）+ `.bak` | **自动保存环形版本 / 崩溃恢复**没有；备份靠手工命名 |

**实测数据（本轮校验器跑真实工程得到）**：`演示草稿` = 1 序列 / 8 轨道 / 45 片段 / 78 媒体 / 8 成片；
warnings：`media_no_ref`（1 条 AI 产物只有服务 URL，**工程无法整包搬走**）、`workOut=303.27s` 与实际内容 26.38s 不符（脏数据）。

## 3. 六条不变量（商用判定线）

| # | 不变量 | 为什么 | 怎么验 |
|---|---|---|---|
| I1 | **任何被片段引用的素材都有可搬走的引用**（`relPath` 或显式 `external:true`） | 工程搬机即坏是最常见的商用事故 | 校验器 `media_no_ref` 必须为 0 |
| I2 | **时间只有一种表示**（整数 tick；帧率是有理数） | `duration: 7.8025` 在 23.976/29.97 下必然漂移 | 全库 grep 浮点秒字段；金样帧号比对 |
| I3 | **一次编辑 = 一条命令 = 一次撤销** | 智能体需要事务边界才能安全试错 | 命令 `run` 返回 changed ids；undo 后工程摘要回到上一态 |
| I4 | **预览与导出走同一个渲染函数** | 两套渲染 = 预览骗人，商用不可接受 | 同一帧在预览/导出路径的像素 parity（容差 ≤3e-6） |
| I5 | **写入前必过校验**（schema + 交叉引用），失败带 code/path/hint | 脏工程会让后续每一步都错 | 保存管线里拦一道；CI 里对 fixture 全跑 |
| I6 | **已发布的 id 与规范永不改名**（效果的参数 id、命令 id、spec 串） | 工程文件存的是 id，改名即破坏老文件 | 冻结清单 + CI 比对 |

## 4. 接口契约

### 4.1 工程文档 v3（`todo-project/3`）

现格式（v2）已有 schema 与校验器（见 `shared/spec/`）。v3 的目标结构：

```
{
  "spec": "todo-project/3",
  "document": {                     // 可 diff、可版本控制、智能体主战场
    "name", "createdAt", "updatedAt",
    "canvas":   { "width","height","frameRate":{"num":30000,"den":1001},"pixelAspect","colorSpace","background" },
    "media":    [ { "id","kind","name","relPath","hash":{"size","head","tail"},"duration":tick,"alpha",... } ],
    "sequences":[ { "id","name","tracks":[{"id","kind","role",...}],
                    "clips":[ { "id","trackId","mediaId","start":tick,"duration":tick,
                                "sourceIn":tick,"sourceOut":tick,"speed","effects":[...],
                                "keyframes":{ "<prop>":[{ "t":tick, ... }] },   // 素材时间
                                "provenance":{ "type","jobId","lane","key","rev" } } ],
                    "markers":[], "workRange":{"in":tick,"out":tick} } ],
    "productions": { "<id>": { "t0":tick,"auto","placed" } }
  },
  "session": { "activeSeqId","playhead","monitorCompose","selection" },   // 不进 diff、不进 undo
  "prefs":   { ... }                                                      // 独立文件更佳
}
```

迁移：`migrations/2→3.mjs` 单步函数 + **旧形状 fixture** + 加载测试；已发布迁移禁改；
新数据若会让旧版**静默丢字段**，就用 no-op 升级让旧版**明确拒绝**（照 FilmCraft 的做法）。
读旧写新；`version:2` 与 `spec:"todo-project/3"` 都认。

### 4.2 命令注册表（唯一写入口）

```js
{
  id: 'timeline.razor',            // 稳定 id，永不改名
  label: '切片',
  category: 'timeline',
  params: { at: { type: 'tick', required: true, doc: '切线位置' } },
  enabled: (s, p) => (p.at > 0 ? null : '切线必须大于 0'),   // 字符串 = 人话的不可用原因
  run: (s, p) => ({ changed: ['clip_ab12'], created: ['clip_cd34'], summary: '切了 1 次' }),
  undoable: true,
  hint: { readOnly: false, destructive: false, idempotent: false },
}
```
- UI 按钮、HTTP `POST /api/timeline/command`、CLI `todo exec`、MCP `command_run` **都 dispatch 同一批 id**。
- `enabled()` 的拒绝原因要能直接展示给人看（照 FilmCraft：`Err` 携带人话）。
- 未知参数必须报错并列出可接受参数（避免智能体瞎猜）。

### 4.3 能力清单（`todo-capabilities/1`）

已落地：`server/spec/capabilities.mjs` + `GET /api/capabilities`（也接受 `/api/ai-capabilities`）。
**只登记真实能力**；未实现的标 `status:'planned'` 并写明缺口——给智能体诚实的边界。
当前：38 条（25 真实 + 13 planned：project/timeline/render/verify/otio）。

### 4.4 错误契约

```json
{ "ok": false, "error": { "code": "conflict", "message": "工程已在另一窗口打开",
  "hint": "关闭另一窗口后重试", "retryable": false, "details": { "path": "..." } } }
```
10 个 code（bad_request/not_found/conflict/busy/permission/needs_config/upstream/timeout/unsupported/internal）已声明。
旧端点仍返回字符串错误，客户端兼容两种（**逐步迁移，不破坏现有前端**）。

### 4.5 渲染与验证

- `POST /api/render/frame {seqId,tick | t, maxEdge}` → PNG（智能体"看一眼"闭环）
- `POST /api/render/preview` → 低码率预览片段
- `POST /api/render/export` → 后台任务，带 `progress / cancel / etaSeconds`
- `POST /api/verify` → 跑验收门，返回 `{ok, gates:[{id,ok,detail}]}`（复用 `accept_gates`）

### 4.6 MCP / CLI / OTIO

- `todo mcp`（stdio）：`command_list / command_run / command_batch / project_inspect / sequence_inspect / render_frame / render_preview / verify_run / media_import`；
  每个工具带 `readOnly/destructive/idempotent` 提示；长任务发 progress 通知 + 可取消。
- `todo` CLI：`capabilities | validate | summary | commands | describe | exec | run(JSONL) | render | verify | mcp`，输出 JSON，退出码 0/1/2。
- OTIO：`POST /api/interchange/otio`（导出/导入），`metadata.todo` 保真私有字段。

## 5. 分期路线（每期独立可交付 + 验收标准）

| 期 | 内容 | 验收标准 |
|---|---|---|
| **P0（本轮完成）** | 工程 schema + 校验器 + 摘要器 + 能力清单端点 + 错误契约 + **CLI + MCP（只读 6 工具）+ fixtures + 能力清单自校验 + 迁移框架** | ✅ `projectSpec.mjs` 跑通真实工程；✅ `/api/capabilities`（含 `?view=catalog` 两级披露）38 条操作；✅ MCP 会话冒烟 9 项通过；✅ **33 个用例通过**；✅ 规范 README 与权威字段表 |
| **P1（半程）** | ✅ 命令注册表（10 条核心命令）+ `DocumentSession`（快照历史/undo/redo/批量回滚/原子保存）+ **写入闸门 I5** + CLI `exec` + MCP `command_preview`（不落盘）；待做：HTTP `POST /api/timeline/command`（需渲染进程桥）+ 剩余命令 | 达成 I3：`undo` 回上一态（30 个用例）；每条命令的 `enabled` 拒绝文案都被断言 |
| **P2（完成）** | ✅ 写锁 + **环形自动保存**（`.history`，默认 20 份）+ **崩溃恢复日志**（重放命令 + 文档哈希逐步校验）+ 原子写（tmp→rename + .bak）+ CLI `snapshots/recover` + MCP 2 工具 + **APP 已接线**（`electron/projectCore.cjs` 桥：开工程取锁、保存走核心、退出放锁、`desktop:project-status/recovery` 诊断） | 达成：两个进程不能同时写（conflict）；崩溃丢失的编辑能完整重放找回（16 用例）；**真机验证**：打开 → `.lock` 出现；保存 → `.history/…json` + `.bak` + 无 `.tmp`/`.journal` 残留；退出 → 锁自动释放 |
| **P3（半程）** | ✅ CLI + MCP（只读 6 工具，含迁移预演）；待补 `render/frame` 与写操作工具 | 智能体仅凭 capabilities 就能：读工程 → 改时间轴 → 渲一帧 → 看图 → 撤销 |
| **P4（地基就位）** | ✅ 迁移框架（相邻单步边 + 静态目录 + 缺口校验 + 拒绝未来版本 + 11 用例）；待做：整数 tick 落地（`todo-project/3`）+ v2 旧形状 fixture | I2 达成；金样帧号比对通过；老工程读入无损 |
| **P5** | 无 UI 核心层抽取 + OTIO 互操作 + I4 parity 测试 | 核心层可在 Node 里跑（无 Electron）；OTIO 往返有损字段清单化 |

## 6. 风险与取舍

| 风险 | 处理 |
|---|---|
| tick 迁移触碰全库时间数学，回归面大 | P4 单独一期 + 金样帧比对；先并存双表示（读旧→内存 tick→写 v3） |
| 命令层要重写前端写操作，工作量最大 | 先做只读 API（P0-P2 已完成大半），命令层按"编辑频次 × 风险"排序逐步迁移 |
| 控制端口/调试通道无鉴权（FilmCraft 的反面教材） | 本地回环 + 一次性 token；`--debug-port` 默认关，显式开启 |
| 单 store 4148 行，抽核心层有风险 | 先抽**纯函数**（schema/摘要/命令），再抽状态机；不动 UI 组件 |
| 与扩展工作流的关系（扩展已经是"生成→入轨"的 DAG） | 复用 `todo-production/1` 的指纹/rev 机制，把它并入统一命令与缓存，不另起一套 |

## 7. 本轮已落地（可验证）

| 文件 | 内容 |
|---|---|
| `shared/spec/project-v2.schema.json` | 工程格式 JSON Schema；每个数值字段的 `description` 写明单位 |
| `shared/spec/README.md` | 规范索引 + **权威字段表**（哪些字段是派生镜像）+ 智能体接入面用法 + 规范债清单 |
| `server/spec/projectSpec.mjs` | 校验器（交叉引用/悬空 id/派生漂移/同轨重叠）+ 摘要器 + CLI |
| `server/spec/projectSpec.test.mjs` | **12 个规范用例**（node:test，零依赖） |
| `server/spec/capabilities.mjs` | 能力清单（38 条操作、10 个错误码常量、命令契约、时间基准目标、四种接入面）+ **作者期自校验** `validateCapabilities()` + author DSL→JSON Schema 编译 |
| `server/spec/capabilities.test.mjs` | **10 个用例**：清单自校验、DSL 编译、类型闭集、两级披露、错误码集合一致性、坏清单可被抓住 |
| `server/spec/migrations.mjs` + `migrations.test.mjs` | 迁移框架：相邻单步边、静态目录、缺口/重复/越界校验、拒绝未来版本（**11 个用例**） |
| `server/spec/__fixtures__/minimal.todo.json` + `media/` | 自洽的通过型 fixture（`verify` 全绿） |
| `server/spec/__fixtures__/broken.todo.json` | 故意坏的 fixture（重复 id / 孤儿轨 / 孤儿媒体 / 时间非法 / 派生漂移 / 越界） |
| `server/spec/__fixtures__/mcp-session.mjs` | MCP 会话冒烟（12 项：握手、工具清单、调用、未知参数、资源、能力、命令清单、**预演不落盘**） |
| `server/cli.mjs` | CLI：`capabilities / validate / summary / clips / verify / migrate / commands / exec / mcp`，只输出 JSON，退出码 0/1/2 |
| `server/core/commands.mjs` | **命令注册表**（10 条核心命令）：作者侧参数 DSL、`enabled()` 携带人话原因、纯函数 `run()`、**写入闸门**（改动后校验，新增错误即拒绝） |
| `server/core/session.mjs` | `DocumentSession`：整文档快照历史 + undo/redo + 批量全成功或全回滚 + revision（缓存失效信号）+ **原子保存**（tmp→rename，留 .bak） |
| `server/core/core.test.mjs` | **30 个用例**：未知命令/未知参数/类型/各命令行为/闸门 I5/会话 I3（撤销精确回上一态）/原子保存 |
| `server/core/projectStore.mjs` | **写锁**（独占创建 + PID 活性 + 陈旧锁接管）+ **环形自动保存**（`<dir>/.history/`，默认 20 份）+ **崩溃恢复日志**（`<file>.journal.jsonl`，重放命令 + 逐条文档哈希校验） |
| `server/core/projectStore.test.mjs` | **14 个用例**：锁冲突（用活进程测）/陈旧锁接管/不可重入/日志语义/环形上限/**崩溃后完整重放恢复**/日志不匹配时如实停下 |
| `server/spec/params.mjs` | 参数 DSL → JSON Schema 编译 + 入参校验（能力清单与命令表**同源**，不会漂移） |
| `server/mcp.mjs` | MCP server（stdio, JSON-RPC 2.0, protocol 2024-11-05）：**8 个只读工具** + 3 个资源；未知参数报 -32602 并列出可接受参数；`todo_command_preview` 预演**绝不落盘**（有断言） |
| `server/aiHttp.mjs` | 新路由 `GET /api/capabilities`（兼容 `/api/ai-capabilities`，支持 `?view=catalog`） |
| `package.json` | `spec:validate / spec:summary / spec:test / spec:capabilities / todo / todo:mcp` |

验证命令：

```powershell
npm run spec:test                                    # 33 用例 + 9 项 MCP 冒烟
npm run todo -- verify "<工程>.todo.json" --human     # 机读验收（真实工程已报出 media.portable 不过）
npm run todo -- migrate "<工程>.todo.json"            # 迁移预演
npm run todo:mcp                                     # 以 MCP server 启动
```

## 8. 待评审问题（需要你拍板）

1. **P4 整数 tick 是否本期做？** 它动全库时间数学，收益是长期正确性；不做也能上线，但 23.976/29.97 项目迟早出问题。
2. **命令层先迁移哪些？** 建议按"智能体最常用"排：`timeline.add_clip / move / trim / split / delete / set_transform / add_track / bind_production / render_export`。
3. **OTIO 优先级？** 若你的片子要交付给外部后期/平台，建议提前到 P3。
4. **自动保存策略**：环形保留几份（FilmCraft 默认 20）、间隔多少秒、是否对工程文件所在目录写锁。
5. **无 UI 核心层的形态**：抽成 workspace 包（`packages/core`）还是保持 `server/` 目录约定？前者干净但要动构建。
