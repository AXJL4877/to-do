# 给 agent 的工作流迁移指南：原始视频工作流 → TO DO 扩展

适用场景：作者先自由完成自己的视频生成工作流，然后交给 agent 改造成可拖入 TO DO 安装、可生成内容、可在时间轴逐元素调整的扩展。此文是改造操作规范，不要求作者先按黑板工作流开发。协议依据当前仓库 2026-10-09 的实现。

交付目标包含三个独立验收点：**包能安装；工作流能运行；生成的元素能编辑**。只把原脚本压成 ZIP，或只返回一个最终 MP4，不算完成元素可编辑的迁移。

分发格式、安装限制和命令见 [extension-authoring.md](extension-authoring.md)。可直接给 agent 的任务文本见 [prompts/convert-workflow-to-extension.md](prompts/convert-workflow-to-extension.md)。

agent 的迁移报告使用 [报告模板](templates/workflow-migration-report.md)，按实际证据填写。

## 1. agent 先审计原工作流，禁止先套模板改坏功能

读入口脚本、依赖文件、配置样例、中间文件、最终输出和一条可以重现的调用命令。运行原工作流的最小离线样例；付费或远程生成使用作者提供的样例/授权，缺少凭据时先完成离线适配。

建立如下映射表，并保存为迁移报告：

| 审计项 | 必须记录的事实 | 如何决定改造 |
|---|---|---|
| 输入 | 文案、参考图、素材、音频、时间戳、选项的实际格式 | 选择现有 input/params；不支持的输入列入宿主缺口 |
| 阶段 | 分镜、TTS、生图、抠图、动画、拼接、字幕、输出 | 每一步由原工作流还是宿主执行；禁止两边重复执行 |
| 中间产物 | 每个元素的源图、透明图、蒙版、动画、布局、时间 | 优先复用，不能仅保留最终合成视频 |
| 时间依据 | 音频、短句、帧、固定秒数、音乐拍点 | 明确秒/毫秒/帧，转换一次，明确全片还是段内基准 |
| 元素身份 | 原始对象 ID、镜头 ID、图层顺序 | 原地复用稳定 ID，不能每次重做重新编号 |
| 参数 | 默认值、范围、枚举、实际消费代码 | 每项映射到 UI、渲染输入和缓存指纹 |
| 依赖 | Python/Node/FFmpeg/模型/API/字体/本地程序 | 可打包的代码入包，宿主依赖写清，密钥走运行环境 |
| 交互 | 需调整哪些对象的位置、大小、动效、文字、素材 | 选择下文编辑等级，列明不能支持的能力 |

原工作流的质量、提示词、随机种子、算法和输出画幅应保留。将执行入口改成函数或 CLI 适配层；不要未经需求依据就重写整个算法。

## 2. 选择编辑等级与接入路线

| 等级 | 交付形式 | 可编辑范围 | 本需求默认 |
|---|---|---|---|
| E0 整片媒体 | 最终视频 | 整条片段裁剪、变换 | 不满足逐元素要求 |
| E1 元素媒体层 | 每元素透明视频/PNG，背景和声音独立 | 每个元素的位置、缩放、旋转、透明度、片段时间、宿主动效 | 最低目标 |
| E2 原生描述 | 宿主支持的可编辑文字/描述 | E1，加文字内容及引擎支持的样式/动画配置 | 引擎已有能力时优先 |
| E3 参数化重生成 | E1/E2 加对象参数、局部任务、缓存 | 可重生成某元素的内部动画，保留工程编辑 | 需具体适配并测试 |

E1 的“可调动效”指对该独立图层应用宿主关键帧/动效；已经烘焙进视频里的笔画、人物姿势和内部相机运动，不能通过关键帧直接修改其算法。修改这类效果需要 E3 重渲或 E2 原生描述。

### 路线 A：复用现有成片宿主，改造原渲染阶段

当原工作流可以接收“本镜头的元素图与时间窗口”，选择 `pipeline: production` + `runtime: python`。宿主执行分段、配音、分镜、素材、字幕、队列和缓存；你的代码执行镜头内的排版/抠图/动画，返回逐元素透明产物。

这是当前黑板报路径，最容易得到 E1。manifest 可参照 `server/skills/chalk-hand/skill.json`，但必须替换 ID、提示词、参数和入口，移除原工作流不需要的黑板业务选项。Python production 的 `planner` 和 `assets` 必须符合现有校验器。

原核心也可以是 Node、命令行程序或远程生成服务：保留核心，用当前支持的 Python 入口做进程/服务桥接即可；必须验证运行环境可找到所需工具与依赖。不要将 runtime.type 写成未支持的 node/remotion 等值。以参数数组启动子进程，不把用户输入拼成 shell 命令。

**入口不是全文工作流入口**：宿主按镜头调用 `render.py --request ...`。若原入口还会自己再次配音、生图、拆分镜，应拆出 `render_scene`/`render_element` 供适配器调用，避免重复成本与时间漂移。

### 路线 B：复用已有原生文字引擎

只有原工作流确实能映射到现有 JIZURA 文字描述时，选择 `production` + `runtime: { type: text, engine: jizura }`。参照 `docs/dynamic-text-extension.md`。不能把任意 Canvas/Remotion/网页动画改个 engine 名字就当成兼容；宿主目前只接受该既有引擎。

### 路线 C：保留原工作流自己的分镜、声音、素材或时间体系

先报告宿主缺口，再实现明确的宿主适配。当前 `production` **不是任意 DAG 插件框架**，没有“包里提供 workflow.json，宿主自动识别任意节点”的接口。包内的 Python 入口主要处于渲染阶段，不能仅靠 manifest 替换 TTS、分镜或素材服务。

例如原工作流依赖音乐拍点、已有分镜 JSON、外部视频生成服务，或要求动态持续运动到镜头末尾：agent 必须找到接入点，设计时间锚点/产物转换与对应 UI；必要时修改校验、生成层、文档、入轨、预览和导出。需交付兼容宿主版本及其改动；不能把不支持的字段写进包后宣称可用。

原服务有 `runProduction(..., services)` 的内部注入接口用于适配/测试，但当前并未将任意 service 注入开放给分发包。已有 `/api/ai-productions` 也不是任意最终结果 JSON 的导入接口。不要混淆内部可调用函数和已经开放的包 API。

## 3. 核心改造：从“整张画面”变成“独立对象 + 合成关系”

假设原工作流生成一块黑板，包含人物、箭头、标题、底板和配音。改造后至少产生：

```text
segment_1
├─ 配音.wav                          # 独立声音
├─ 底板.png                          # 独立背景
└─ board_1
   ├─ person_1.webm + person_1_hold.png
   ├─ arrow_1.webm  + arrow_1_hold.png
   └─ title_1.webm  + title_1_hold.png
```

`person_1` 是“作者希望整体移动的小人”这一逻辑对象；小人的手、脸和衣服若不需要分别编辑，可以留在同层。跨物体的阴影、遮罩、粒子和连线要明确归属，避免移动一个元素时留下半截效果。

必须做到：

1. 在原合成/拼接之前截取独立对象产物。仅有最终视频时无法可靠恢复透明物体，必须上溯生成阶段、保留对象蒙版，或重新生成分层素材。
2. 每元素 RGBA，WebM 使用 VP9 alpha，PNG 保留透明；不要在每层烘焙全画面背景、字幕或声音。
3. 每个元素在不同时间轴片段中用同一个逻辑 ID；输出顺序稳定，当前 `scene.elements[]` 顺序决定元素默认轨道层级，第一个元素占第1层。
4. 入场视频和保持 PNG 使用相同尺寸、透明边距和坐标基准。透明边距必须覆盖整个动效包络，否则弹跳、旋转、阴影或粒子会被裁掉。
5. 默认位置由 `crop` 与原画幅传递；不要把人物在大画布中的 x/y 又烘焙到小裁剪图里，造成二次偏移。
6. 给最终预览视频可作为额外验收产物，但逐元素文件才是可编辑时间轴的依据。

## 4. 当前 production 渲染接口：可以直接照着实现

### 4.1 请求

宿主生成请求文件，以 Python 进程调用入口，cwd 是已安装包目录：

```text
python render.py --request <request.json>
```

请求示例：

```json
{
  "spec": "todo-skill-render/1",
  "jobId": "p_example",
  "mode": "scene-clips",
  "outDir": "D:/example/ai-generated",
  "ffmpeg": "D:/example/ffmpeg.exe",
  "params": { "size": "1280x720", "fps": 30, "drawSpeed": 1 },
  "scene": {
    "id": "b1",
    "startMs": 2000,
    "endMs": 6000,
    "elements": [
      { "id": "e1", "label": "人物", "role": "hero", "weight": 1.5,
        "image": "D:/example/ai-generated/person.png", "atMs": 2300, "windowEndMs": 4200 }
    ]
  },
  "outputs": { "prefix": "p_example_a1b2c3d4", "hand": "p_example_hand_1.png" }
}
```

这段 JSON 是接口示例，示例磁盘文件不随文档提供。agent 应使用宿主实际生成的请求和素材测试。

### 4.2 适配器步骤

```text
读取并验证请求/spec/mode
→ 转换 scene.elements 为原工作流内部对象（复用输入 ID，不创建随机对象 ID）
→ params 转成原工作流配置；选择 request.ffmpeg；使用原种子规则
→ 调用原 render_scene/render_element，独立生成各层
→ 将媒体写入 request.outDir；使用 outputs.prefix + scene.id + element.id 命名
→ 校验真实视频尺寸、帧率、帧数、alpha 与 hold PNG
→ 将结果换成下述 scene-clips 结构，stdout 输出一行 @result JSON
```

不要在导入时执行工作流，不要自行改变工程 store，不要返回安装目录里的临时相对媒体文件。使用 outDir 中的顶层文件名作为结果路径；宿主负责转成 `/ai-generated/...` URL。临时文件可以另建目录，但交付的媒体应归一到宿主可服务的产物位置。

### 4.3 结果

```json
{
  "alpha": true,
  "width": 1280,
  "height": 720,
  "fps": 30,
  "scene": {
    "id": "b1",
    "startMs": 2000,
    "endMs": 6000,
    "layout": "workflow-layout-v1",
    "elements": [
      { "id": "e1", "label": "人物", "role": "hero", "enter": "fade",
        "box": [100, 160, 320, 360], "crop": [80, 140, 360, 400],
        "startMs": 2300, "durationMs": 1200, "frames": 37,
        "video": "p_example_a1b2c3d4_b1_e1.webm",
        "hold": "p_example_a1b2c3d4_b1_e1_hold.png", "tip": [] }
    ]
  }
}
```

结果是 `@result ` 后的 JSON，不是扩展包 manifest，也不是整个 `todo-skill-output/1` 清单；后者由宿主生成。

| 字段 | 规则与实际消费点 |
|---|---|
| width/height | 整个源画幅，不能填裁剪视频的小尺寸 |
| fps/frames | 真实编码值；不能只改元数据。当前入轨用 `(frames - 1) / fps` 算入口段，最后一帧与保持图衔接 |
| scene.startMs/endMs | 相对**本段配音0秒**，不是全片时间，不是本镜头0秒 |
| element.startMs | 相同段内基准，通常沿用输入 atMs；不是 timeline 的全局 start |
| durationMs | 如实描述入场时长；当前切入保持图的主依据仍是帧数/fps |
| id | 必须对应输入元素 ID；稳定 ID 使局部更新能识别原片段 |
| box | 逻辑物体在源画幅中的像素框；不能代替 crop |
| crop | `[左,上,宽,高]`，源画幅像素坐标；视频和 PNG 的实际尺寸为宽×高 |
| video/hold | outDir 内真实存在的顶层文件名，分别入口视频和完成后的透明静帧 |
| enter | 当前宿主标签语义为 draw/stamp/fade；不是任意动效描述接口 |
| tip/hand | 仅笔尖跟随需要；没有手势则 tip 为空且不返回 hand |

源图层进入工程后，`crop` 经 `elementTransform` 计算默认位置。核心实现：`src/lib/chalkHandLayers.ts`、`src/lib/productionTimeline.ts`。不要添加虚构的 `position/animation/zIndex` 字段并期待它们被宿主读取；若确需这些字段，先实现文档、校验、入轨与 UI 的全链路。

注意两套位置单位不同：`crop` 是源画幅像素，工程 `transform.x/y` 是相对画面中心、以半画幅为单位的归一坐标（0为中心，±1约为对应边缘），不是像素；scaleX/scaleY 是相对素材默认适配尺寸的倍数。宿主先等比将源画幅居中放入工程，再换算图层中心和缩放。agent 应调用/参照既有转换函数，不能把 crop.x 直接赋给 transform.x。宿主关键帧的 `t` 则是片段局部秒，与请求的段内毫秒不同。

### 4.4 时间与持续运动的边界

现有媒体 production 的默认模型是：**入口视频 → 最后一帧静止保持到镜头末尾**。角色持续跳舞、循环背景、粒子持续移动等不能不加判断套此模型；可以让入口视频覆盖预期运动时段并验证末帧切换，或为持续视频/循环层增加宿主适配。不能拿一张 hold PNG 宣称保留了全程运动。

声音由独立配音层提供；透明元素视频应无混入的配音。原工作流需要音乐、音效、多角色声道或没有口播时，先报告现有宿主时间/声音接口缺口，选择保留原时间模型的适配路线。

## 5. 逐元素编辑究竟在哪里发生

| 需求 | 当前可行方式 | 必须注意 |
|---|---|---|
| 改位置、大小、旋转 | 元素片段的 transform；监视器与属性面板 | 入场与保持片段共享逻辑元素，当前 chalkHand 配对同步基础几何变换 |
| 改透明度、平移/旋转/缩放动效 | 独立片段的宿主 keyframes/动效预设 | 关键帧时间相对该片段；draw/hold 两段不会自动拥有一条贯穿式动画曲线 |
| 改入场算法或笔画速度 | 修改渲染参数后局部重渲镜头 | 烘焙效果无法通过普通关键帧“反解” |
| 改元素描述、替换图、选择候选 | production 工作台 + setElement/pickVariant/upload | 描述不是 transform；改 draw 会触发候选素材变化 |
| 改原生动态文字的内容/样式 | 原生 text/fancy.dynamic 片段 | 不要预先把文字烘焙进人物视频 |
| 重渲后保留用户位置 | 当前媒体入轨比较 source.layout 与 transform | 目前主要保护位置/缩放/旋转，不能承诺保留所有手工效果与关键帧 |

当前媒体重生成分支重新创建 draw/hold 片段，没有完整透传旧片段的 keyframes、effects、transition、mask、opacity 等编辑；文字分支会保留旧 transform/keyframes，但也不是任意编辑状态都保留。因此：

- 仅要求“生成后可编辑”，E1 已能满足，不必虚构新的元素参数 UI。
- 要求“局部重做仍保留所有位置与动效”，agent 需要修改并测试入轨合并策略，明确哪些值归生成器、哪些归用户；不能只写 README 宣称支持。
- 要求“每个元素独立修改内部动画参数”，当前 setElement 接受的是 label/draw/role/weight/at，不提供通用 per-element 动画参数。需新增文档字段、编辑操作、hash、请求传递、UI、结果适配及回归。写到 JSON 而未实现消费链路不算支持。

“局部”也要如实描述：当前 `scope.elements` 会连带重渲所属镜头；不保证只执行单个元素的渲染函数。可在原渲染器内部增加元素缓存，但这不改变宿主的镜头任务粒度。

## 6. 参数、缓存和身份：最容易漏的接入点

每个参数都要有一行映射：`原始选项 → params.id → UI 类型/范围/默认 → 消费函数 → 受影响层 → hash 输入 → 验证动作`。

当前 Python production 渲染缓存使用 `server/production/layers.mjs` 的固定 `RENDER_PARAM_KEYS`：

```text
size, fps, layout, tone, drawSpeed, stroke, fill, quality, handSize, enter
```

**声明一个新参数并不意味着它会使旧缓存失效。**例如原工作流新增 `bounceHeight`，即使 manifest/UI 和 render.py 都识别，若 hash 没包含它，修改参数后可能继续复用旧视频。agent 必须沿用语义一致的已支持字段，或修改宿主缓存适配并测试该参数变化能重渲；不能用“每次改包版本”代替正常参数失效机制。

稳定 ID 用于对象身份；hash 用于对象内容版本，二者不能互换。输出文件名包含请求 prefix，避免同名覆盖旧媒体缓存。修改生产文档时沿用存在的节点 ID；新增/删除对象才创建/移除 ID。不要随机重建全树来实现“刷新”。

宿主服务的密钥、作者绝对路径、运行缓存、大模型权重不进入发行包。相对导入、字体和配置必须在已安装目录能解析；通过请求 ffmpeg 与宿主环境变量寻找工具，不假定作者桌面的目录层级。

## 7. 打包与交付

渲染与导出还须遵守 [性能准则](render-export-performance.md)：审计并改造低效逐帧实现，复用资源、按依赖有界并行，测量同画质的冷热基线与新流程，预算/质量不通过继续修改。新增性能检查与 PERFORMANCE.json，不能只验证能导出。

功能交付必须使用 [扩展自检与修复闭环](extension-self-check.md)，附 extension.check.json 和真实测试脚本。运行 `npm run extension:check -- <源码目录> <目录外报告.json> <目录外包.todoext>`；失败则修复后重跑，直到最新报告 ok=true。下述 extension:pack 是低层格式封装命令，不能替代验收。报告和包均放在源码目录之外。

建议目录：

```text
my-extension/
├─ skill.json
├─ render.py                      # TO DO 协议适配，不承担工程修改
├─ workflow/                      # 保留原工作流核心函数
├─ assets/                        # 小型静态资源/字体，符合包大小限制
├─ README.md                      # 用法、依赖、宿主版本、编辑等级、已知边界
└─ MIGRATION.md                   # 输入/阶段/参数/元素映射与验收证据
```

这是文件组织建议，只有 skill.json/runtime 等已有字段有运行语义；MIGRATION.md 由 agent 写给作者，不是新宿主协议。使用自己的稳定 ID 和三段版本；包根目录的 extension.json 由工具生成。

```powershell
npm run extension:pack -- <源码目录> <目录外的输出.todoext>
npm run extension:test
npm run skills:check
```

涉及宿主改动还要运行相关 production、预览、导出测试及 build。Python 包安装不自动 pip install；如果环境没有需要的库，agent 必须在 README/报告标明，不能把“安装成功”当作运行验证。

## 8. agent 必须完成的验收，不允许把三种成功混为一谈

| 验收 | 操作 | 通过标准 |
|---|---|---|
| 原工作流基线 | 相同固定种子/测试素材跑原入口 | 保留运行命令和参考产物 |
| 协议 | 用真实请求运行适配入口 | 退出0，@result 可解析，返回 ID 对应输入，文件真实存在 |
| 媒体 | ffprobe/PNG 检查，透明背景合成对比 | 画幅/裁剪/帧率/帧数正确，真实 alpha，不裁断动效 |
| 安装 | 在隔离用户数据中安装 .todoext，再查询技能列表 | 包被识别，manifest 已发现；不执行工作流 |
| 入轨 | 完成一次生成与同步 | 每元素独立片段，背景、配音、字幕独立，同步两次不重复 |
| 编辑 | 移动一个对象；改缩放/旋转/透明度；添加平移动效 | 只影响该对象，draw/hold 无意外跳位，相邻对象不动 |
| 时间 | 工程播放头非0提交，段内镜头非0，30/其他fps；必要时裁剪/变速 | 无全片/段内/片段局部时间混淆，配音同步 |
| 参数 | 改每个影响渲染的参数 | 目标节点 dirty，产物/哈希变化，不重复配音和付费素材 |
| 局部重做 | 调整位置/动效后重做一个元素/镜头 | 按声明的编辑保护策略验收，不能隐瞒会丢失的状态 |
| 删除与缓存 | 删除一个片段后重复同步；无变化重新运行 | 同版删除不复活；无变化复用缓存 |
| 导出 | 从 TO DO 导出短样例，并检查画面 | 与预览位置、alpha、时间、动效一致；不能只检查原工作流的成片 |
| 升级 | 同包重装、新版升级、失败包 | 重装不重复，升级可发现，损坏包不破坏现有包 |

缺少原工作流、真实服务权限或运行依赖时，仍可完成适配和离线协议验证，但交付报告必须写明未完成的真实运行/导出检查，不能把 mock 结果作为真实内容生产成功。

## 9. agent 最终必须交付

1. 原工作流审计与路线选择；被保留、被替换的阶段清单。
2. 参数映射、逻辑元素/图层/坐标/时间映射、依赖列表和缺口处理。
3. 可安装的 .todoext 与完整源码；若需要宿主修改，同时交付宿主 diff 和最低兼容版本说明。
4. 一条原入口命令、一条适配入口样例、一条打包命令；样例素材与结果要可重现。
5. 实际通过的安装、生成、逐元素编辑、局部重做、导出证据；明确 E1/E2/E3 能力边界。

仓库当前主要定位文件：`server/skillPacks.mjs`（manifest/参数校验）、`server/skillJobs.mjs`（Python调用）、`server/production/layers.mjs`（请求与缓存）、`doc.mjs`（文档/编辑）、`runner.mjs`（生成调度）、`src/lib/productionTimeline.ts`（逐元素入轨与更新）、`chalkHand.ts`（draw/hold 配对）、`src/types.ts`（工程片段）、`src/components/ProductionStudio.tsx`（工作台）、`server/extensionPacks.mjs`（打包安装）。以实际代码为准，遇到与文档不符的行为先验证再修正文档。
