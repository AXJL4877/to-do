/** 烧录字幕时可选的顶部章节进度条。默认关；打开后整段只出一条，段宽按时间。 */

export const CHAPTER_MAX = 6
export const CHAPTER_TITLE_MAX = 8

export type ChapterSpan = { title: string; start: number; end: number }

/** 交给字幕任务的进度条：时间相对 placeAt，0 是最早一段音频的起点 */
export type ChapterBarRequest = {
  titles: string[]
  duration: number
  ranges: [number, number][]
  placeAt: number
}

export type ChapterBarPlan = ChapterBarRequest & { chapters: ChapterSpan[] }

function round3(n: number) {
  return Math.round(n * 1000) / 1000
}

function chars(text: string) {
  return [...text.trim()]
}

/** 一行一个章名。空行丢掉。超过 6 段或单行超过 8 字时返回原因，不截断。 */
export function chapterTitleError(text: string): string | null {
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  if (!lines.length) return '打开进度条后请写上章名，一行一个'
  if (lines.length > CHAPTER_MAX) return `进度条最多 ${CHAPTER_MAX} 段，请先合并章名`
  if (lines.some((s) => chars(s).length > CHAPTER_TITLE_MAX)) return `章名请控制在 ${CHAPTER_TITLE_MAX} 个字以内`
  return null
}

export function chapterTitles(text: string): string[] {
  return text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
}

/**
 * 用所选音频的时间线位置排进度条。
 * 章名数量和音频段数相同：一段一章，段间空隙并进前一章。
 * 否则在「最早起点 → 最晚终点」上均分。
 */
export function planChapterBar(
  clips: { start: number; duration: number }[],
  titles: string[],
): ChapterBarPlan | null {
  const names = titles.map((t) => t.trim()).filter(Boolean)
  if (!names.length || names.length > CHAPTER_MAX || !clips.length) return null
  if (names.some((t) => chars(t).length > CHAPTER_TITLE_MAX || !chars(t).length)) return null
  const ordered = [...clips].sort((a, b) => a.start - b.start || b.duration - a.duration)
  const placeAt = Math.min(...ordered.map((c) => c.start))
  const end = Math.max(...ordered.map((c) => c.start + Math.max(0, c.duration)))
  const duration = end - placeAt
  if (!(duration > 0.05)) return null

  let chapters: ChapterSpan[]
  if (names.length === ordered.length) {
    chapters = names.map((title, i) => {
      const start = Math.max(0, ordered[i].start - placeAt)
      const next = ordered[i + 1]
      const stop = next ? next.start - placeAt : duration
      return { title, start, end: Math.min(duration, Math.max(start + 0.05, stop)) }
    })
  } else {
    const step = duration / names.length
    chapters = names.map((title, i) => ({
      title,
      start: i * step,
      end: i === names.length - 1 ? duration : (i + 1) * step,
    }))
  }
  chapters[chapters.length - 1] = { ...chapters[chapters.length - 1], end: duration }
  return {
    titles: chapters.map((c) => c.title),
    duration: round3(duration),
    ranges: chapters.map((c) => [round3(c.start), round3(c.end)]),
    placeAt: round3(placeAt),
    chapters: chapters.map((c) => ({ title: c.title, start: round3(c.start), end: round3(c.end) })),
  }
}
