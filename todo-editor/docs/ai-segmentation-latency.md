# AI 分段等待与取消

旧调用链：`segmentScript → defaultServices.chat → withTransientRetry → chatPlanner → fetch`。
`chatPlanner` 单次超时 300 秒，通用瞬态错误重试最多两次，等待分别为 2 秒、4 秒。
因此匹配重试条件的超时最多约 906 秒；这是代码推导上限，不是实测服务商响应时间。
原分段阶段的进度没有工作总量，因此一直显示 0%，没有已等待时间。

2026-10-09 本地脱敏检查：配置了 API 凭据，服务地址主机为 huniuai.com；规划器默认模型为
`gemini-3.8-flash`（可由 `TODO_AI_SKILL_MODEL` 覆盖）。当前开发目录仅有两个完成的按字数分段文档，
没有能证实某次 AI 分段服务延迟的记录。没有发送付费 API 请求。

现在语义分段使用共计 45 秒预算，包含首次请求、最多一次瞬态错误重试和重试前等待。
预算耗尽时 AbortController 中止 fetch 及响应读取，等待被中止的操作结束，然后按段落和字数分段。
分段仍直接摘取原文，保留句子顺序；标题、角色设定只在成功 AI 分段时返回。
结果的 `source` 为 `fallback`，`notes` 说明失败或超时原因，继续后续生成。
用户主动停止时抛出 `ProductionCanceled`，不保存新分段、不启动后续配音。

每秒报告 `onProgress({ phase, elapsedMs, timeoutMs, attempt })`。
phase 为 `waiting`、`retrying` 或 `fallback`；运行器在现有 phase 文本显示等待秒数和预算。
百分比继续反映已完成任务，不把等待时间当作完成进度。

注入的 `chat(messages, { signal })` 必须响应 AbortSignal。默认服务把 signal 传至 `chatPlanner` 和 fetch；
它不会进入通用长重试包装器。这里没有使用 Promise.race，也不会在返回 fallback 时留下未结束的网络请求。
自定义不响应取消的服务无法同时保证截止返回和没有后台任务，不能用于这条受限调用链。
分镜规划等其它调用继续使用原有重试策略。

离线回归：`node scripts/test-segment-budget.mjs`。覆盖慢请求取消后回退、原文保留、瞬态恢复、
永久失败不重试、按段落模式不请求 AI、默认适配器传递取消到 fetch，以及停止后不配音。
