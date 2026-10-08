/** 配音面板和口播稿共用的音色选择，存在本机。 */
export const VOICE_STORE = 'todo.tts.voice'
export const TTS_VOICE_EVENT = 'todo-tts-voice'

export type VoiceChoice = { voice: 'mizai' | 'clone'; cloneId: string }

export function loadVoiceChoice(): VoiceChoice {
  const choice: VoiceChoice = { voice: 'mizai', cloneId: '' }
  try {
    const saved = JSON.parse(localStorage.getItem(VOICE_STORE) || '{}') as Record<string, unknown>
    if (saved.voice === 'mizai' || saved.voice === 'clone') choice.voice = saved.voice
    if (typeof saved.cloneId === 'string') choice.cloneId = saved.cloneId.slice(0, 64)
  } catch { /* */ }
  return choice
}

export function saveVoiceChoice(patch: Partial<VoiceChoice>) {
  let prev: Record<string, unknown> = {}
  try {
    const raw = JSON.parse(localStorage.getItem(VOICE_STORE) || '{}') as unknown
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) prev = raw as Record<string, unknown>
  } catch { /* */ }
  localStorage.setItem(VOICE_STORE, JSON.stringify({ ...prev, ...patch }))
  window.dispatchEvent(new Event(TTS_VOICE_EVENT))
}
