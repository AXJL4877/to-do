# TODO 扩展开发工具包

把整个文件夹交给改造 agent，同时提供 TO DO 源码路径、原工作流路径和样例。首先让 agent 阅读 docs/prompts/convert-workflow-to-extension.md，并按其步骤完成迁移、测试、修复与交付。

## 文件用途

- docs/extension-authoring.md：安装包格式与宿主扩展协议。
- docs/workflow-to-extension.md：如何把已有视频工作流拆为可编辑元素并接入时间轴。
- docs/extension-self-check.md：可执行验收、实质断言与失败后修复重测规则。
- docs/render-export-performance.md：渲染/导出路线、Python 逐帧改造、资源复用、有界并行、流水线与性能验收。
- scripts/check-render-performance.mjs：校验冷热基线/候选测量、时间/内存预算与质量证据；scripts/test-render-performance.mjs 是反例回归。
- docs/prompts/convert-workflow-to-extension.md：可直接交给 agent 的任务指令。
- docs/templates/：测试清单和迁移报告模板；清单里的测试脚本需要按工作流实现，不能空跑通过。
- scripts/check-extension.mjs：通用自检与发行门禁。
- scripts/test-extension-check.mjs：门禁自身的反例回归。
- examples/extensions/：真实扩展目录示例。转角推进包含测试清单与接入报告；paper-titles 用于门禁回归 fixture。
- samples/：转角推进 1.2.1 安装包、无声视觉样片与此前真实验收报告。

## 运行依赖与接入

自检依赖 TO DO 源码中的校验器、安装器及项目依赖，不是脱离宿主即可独立运行的应用。此文件夹是开发资料与工具集合；不包含整个 TO DO、node_modules、TTS 凭据或完整文字渲染器。示例需要当前更新后的宿主。

当前 D:\Desktop\to_do\todo-editor 已有这些工具，可在该项目目录直接运行：

```powershell
npm run extension:check -- examples/extensions/corner-chain deliverables/corner-chain-check.json deliverables/corner-chain.todoext
```

用于另一个兼容的 TO DO 源码工程时，由 agent 将 scripts/、docs/ 和必要示例合并到对应目录，检查与现有代码的兼容性，不要盲目覆盖。若没有 npm 脚本，也可在 TO DO 项目根目录直接运行：

```powershell
node scripts/check-extension.mjs <扩展源码目录> <源码目录外/报告.json> <源码目录外/输出.todoext>
node scripts/test-extension-check.mjs
```

每个扩展须提供 README.md、MIGRATION.md、extension.check.json 及其引用的真实测试脚本。全部通过才输出包；任何 FAIL 则修复后重新完整验收。不得以低层封装成功、空脚本、旧报告或旧产物冒充通过。真实依赖/凭据缺失时如实报告阻塞。

## 渲染效率是交付要求

agent 必须先看 docs/render-export-performance.md，评估原工作流的 Python 逐帧、PNG 落盘、资源重建与重复编码。基础合成优先评估 FFmpeg，文字/形状优先复用宿主渲染，必要自定义逐帧计算采用向量化/原生库或有界进程池。能安全并行的独立重任务应并行，保持帧序、背压、资源预算与质量。

迁移清单 origin=migration 现在必须包含 performance 检查，缺少则失败。docs/templates/render-performance.json 是待填实测模板，默认不会通过；不能把合成测试数据当基准。基线/新流程在同一环境、相同画质下各测冷/热至少三次，预算或质量失败继续修改。检查测量报告：

```powershell
node scripts/check-render-performance.mjs <实测PERFORMANCE.json>
node scripts/test-render-performance.mjs
```

这些工具不会自动改写原工作流或自动采集所有进程内存；agent 必须实现实际 benchmark、质量断言与正确的进程树/显存测量。samples 中的历史示例报告不包含新增性能认证，不证明其他工作流已优化。

samples/corner-chain-check.json 是原项目上的历史验收证据，含原项目绝对路径与宿主摘要；移动本工具包或修改代码后必须重新验收，不能将历史报告作为新环境通过证明。报告明确标记了 mock TTS，不代表真实远程配音质量。

SHA256SUMS.json 保存本文件夹内容清单，用于复制后校验。

## 黑板渲染参考

docs/chalk-render-performance.md 记录宿主已实现的局部工作区、进程并行和线程预算。scripts/test-chalk-render-performance.py、test-chalk-concurrency.mjs、benchmark-chalk-pipeline.py 须在配套更新后的 TO DO 源码根目录执行；本工具包不包含宿主补丁，也不能独立运行这些测试。samples/chalk-pipeline-benchmark.json 是本机固定样例的历史测量，不是新扩展的性能认证。
