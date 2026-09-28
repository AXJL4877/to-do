# B2 原生预览引擎报告（协议 v1）

日期：2026-09-28  
产物：`native/bin/todo-preview-engine.exe`、`todo-job-bind.exe`、`spike-host.exe`  
源码：`native/preview/`、`electron/previewEngine.cjs`、`src/lib/nativePreviewBridge.ts`、`src/hooks/usePreviewSuspend.ts`

## 实现要点

| 项 | 选择 |
|---|---|
| 窗口 | `WS_POPUP` + owner=主窗 HWND；`WS_EX_TRANSPARENT \| NOACTIVATE \| TOOLWINDOW`；`HTTRANSPARENT` / `MA_NOACTIVATE` |
| 纯色填充 | **GDI** `FillRect`（青绿 `RGB(40,180,120)`） |
| DPI | 运行时 `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)`；附 `todo-preview-engine.manifest` 声明（MinGW 未嵌入 PE，靠运行时） |
| 坐标 | 主进程 `contentBounds + cssRect` → `screen.dipToScreenRect`；引擎不做 DPI 换算 |
| 生命周期 | **Job Object**：`todo-job-bind.exe` 创建 `KILL_ON_JOB_CLOSE` 并绑定引擎 PID，stdin 随主进程关闭；**后备**：引擎读 `TODO_PARENT_PID` 监视父进程 |
| 崩溃 | 非 0 / 异常退出 → `preview:crashed`，回退 canvas；**不自动重启**（B11） |
| 范围 | 仅节目监视器；`settings.nativePreview` 默认 `false` |

## 自动化（`npm run preview:test`）

- 未知命令 / 畸形 JSON / 重复 init / 超长行 → `error` 且进程存活  
- 1000× seek → `seekTotalUs < 5000`  
- play 30s → playhead 误差 `< 1` 帧  
- stdin 关闭 → 1s 内退出  

## 人工验收清单（agent 不宣称通过）

1. [ ] 预览区出现纯色窗口；系统缩放 100% / 125% / 150% 下位置尺寸正确（截图）
2. [ ] 主窗移动、最大化、最小化再恢复后位置不漂移
3. [ ] （若有）主窗拖到另一块不同缩放显示器，位置仍正确；无条件则 **未验证**
4. [ ] 打开工具条下拉 / 工程设置 / 导出 / 右键菜单 → 预览窗隐藏；关闭后恢复且最后一帧仍在
5. [ ] 切换到其他应用，预览窗不遮挡其他应用（截图）
6. [ ] 鼠标点击 / 拖动 / 滚轮穿透到下方 HTML（预览区上方可交互控件）
7. [ ] 强杀引擎：编辑器不崩，回退旧 canvas；强杀编辑器：无残留 `todo-preview-engine` 进程

## 遗漏 / 已知代价

- Toast / 提示层、PropWheel、AI 配置浮层：**未**挂 `usePreviewSuspend`（后续可补）
- **全屏预览**：开启全屏时停原生、走旧 canvas；退出全屏再按开关恢复
- **拖拽媒体**：`beginMediaDrag` → `suspend(drag)`（已做）
- 双同名 GPU LUID：`init.adapterLuid` 可覆盖；默认 S0.2 最大显存规则
- **杀软**：请将 `todo-editor/native/bin` 加入排除项，否则 exe 可能被隔离导致测试失败

## 复现

```bat
npm run native:build
npm run preview:test
rem UI：工程设置勾选「原生节目预览」后看节目窗青绿纯色层
npm run electron:dev
```
