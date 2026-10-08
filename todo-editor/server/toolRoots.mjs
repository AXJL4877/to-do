/**
 * 内嵌工具根目录。默认指向 todo-editor/vendor/*，换机克隆后开箱可用；仍可用环境变量覆盖。
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const EDITOR_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const VENDOR_TTS_ROOT = path.join(EDITOR_ROOT, 'vendor', 'tts-timeline')
export const VENDOR_MISHI_ROOT = path.join(EDITOR_ROOT, 'vendor', 'mishi')
export const VENDOR_BLACKBOARD_ROOT = path.join(EDITOR_ROOT, 'vendor', 'blackboard')
export const VENDOR_BURN_SUBTITLES_ROOT = path.join(EDITOR_ROOT, 'vendor', 'burn-subtitles')

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

export function resolveBlackboardRoot() {
  const fromEnv = String(process.env.BLACKBOARD_ROOT || '').trim()
  if (fromEnv) return path.resolve(fromEnv)
  return VENDOR_BLACKBOARD_ROOT
}

export function resolveBurnSubtitlesRoot() {
  const fromEnv = String(process.env.BURN_SUBTITLES_DIR || '').trim()
  if (fromEnv) return path.resolve(fromEnv)
  return VENDOR_BURN_SUBTITLES_ROOT
}

export function ttsTimelineReady(root = resolveTtsTimelineRoot()) {
  return existsSync(path.join(root, 'run.py'))
}

export function mishiReady(root = resolveMishiRoot()) {
  return existsSync(path.join(root, 'run.py')) || existsSync(path.join(root, 'media', 'tts.py'))
}

export function blackboardReady(root = resolveBlackboardRoot()) {
  return existsSync(path.join(root, 'scripts', 'stream_render.py'))
    && existsSync(path.join(root, 'assets', 'hand-chalk.png'))
}

export function burnSubtitlesReady(root = resolveBurnSubtitlesRoot()) {
  return existsSync(path.join(root, 'burn_subtitles.py'))
}
