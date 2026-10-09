# 转角推进接入与自检记录

这是新开发的文字扩展，没有待迁移的独立原工作流，因此 extension.check.json 的 origin 为 new。入口为现有 production text/jizura，配音与时间戳归宿主；生成的场景、字体、corner 参数进入原生文字片段，渲染归 src/lib/cornerChain.ts。包内没有可热加载渲染 JS，需要同步更新宿主。

编辑等级：原生文字可编辑内容、字体、位置、缩放、旋转及宿主透明度关键帧。production-timeline.browser.ts 用此扩展的生产文档检查入轨、重复同步、文字与配音链接、位置旋转编辑、透明度关键帧和重渲保护。不是把最终视频当作一个可编辑元素。

时间：TTS 短句秒转为 board 段内毫秒，composition.offset 再转回段内秒；宿主片段关键帧为局部秒。生成器 hash 包含完整参数、邻句和全片句序。production-cache 检查视觉参数与邻句变化使缓存失效，同时复用已有配音。

自检命令：

```powershell
npm run extension:check -- examples/extensions/corner-chain deliverables/corner-chain-check.json deliverables/corner-chain.todoext
```

实际测试结果以该命令产生的报告为准。报告保存每项命令、退出结果、日志、产物 SHA-256、源码摘要及最终包 SHA-256。FAIL 后先修复对应实现/测试，再运行完整命令；旧报告与旧安装包不代表新代码通过。

依赖：Node、仓库 Electron/ffmpeg 与字体环境。production-cache 和 timeline-editing 使用合成 WAV/mock TTS，验证调用与编辑链路，不证明远程配音质量；实际配音需要用户配置服务。preview-export 运行真实宿主渲染和 ffmpeg，无声视觉样片逐句检查并比较预览/导出像素。8 套编排按句序循环，几何检查验证保留的句子外框不重叠；审美质量仍需看样片。
