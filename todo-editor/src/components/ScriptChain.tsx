import { useState } from 'react'
import { requestScriptAi } from '../lib/scriptAi'
import {
  CHAIN_STEPS,
  INSERT_KINDS,
  THEME_TRACKS,
  ensureChainOutline,
  type ChainStep,
  composeChainBody,
  type OutlineInsert,
  type OutlineInsertKind,
  type OutlineSeg,
  type ScriptWorkspace,
} from '../lib/scriptWorkspace'

const ROLES = ['开场', '展开', '转折', '收束']

function newSeg(index: number): OutlineSeg {
  return {
    id: `c${Date.now().toString(36)}${index}${Math.random().toString(36).slice(2, 5)}`,
    role: ROLES[index] || `第${index + 1}段`,
    key_point: '',
    target_chars: 80,
    material_ids: [],
    inserts: [],
  }
}

function setInsert(seg: OutlineSeg, kind: OutlineInsertKind, text: string): OutlineSeg {
  const inserts = [...(seg.inserts || [])]
  const found = inserts.findIndex((item) => item.kind === kind)
  const next: OutlineInsert = found >= 0
    ? { ...inserts[found], text }
    : { id: `${seg.id}-${kind}`, kind, text }
  if (found >= 0) inserts[found] = next
  else inserts.push(next)
  return { ...seg, inserts }
}

function insertText(seg: OutlineSeg, kind: OutlineInsertKind) {
  return (seg.inserts || []).find((item) => item.kind === kind)?.text || ''
}

function beatsFromAi(text: string) {
  return text.split(/\n+/)
    .map((line) => line.replace(/^\s*(?:\d+[.、)]|[-*·])\s*/, '').trim())
    .filter((line) => line.length > 1)
    .slice(0, 6)
}

export function ScriptChain({
  ws,
  onPatch,
  onWrite,
}: {
  ws: ScriptWorkspace
  onPatch: (ws: ScriptWorkspace) => void
  onWrite: (text: string) => void
}) {
  const [busyKey, setBusyKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const step = ws.chain_step
  const hint = CHAIN_STEPS.find((item) => item.id === step)?.hint || ''
  const preview = composeChainBody(ws.outline)
  const themeReady = !!ws.track.trim() && !!ws.user_brief.trim()
  const outlineReady = ws.outline.some((seg) => seg.key_point.trim())

  const go = (chain_step: ChainStep, extra?: Partial<ScriptWorkspace>) => {
    setError(null)
    onPatch({ ...ws, ...extra, chain_step })
  }

  const patchOutline = (outline: OutlineSeg[]) => onPatch({ ...ws, outline })

  const draftOutline = async () => {
    setBusyKey('outline')
    setError(null)
    try {
      const res = await requestScriptAi({
        mode: 'insert',
        fullText: `${ws.track}\n${ws.user_brief}`,
        instruction: '按这个赛道和这一期的主题，写 4 行口播大纲。每行只写这一段要讲清的一句。不要解释，不要写数据、故事或互动。',
      })
      const lines = beatsFromAi(res.text || res.reply)
      if (!lines.length) throw new Error('没有得到可用的大纲，可以直接自己写')
      patchOutline(lines.map((line, index) => ({
        ...(ws.outline[index] || newSeg(index)),
        role: ROLES[index] || `第${index + 1}段`,
        key_point: line,
        inserts: ws.outline[index]?.inserts || [],
      })))
    } catch (err) {
      setError(err instanceof Error ? err.message : '大纲没有写出来')
    } finally {
      setBusyKey('')
    }
  }

  const fillInsert = async (seg: OutlineSeg, kind: OutlineInsertKind) => {
    const label = INSERT_KINDS.find((item) => item.id === kind)?.label || '穿插'
    setBusyKey(`${seg.id}:${kind}`)
    setError(null)
    try {
      const res = await requestScriptAi({
        mode: 'insert',
        fullText: [ws.track, ws.user_brief, seg.key_point].filter(Boolean).join('\n'),
        instruction: `只写一句能直接朗读的${label}，接在这一段后面。不要标题，不要序号，不要解释。`,
      })
      const text = (res.text || res.reply).split('\n').map((line) => line.trim()).find(Boolean) || ''
      if (!text) throw new Error(`${label}没有写出来，可以直接自己填`)
      patchOutline(ws.outline.map((item) => item.id === seg.id ? setInsert(item, kind, text) : item))
    } catch (err) {
      setError(err instanceof Error ? err.message : '没有写出来')
    } finally {
      setBusyKey('')
    }
  }

  return (
    <section className={`script-chain${step === 'draft' ? ' script-chain-draft' : ''}`} data-testid="script-chain">
      <p className="script-chain-hint">{hint}。数据、故事和互动都挂在对应段落上，写进正文时不带标题。</p>
      {error ? <p className="script-ask-dock-err">{error}</p> : null}

      {step === 'theme' ? (
        <>
          <p className="script-chain-label">这条内容做哪条赛道</p>
          <div className="script-chain-tracks">
            {THEME_TRACKS.map((track) => (
              <button key={track} type="button" className={`script-chain-track${ws.track === track ? ' on' : ''}`} onClick={() => onPatch({ ...ws, track })}>
                {track}
              </button>
            ))}
          </div>
          <label className="script-chain-label">其他赛道
            <input className="input" value={THEME_TRACKS.includes(ws.track) ? '' : ws.track} placeholder="自己写，例如：本地生活"
              onChange={(e) => onPatch({ ...ws, track: e.target.value.trim() })} />
          </label>
          <label className="script-chain-label">这一期讲什么
            <textarea data-testid="chain-intent" className="input script-chain-area" value={ws.user_brief}
              placeholder="例如：年轻人第一份工资，为什么不能先拿去理财"
              onChange={(e) => onPatch({ ...ws, user_brief: e.target.value })} />
          </label>
          <div className="script-chain-actions">
            <button type="button" className="btn btn-primary text-[11px]" data-testid="chain-next" disabled={!themeReady}
              onClick={() => go('outline', {
                topic: { title: ws.user_brief.trim(), core_claim: ws.user_brief.trim(), angle: ws.track },
                outline: ensureChainOutline(ws.outline),
              })}>
              下一步：写大纲
            </button>
          </div>
        </>
      ) : null}

      {step === 'outline' ? (
        <>
          <p className="script-chain-label">{ws.track} · {ws.user_brief}</p>
          {ws.outline.map((seg, index) => (
            <div key={seg.id} className="script-chain-row">
              <input className="input script-chain-role" value={seg.role} aria-label="段落作用"
                onChange={(e) => patchOutline(ws.outline.map((item) => item.id === seg.id ? { ...item, role: e.target.value } : item))} />
              <textarea data-testid="chain-point" className="input script-chain-area" value={seg.key_point}
                placeholder="这一段要讲清的一句"
                onChange={(e) => patchOutline(ws.outline.map((item) => item.id === seg.id ? { ...item, key_point: e.target.value } : item))} />
              <button type="button" className="btn text-[11px]" onClick={() => patchOutline(ws.outline.filter((item) => item.id !== seg.id))}>去掉</button>
              <span className="script-chain-note">{index + 1}</span>
            </div>
          ))}
          <div className="script-chain-actions">
            <button type="button" className="btn text-[11px]" onClick={() => patchOutline([...ws.outline, newSeg(ws.outline.length)])}>加一段</button>
            <button type="button" className="btn text-[11px]" disabled={!!busyKey || ws.outline.some((seg) => seg.key_point.trim())} onClick={() => { void draftOutline() }}>
              {busyKey === 'outline' ? '正在起草…' : '按主题起草大纲'}
            </button>
            <button type="button" className="btn text-[11px]" onClick={() => go('theme')}>返回大主题</button>
            <button type="button" className="btn btn-primary text-[11px]" data-testid="chain-next" disabled={!outlineReady} onClick={() => go('weave')}>
              下一步：穿插
            </button>
          </div>
        </>
      ) : null}

      {step === 'weave' ? (
        <>
          {ws.outline.filter((seg) => seg.key_point.trim()).map((seg) => (
            <article key={seg.id} className="script-chain-card">
              <p className="script-chain-label">{seg.role} · {seg.key_point}</p>
              {INSERT_KINDS.map((kind) => (
                <label key={kind.id} className="script-chain-label">{kind.label}
                  <textarea data-testid={`chain-${kind.id}`} className="input script-chain-area" value={insertText(seg, kind.id)}
                    placeholder={kind.hint}
                    onChange={(e) => patchOutline(ws.outline.map((item) => item.id === seg.id ? setInsert(item, kind.id, e.target.value) : item))} />
                  <button type="button" className="btn text-[11px]" disabled={!!busyKey || !seg.key_point.trim()} onClick={() => { void fillInsert(seg, kind.id) }}>
                    {busyKey === `${seg.id}:${kind.id}` ? '正在写…' : `帮我写${kind.label}`}
                  </button>
                </label>
              ))}
            </article>
          ))}
          <div className="script-chain-actions">
            <button type="button" className="btn text-[11px]" onClick={() => go('outline')}>返回大纲</button>
            <button type="button" className="btn btn-primary text-[11px]" data-testid="chain-write" disabled={!preview.trim()}
              onClick={() => onWrite(preview)}>
              写进口播正文
            </button>
          </div>
        </>
      ) : null}

      {step === 'draft' ? (
        <div className="script-chain-actions">
          <button type="button" className="btn text-[11px]" onClick={() => go('weave')}>返回穿插</button>
          <button type="button" className="btn btn-primary text-[11px]" data-testid="chain-write" disabled={!preview.trim()} onClick={() => onWrite(preview)}>
            按大纲和穿插重写正文
          </button>
          {preview.trim() && preview !== ws.body.trim() ? <span className="script-chain-note">大纲或穿插有改动，正文还是上一版。</span> : null}
        </div>
      ) : null}
    </section>
  )
}
