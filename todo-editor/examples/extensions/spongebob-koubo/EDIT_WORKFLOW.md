# 海绵宝宝口播 · 渐进式入轨（对照原管线）

原工作流：`d:\Desktop\手绘风格\trial\koubo`（`PIPELINE.md`）。

生成顺序与时间轴入轨顺序一致，**禁止**另发明「整片盖轨当画面」：

```
① TTS 口播入轨
② 按镜头逐镜补画面（visual 一类一类出现）
③ 转场音效：随泡泡遮罩元素落到独立音频轨（不是混在画面里）
④ 画面齐后，按 bgm_plan 铺三段 BGM（片头 → 中段 → 后段）
```

---

## ① 配音（先入轨）

| 轨 | 来源 |
|---|---|
| A · 口播 | `01_口播试听/audio.wav` + `timing.json` |

对应原命令：`run_pipeline.py --tts`。

---

## ② 画面（逐镜补）

设计产出 `02/shots_design.json` 的 `beats[].visual`，渲染/`layers_export` 按镜写出可编辑层。入轨按时间顺序铺，例如：

| 顺序 | visual | 画面 |
|---|---|---|
| 最先 | `intro_red` | 黑底红字（分行）→ 碎裂黑场 → 泡泡遮罩揭开；**此句无宿主白字幕** |
| 随后 | `scene` / `dialogue` / `duo` / `emphasis` / `reveal` / `reaction` / `card` / `stamp` | 海滩底板 + 角色/道具/气泡/花字/黄卡…按短语 `enter`/`enter_at` 出场；**有字幕** |

宿主时间轴：每个元素一条 hold（+ 入场 **VP9 alpha WebM**，`alpha_mode=1`，宿主 Chromium 可播真透明；导出侧按该标记自动转 qtrle/argb MOV），可单独挪缩。  
泡泡转场同样是 **VP9 alpha WebM**（真 alpha，边缘平滑）。**不要**再用「预乘黑底 + H.264 + 近黑抠像」：色度 4:2:0 会把绿幕溢色糊成绿边，宿主 ≤18 是硬阈值会在软边上打块状空洞，而且素材必须带 `chromaKey=nearblack`，标记一丢就是满幅黑屏（宿主仍兼容该老路径，但新产物不再走）。`sourceFilm` 只作对照，**默认不铺**。

---

## ③ 转场音效（随画面层走，独立音频轨）

泡泡遮罩转场的音效是**元素级音频**，不是画面的一部分，也不是 BGM：

| 环节 | 谁做 | 产出 |
|---|---|---|
| 抽音轨 | `layers_export._wipe_sfx()` | 从 `kit/assets/fx/bubble_wipe.mp4` 自带音轨抽出，`atempo` 压到墙钟 2s、`volume=5.0`（与 `kit/render.py` 的权威混音同参），写成 `<stem>_sfx.wav` |
| 挂到元素 | `_wipe_overlay_layer()` | 该元素带 `"sfx": "<stem>_sfx.wav"`（兜底用包内 `bubble_wipe.wav`） |
| 收进产物 | 宿主 `bindLayerBoards` | 复制成 `<docId>_<elementId>_sfx.wav` 放进 `ai-generated/` |
| 换成 URL | 宿主 `publicProduction` | `sfx` 与 `video`/`hold` 同语义，都换成 `/ai-generated/...` |
| 落轨 | 宿主 `productionTimeline` | `SFX_LANE` 独立音频片段，与元素起止一致 |

对应时间轴键：`<seg>/<element>/sfx`。

**两条硬约束（踩过）：**

1. 音效值必须是**音频**文件。曾经在生成器之后又复制一份 `bubble_wipe.mp4` 覆盖 `sfx`，
   前端 `<audio>` 解不了裸 mp4 → 时间轴**静默无声**，且没有任何报错。
   同一个元素的 `sfx` 键只允许一个地方写。
2. `sfx` 只有被宿主换成 URL 才能加载。漏掉这一步会取到站点根 → 404 → 同样静默无声。
   `checks/edit-workflow-contract.mjs` 与 `scripts/skill-pack-selfcheck.mjs` 各锁一条。

---

## ④ BGM（画面后再铺，三段渐进）

来自 `02/bgm_plan.json`（`bgm_policy.py` 硬锁）：

| id | 曲目 | 角色 |
|---|---|---|
| `intro` | 跨越大洋的飞机 - Holding Court | 片头 |
| `mid` | 眠舸 - 精卫（降调） | 中段 |
| `outro` | TRA$H - Memories | 后段升华 |

时间轴上是 **三条** BGM 片段（`…/bgm/intro|mid|outro`），起止与 plan 的 `start`/`end` 一致，不是整条口播复制床。

没有 `bgm_plan` 时才回退整段 `bgm_bed.wav`（`mix_bgm.py` 出的纯 BGM 床轨，**不含口播**）。

---

## 操作

```powershell
cd D:\Desktop\to_do\todo-editor
$env:TODO_DATA_DIR = "$env:APPDATA\todo-editor\data"
node scripts/koubo_edit_bind.mjs <productionId>
node scripts/trigger-live-accept-koubo.mjs <productionId>
```

验收看：口播先在；0.3s 开场红字 hold；泡泡转场音效在独立音频轨（`…/sfx`）；BGM 分 intro/mid/outro。
