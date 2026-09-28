# S0 Spike 结论报告（最小验证）

日期：2026-09-28  
机器：RTX 4060 Laptop + 系统缩放实测 150%（scaleFactor=1.5）  
产物：`native/bin/spike-child-window.exe`、`spike-dxgi-mt.exe`；源码 `native/spikes/`；Electron 入口 `TODO_SPIKE_CHILD=1` + `electron/spikeOverlay.cjs`

---

## S0.1 子窗口叠加 — **有条件通过（popup 可用 / child 失败）**

| 检查项 | child `WS_CHILD` | popup `WS_POPUP` owner |
|---|---|---|
| a. 稳定显示在 Chromium 内容之上 | **失败** | **通过** |
| b. 100/125/150% DPI 尺寸位置 | 部分（坐标需物理像素） | **有条件通过**（公式已修正为 `(content+rect)*scale`） |
| c. HTML 菜单/对话框重叠 | 不适用（不可见） | **风险：会盖住页面内菜单**（同屏像素叠在 RenderWidget 之上） |
| d. 鼠标穿透到 HTML | **失败**（命中 overlay，且看不见） | **通过** |

### 证据

**Host 离线（非 Electron）**
- child：`EnumChildWindows` 见 `TodoSpikeOverlay`；但 `WindowFromPoint` 仍命中 overlay（穿透失败）。
- popup：`WindowFromPoint -> TodoSpikeHost`（穿透成功）。截图：`host-popup-screen.png`

**Electron + child（窗口 restore 后）**
- Z-order 顶层为 `TodoSpikeOverlay`，其次 `Chrome_RenderWidgetHostHWND`、`Intermediate D3D Window`。
- 屏幕取色 **无品红**（`center=244,243,240 magenta=0/2332`）→ GDI 子窗在 Z 序上“在上”，但被 Chromium D3D/DWM 合成画面盖住。
- `WindowFromPoint -> TodoSpikeOverlay` → 拦截鼠标却不显示。
- 截图：`electron-child-restored.png`

**Electron + popup**
- 屏幕取色 `centerPixel=252,51,191`，`magentaSamples=1656/4002` → **品红可见**。
- `WindowFromPoint -> Chrome_RenderWidgetHostHWND` → **鼠标落到 Chromium**。
- `display.scaleFactor=1.5`；spike 进程 `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)`。
- Electron：`getContentBounds()` 为 DIP；日志见 `electron-spike-out.txt`。
- 截图：`electron-popup-screen.png`；`capturePage` 不一定含原生窗：`electron-capture-popup.png`

### 对 B2 的影响
- **不要用 `WS_CHILD` 挂在 `BrowserWindow` HWND 上做预览 Present**。
- **采用 `WS_POPUP` + owner=主窗 HWND**，跟随 `move/resize/minimize`，坐标统一：`physical = (contentBoundsDIP + cssRect) * scaleFactor`。
- 交互：预览层若需点击穿透用 `WS_EX_TRANSPARENT` + `HTTRANSPARENT`（popup 已验证）；若需在预览上拖特效手柄，则**不能**全局穿透，需分区命中。
- 页面内 HTML 菜单会被 popup 挡住 → 菜单打开时隐藏/降 Z，或仅在预览 HWND 区域呈现。

---

## S0.2 DXGI 适配器选择 — **通过**

命令：`native/bin/spike-dxgi-mt.exe`

```
adapter[0] "NVIDIA GeForce RTX 4060 Laptop GPU" LUID=00000000:0001351B vramMB=7956.0 flags=0x0
adapter[1] "NVIDIA GeForce RTX 4060 Laptop GPU" LUID=00000000:00024D0A vramMB=7956.0 flags=0x0
adapter[2] "Microsoft Basic Render Driver" LUID=... vramMB=0.0 flags=0x2 SOFTWARE
SELECTED adapter[0] ... vramMB=7956.0
D3D11CreateDevice hr=0x00000000 featureLevel=0xB100 flags=0x820
```

- `flags=0x820` = `BGRA_SUPPORT(0x20) | VIDEO_SUPPORT(0x800)`
- Feature Level **11.1** (`0xB100`)
- 规则有效：排除 SOFTWARE、排除 vram=0；取显存最大；支持 LUID 覆盖参数。
- 本机出现 **两个同名 NVIDIA LUID**（Optimus/多链路）→ B2 应持久化用户选中的 LUID，不能只按名称。

### 对 B2 的影响
- Device 创建必须走 **选中的 IDXGIAdapter1 + DRIVER_TYPE_UNKNOWN + BGRA|VIDEO**。
- 配置项保存 LUID；默认跳过 SOFTWARE 与 vram==0（挡住 Oray 类虚拟适配器）。

---

## S0.3 ID3D11Multithread 自声明 — **通过**

同一 `spike-dxgi-mt.exe`：

```
QI ITodoD3D11Multithread hr=0x00000000 ptr=...
GetMultithreadProtected(default)=0
SetMultithreadProtected(TRUE) returned=0 after=1
QI ID3D11VideoDevice hr=0x00000000
```

- IID `9B7E4E00-342C-4106-A19F-4F2704F689F0` 自声明接口 **QI 成功**（无需 MinGW `d3d11_4.h`）。
- `SetMultithreadProtected` 返回值为**先前状态**（0），设置后 `Get==1`。

### 对 B2 的影响
- 可在 MinGW/w64devkit 下安全启用多线程保护，无需换 MSVC 只为这个接口。
- 解码线程与 Present 线程共享 Device 前调用 `SetMultithreadProtected(TRUE)`。

---

## 总表

| Spike | 结论 | B2 关键决策 |
|---|---|---|
| S0.1 | **有条件通过**（仅 popup） | Present 用 owner popup，不用 WS_CHILD |
| S0.2 | **通过** | Adapter 枚举+LUID 配置；BGRA\|VIDEO |
| S0.3 | **通过** | 自声明 IID QI + SetMultithreadProtected(TRUE) |

## 复现

```bat
native\bin\spike-dxgi-mt.exe
set TODO_SPIKE_CHILD=1
set TODO_SPIKE_MODE=popup
npm run electron:dev
```
