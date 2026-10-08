# 协作说明

私密仓：https://github.com/AXJL4877/to-do  

本仓库已内嵌（`todo-editor/vendor/`）：

| 模块 | 作用 |
|------|------|
| `tts-timeline` | 配音 + 时间戳 |
| `mishi` | 虎妞/火山密钥与生视频 host |
| `blackboard` | 黑板手绘渲染 |
| `burn-subtitles` | 字幕对时 |

另有 `todo-editor/.data/ai-config.json`（虎妞 API Key）。

**勿把仓库改成 Public**，否则 Key 会泄露。

## 协作者首次配置

```bash
git clone https://github.com/AXJL4877/to-do.git
cd to-do/todo-editor
npm install
python --version   # 配音 / 黑板手绘 / 字幕需要 Python3 + opencv-python numpy
npm run electron:dev
```

Python 侧建议：

```bash
pip install opencv-python-headless numpy
```

可选本地 H3（不内嵌）：设 `H3_COMFY_DIR`、`H3_STUDIO_DIR`。

ffmpeg 优先用 `todo-editor/native/bin`（需本机构建或拷贝）；也可系统 PATH / WinGet。

## 协作约定

- 用分支 + PR，少直接推 `master`
- 不要提交：生成素材、安装包、`vendor/*/outputs`、`vendor/*/jobs`
- 密钥仅因私密协作入库；换人或公开前务必轮换 Key
