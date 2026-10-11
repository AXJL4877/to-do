import { bindExtensionDropImport, EXTENSIONS_CHANGED, importExtensionFiles } from '../src/lib/extensionImport'
import { resolveSkillDraft } from '../src/lib/aiSkills'
import { DYNAMIC_TEXT_PACK } from '../src/lib/dynamicTextPack'

;(window as any).extensionTests = (async () => {
  const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message) }
  const pack = new File(['zip'], 'paper.todoext')
  const media = new File(['video'], 'clip.mp4')
  let calls = 0, events = 0
  window.addEventListener(EXTENSIONS_CHANGED, () => events++)
  window.fetch = async (url, options) => {
    calls++
    assert(String(url).endsWith('/api/ai-extensions/import'), 'upload endpoint')
    assert(options?.body instanceof ArrayBuffer, 'raw binary upload')
    return new Response(JSON.stringify({ ok: true, extension: { id: 'example.paper', name: 'Paper', version: '1.0.0', kind: 'skill', action: 'installed' } }), { status: 200 })
  }
  const result = await importExtensionFiles([pack, media])
  assert(calls === 1 && events === 1 && result.remaining[0] === media, 'mixed files partition and refresh')
  let ordinary = 0, mediaImported = 0, installed = 0
  const target = document.createElement('div'); document.body.append(target)
  target.addEventListener('drop', () => ordinary++)
  const messages: string[] = []
  const stop = bindExtensionDropImport({ onMessage: m => messages.push(m), onInstalled: () => installed++, onMedia: async files => { mediaImported += files.length } })
  const drop = (files: File[]) => { const transfer = new DataTransfer(); files.forEach(file => transfer.items.add(file)); target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })) }
  drop([media]); assert(ordinary === 1, 'ordinary media reaches existing drop handler')
  drop([pack, media]); drop([pack])
  for (let i = 0; i < 100 && installed < 2; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert(installed === 2 && mediaImported === 1 && ordinary === 1, 'queued capture imports packages once and preserves mixed media')
  stop(); drop([media]); assert(ordinary === 2, 'listener cleanup')
  window.fetch = async () => new Response(JSON.stringify({ ok: false, error: 'bad package' }), { status: 400 })
  const failed = await importExtensionFiles([pack]); assert(failed.errors.length === 1 && events === 3, 'failed upload has no refresh event')
  const oversized = new File(['x'], 'large.todoext'); Object.defineProperty(oversized, 'size', { value: 513 * 1024 * 1024 })
  window.fetch = async () => { throw new Error('must not upload oversized file') }
  assert((await importExtensionFiles([oversized])).errors[0].includes('512 MB'), 'client upload limit')
  const oldDraft = { prompt: '保留文案', params: { removed: 'value' }, plan: { title: 'old', notes: '', elements: [] }, version: '0.1.0' }
  const upgraded = resolveSkillDraft(DYNAMIC_TEXT_PACK, oldDraft)
  assert(upgraded.prompt === oldDraft.prompt && !('removed' in upgraded.params) && upgraded.plan === null, 'upgraded schema resets stale params and plans while preserving prompt')
  assert(resolveSkillDraft(DYNAMIC_TEXT_PACK, upgraded) === upgraded, 'same version retains user edits')
  return { ok: true, checks: 10, messages }
})()
