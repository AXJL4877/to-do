import assert from 'node:assert/strict'
import { bedSpan, parseBgmLibrary, planBgmPieces } from './bgmLibrary'

const pieces = (music: number, span: number, loop: boolean) =>
  planBgmPieces(music, 0, span, loop).map((p) => [p.start, p.duration, p.outPoint])

assert.deepEqual(pieces(120, 30, true), [[0, 30, 30]], '长曲裁到成片时长')
assert.deepEqual(pieces(10, 25, false), [[0, 10, 10]], '短曲不循环就只放一遍')
assert.deepEqual(pieces(10, 25, true), [[0, 10, 10], [10, 10, 10], [20, 5, 5]], '短曲接龙，尾段裁齐')
assert.deepEqual(pieces(10, 20, true), [[0, 10, 10], [10, 10, 10]], '刚好整数段不留空尾巴')
assert.deepEqual(pieces(0, 10, true), [], '没有时长就不铺')
assert.deepEqual(planBgmPieces(8, 4, 12, false), [{ start: 4, duration: 8, inPoint: 0, outPoint: 8 }])

const track = (id: string, kind: string, role?: 'bgm') => ({ id, kind, ...(role ? { role } : {}) })
const clip = (id: string, trackId: string, start: number, duration: number, extra: Record<string, unknown> = {}) =>
  ({ trackId, start, duration, enabled: true, mediaId: id, ...extra })

const voice = bedSpan({
  tracks: [track('v', 'video'), track('a', 'audio'), track('b', 'audio', 'bgm')],
  clips: [
    clip('pic', 'v', 0, 40),
    clip('voice', 'a', 2, 6),
    clip('bed', 'b', 0, 40, { meta: { role: 'bgm' } }),
    clip('cam', 'a', 0, 40, { linkedId: 'pic' }),
  ],
})
assert.deepEqual(voice, { start: 2, end: 8 }, '只包住配音，不把画面声和配乐算进去')

const picture = bedSpan({
  tracks: [track('v', 'video'), track('a', 'audio')],
  clips: [clip('pic', 'v', 1, 9), clip('cam', 'a', 1, 9, { linkedId: 'pic' })],
})
assert.deepEqual(picture, { start: 0, end: 10 }, '没有配音就从 0 铺到时间线末尾')

const onlyBed = bedSpan({
  tracks: [track('b', 'audio', 'bgm')],
  clips: [clip('bed', 'b', 3, 7, { meta: { role: 'bgm' } })],
})
assert.deepEqual(onlyBed, { start: 0, end: 10 }, '只剩旧配乐时仍能算出替换范围')
assert.equal(bedSpan({ tracks: [], clips: [] }), null)

const lib = parseBgmLibrary({
  version: 1,
  items: [
    { id: 'a', title: '  夜路  ', path: 'D:\\m\\a.mp3', duration: 12, moods: ['沉稳', '不存在', '沉稳'], energy: 'low', loop: false, gainDb: -18, sourceNote: '已购' },
    { id: 'a', title: '重复', path: '', duration: 3 },
    { id: '', title: '缺 id', duration: 3 },
    { id: 'b', title: '', duration: 0 },
    { title: '缺字段' },
    { id: 'c', duration: 4, gainDb: 12, energy: 'loud', loop: true },
  ],
})
assert.equal(lib.length, 2)
assert.equal(lib[0].title, '夜路')
assert.deepEqual(lib[0].moods, ['沉稳'])
assert.equal(lib[0].energy, 'low')
assert.equal(lib[0].loop, false)
assert.equal(lib[0].gainDb, -18)
assert.equal(lib[1].title, '未命名')
assert.equal(lib[1].gainDb, 0)
assert.equal(lib[1].energy, 'mid')
assert.equal(lib[1].loop, true)

console.log('bgm library selfcheck ok')
