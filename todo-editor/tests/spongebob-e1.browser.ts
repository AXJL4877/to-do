/**
 * 海绵宝宝 E1：真实生产文档入轨后，角色/道具分轨且可改缩放。
 */
import { useApp } from '../src/store'
import { syncProduction } from '../src/lib/productionTimeline'
import type { Production } from '../src/lib/production'
import { defaultScene3d, type Track } from '../src/types'

const results: { name: string; ok: boolean; error?: string }[] = []
function check(ok: unknown, message: string) { if (!ok) throw new Error(message) }
function test(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }) } catch (e) { results.push({ name, ok: false, error: String(e) }) }
}

const track = (id: string, kind: Track['kind']): Track => ({ id, name: id, kind, locked: false, muted: false, hidden: false, solo: false, height: 48 })
const fixture = (window as unknown as { spongebobProductionFixture?: Production }).spongebobProductionFixture
check(fixture, '缺少 spongebobProductionFixture')

const PID = fixture!.id
const seqId = 'sb-e1'
useApp.setState({
  started: true,
  media: [],
  folders: [],
  sequences: [{ id: seqId, name: 'sb', tracks: [track('v1', 'video'), track('a1', 'audio'), track('s1', 'subtitle')], clips: [], markers: [], workIn: 0, workOut: 20, scene3d: defaultScene3d() }],
  activeSeqId: seqId,
  settings: { ...useApp.getState().settings, width: 1920, height: 1080, fps: 30, aiProductions: { [PID]: { t0: 0, auto: true, placed: {}, createdAt: 0 } } },
})

test('分层入轨：多元素 + 配音 + 字幕', () => {
  check(syncProduction(fixture!), '应入轨')
  const clips = useApp.getState().seq().clips.filter((c) => c.meta?.source?.jobId === PID)
  const holds = clips.filter((c) => String(c.meta?.source?.key || '').endsWith('/hold'))
  const draws = clips.filter((c) => String(c.meta?.source?.key || '').endsWith('/draw'))
  const voice = clips.filter((c) => String(c.meta?.source?.key || '').endsWith('/voice'))
  const subs = clips.filter((c) => String(c.meta?.source?.key || '').endsWith('/subs') || useApp.getState().seq().tracks.find((t) => t.id === c.trackId)?.kind === 'subtitle')
  check(holds.length >= 4, `hold 层不足: ${holds.length}`)
  check(draws.length >= 4, `draw 层不足: ${draws.length}`)
  check(voice.length >= 1, '缺配音')
  check(subs.length >= 2, `字幕不足: ${subs.length}`)
  const xs = new Set(holds.map((c) => Math.round((c.transform?.x ?? 0) * 1000)))
  check(xs.size >= 2, `元素 x 未分开: ${[...xs]}`)
})

test('改缩放只影响该元素', () => {
  const clips = useApp.getState().seq().clips.filter((c) => c.meta?.source?.jobId === PID)
  const holds = clips.filter((c) => String(c.meta?.source?.key || '').endsWith('/hold') && !(c.name || '').includes('背景'))
  check(holds.length >= 1, '没有可编辑角色 hold')
  const target = holds[0]
  const beforeOthers = holds.slice(1).map((c) => ({ id: c.id, x: c.transform?.x, s: c.transform?.scaleX }))
  useApp.getState().patchClipsQuiet({
    [target.id]: {
      transform: { ...target.transform!, scaleX: (target.transform?.scaleX || 1) * 1.4, scaleY: (target.transform?.scaleY || 1) * 1.4, x: (target.transform?.x || 0) + 0.1 },
    },
  })
  const after = useApp.getState().seq().clips.find((c) => c.id === target.id)!
  check((after.transform?.scaleX || 0) > (target.transform?.scaleX || 0), '缩放未生效')
  for (const o of beforeOthers) {
    const cur = useApp.getState().seq().clips.find((c) => c.id === o.id)!
    check(Math.abs((cur.transform?.x || 0) - (o.x || 0)) < 1e-6, '其它元素被带动')
    check(Math.abs((cur.transform?.scaleX || 0) - (o.s || 0)) < 1e-6, '其它元素缩放被改')
  }
})

;(window as unknown as { spongebobE1Tests: unknown }).spongebobE1Tests = {
  failed: results.some((r) => !r.ok),
  results,
}
