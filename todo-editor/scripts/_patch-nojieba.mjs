/**
 * design.py 的 _intro_lines：去掉 jieba 依赖，改为「按标点切小句 + 按长度折行」。
 *
 * 为什么：那条 jieba 路径从来没跑通过——jieba 不在扩展包里、不在 TODO 的 python 运行时里，
 * 机器上的 python 也没有。旧运行能出开场文字，是因为一直走 forced（LLM 给的行）。
 * 按"一切都在包中发生"的原则，正确做法是**不引入新依赖**，而不是塞一个分词库进去。
 *
 * 中文口播稿的语义边界本来就是标点（逗/句），先按标点切小句即可避免"拦腰斩"。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const targets = [
  path.join(process.env.APPDATA || '', 'todo-editor', 'data', 'skills', 'studio.spongebob-koubo', 'workflow', '02_镜头设计', 'design.py'),
  'examples/extensions/spongebob-koubo/workflow/02_镜头设计/design.py',
]

const OLD = `    import logging

    import jieba

    jieba.setLogLevel(logging.ERROR)
    cuts, pos = [], 0
    for word in jieba.cut(body):
        pos += len(word)
        cuts.append(pos)
    cuts = [c for c in cuts if 3 <= c <= 7 and c < len(body)] or [min(6, len(body) - 1)]
    head = min(cuts, key=lambda c: abs(c - 6))
    rest = body[head:]
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "kit"))
    from kit import typo

    return [body[:head]] + typo.wrap_card(rest, 6)`

const NEW = `    # 不依赖分词库：先按标点切成小句（中文口播稿的语义边界就是逗句），再按长度折行。
    # 这里原来 import jieba —— 那既不在扩展包内、也不在 python 运行时里，
    # 是一条**从没跑通过的死路径**（旧运行都走 forced=LLM 给的行）。
    # 按"一切都在包中发生"的原则，正确做法是不引入新依赖。
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "kit"))
    from kit import typo

    clauses = [c.strip() for c in re.split(r"[，。！？；,]", text) if c.strip()]
    if not clauses:
        return []
    head = clauses[0]
    rest = "".join(clauses[1:])
    lines = typo.wrap_card(head, 8) if len(head) > 8 else [head]
    if rest:
        lines += typo.wrap_card(rest, 6)
    return [ln for ln in lines if ln][:4]`

for (const file of targets) {
  if (!existsSync(file)) { console.log(`- 跳过：${file}`); continue }
  let t = readFileSync(file, 'utf8')
  if (t.includes('不依赖分词库')) { console.log(`- 已改过：${path.basename(path.dirname(path.dirname(file)))}`); continue }
  if (!t.includes(OLD)) { console.error(`✗ 锚点未命中：${file}`); continue }
  writeFileSync(file, t.replace(OLD, NEW))
  console.log(`✓ ${file}`)
}
