/**
 * design.py：开场红字改为**由口播稿确定性推导**，不再采用 LLM 的 intro_lines。
 *
 * 实测问题：模型给的是「錢越來越 / 不錢了 / 這不是覺」，而原句是
 * 「钱越来越不值钱了，这不是错觉」—— 丢字（值、錯）+ 繁简错配。
 * 开场是观众第一眼看到的东西，必须与原稿逐字一致；_intro_lines 在 forced=None 时
 * 会用 jieba 按词边界切分，正是我们要的确定性行为。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const targets = [
  path.join(process.env.APPDATA || '', 'todo-editor', 'data', 'skills', 'studio.spongebob-koubo', 'workflow', '02_镜头设计', 'design.py'),
  'examples/extensions/spongebob-koubo/workflow/02_镜头设计/design.py',
  path.join(process.env.APPDATA || '', 'todo-editor', 'data', 'skills', 'studio.spongebob-koubo', 'workflow', '02_镜头设计', 'llm_briefs.py'),
  'examples/extensions/spongebob-koubo/workflow/02_镜头设计/llm_briefs.py',
]

const oldLine = '        intro_lines = _intro_lines(text, forced=b.get("intro_lines"))'
const newBlock = `        # 开场红字**由口播稿确定性推导**，不用模型给的 intro_lines：
        # 实测模型会给出丢字/繁简错配的版本（「錢越來越／不錢了／這不是覺」，
        # 原句是「钱越来越不值钱了，这不是错觉」）。开场是观众第一眼看到的东西，
        # 必须与原稿逐字一致，所以这里固定走 jieba 断词切分（forced=None）。
        intro_lines = _intro_lines(text, forced=None)`

for (const file of targets) {
  if (!existsSync(file)) { console.log(`- 跳过（不存在）：${path.basename(file)}`); continue }
  let t = readFileSync(file, 'utf8')
  if (t.includes('intro_lines = _intro_lines(text, forced=None)')) { console.log(`- 已改过：${path.basename(file)}`); continue }
  if (!t.includes(oldLine)) { console.log(`- 无该行（可能不在此文件）：${path.basename(file)}`); continue }
  t = t.replace(oldLine, newBlock)
  writeFileSync(file, t)
  console.log(`✓ ${file}`)
}
