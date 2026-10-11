# 规范索引（machine-readable specs）

这个目录放**机器可读的规范**，供人、智能体、和我们的校验器共同使用。
约定沿用仓库既有习惯：每个协议一个 `todo-xxx/N` 字符串，写进产物的顶层字段。

## 目录

| 文件 | 内容 |
|---|---|
| `project-v2.schema.json` | 工程文件（`.todo.json`）现行格式 `todo-project/2` 的 JSON Schema |
| `../server/spec/projectSpec.mjs` | 校验器 + 机器可读摘要 + CLI（零依赖） |

## 已版本化的协议一览

| 协议串 | 载体 | 定义位置 |
|---|---|---|
| `todo-project/2` | 工程文件（裸 `version: 2`） | `src/store.ts` `PROJECT_FILE_VERSION` |
| `todo-production/1` | 成片文档 | `server/production/doc.mjs` |
| `todo-extension-pack/1` | 扩展包 | `server/extensionPacks.mjs` |
| `todo-skill-pack/1` | 技能包 | `server/skillPacks.mjs` |
| `todo-style-pack/1` | 风格包 | `server/stylePacks.mjs` |
| `todo-anim-pack/2` | 动画包 | `server/animPacks.mjs` |
| `todo-skill-render/1` / `todo-skill-output/1` | 渲染请求 / 产物清单 | `server/skillJobs.mjs` |
| `todo-anim-output/1` | 动画产物 | `server/aiJobs.mjs` |

## 工程文件的权威规则（读之前先看这张表）

| 概念 | 权威字段 | 派生/会话字段 | 单位 |
|---|---|---|---|
| 画布 | `settings.width/height` | — | 像素 |
| 帧率 | `settings.fps` | — | 帧/秒 |
| 片段在时间轴的位置 | `clip.start` / `clip.duration` | `clip.meta.absIn/absOut/start/duration/end` | 秒 |
| 片段取素材的范围 | `clip.inPoint` / `clip.outPoint` | `clip.meta.inPoint/outPoint` | 秒（媒体自身时间轴） |
| 素材长期引用 | `media.relPath`（相对工程文件） | `media.path`（本机绝对）、`media.url`（会话态） | — |
| 片段→素材 | `clip.mediaId` → `media[].id` | — | — |
| 片段→轨道 | `clip.trackId` → `sequences[].tracks[].id` | `clip.meta.trackId` | — |
| AI 产物溯源 | `clip.meta.source.{jobId,kind,lane,key,rev}` | `layout` | — |
| 成片落位 | `settings.aiProductions[id].{t0,auto,placed}` | — | 秒 / 布尔 / 指纹 |

**不要相信**派生镜像字段：它们可能落后于片段（校验器会以 `meta_mirror_drift` 报出来）。

## 用法

### 智能体接入面（优先）

```powershell
# MCP server（stdio）。工具 6 个：todo_capabilities / todo_project_validate / todo_project_summary
#   / todo_project_clips / todo_verify / todo_project_migrate_plan
# 资源 3 个：capabilities、工程 schema、本文件
npm run todo:mcp

# CLI（只输出 JSON；退出码 0=通过 / 1=检查未过 / 2=用法或读取错误）
npm run todo -- capabilities --catalog              # 能力清单（catalog=只给签名，省 token）
npm run todo -- validate "<工程>.todo.json" --human  # 按规范校验
npm run todo -- summary  "<工程>.todo.json"          # 结构化摘要
npm run todo -- clips    "<工程>.todo.json" --from 0 --to 30
npm run todo -- verify   "<工程>.todo.json" --human  # 机读验收
npm run todo -- migrate  "<工程>.todo.json"          # 迁移预演（只读）
```

HTTP 侧：`GET /api/capabilities`（`?view=catalog` 只给签名）——同样两级披露。

`verify` 的检查项（商用判定线的可执行版本）：

| check | 含义 |
|---|---|
| `spec.valid` | 规范校验（交叉引用 / 悬空 id / 派生漂移 / 同轨重叠） |
| `media.reachable` | 被时间轴引用的素材是否真的在磁盘上 |
| `media.portable` | 被引用素材是否都有 `relPath`（没有 ⇒ 工程搬走就坏，对应不变量 I1） |
| `refs.integrity` | 是否有悬空引用 |
| `media.unused` | 未被引用的素材数（提示，不算失败） |

### 写入：命令层（唯一入口）

**不能直接改 JSON** —— 写入必须走命令注册表（`server/core/commands.mjs`），这样 UI / CLI / MCP / 未来的 HTTP
共享同一份校验闸门与撤销历史。

```powershell
npm run todo -- commands --catalog                     # 列命令（10 条）
npm run todo -- exec <工程> timeline.add_clip --args '{"trackId":"tr_v2","start":20,"duration":2}'          # 预演，不落盘
npm run todo -- exec <工程> timeline.add_clip --args '{...}' --write                                       # 落盘（原子写 + .bak）
```

命令层的四条保证：

| 保证 | 机制 |
|---|---|
| 一次编辑 = 一条命令 = 一次撤销 | `DocumentSession` 整文档快照历史，`undo()/redo()` |
| 写入闸门：不得引入新的规范错误 | 每条命令跑完立刻 `validateProject`，新增错误 → 拒绝且**文档不变** |
| 失败不留痕 | 命令是纯函数（`applyCommand` 不改传入文档）；失败不进历史、不落盘 |
| 批量全成功或全回滚 | `session.execMany()` |

已发布的命令 id **永不改名**（工程里存的是 id）。当前 10 条：`timeline.add_clip / move_clip / trim_clip /
split_clip / delete_clips`、`clip.set_transform`、`track.add / remove`、`marker.add`、`sequence.set_work_range`。

### 直接调库

```js
import { validateProject, summarizeProject } from './server/spec/projectSpec.mjs'
const report = validateProject(json)   // { ok, spec, errors[], warnings[], stats }
const brief  = summarizeProject(json)  // 画布/序列/轨道/时间跨度/成片/素材清单
```

错误带 `code` / `path`（JSON Pointer 风格）/ `hint`，可以直接回喂给智能体去修。

### 测试

```powershell
npm run spec:test     # 33 个用例（规范 12 + 能力清单 10 + 迁移框架 11）+ MCP 会话冒烟（9 项）
```

## 迁移框架（v3 的地基，已就位）

`server/spec/migrations.mjs` 把「格式演进」做成**相邻单步边 + 静态目录**：

| 规则 | 为什么 |
|---|---|
| 边必须相邻（`to === from + 1`）、无重复、无缺口、不得越过当前版本 | 目录本身就是不变量，构造期就炸（照 DSH） |
| **已发布的边永不修改**，只允许追加 | 老工程永远可读 |
| 读未来版本 → **明确拒绝**并给提示，不半读半写 | 「半读半写」是最坏的结果（照 filmcraft） |
| 每个边配一个旧形状 fixture（`__fixtures__/project-v<from>.todo.json`） | 迁移必须有回归证据 |

当前 `PROJECT_CURRENT_VERSION = 2`、`OLDEST_SUPPORTED = 2`，所以边列表为空——
v3 落地时只需加一条边 + 一个 v2 fixture。`npm run todo -- migrate <工程>` 可随时预演。

## 规范债（改造路线）

1. **裸整数版本** → v3 改为 `spec: "todo-project/3"` 字符串，并写迁移器（读旧写新）。
2. **文档与会话混在一起**：`playhead` / `monitorCompose` / `activeSeqId` / `prefs` / `scriptWorkspace` 每次编辑都在变，导致工程文件无法有效 diff。v3 拆成 `document` / `session` / `prefs` 三段。
3. **派生镜像冗余**：`clip.meta` 重复了 6 个时间字段。v3 只保留 `meta.source` 等溯源信息，其余由工具按需计算。
4. **AI 产物未落本地路径**：实测 78 个媒体里有条目不写 `path`/`relPath`（只靠 AI 服务 URL），工程无法整包搬走。v3 要求所有被片段引用的素材必须有 `relPath` 或明确的 `external: true` 标记。
5. **schema 与 TS 类型双份维护**：v3 起从 `src/types.ts` 单一来源生成 schema（或反过来用 schema 生成类型），并加 CI 校验二者一致。

## 共享核心层（Electron 与 Web 共用）

`server/spec/*` 与 `server/core/commands.mjs` 是**纯模块**：不引入任何 `node:` 内置模块，
所以既能被 Node（CLI / MCP / 主进程）用，也能被浏览器（渲染进程 / 未来的 Web 客户端）直接 `import`。

| 模块 | 作用 | 浏览器可用 |
|---|---|---|
| `server/spec/params.mjs` | 参数 DSL → JSON Schema + 入参校验 | ✅ |
| `server/spec/projectSpec.mjs` | 工程校验器 + 结构化摘要 | ✅ |
| `server/spec/migrations.mjs` | 版本迁移框架（相邻单步边 + 目录校验） | ✅ |
| `server/spec/capabilities.mjs` | 能力清单 + 自校验 | ✅ |
| `server/core/commands.mjs` | 命令注册表 + 写入闸门 | ✅ |
| `server/core/session.mjs` / `projectStore.mjs` | 会话历史 / 锁 / 备份 / 恢复（做文件 IO） | ❌ 仅 Node |

**这条边界有测试守着**（`server/spec/architecture.test.mjs`）：纯核心模块一旦引入 `node:`，
或反向依赖 IO 模块，测试就红。理由：这种退化在 Node 里跑测试完全正常，
只会在浏览器里静默失败——所以必须变成一条会响的警报。

实测（在应用渲染进程里直接 import 共享核心）：

```
validateProject  → spec=todo-project/2  ok  44 片段 / 78 媒体 / 8 成片  0 错 1 警
summarizeProject → clips 44, duration 26.377s, tracks 7
applyCommand     → marker.add 执行成功（创建 id，原文档未改）
capabilities     → todo-capabilities/1，38 条操作
```
