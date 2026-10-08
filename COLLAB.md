# 协作说明

私密仓：https://github.com/AXJL4877/to-do  

本仓库已内嵌：
- `todo-editor/vendor/tts-timeline` — 配音 + 字/句时间戳
- `todo-editor/vendor/mishi` — 虎妞/火山密钥与生视频 host（含 `.env`）
- `todo-editor/.data/ai-config.json` — 编辑器 AI 设置（虎妞 API Key）

**勿把仓库改成 Public**，否则 Key 会泄露。

## 协作者首次配置

1. 接受 `to-do` 仓库邀请并克隆：

```bash
git clone https://github.com/AXJL4877/to-do.git
cd to-do/todo-editor
npm install
```

2. 需要 Python 3（配音 / 云端生视频）：

```bash
python --version
```

3. 运行：

```bash
npm run electron:dev
# 或只跑网页：npm run dev
```

4. AI 面板齿轮 → **AI 设置**：确认「配音模块 / 密匙模块：已内嵌」。Key 已随仓带上；若要改 Key 可直接粘贴保存。

可选覆盖路径（一般不需要）：

```powershell
$env:TTS_TIMELINE_ROOT = "D:\path\to\tts-timeline"
$env:MISHI_ROOT = "D:\path\to\mishi"
```

## 协作约定

- 用分支 + PR，少直接推 `master`
- 枢纽文件先口头认领：`store.ts` / `types.ts` / `electron/*` / `vite.config.ts`
- 不要提交：生成素材、安装包、`vendor/*/outputs`、`vendor/*/jobs`
- 密钥文件在仓内仅因私密协作；换人或公开前务必轮换 Key
