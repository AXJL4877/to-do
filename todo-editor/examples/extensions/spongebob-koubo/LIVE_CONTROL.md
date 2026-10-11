# 实机控制 TO DO（给 Agent / 自己用）

我**不能**默认实时盯着你磁盘上任意打开的 `.todo` 工程。要准，靠这条通道：

## 你这边固定做法

1. **验收前必须新建空工程**。`演示草稿` 这类工程会叠历史 `p_mv*` 轨，看起来像「素材还是旧的」。  
2. 保持 `electron:dev` 主窗口开着；改完 `liveAcceptKoubo.ts` 后确认热更新（或重启一次）。  
3. 生图 job 名已带工作区指纹；若仍怀疑旧图，先看 `asset_md5_*.json` / `latency`（真新生图通常几十秒以上，2 秒出齐多半是密匙 job 缓存）。  
4. 让我跑命令，不要只口述「你看一下」。

## 命令

```powershell
cd D:\Desktop\to_do\todo-editor

# 导出当前打开工程的时间轴快照（我读这个文件，不靠猜）
node scripts/todo-live-ctl.mjs dump

# 清掉 koubo/成片污染轨
node scripts/todo-live-ctl.mjs clean
node scripts/todo-live-ctl.mjs clean p_mvmin_wipe1

# 清完再按规范入轨并验收
node scripts/todo-live-ctl.mjs accept p_mvmin_wipe1
```

产物：

- `native/test-output/spongebob-koubo/LIVE_CTL_REPORT.json`
- `native/test-output/spongebob-koubo/PROJECT_SNAPSHOT.json`（dump/accept 后）

快照里会标：`project.path`、全部片段、`foreignClips`（污染嫌疑）。

## Agent 纪律

- 改时间轴前先 `dump`；看到 `foreignClips` 先 `clean`。  
- 验收以快照 + 播头画面为准，不以「生产文档里有 sourceFilm」冒充工程正确。  
- 新旧成片 ID 不要混在同一工程里叠轨。
