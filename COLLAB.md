# 协作说明

私密仓：https://github.com/AXJL4877/to-do  
AI 工具（密匙）：https://github.com/AXJL4877/mishi（私密，含本机测试用 `.env`）

## 协作者首次配置

1. 接受两个仓库的邀请邮件（`to-do` + `mishi`）
2. 克隆：

```bash
# 剪辑软件
git clone https://github.com/AXJL4877/to-do.git
# 密匙：默认期望路径（Windows）
git clone https://github.com/AXJL4877/mishi.git "%USERPROFILE%\Desktop\密匙"
```

若密匙不在 `桌面\密匙`，启动前设环境变量：

```powershell
$env:MISHI_ROOT = "D:\path\to\mishi"
```

3. 安装并运行编辑器：

```bash
cd to-do/todo-editor
npm install
npm run electron:dev
# 或只跑网页：npm run dev
```

4. 密匙依赖 Python；在密匙目录执行：

```bash
python run.py check
```

## 协作约定

- 用分支 + PR，少直接推 `master`
- 枢纽文件先口头认领：`store.ts` / `types.ts` / `electron/*` / `vite.config.ts`
- 不要提交：`todo-editor/.data/`、生成素材、安装包
- 密匙 `.env` 已在私密仓共享；**勿把仓库改成 Public**，否则 Key 会泄露
