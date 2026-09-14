import { desktop } from './desktop'
import { aiPopoutUrl } from './storeSync'

const POPOUT_NAME = 'todo-ai-popout'

let browserPopout: Window | null = null
let pollTimer: number | null = null

function clearPoll() {
  if (pollTimer != null) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
}

export async function openAiPopoutElectron(): Promise<boolean> {
  const d = desktop()
  if (!d?.openAiWindow) return false
  try {
    await d.openAiWindow()
    return true
  } catch {
    return false
  }
}

/** 浏览器：同步 window.open（勿先 await） */
export function openAiPopoutBrowser(): { ok: boolean } {
  clearPoll()
  const w = window.open(aiPopoutUrl(), POPOUT_NAME, 'popup=yes,width=420,height=720,left=100,top=80')
  if (!w || w.closed || (w.outerWidth === 0 && w.outerHeight === 0)) {
    try { w?.close() } catch { /* */ }
    return { ok: false }
  }
  browserPopout = w
  try { w.focus() } catch { /* */ }
  pollTimer = window.setInterval(() => {
    if (browserPopout && browserPopout.closed) {
      clearPoll()
      browserPopout = null
      void import('../store').then(({ useApp }) => {
        useApp.setState({ aiFloat: false, aiFloatKind: null })
      })
    }
  }, 500)
  return { ok: true }
}

export function closeAiPopout() {
  clearPoll()
  const d = desktop()
  if (d?.closeAiWindow) {
    void d.closeAiWindow()
    return
  }
  if (browserPopout && !browserPopout.closed) {
    browserPopout.close()
    browserPopout = null
  }
}
