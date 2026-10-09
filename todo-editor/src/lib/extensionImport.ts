import { aiFetch } from './aiFetch'

export const EXTENSIONS_CHANGED = 'todo:extensions-changed'
export type InstalledExtension = { id: string; name: string; version: string; kind: 'skill' | 'style' | 'animation'; action: 'installed' | 'updated' | 'unchanged' | 'removed' }
export const isExtensionFile = (file: File) => /\.(todoext|zip)$/i.test(file.name)
let lastInstalled: InstalledExtension | undefined
export const getLastInstalledExtension = () => lastInstalled

export async function uninstallExtension(kind: InstalledExtension['kind'], id: string) {
  const response = await aiFetch('/api/ai-extensions/uninstall', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, id }),
  })
  const result = await response.json()
  if (!response.ok || !result.ok || !result.extension) throw new Error(result.error || '扩展移除失败')
  const extension: InstalledExtension = result.extension
  window.dispatchEvent(new CustomEvent(EXTENSIONS_CHANGED, { detail: extension }))
  return extension
}

export async function importExtensionFiles(files: File[]) {
  const installed: InstalledExtension[] = []
  const errors: string[] = []
  for (const file of files.filter(isExtensionFile)) {
    try {
      if (file.size > 32 * 1024 * 1024) throw new Error('扩展包不能超过 32 MB')
      const response = await aiFetch('/api/ai-extensions/import', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: await file.arrayBuffer() })
      const result = await response.json()
      if (!response.ok || !result.ok || !result.extension) throw new Error(result.error || '扩展安装失败')
      const extension: InstalledExtension = result.extension
      installed.push(extension)
      lastInstalled = extension
      window.dispatchEvent(new CustomEvent(EXTENSIONS_CHANGED, { detail: extension }))
    } catch (e) { errors.push(`${file.name}：${e instanceof Error ? e.message : String(e)}`) }
  }
  return { installed, errors, remaining: files.filter(file => !isExtensionFile(file)) }
}

export function bindExtensionDropImport(callbacks: {
  onMessage: (message: string) => void
  onInstalled: (extension: InstalledExtension) => void
  onMedia: (files: File[]) => Promise<void>
}) {
  let queue = Promise.resolve()
  const dragover = (event: DragEvent) => {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
  }
  const drop = (event: DragEvent) => {
    const files = Array.from(event.dataTransfer?.files ?? [])
    if (!files.some(isExtensionFile)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    queue = queue.then(async () => {
      callbacks.onMessage('正在校验并安装扩展包…')
      const result = await importExtensionFiles(files)
      result.installed.forEach(callbacks.onInstalled)
      const messages = result.installed.map(p => `${p.action === 'updated' ? '已更新' : p.action === 'unchanged' ? '已安装，无需重复导入' : '已安装'}「${p.name}」${p.version}`)
      messages.push(...result.errors)
      if (result.remaining.length) await callbacks.onMedia(result.remaining)
      callbacks.onMessage(messages.join('；'))
    }).catch(e => callbacks.onMessage(e instanceof Error ? e.message : String(e)))
  }
  window.addEventListener('dragover', dragover, true)
  window.addEventListener('drop', drop, true)
  return () => { window.removeEventListener('dragover', dragover, true); window.removeEventListener('drop', drop, true) }
}
