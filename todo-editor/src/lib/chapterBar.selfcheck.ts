import { chapterTitleError, planChapterBar } from './chapterBar'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

const gap = planChapterBar(
  [{ start: 10, duration: 8 }, { start: 20, duration: 5 }],
  ['成本墙', '换维度'],
)
assert(gap && gap.placeAt === 10 && gap.duration === 15, `空隙应并进整段：${JSON.stringify(gap)}`)
assert(gap.ranges[0][0] === 0 && gap.ranges[0][1] === 10 && gap.ranges[1][0] === 10 && gap.ranges[1][1] === 15, '一段一章，空隙归前一章')

const split = planChapterBar(
  [{ start: 0, duration: 9 }, { start: 12, duration: 3 }],
  ['工程经济', '成本墙', '换维度'],
)
assert(split && split.duration === 15 && split.ranges.length === 3, '章名和段数不同时均分整段')
assert(split.ranges[2][1] === 15 && Math.abs(split.ranges[1][0] - 5) < 0.001, '均分到片尾')

const ordered = planChapterBar(
  [{ start: 30, duration: 10 }, { start: 0, duration: 10 }],
  ['先说', '后说'],
)
assert(ordered && ordered.titles[0] === '先说' && ordered.ranges[0][1] === 30, '按时间线先后，不按选择顺序')

assert(planChapterBar([], ['成本墙']) == null, '没有音频就不排')
assert(chapterTitleError('') === '打开进度条后请写上章名，一行一个', '空章名')
assert(chapterTitleError('一\n二\n三\n四\n五\n六\n七')?.includes('6'), '超过 6 段')
assert(chapterTitleError('这是一个超过八个字的章名')?.includes('8'), '章名过长')
assert(chapterTitleError('成本墙\n\n换维度') == null, '空行忽略')

console.log('chapter bar selfcheck ok')
