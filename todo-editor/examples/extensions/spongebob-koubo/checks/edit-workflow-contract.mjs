/**
 * 静态契约：扩展内是否具备 EDIT_WORKFLOW 要求的代码与文档（不跑成片）。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const errors = []

function need(rel, pred, msg) {
  const p = path.join(root, rel)
  if (!existsSync(p)) {
    errors.push(`缺少 ${rel}`)
    return
  }
  if (pred) {
    const text = readFileSync(p, 'utf8')
    if (!pred(text)) errors.push(msg || `契约失败: ${rel}`)
  }
}

need('EDIT_WORKFLOW.md', (t) => t.includes('bgm_bed') && t.includes('开场红字') && t.includes('koubo_edit_bind'))
need('workflow/kit/kit/layers_export.py', (t) => t.includes('开场红字') && (t.includes('整幅') || t.includes('[0, 0, W, H]')))
need('workflow/04_动画渲染/mix_bgm.py', (t) => t.includes('纯 BGM 床轨') && t.includes('bed_cmd'))
need('skill.json', (t) => {
  const j = JSON.parse(t)
  return j.preserveSource?.entry === 'workflow/run_pipeline.py' && !!j.version
})

// 泡泡转场音效契约。这段曾经被后加的代码覆盖成裸 mp4，导致时间轴"音效缺失"却没有任何报错，
// 所以把「有抽轨 + 值只能是 wav + 有兜底 + 不许把视频当音效」锁成静态契约。
need('workflow/kit/kit/layers_export.py', (t) => {
  if (!/_wipe_sfx\(/.test(t)) errors.push('layers_export.py 缺少 _wipe_sfx()（从片源抽音轨）')
  if (!/el\["sfx"\]\s*=/.test(t)) errors.push('layers_export.py 没有把泡泡音效挂到元素上（el["sfx"] 缺失）')
  if (!t.includes('bubble_wipe.wav')) errors.push('layers_export.py 缺少 bubble_wipe.wav 兜底')
  // 裸片源被当成音效值 = 前端 <audio> 解不了 mp4，症状是"音效缺失"但不报错
  for (const m of t.matchAll(/(?:sfx"\]\s*=|["']sfx["']\s*:)\s*["']([^"']+)["']/g)) {
    if (m[1].toLowerCase().endsWith('.mp4')) {
      errors.push(`layers_export.py 把视频当音效赋给 sfx：${m[1]}（应为 wav）`)
    }
  }
  return true
})
need('workflow/kit/assets/fx/bubble_wipe.mp4', null, '缺少泡泡转场片源（音效源头）')
need('workflow/kit/assets/fx/bubble_wipe.wav', null, '缺少泡泡转场音效兜底')

// ── 标准扩展结构契约 ────────────────────────────────────────────────
// 本扩展同时声明 preserveSource（真实出片路径）与 runtime/render.py（协议适配入口）。
// 这两个字段并存时，宿主只会走 preserveSource（server/production/runner.mjs:136），
// 所以 render.py 是**协议探针**而不是成片渲染器。以下断言防止后来者把二者混为一谈：
//   · 把 render.py 改成"看起来像成片"的实现 → 白费力气，永远不跑
//   · 或以为 planner/assets 真的参与生成 → 改错地方
//   · 或删掉 runtime → 包校验直接不过（production 管线要求 runtime）
{
  const skillText = readFileSync(path.join(root, 'skill.json'), 'utf8')
  const j = JSON.parse(skillText)
  if (!j.preserveSource) errors.push('skill.json 缺少 preserveSource（真实出片路径）')
  if (!j.runtime || j.runtime.type !== 'python' || j.runtime.entry !== 'render.py') {
    errors.push('skill.json 的 runtime 必须指向包内 render.py（production 管线的协议适配入口）')
  }
  if (j.runtime && !existsSync(path.join(root, j.runtime.entry))) {
    errors.push(`skill.json runtime.entry 指向的文件不存在：${j.runtime.entry}`)
  }
  // planner/assets 在 preserveSource 模式下不参与生成，必须显式标注，否则读者会以为它们生效
  const unusedMarker = '不被使用'
  if (!String(j.planner?.system || '').includes(unusedMarker)) {
    errors.push(`skill.json planner.system 必须显式标注"${unusedMarker}"（preserveSource 下宿主不使用它）`)
  }
  if (!String(j.assets?.template || '').includes(unusedMarker)) {
    errors.push(`skill.json assets.template 必须显式标注"${unusedMarker}"（preserveSource 下宿主不使用它）`)
  }
}

need('render.py', (t) => {
  if (!t.includes('protocol-probe')) {
    errors.push('render.py 的结果必须把 layout 标成 protocol-probe（它是协议自检，不是成片渲染器）')
  }
  if (!/不是成片渲染器|不会\*\*调用/.test(t)) {
    errors.push('render.py 顶部必须写明它不是成片渲染器、生成时不会被宿主调用')
  }
  return true
})

// 生图耗时的**尾部**才是总时长的决定项（实测：19 张里 11 张 <60s，剩下几张拖到 14 分钟，
// 直接顶穿 15 分钟预算）。只记 p50 会让这个问题永远看不见，所以把分布锁成契约。
need('workflow/03_素材生成/generate_images.py', (t) => {
  for (const key of ['latency_p90', 'latency_max', 'latency_n']) {
    if (!t.includes(key)) errors.push(`generate_images.py 必须回报 ${key}（只报 p50 会藏住慢尾）`)
  }
  return true
})
need('workflow/03_素材生成/gen_from_brief.py', (t) => {
  for (const key of ['latency_p90', 'latency_max']) {
    if (!t.includes(key)) errors.push(`gen_report 必须写入 ${key}，否则报告看不出慢在尾部`)
  }
  return true
})

// 设计阶段的计时盲区：只记 llm_parallel 会让"980s 里到底哪一步慢"无从判断
// （实测该字段只 24-31s，而阶段总耗时 980s）。必须逐步计时并写进报告。
need('workflow/02_镜头设计/llm_briefs.py', (t) => {
  for (const key of ['timing_per_attempt', 'classify_bgm_s', 'assets_parallel_s', 'total_s']) {
    if (!t.includes(key)) errors.push(`llm_briefs.py 必须记录 ${key}，否则设计阶段耗时无法归因`)
  }
  // 超时必须自证：否则一次 600s 卡顿和"返回坏 JSON"在报告里长得一样，
  // 这正是设计阶段 980s 无法归因的直接原因。
  if (!t.includes('class LlmTimeout')) {
    errors.push('llm_briefs.py 必须定义 LlmTimeout：_ask 不能把超时类型抹成 RuntimeError（否则会被重试放大到 CHAT_TIMEOUT×9）')
  }
  if (!t.includes('except subprocess.TimeoutExpired')) {
    errors.push('_ask 必须单独处理 subprocess.TimeoutExpired 并停止在该层重试')
  }
  if (!t.includes('report.setdefault("timeouts"')) {
    errors.push('llm_briefs.py 必须把超时次数记进 report["timeouts"]')
  }
  // 生效的超时值必须可配置且写进报告：否则事后无法判断某次跑用的是 600s 还是别的值
  if (!t.includes('KOUBO_CHAT_TIMEOUT')) {
    errors.push('llm_briefs.py 的 chat 超时必须可用 KOUBO_CHAT_TIMEOUT 覆盖（无观测不下调默认值）')
  }
  if (!t.includes('"chat_timeout_s"')) {
    errors.push('design_report 必须写入 chat_timeout_s，记录那次跑真正生效的超时')
  }
  return true
})

const skill = JSON.parse(readFileSync(path.join(root, 'skill.json'), 'utf8'))

// 绝不自动关机。
// run_pipeline.py 的 --all 会**默认打开**关机（见其 L206），而 run_all.py 在全部门通过后执行
// `shutdown /s /t 90`。原先 preserveSource.args 只有 ["--all","--skip-clean"]，
// 于是**每次从界面点生成，验完收就 90 秒后关机** —— 实测真机上关掉了用户的电脑。
// 这是从 UI 反复触发的路径，必须显式禁止，而不是依赖用户知道要加 --no-shutdown。
{
  const args = skill.preserveSource?.args || []
  if (!args.includes('--no-shutdown')) {
    errors.push('preserveSource.args 必须包含 --no-shutdown：--all 会默认关机，从界面生成会关掉用户的电脑')
  }
  if (args.includes('--shutdown')) {
    errors.push('preserveSource.args 不得包含 --shutdown')
  }
}

if (!String(skill.description || '').includes('分层') && !String(skill.description || '').includes('可编辑')) {
  // soft: description should mention editable layers
}

if (errors.length) {
  console.error(JSON.stringify({ ok: false, errors }, null, 2))
  process.exit(1)
}
console.log(JSON.stringify({ ok: true, version: skill.version, contract: 'EDIT_WORKFLOW.md' }))
