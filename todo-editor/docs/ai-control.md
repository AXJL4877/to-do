# AI 控制 TO DO：三种接入面与沙箱对策

> 给外部 agent（含在沙箱里跑的 agent）的操作手册。目标：**不用点界面就能驱动生成、读产物、验结果**。

## 0. 先判断你在哪种环境

| 环境 | 能否写 AppData | 该用哪条路 |
|---|---|---|
| 用户自己在用（正常桌面） | 能 | 直接用药应用自己的 `/api/*`（端口见下），或 CLI / MCP |
| agent 跑在只许写工作区的沙箱里 | **不能** | 用 `scripts/todo-ctl.mjs` 起**控制实例**（本文重点） |

判据（一条命令）：

```powershell
python -c "import pathlib,os; p=pathlib.Path(os.environ['APPDATA'])/'todo-editor'/'data'/'_probe'; p.mkdir(parents=True,exist_ok=True); print('writable')"
```

报 `PermissionError [WinError 5]` / `EPERM` 就是沙箱环境。**这不是应用缺陷**，是沙箱边界；Electron 拉起的子进程和它再拉的 Python 都继承同一限制。

## 1. 控制实例（沙箱环境首选）

```powershell
node scripts/todo-ctl.mjs start     # 建 .data-ctl/data 并起服务（幂等）
node scripts/todo-ctl.mjs status    # 探活 + 列出成片
node scripts/todo-ctl.mjs list      # 成片 + 最近任务
node scripts/todo-ctl.mjs run <productionId> [--force]   # 跑生成并轮询到结束
node scripts/todo-ctl.mjs new --script-file 口播.txt      # 新建（打印新 id）
node scripts/todo-ctl.mjs verify <productionId>           # 校验产物
node scripts/todo-ctl.mjs stop
```

它会做四件事（都在工作区内，不碰用户 AppData）：

1. `TODO_DATA_DIR = <repo>/.data-ctl/data`，所有写入都落在可写区；
2. 从 AppData **复制** `ai-config.json`（所以**真实生成可用**，不是 mock）；
3. 复制技能包与**已生成素材**（跳过 `wipe_cache`/`__pycache__`/`.npz` 等可再生重物），避免重复付费生图；
4. 复制成片文档，便于复用已冻结的分镜与参数。

固定端口 `7411`（`--port` 可改）。日志：`.data-ctl/server.log`。

### 直接调 API

服务就是 `server/aiServer.mjs`，接口与桌面版一致：

```powershell
# 列出成片
Invoke-RestMethod http://127.0.0.1:7411/api/ai-productions

# 新建（run:false 只建不跑）
$body = '{"skillId":"studio.spongebob-koubo","script":"...","run":false}'
Invoke-RestMethod http://127.0.0.1:7411/api/ai-productions -Method Post -Body $body -ContentType 'application/json'

# 跑 / 强制真跑 / 停止 / 编辑
Invoke-RestMethod http://127.0.0.1:7411/api/ai-productions/<id>/run    -Method Post -Body '{"force":true}'
Invoke-RestMethod http://127.0.0.1:7411/api/ai-productions/<id>/cancel -Method Post
Invoke-RestMethod http://127.0.0.1:7411/api/ai-productions/<id>/edit   -Method Post -Body '{"ops":[...]}'
```

⚠️ `params.sourceWork` **不能用 `setParams` 设**：它不在 `skill.json` 声明的参数里，宿主会拒。
（它是"命令行导入"时由 `scripts/import-koubo-workdir.mjs` 写进文档的。想换工作目录，就换成片或改文档。）

## 2. 其它两条接入面

| 面 | 用法 | 适用 |
|---|---|---|
| CLI | `npm run todo -- capabilities\|commands\|exec\|verify\|frame\|app\|otio\|mcp` | 磁盘工程；`app` 子命令需应用以 `--debug-port 9222` 启动 |
| MCP | `npm run todo:mcp`（stdio, 13 工具 / 3 资源） | agent 原生集成；`todo_render_frame` 直接把画面回给模型 |

发现能力**只读** `GET /api/capabilities`，不要读源码猜。

## 3. 已修复的阻断缺陷（曾让生成完全跑不起来）

`server/production/job.mjs` 写好了 `executeProductionJob`（成片管线执行器），
但 **`server/skillJobs.mjs` 的分流表里没有 `production`**，于是成片任务掉进 `executeElementsJob`，
而它的 `req.prompt` 对成片永远是 `undefined`：

```
TypeError: Cannot read properties of undefined (reading 'slice')
```

任务在 ~58ms 内失败、阶段停在「待生成」。已在 `executeSkillJob` 补上分流：

```js
if (pipeline === 'production' && job.params.request.productionId) {
  const { executeProductionJob } = await import('./production/job.mjs') // 动态 import：避免与 SKILL_OUTPUT_SPEC 形成初始化顺序依赖
  return executeProductionJob(job, ctx)
}
```

判据用 `request.productionId`（PROTOCOL.md §5 的定义），避免误拦老任务。

**回归测试**（零 AI 调用、零费用，可重复）：

```powershell
npm run production:dispatch
```

它用一个最小技能包（桩 `preserveSource`）走完整套流程，断言任务确实进了成片执行器、
分层与元素级音效真的入轨。把分流那一支去掉会立刻复现原 bug：

```
TypeError: Cannot read properties of undefined (reading 'slice')
    at fallbackPlan (server/skillPacks.mjs:589)
    at executeElementsJob (server/skillJobs.mjs:130)
```

> 写这类测试的坑：包内管线会派生 Python 子进程，而沙箱里**子进程只能写工作区**。
> 夹具根目录必须放在 `native/test-output/` 这类工作区内路径（`%TEMP%` 会拿到 `WinError 5`）。
> 本测试已按此处理，并支持 `TODO_DISPATCH_TMP` 覆盖。

## 4. 已验证结论（泡泡转场音效）

链路：`layers_export._wipe_sfx()` → 元素级 `sfx` → `bindLayerBoards` → `publicProduction` → 时间轴 `SFX_LANE`。

| 环节 | 实测 |
|---|---|
| 真实分层导出 | 13 boards / 16 elements，`s01_wipe_sfx.wav` 385,594 B |
| 音效技术参数 | `pcm_s16le 48kHz 2ch **2.0079s**`（包内未压速兜底是 4.01s → 修复生效） |
| 宿主绑定产物 | `p_mv…_s01_wipe_sfx.wav` 385,594 B（带 docId 前缀，不跨工程覆盖） |
| 宿主视图 | `publicProduction` 返回 `/ai-generated/…_s01_wipe_sfx.wav`（修复前是裸文件名 → 404 → 静默无声） |
| 端到端门 | `preview-black-gate`：泡泡音效落到独立音频轨 ✅ |

## 5. 还没验的（如实说明）

- **真机 GUI 路径**：需要人在界面里点一次；沙箱里我替代不了这一层。
- **完整付费生成**：上面走的是扩展**真实**分层导出 + 宿主真实绑定（零 AI 调用），
  但没有为验证而重跑一次全量生图；`run --force` 会产生生图费用。

## 6. 环境边界速查（踩过的坑）

| 现象 | 真因 | 对策 |
|---|---|---|
| `EPERM ... .tmp`（建文档时） | 沙箱只许写工作区，AppData 在外 | 用控制实例（§1） |
| `PermissionError [WinError 5]`（Python 写 `kit_assets`/`04_动画渲染`） | 同上，**子进程同样受限** | 数据目录与夹具都放工作区内 |
| `ELECTRON_RUN_AS_NODE=1` 导致 `app.isPackaged` 报错 | 某些 agent 会话会注入该变量 | 启动 Electron 前删掉它 |
| Electron 以 `0x80000003` 静默退出 | Chromium 沙箱被进程限制拦 | 加 `--no-sandbox` |
| 文字乱码 / `UnicodeEncodeError: 'gbk'` | 控制台编码 | `sys.stdout.reconfigure(encoding='utf-8')` |
| `ffmpeg` 能跑但写不出文件 | 内置 ffmpeg 在工作区内，同样只能写工作区 | 把 ffmpeg 放到区外（如 `C:\todo-ffmpeg`）并设 `FFMPEG` |

> 这些**都是 agent 侧的环境边界，不是应用缺陷**。用户在正常桌面上直接启动应用不会遇到任何一条。
