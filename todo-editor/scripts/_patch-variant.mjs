/**
 * richness.py 的 variant_prompt：多次被拒时**简化动作**，而不是只删上下文。
 *
 * 实证：`ch_s7_spongebob_gold_shield`（海绵宝宝举盾挡海浪）连续 6~12 次被拒，
 * 抠图报告都是 `subject_at_edge=[...,true]` / `cropped=true`——**主体右边距 = 0**。
 * 原因不是 prompt 缺约束：CUTOUT 里本来就写着 "complete and fully inside the frame with
 * clear empty margin on all four sides"，但**描述的动作用海浪，海浪天然铺满并溢出画幅** ✗
 * 而原 variant_prompt 只会删口播上下文、截短，12 次都在重复同一个必然溢出的构图。
 *
 * 修法：attempt%4>=3 时把动作压成"单主体持物、静止"，并显式禁掉会铺满画幅的元素。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const targets = [
  path.join(process.env.APPDATA || '', 'todo-editor', 'data', 'skills', 'studio.spongebob-koubo', 'workflow', 'richness.py'),
  'examples/extensions/spongebob-koubo/workflow/richness.py',
]

const OLD = `    if attempt % 4 >= 2:
        p = re.sub(r"Richness L5[^.]*\\.\\s*", "", p)
        p = p[:420].rstrip(". ") + ". Original cartoon design, no celebrity likeness, no logo text."
    return p`

const NEW = `    if attempt % 4 >= 2:
        p = re.sub(r"Richness L5[^.]*\\.\\s*", "", p)
        p = p[:420].rstrip(". ") + ". Original cartoon design, no celebrity likeness, no logo text."
    if attempt % 4 >= 3:
        # 多次被拒基本只有一种原因：主体被画幅裁到（cropped / subject_at_edge）。
        # 光靠 CUTOUT 里已有的留白要求没用——动作本身若含"海浪/水花/爆炸/烟雾"，
        # 模型就会画成铺满画幅。这里把动作压到最小并显式点名禁掉这些元素。
        p = p.split(". ")[0].rstrip(". ")
        p = (
            p
            + ". Show only the single character holding the object, standing still, whole body visible. "
            + "No water, no waves, no splashes, no explosion, no smoke, no motion trails, no background scenery. "
            + "Keep a wide empty white margin on every side so nothing is cut off by the image edge."
        )
    return p`

for (const file of targets) {
  if (!existsSync(file)) { console.log(`- 跳过：${file}`); continue }
  let t = readFileSync(file, 'utf8')
  if (t.includes('No water, no waves, no splashes')) { console.log('- 已改过'); continue }
  if (!t.includes(OLD)) { console.error(`✗ 锚点未命中：${file}`); continue }
  writeFileSync(file, t.replace(OLD, NEW))
  console.log(`✓ ${file}`)
}
