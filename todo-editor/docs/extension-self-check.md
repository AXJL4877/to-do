# 扩展自检与修复闭环

每个交付扩展同时提供源码、README.md、MIGRATION.md、extension.check.json 与清单引用的测试脚本。自动校验入口在 scripts/check-extension.mjs；所有发行包使用此入口交付：

```powershell
npm run extension:check -- <扩展源码目录> <源码目录外/验收报告.json> <源码目录外/扩展.todoext>
```

成功：退出 0、报告 ok=true、output 包哈希存在。失败：退出 1、ok=false、output=null，旧发行文件保持原样，不能把它当作本次成功产物。报告与发行包不能放进源码目录。源目录必须是真正要发行的文件，不要混入运行缓存。

## 自检入口实际检查什么

1. 使用宿主同一套 manifest/参数/路径/大小/哈希校验器打包。
2. 在临时 TODO_DATA_DIR 安装，再安装同版本验证幂等；不触碰实际用户数据，结束后删除临时目录。
3. 验证测试清单与文档。skill 必须覆盖 runtime、timeline、editing、cache、export；style/animation 必须覆盖 runtime、editing、export。origin=migration 还必须覆盖 baseline 与 performance，缺失则失败。新开发渲染扩展也按性能准则增加基准和预算。
4. 按顺序执行测试，shell=false。任何非零退出、启动失败或超时为 FAIL；继续运行后面的独立检查，集中反馈问题。
5. runtime/export/baseline 必须写出非空产物。本次检查未更新的旧产物不算证据。报告保存命令、日志、SHA-256；临时安装目录内的证据会复制到报告旁保留。
6. 重新检查包源码与宿主/测试源码摘要。测试期间代码改变即失败，要求在最终代码上再测。全部通过才输出包，并记录最终字节的 SHA-256。

清单的 covers 是测试作者声明，不能代替断言。不能用打印 PASS、空脚本、只检查文件存在来假装测试功能。审阅测试脚本与查看视觉结果仍是交付要求。自检证明列出的测试通过，不保证审美或任意第三方服务质量。

每类测试至少包含以下实质断言，按原工作流能力扩充：

| covers | 必须实际验证 |
|---|---|
| baseline | 原入口与适配入口用同一素材/固定种子运行；比较逻辑对象、时间与视觉/音频特征，保留原结果与差异记录 |
| runtime | 从安装目录执行协议入口；输入/输出稳定 ID 对应、文件存在、媒体可解码、画幅/fps/alpha正确；原生文字则检查描述与真实渲染帧 |
| timeline | 本扩展实际生产文档入轨，逻辑对象独立成片段、配音链接与时间对齐正确、重复同步不重复添加、局部更新不影响无关对象 |
| editing | 改独立元素位置/缩放/旋转/透明度，在真实 store 与渲染采样中生效；有关键帧则检查起点/中间插值，按声明检查重渲后保留，不只比 JSON |
| cache | 参数或元素内容变化触发正确层重新生成；无关参数/相同请求按声明复用；不能用改包版本代替参数变化测试 |
| export | 通过 TO DO 导出真实文件并解码检查时长/画面/声音，比较预览与导出；不能以原工作流自己的最终 MP4 代替宿主导出 |
| performance | 同画质、同环境、固定输入的冷热基线与新流程各至少三次；比较中位数、内存/显存/并发与质量。用 check-render-performance.mjs 校验真实 PERFORMANCE.json，预算或质量失败则继续修改 |

超出当前宿主能力时先做并测试宿主适配，不能把用户要求从测试清单删掉。迁移工作流默认至少 E1；一个烘焙视频不能算全部逻辑元素可编辑。

## 清单格式与测试上下文

模板：docs/templates/extension.check.json。真实完整示例：examples/extensions/corner-chain/extension.check.json。模板引用的脚本必须由改造 agent 实现，未实现会失败，不提供“默认通过”占位实现。

- spec 固定 todo-extension-check/1；origin 为 migration 或 new。
- 每项 id 唯一；argv 是程序与逐个参数数组，不能写 shell 拼接命令。node 自动使用当前 Node；Python 按运行环境使用 python 或绝对解释器路径，机器专属路径不要写进发行包。
- cwd=installed 从真正安装后的扩展目录运行，适合自身协议、依赖和渲染测试；cwd=repo 从 TO DO 仓库运行，适合宿主入轨/导出适配测试。用 installed 测路径兼容性，不能只在原作者目录跑。
- 环境变量 TODO_EXTENSION_SOURCE 指向源码，TODO_EXTENSION_DIR 指向临时已安装目录，TODO_EXTENSION_REPORT_DIR 指向报告目录。宿主测试应读取本扩展的真实生产 fixture，不能把内置示例的通过计为此扩展验收。
- covers 可用 runtime/timeline/editing/cache/export/baseline/performance/host；每项可验证多个能力。迁移 baseline 应比对原流程与适配流程固定样例的对象、时间、输出质量，而非只跑一遍新代码。performance 的实测脚本和预算校验必须纳入清单，详见 render-export-performance.md。
- mode 为 offline/mock/network；mock 在报告中明确列为限制。network 默认失败，只有作者授权后显式加 --allow-network 才运行；此开关不代表用户授权付费调用。真实 TTS 未运行时必须如实注明。
- timeoutMs 为 100–600000 毫秒；artifacts 为 cwd 内相对文件路径数组，不允许越界。各测试重新生成报告/fixture/媒体证据。安装过程不执行这些脚本，只有作者主动运行自检入口才执行。

## agent 强制修复闭环

1. 阅读规范与真实宿主代码，完成适配、测试和清单。
2. 运行完整 extension:check 命令并读取 JSON 报告及每个失败日志。
3. 对 FAIL 定位原因、修改实现或错误测试。不要删除失败检查、降低断言、改 mock 标签、用旧文件或重复跑命令掩盖问题。
4. 单项验证修复后重新跑完整自检。任何源码/宿主改动后，旧报告失效。
5. 只有最新运行退出 0、ok=true 才交付包；同步交付源码、报告、样例与宿主适配说明。缓存/局部重做/逐元素编辑必须有真实链路断言。
6. 依赖、凭据或用户资料确实缺失时，标为未通过并报告具体阻塞；继续可做的部分，不能宣称全部验收或悄悄转成 mock。

当前低层 extension:pack 只做封装，保留给格式调试；它不代表功能验收。开发交付必须用带输出路径的 extension:check，不得以 extension:pack 或 corner:pack 的成功代替。也可直接运行 `node scripts/check-extension.mjs <源码目录> --report <报告路径> --output <包路径>`；npm 入口建议使用前述三个位置参数，避免部分 Windows npm 启动器吞掉选项。

## 自检脚本自身的回归

```powershell
npm run extension:check-test
```

包含成功发行、失败阻断、旧文件保护、缺失/陈旧证据、缺项、超时、源码变更和迁移基线缺失等反例。
