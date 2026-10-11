# scripts/ — 打包期维护脚本（**运行时不会执行**）

这个目录是扩展**组装/迁移期**用的一次性工具：把作者机器上的原工作流
（`d:\Desktop\手绘风格\…`）整理成自包含的 `workflow/`，并消除里面的绝对路径。

- 宿主生成成片时**只调用** `workflow/run_pipeline.py`，不会碰这里的任何文件。
- `workflow/kit/` 不 import 这里；删掉本目录不影响出片。
- 它们随包分发只是为了留痕（便于日后重新组装或核对改了哪些路径），**不是包接口**。

| 文件 | 作用 |
|---|---|
| `assemble_workflow.py` | 把原 `trial/koubo` + `kit` + 字体拷成自包含 `workflow/`（头部常量指向作者机器，换机器需改） |
| `patch_portable.py` | 重写 `workflow/` 里的绝对路径，使包可移植（含 `C:\Windows\Fonts` → 包内字体） |
| `fix_kit_parents.py` / `fix_trial_paths.py` | 修正组装后的相对层级与路径引用 |
| `make_bgm_bed.py` | 从已有 koubo 工作区按 `bgm_plan` 生成纯 BGM 床轨 `bgm_bed.wav`（不含口播） |
| `reexport_layers.py` | 从已有工作目录重新导出 `layers_manifest.json`（调试分层用） |
| `templates/` | 组装时的文件模板（`paths.py` / `run_tts.py` / `resolve_voice.py` / `render_koubo.py`），由 `assemble_workflow.py` 使用 |

⚠️ 这些脚本含**作者机器绝对路径**且不做参数化，属于历史记录。
如果你的目标是"另一台机器重新组装一遍"，请先把头部常量改成环境变量。
