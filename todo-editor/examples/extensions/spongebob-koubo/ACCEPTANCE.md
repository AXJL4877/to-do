# 海绵宝宝口播 · 验收（对照原管线渐进顺序）

参照：`d:\Desktop\手绘风格\trial\koubo\PIPELINE.md` + `ACCEPTANCE_AUTO.md`。

## 管线阶段（不得跳步另发明）

| # | 原阶段 | 产物 | 入轨 |
|---|---|---|---|
| 0 | clean | 清串台 | — |
| 1 | tts | `01/audio.wav` + timing | **先**铺口播轨 |
| 2 | design | shots_design / plan / **bgm_plan** | 定 visual + 三段 BGM 时刻 |
| 3 | assets | cut 透明素材 | 素材像素 |
| 4 | render | `成片.mp4` + layers | **再**按镜铺分层 |
| 5 | bgm | mix 叠床 | **最后**铺 intro/mid/outro 三轨 |
| 6 | accept | g1–g8 | 硬门 |

## 时间轴必须长这样

1. **口播轨**：来自 TTS，不是成片混音。  
2. **画面**：开场 `intro_red` 红字层 → 其后按 beat 的 visual 逐类出现元素（scene/dialogue/…），禁止默认只放一条静音成片。  
3. **字幕**：`intro_red` 句**无**宿主白字幕；从首个元素镜起才铺短语字幕（与 `kit.render` 一致）。  
4. **分层入场片 / 泡泡转场**：一律 **VP9 alpha WebM**（`alpha_mode=1`，真透明）——宿主预览是 Chromium，qtrle MOV 解不出会整层不可见；「预乘黑底 + H.264 + 近黑抠像」会留绿边、硬阈值块状空洞，且依赖素材带 `chromaKey=nearblack`（丢了即满幅黑屏）。禁止把透明内容烤成不透明黑底。  
5. **BGM**：`bgm_plan` 三段分轨（Holding Court → 精卫降调 → Memories），禁止口播复制当 BGM。

## 禁止

- 用整片 `sourceFilm` 冒充「已对齐原流程」  
- 三行红字同时糊满整段开场  
- 开场红字下叠口播字幕  
- 泡泡转场黑底不透明（`chromaKey=nearblack` 丢失）
- 用 qtrle / ffv1 当宿主入场层（Chromium 解不出，预览看不见）
- 用近黑抠像冒充真 alpha（绿边 + 块状空洞）
- 自造 BGM 曲目或合并成一条无分段床冒充三段政策
