/**
 * 内嵌工具根目录：配音（TTS_timeline）与密匙（生视频 host / Volc TTS）。
 * 默认指向 todo-editor/vendor/*，换电脑克隆后开箱可用；仍可用环境变量覆盖。
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const EDITOR_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const VENDOR_TTS_ROOT = path.join(EDITOR_ROOT, 'vendor', 'tts-timeline')
export const VENDOR_MISHI_ROOT = path.join(EDITOR_ROOT, 'vendor', 'mishi')

export function resolveTtsTimelineRoot() {
  const fromEnv = String(process.env.TTS_TIMELINE_ROOT || '').trim()
  if (fromEnv) return path.resolve(fromEnv)
  return VENDOR_TTS_ROOT
}

export function resolveMishiRoot() {
  const fromEnv = String(process.env.MISHI_ROOT || '').trim()
  if (fromEnv) return path.resolve(fromEnv)
  return VENDOR_MISHI_ROOT
}

export function ttsTimelineReady(root = resolveTtsTimelineRoot()) {
  return existsSync(path.join(root, 'run.py'))
}

export function mishiReady(root = resolveMishiRoot()) {
  return existsSync(path.join(root, 'run.py')) || existsSync(path.join(root, 'media', 'tts.py'))
}
