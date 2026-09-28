# 进度账本

## 已有状态（2026-09-28 只读确认）
- B1.0/B1.1/B1.2a/B1.2b：附件报告已通过；本轮不重写基线。
- T1：2969dfe、145db33 已提交。本轮重新运行交叉校验。
- T2：工作区已有未提交原生协议/GDI popup 骨架。尚无 D3D11 视频合成器；不宣称 T3–T13 完成。
- 本轮开始前有大量未提交改动，保留，不并入本轮提交。

## FIX-PREVIEW-CACHE：缓存回看卡顿与多层错帧
- 状态：调查/复现测试中；commit：待门禁通过。
- 原因证据：previewCache 预取不检查 seek/采样稳定性即入库，且与前台使用相同 clip 解码槽；videoCache 暂停返回旧快照不标记不稳定；播放允许 8 帧漂移但仍允许缓存；缓存命中未调用已有 holdVideoDecode。
- 方案：先用单个隐藏 Electron 测试进程加载真实视频/Canvas 复现；隔离预取槽、等待各层同帧就绪；仅准确采样可入缓存；命中缓存停止前台视频解码；覆盖缓存失效。保留 HTML 预览回退与现有原生骨架。
- 范围：src/lib/previewCache.ts、src/lib/videoCache.ts、必要的 monitorDraw.ts 采样状态；scripts/test-preview-cache.mjs、tests/preview-cache.browser.ts、本账本及人工清单。
- 验收：新回归测试、npm run build、golden:check、crosscheck-keyframes、crosscheck-timemap、preview:test。没有 perf-gate/baseline.json，不能给出原生性能达标结论。
- 未决：用户工程实际多媒体布局需人工回看；原生后续任务按用户补充要求继续推进。

## 用户补充：优先原生编译高性能引擎
- 已确认方向：保留 Electron/React UI，C++17 + FFmpeg D3D11VA 硬解，常驻显式选卡 D3D11 Device，GPU 纹理合成/缓存；不重写为纯 C，不用浏览器缓存替代原生目标。
- 使用设计/计划技能，用户附件已给定架构与自主执行授权，按附件顺序执行，无需重复授权。
- 原生推进前先收尾已复现的回退错误；避免迁移期间 fallback 缓存继续污染。
- [ ] T2 核实协议、修复与 T1 冲突的新增 quantize.h（当前 round，附件要求 floor），补 PROTOCOL.md；检查 unsupported 回退。
- [ ] T3 独立 decoder worker / render worker，固定帧池+SPSC；D3D11VA GPU texture→NV12 shader→popup；seek serial 过滤；逐帧读回断言。
- [ ] T4 先建性能门禁：真实帧号、P99/P95/丢帧/GPU驱动信息，禁止假 stats。
- [ ] T5 多层 z-order 合成、独立解码槽和转场；所有层同一时间线帧准备好后原子上屏。
- [ ] T6 全 I 帧代理、显存预算、双向预取、编辑区间失效。
- [ ] T7–T13 按附件顺序；全部自动和人工门禁之前不宣称达到完成定义。
- 每阶段：先失败测试→实现→全部相关门禁→提交→更新账本。源素材解码不在 render thread，热路径不分配、不做文件 IO，不复用逐帧创建设备的旧导出链路。
- 发现事实冲突：native/shared/quantize.h 新增 round 版本与已提交 timemap.h/cpp 的 floor 同名函数冲突，先修复再链接 B3。

## FIX-PREVIEW-CACHE 验收（2026-09-28）
- 状态：代码与自动化验收完成，等待人工工程回看；提交待记录。
- 文件：src/lib/previewCache.ts、src/lib/videoCache.ts、src/lib/monitorDraw.ts、scripts/test-preview-cache.mjs、tests/preview-cache.browser.ts、docs/PROGRESS.md、docs/HUMAN_VERIFY.md。
- 同一缓存链路文件在本轮前已有未提交支撑改动（共享上一帧、离屏合成、帧稳定性标记、Canvas池）。保留并随本任务收口；其他现存 Electron/UI/fixture 改动不提交、不还原。
- 修复：预取独立槽，所有层就绪才入库；暂停精确采样；实时漂移帧不入库；命中缓存暂停视频，离开缓存强制对齐；freeze编辑失效并取消旧预取；缓存条不跨缺帧；旋转/透明/letterbox不能误剔除下层。
- 独立审查发现缓存→实时切换的旧帧回跳，已用真实视频复现并修复；移除修复时对应测试失败，恢复后通过。补充失效期间pending预取的取消及替代任务完成测试。
- 新测试：node scripts/test-preview-cache.mjs，10/10通过。完整输出：native/test-output/cache-tests.log；结构结果：native/test-output/preview-cache/results.json；失败像素图由脚本自动保存。
- 预取像素验收使用独立HTMLVideo seek及手工画布布局，PSNR门槛45dB。第一次参考绘图漏了全画幅crop裁剪，导致半像素边缘抗锯齿差异36.56dB；补齐参考的指定裁剪语义后通过，未降低阈值。
- npm run build：exit 0；完整输出native/test-output/cache-build.log。既有Vite混合静态/动态导入与大包警告保留。
- golden.mjs --check：每个原生进程前500ms间隔，重试0；未更改基线。完整输出如下。


```text
[blend_multiply_screen_add] 20 samples, canvas 640x360
....................
[crop] 20 samples, canvas 640x360
....................
[fade_black] 20 samples, canvas 640x360
....................
[four_layer] 20 samples, canvas 960x540
....................
[freeze] 20 samples, canvas 640x360
....................
[letterbox_odd_aspect] 20 samples, canvas 853x401
....................
[reverse] 20 samples, canvas 640x360
....................
[reverse_out_unset] 20 samples, canvas 640x360
....................
[single] 20 samples, canvas 640x360
....................
[speed2x] 20 samples, canvas 640x360
....................
[speed_1_5x_reverse] 20 samples, canvas 640x360
....................
[transform_ease] 20 samples, canvas 640x360
....................
[transform_keyframes] 20 samples, canvas 640x360
....................
[transform_keyframes_unknown_fields] 20 samples, canvas 640x360
....................
[transition_dissolve] 20 samples, canvas 640x360
....................
[transition_push] 20 samples, canvas 640x360
....................
[transition_wipe] 20 samples, canvas 640x360
....................
[two_layer_normal] 20 samples, canvas 640x360
....................
golden --check OK：360 帧哈希 100% 一致

```
- crosscheck-keyframes、crosscheck-timemap：每次进程启动前50ms间隔，重试0。完整输出：
```text
crosscheck-keyframes OK：200 groups × 100 times = 20000 点
maxAbsErr=0.000e+0 (< 0.000001)
crosscheck-timemap OK：500 groups × 100 times = 50000 点
maxAbsErr=0.000e+0 (< 1e-9)

```
- 相对baseline：golden哈希变化0；不存在tests/perf/baseline.json和perf-gate，不能声称P99/丢帧/seek性能已达标。
- 风险：HTML实时路径仍允许跨层采样时刻偏差（现已禁止误入缓存），需T3–T6原生链路替代；新增预取槽会增加解码器资源。
