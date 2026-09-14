import { desktop } from './desktop'
import { popoutUrl } from './storeSync'

const POPOUT_NAME = 'todo-timeline-popout'

let browserPopout: Window | null = null
let pollTimer: number | null = null

function clearPoll() {
  if (pollTimer != null) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
}

/** Electron：await IPC。浏览器：必须在点击同步栈里 window.open。 */
export async function openTimelinePopoutElectron(): Promise<boolean> {
  const d = desktop()
  if (!d?.openTimelineWindow) return false
  try {
    await d.openTimelineWindow()
    return true
  } catch {
    return false
  }
}

/**
 * 浏览器路径：同步 window.open（勿先 await）。
 * Electron 请用 openTimelinePopoutElectron。
 */
export function openTimelinePopoutBrowser(): { ok: boolean } {
  clearPoll()
  const w = window.open(popoutUrl(), POPOUT_NAME, 'popup=yes,width=1280,height=420,left=80,top=120')
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
        useApp.setState({ timelineFloat: false, timelineFloatKind: null })
      })
    }
  }, 500)
  return { ok: true }
}

export function closeTimelinePopout() {
  clearPoll()
  const d = desktop()
  if (d?.closeTimelineWindow) {
    void d.closeTimelineWindow()
    return
  }
  if (browserPopout && !browserPopout.closed) {
    browserPopout.close()
    browserPopout = null
  }
}
