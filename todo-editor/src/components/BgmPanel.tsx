import { useMemo, useRef, useState } from 'react'
import { Loader2, Music2, Pause, Play, Plus, Trash2 } from 'lucide-react'
import clsx from 'clsx'
import { useApp } from '../store'
import { desktop } from '../lib/desktop'
import { parseMediaFiles } from '../lib/importFiles'
import { uid } from '../types'
import {
  BGM_MOODS, bgmPlaybackUrl, loadBgmLibrary, saveBgmLibrary,
  type BgmEnergy, type BgmEntry, type BgmMood,
} from '../lib/bgmLibrary'

const AUDIO_EXT = /\.(mp3|wav|aac|m4a|flac|ogg)$/i

function clock(sec: number) {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function titleFromName(name: string) {
  return name.replace(/\.[^.]+$/, '').trim().slice(0, 80) || '未命名'
}

function samePath(a: string, b: string) {
  return !!a && !!b && a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
}

/** 媒体库「配乐」：本机曲库，试听后铺到锁定的配乐轨。 */
export function BgmPanel() {
  const placeBgm = useApp((s) => s.placeBgm)
  const [items, setItems] = useState<BgmEntry[]>(() => loadBgmLibrary())
  const [mood, setMood] = useState<BgmMood | 'all'>('all')
  const [energy, setEnergy] = useState<BgmEnergy | 'all'>('all')
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const audioRef = useRef<HTMLAudioElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  function commit(next: BgmEntry[]) {
    setItems(next)
    saveBgmLibrary(next)
  }

  function patch(id: string, part: Partial<BgmEntry>) {
    commit(items.map((item) => (item.id === id ? { ...item, ...part } : item)))
  }

  const shown = useMemo(() => items.filter((item) => {
    if (mood !== 'all' && !item.moods.includes(mood)) return false
    if (energy !== 'all' && item.energy !== energy) return false
    return true
  }), [items, mood, energy])

  function stop() {
    const audio = audioRef.current
    if (audio) {
      audio.pause()
      audio.currentTime = 0
    }
    setPlayingId(null)
  }

  function togglePlay(item: BgmEntry) {
    const audio = audioRef.current
    const url = bgmPlaybackUrl(item)
    if (!audio || !url) {
      useApp.getState().setToast('找不到这首曲子的文件')
      return
    }
    if (playingId === item.id && !audio.paused) {
      audio.pause()
      setPlayingId(null)
      return
    }
    if (audio.dataset.bgm !== item.id) {
      audio.dataset.bgm = item.id
      audio.src = url
    }
    setPlayingId(item.id)
    void audio.play().catch(() => {
      setPlayingId(null)
      useApp.getState().setToast('试听失败')
    })
  }

  function ingest(rows: { name: string; path?: string; url: string; duration: number }[]) {
    const added: BgmEntry[] = []
    let skipped = 0
    for (const row of rows) {
      if (!(row.duration > 0.05) || (!row.url && !row.path)) continue
      if (row.path && (items.some((item) => samePath(item.path, row.path!)) || added.some((item) => samePath(item.path, row.path!)))) {
        skipped++
        continue
      }
      added.push({
        id: uid('bgm'),
        title: titleFromName(row.name),
        path: row.path || '',
        ...(row.path ? {} : { url: row.url }),
        duration: row.duration,
        moods: [],
        energy: 'mid',
        loop: true,
        gainDb: -20,
        sourceNote: '',
      })
    }
    if (added.length) commit([...items, ...added])
    const toast = added.length
      ? `已加入 ${added.length} 首${skipped ? `，跳过 ${skipped} 首重复` : ''}`
      : skipped
        ? '这些曲子已经在库里'
        : '没有读出可用的音频时长'
    useApp.getState().setToast(toast)
  }

  async function addFromDesktop() {
    const api = desktop()
    if (!api?.pickMediaFiles) {
      fileRef.current?.click()
      return
    }
    const picked = await api.pickMediaFiles()
    if (!picked.ok || !picked.files.length) return
    const audio = picked.files.filter((file) => file.kind === 'audio' || AUDIO_EXT.test(file.name))
    if (!audio.length) {
      useApp.getState().setToast('请选择音频文件')
      return
    }
    setBusy(true)
    try {
      const rows: { name: string; path?: string; url: string; duration: number }[] = []
      for (const file of audio) {
        const probed = await api.probeMedia(file.path)
        const duration = probed.ok ? probed.duration ?? 0 : 0
        if (duration > 0.05) rows.push({ name: file.name, path: file.path, url: file.url, duration })
      }
      ingest(rows)
    } finally {
      setBusy(false)
    }
  }

  async function addFromBrowser(list: FileList | null) {
    if (!list?.length) return
    setBusy(true)
    try {
      const parsed = await parseMediaFiles([...list])
      ingest(parsed.filter((item) => item.kind === 'audio').map((item) => ({
        name: item.name, path: item.path, url: item.url, duration: item.duration,
      })))
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  function remove(id: string) {
    if (playingId === id) stop()
    commit(items.filter((item) => item.id !== id))
  }

  function toggleMood(item: BgmEntry, next: BgmMood) {
    const moods = item.moods.includes(next) ? item.moods.filter((m) => m !== next) : [...item.moods, next]
    patch(item.id, { moods })
  }

  return (
    <div className="bgm-panel flex flex-col gap-2 min-h-0 flex-1" data-testid="bgm-panel">
      <audio ref={audioRef} preload="none" onEnded={() => setPlayingId(null)} />
      <div className="flex items-center gap-2">
        <button type="button" className="btn btn-primary" data-testid="bgm-add" disabled={busy} onClick={() => void addFromDesktop()}>
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
          添加曲目
        </button>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{items.length} 首</span>
      </div>
      <input ref={fileRef} type="file" multiple accept="audio/*,.mp3,.wav,.aac,.m4a,.flac,.ogg" className="hidden" data-testid="bgm-file" onChange={(e) => void addFromBrowser(e.target.files)} />
      <p className="text-[10px] m-0" style={{ color: 'var(--text-muted)' }}>
        曲库存在本机，所有工程共用。铺到成片会换掉当前配乐，并压在口播下面。
      </p>
      <div className="flex flex-wrap gap-1">
        <button type="button" className={clsx('tab', mood === 'all' && energy === 'all' && 'active')} data-testid="bgm-filter-all" onClick={() => { setMood('all'); setEnergy('all') }}>全部</button>
        {BGM_MOODS.map((item) => (
          <button key={item} type="button" className={clsx('tab', mood === item && 'active')} data-testid={`bgm-filter-${item}`} onClick={() => setMood(item)}>{item}</button>
        ))}
        {(['low', 'mid'] as const).map((item) => (
          <button key={item} type="button" className={clsx('tab', energy === item && 'active')} data-testid={`bgm-energy-${item}`} onClick={() => setEnergy(energy === item ? 'all' : item)}>
            {item === 'low' ? '低能量' : '中能量'}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1.5">
        {!items.length && (
          <div className="py-8 text-center text-[12px]" style={{ color: 'var(--text-muted)' }} data-testid="bgm-empty">
            <Music2 size={18} className="inline mb-1" />
            <p className="m-0">还没有曲目。添加你已经有权使用的音乐。</p>
          </div>
        )}
        {!!items.length && !shown.length && (
          <p className="text-[12px] text-center py-6 m-0" style={{ color: 'var(--text-muted)' }}>没有符合筛选的曲子</p>
        )}
        {shown.map((item) => {
          const url = bgmPlaybackUrl(item)
          return (
            <div key={item.id} className="rounded-lg border p-2 flex flex-col gap-1.5" style={{ borderColor: 'var(--border)' }} data-testid={`bgm-card-${item.id}`}>
              <div className="flex items-center gap-1.5">
                <button type="button" className="icon-btn shrink-0" disabled={!url} title={playingId === item.id ? '停止' : '试听'} data-testid={`bgm-play-${item.id}`} onClick={() => togglePlay(item)}>
                  {playingId === item.id ? <Pause size={12} /> : <Play size={12} />}
                </button>
                <input
                  type="text"
                  className="min-w-0 flex-1"
                  style={{ height: 26 }}
                  aria-label="曲名"
                  data-testid={`bgm-title-${item.id}`}
                  value={item.title}
                  onChange={(e) => patch(item.id, { title: e.target.value.slice(0, 80) })}
                />
                <span className="text-[10px] shrink-0" style={{ color: 'var(--text-muted)' }}>{clock(item.duration)}</span>
                <button type="button" className="icon-btn shrink-0" title="从曲库移除" data-testid={`bgm-remove-${item.id}`} onClick={() => remove(item.id)}>
                  <Trash2 size={12} />
                </button>
              </div>
              <div className="flex flex-wrap gap-1">
                {BGM_MOODS.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className={clsx('tab', item.moods.includes(tag) && 'active')}
                    style={{ height: 20, padding: '0 6px' }}
                    data-testid={`bgm-mood-${item.id}-${tag}`}
                    onClick={() => toggleMood(item, tag)}
                  >
                    {tag}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                <label className="flex items-center gap-1 cursor-pointer">
                  <input type="checkbox" checked={item.loop} data-testid={`bgm-loop-${item.id}`} onChange={(e) => patch(item.id, { loop: e.target.checked })} />
                  可循环
                </label>
                <label className="flex items-center gap-1">
                  能量
                  <select value={item.energy} data-testid={`bgm-energy-set-${item.id}`} onChange={(e) => patch(item.id, { energy: e.target.value === 'low' ? 'low' : 'mid' })}>
                    <option value="low">低</option>
                    <option value="mid">中</option>
                  </select>
                </label>
                <label className="flex items-center gap-1">
                  增益
                  <input
                    type="number"
                    style={{ width: 52, height: 22, padding: '0 4px' }}
                    min={-40}
                    max={-6}
                    step={1}
                    data-testid={`bgm-gain-${item.id}`}
                    value={item.gainDb}
                    onChange={(e) => {
                      const n = Number(e.target.value)
                      if (Number.isFinite(n)) patch(item.id, { gainDb: Math.max(-60, Math.min(0, n)) })
                    }}
                  />
                </label>
              </div>
              <input
                type="text"
                style={{ height: 24, width: '100%' }}
                placeholder="来源，如自制 / 已购"
                aria-label="来源"
                data-testid={`bgm-source-${item.id}`}
                value={item.sourceNote}
                onChange={(e) => patch(item.id, { sourceNote: e.target.value.slice(0, 80) })}
              />
              <button type="button" className="btn btn-ghost" data-testid={`bgm-place-${item.id}`} onClick={() => placeBgm(item)}>
                铺到成片
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
