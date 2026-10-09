# 纸片标题：TO DO 扩展包示例

完整的 `todo-skill-pack/1` 声明，复用宿主的 JIZURA 文字引擎；无额外 Python 依赖。用于展示独立 ID 的扩展如何从安装、参数界面接入成片生成和可编辑时间轴。

在 todo-editor 根目录打包：

```powershell
npm run extension:pack -- ./examples/extensions/paper-titles ./examples/extensions/paper-titles.todoext
```

将生成的 `.todoext` 拖入 TO DO。生成口播前需配置已有 AI/配音服务。改变包内容后提高 skill.json 的 version。完整开发准则见 `docs/extension-authoring.md`。
