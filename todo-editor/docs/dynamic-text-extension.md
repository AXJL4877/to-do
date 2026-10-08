# Dynamic text production extension

Entry: 拓展 → 动态文字 → 口播文案 → 一键成片.
The authoritative package is server/skills/dynamic-text/skill.json, using
the same todo-skill-pack/1 manifest, production documents, queue, retries,
voice synthesis, subtitle generation, incremental updates and timeline
placement as the blackboard extension.

The fixed text/jizura runtime uses the host Canvas renderer. It requires no
image generation: narration phrase timestamps are split into short literal
text scenes, then assigned effects, colors and seeded motion. Phrase chunks
use proportional timing within a phrase and retain punctuation. Documents
store editable text descriptors rather than image variants. Synchronization
inserts text clips linked to their voice; sequence export uses the same engine.

The frontend reads metadata from the same manifest. SkillsPanel opens the
production workflow, including voice, aspect ratio, effects and subtitles.
ProductionStudio edits narration and text scenes and reruns changed layers.
The inspector opens DynamicTextPanel only for editing individual timeline
clips. The font library contains no dynamic entry. Saved version-1 clips
remain compatible.

Validation: npm run dynamic:production, npm run production:test,
npm run dynamic:test, npm run dynamic:export, npm run skills:check,
and npm run build. The export integration checks audio/video streams and
visible text in every scene of an automatically placed production.


## 完整编排（3.0.0）

默认入口仍是「拓展 → 动态文字 → 口播文案 → 一键成片」。新项目默认完整自动编排，保留旧六种文字模板兼容。

完整引擎来自 JIZURA 0.10.1（fc16bfe），包含全部表达包：184 排版、125 入场、52 持续运动、109 退场、130 装饰、62 文字质感、66 背景、36 镜头、69 后期效果、27 转场，共 860 个部件及 27 套整体风格。它们参与组合，不是 860 个固定视频模板。

生产参数可选整体风格、情绪、透明或风格背景、段内统一、随机种子、五项效果强度和各类部件。默认按风格自动搭配；指定不适合字数的排版退回居中。字体使用本地字体，文字颜色由整体风格色板控制。没有移植上游网页、音频导入和独立导出 UI，配音、时间线和导出沿用宿主系统。

v2 动态描述保存整段原文场景和配音边界，每个可编辑文字片段记录段内偏移；渲染完整段计划，以保持跨句转场。文字不会被识别为歌词控制指令。改字在当前片段覆盖对应场景；生产工作室改字会重算整段关联画面。v1 项目继续旧模板渲染。

引擎纸张与颗粒纹理使用确定性随机数，离屏纹理缓冲使用稳定的 CPU Canvas 路径，避免预览首帧与重复帧之间的 GPU 合成差异。升级上游后运行 `node scripts/vendor-jizura.mjs <checkout>` 再运行 `node scripts/catalog-jizura.mjs`，同步目录与官方拓展参数。MIT 声明保留于 src/lib/jizura/LICENSE 和 public/licenses/JIZURA.txt。
