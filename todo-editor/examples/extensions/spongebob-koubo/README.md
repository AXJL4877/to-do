# 海绵宝宝口播

独立 ID：`studio.spongebob-koubo`。包内管线与 `d:\Desktop\手绘风格\trial\koubo` 同职责：

`clean → tts → design → assets → render → mix_bgm → accept`

时间轴按原流程**渐进入轨**（见 [EDIT_WORKFLOW.md](EDIT_WORKFLOW.md)）：

1. 先铺 TTS 口播  
2. 再按镜头 visual 逐镜补画面（开场红字 → scene/dialogue/…）  
3. 最后按 `bgm_plan` 铺片头 / 中段 / 后段 BGM  

## 包内结构（标准扩展布局）

```text
spongebob-koubo/
├─ skill.json            # 清单：pipeline=production，同时声明 preserveSource 与 runtime
├─ render.py             # 协议自检入口（见下）：手搓 todo-skill-render/1 握手，不是成片渲染器
├─ workflow/             # 包内真实管线（preserveSource 的入口）
│  ├─ run_pipeline.py    #   宿主调用这个出片
│  ├─ 01_口播试听/ … 04_动画渲染/
│  ├─ accept_gates/      #   机器可读的硬验收门
│  ├─ kit/               #   渲染内核（render.py / layers_export.py / typo.py / bubble.py …）
│  │  ├─ assets/         #   fx（泡泡转场）、backgrounds、cut  …
│  │  └─ fonts/          #   随包字体（见下）
│  └─ ref_bgm/           #   三段规定曲目
├─ checks/               # extension:check 用的检查脚本
├─ scripts/              # 打包期一次性脚本（assembling / patching）
├─ README.md / MIGRATION.md / ACCEPTANCE.md
└─ EDIT_WORKFLOW.md / LIVE_CONTROL.md
```

**与文档建议布局的唯一偏差**：`docs/workflow-to-extension.md` 建议把 `assets/` 放在包根。
这里保持 `workflow/kit/assets/`，因为 `paths.py` / `assemble_workflow.py` / `kit/assets.py`
都以 `workflow/kit` 为根解析资源。挪到包根要同步改这三处解析逻辑，收益只是"更像模板"，
风险却是打断已验证的出片基线，所以**有意保留**。

### `render.py` 是协议探针，不是成片渲染器

本扩展用 `preserveSource` 把出片委托给 `workflow/run_pipeline.py`；宿主看到该字段后
直接走包内管线，**不会调用 `render.py`**（`server/production/runner.mjs:136`）。
`render.py` 的存在只为证明"包内 Python 与宿主协议对得上"（离线、不花钱、不需要 AI 服务），
其结果里 `scene.layout = "protocol-probe"`。真实逐元素分层在 `workflow/kit/kit/layers_export.py`。

同理，`skill.json` 里的 `planner.system` 与 `assets.*` 在生成时**不被宿主使用**
（production 管线要求这两个字段存在才通过校验），两处都已显式标注。

## 安装与入轨

```powershell
cd <repo>/todo-editor
$env:TODO_DATA_DIR = "$env:APPDATA\todo-editor\data"
node scripts/koubo_edit_bind.mjs <productionId>
node scripts/trigger-live-accept-koubo.mjs <productionId>
```

## 开场红字字体

开场红字的字体链是 **包内优先**，桌面路径只作兜底（`kit/typo.py:TITLE_FONT_CHAIN`）：

1. 包内 `workflow/kit/fonts/字魂剑气手书(商用需授权).ttf` ← 正常走这个
2. 兜底 `D:\Desktop\TTF\字魂剑气手书(商用需授权).ttf` ← 只在包内缺失时用
3. 逐字后备 `workflow/kit/fonts/AmezumiGothic.ttf` ← 首选字体缺某个字时只换那个字
4. 最后 `CARD_FONT`（思源宋 Heavy）

- 首选字体缺某个字时，只换那一个字的字体，**不再把整字丢掉**（旧版会丢字，导致开场文字不全）。
- 简体字形优先；简体没有、繁体有才用繁体。
- ⚠️ `字魂剑气手书` **商用需授权**，随包分发前请确认授权（其余字体为 OFL，可自由分发）。

自检：`runtime\python\python.exe scripts\verify-koubo-title-font.py`
（读字体链 → 逐字覆盖报告 → 写出预览 PNG `native/test-output/koubo-title-font-preview.png`）。
