import type { Clip } from '../types'

/**
 * 链接闭包：a.linkedId === b.id（音视频配对、字幕 → 配音）或两者共用同一个非片段 id 的链接标记（旧数据），
 * 按传递关系收齐整组。
 */
export function linkedClosure(clips: Pick<Clip, 'id' | 'linkedId'>[], ids: Iterable<string>): string[] {
  const byId = new Set(clips.map((c) => c.id))
  const out = new Set(ids)
  let grew = true
  while (grew) {
    grew = false
    const tokens = new Set<string>()
    for (const c of clips) if (out.has(c.id) && c.linkedId && !byId.has(c.linkedId)) tokens.add(c.linkedId)
    for (const c of clips) {
      if (out.has(c.id)) {
        if (c.linkedId && byId.has(c.linkedId) && !out.has(c.linkedId)) { out.add(c.linkedId); grew = true }
      } else if (c.linkedId && (out.has(c.linkedId) || tokens.has(c.linkedId))) {
        out.add(c.id)
        grew = true
      }
    }
  }
  return [...out]
}
