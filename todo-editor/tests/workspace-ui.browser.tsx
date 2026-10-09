import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { useResize } from '../src/hooks/useResize'
import { Workspace, TimelineResizeHandle } from '../src/components/Workspace'
import { Timeline } from '../src/components/Timeline'
import { useApp } from '../src/store'
import App from '../src/App'

const results: { name: string; ok: boolean; error?: string; details?: unknown }[] = []
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => { flushSync(() => {}); resolve() }))
async function test(name: string, run: () => unknown | Promise<unknown>) {
  try { results.push({ name, ok: true, details: await run() }) }
  catch (e) { results.push({ name, ok: false, error: String(e) }) }
}
const host = document.createElement('div')
document.body.append(host)
const root = createRoot(host)
function pointer(target: EventTarget, type: string, x: number, id = 1, button = 0) {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: id, clientX: x, clientY: 100, button }))
}
async function run() {
  const deltas: number[] = []
  function Probe() { return <div id="resize-probe" onPointerDown={useResize(dx => deltas.push(dx))} /> }
  flushSync(() => root.render(<Probe />))
  const handle = document.getElementById('resize-probe')!
  handle.setPointerCapture = () => {}
  await test('120 pointer moves produce one frame update with the full distance', async () => {
    pointer(handle, 'pointerdown', 0)
    for (let x = 1; x <= 120; x++) pointer(window, 'pointermove', x)
    await frame()
    check(deltas.length === 1 && deltas[0] === 120, `updates=${deltas.length}, distance=${deltas.reduce((a,b) => a+b,0)}`)
    pointer(window, 'pointerup', 120)
    return { pointerEvents: 120, layoutUpdates: deltas.length, distance: deltas[0] }
  })
  await test('pointer cancellation flushes pending distance and stops the gesture', async () => {
    deltas.length = 0
    pointer(handle, 'pointerdown', 0)
    pointer(window, 'pointermove', 20)
    pointer(window, 'pointercancel', 20)
    pointer(window, 'pointermove', 80)
    await frame()
    check(deltas.reduce((a,b) => a+b,0) === 20, 'cancelled pointer continued resizing')
  })
  await test('other pointers and right mouse button cannot resize the active panel', async () => {
    deltas.length = 0
    pointer(handle, 'pointerdown', 0)
    pointer(window, 'pointermove', 50, 2)
    pointer(window, 'pointerup', 50, 2)
    pointer(window, 'pointermove', 15)
    pointer(window, 'pointerup', 15)
    await frame()
    check(deltas.reduce((a,b) => a+b,0) === 15, 'foreign pointer changed active gesture')
    deltas.length = 0
    pointer(handle, 'pointerdown', 0, 3, 2)
    pointer(window, 'pointermove', 50, 3)
    pointer(window, 'pointerup', 50, 3)
    await frame()
    check(deltas.length === 0, 'right button resized the panel')
  })
  await test('pointer release and window blur preserve pending displacement', async () => {
    deltas.length = 0
    pointer(handle, 'pointerdown', 0)
    pointer(window, 'pointermove', 8)
    pointer(window, 'pointerup', 8)
    check(deltas.reduce((a,b) => a+b,0) === 8, 'release lost the final displacement')
    pointer(handle, 'pointerdown', 8)
    pointer(window, 'pointermove', 20)
    window.dispatchEvent(new Event('blur'))
    pointer(window, 'pointermove', 100)
    await frame()
    check(deltas.reduce((a,b) => a+b,0) === 20, 'blur lost distance or continued resizing')
  })
  useApp.getState().seedDemo()
  useApp.getState().setLayout({ sidebarW: 248, rightW: 280, timelineH: 240, panelDock: { media: 'left', ai: 'tab' } })
  useApp.setState({ toast: null, playing: false, selectedClipIds: [], libraryTab: 'media', monitorView: 'edit' })
  host.style.cssText = 'height:100vh;width:100%;display:flex;flex-direction:column;padding:12px;gap:0'
  flushSync(() => root.render(<><Workspace /><TimelineResizeHandle /><Timeline /></>))
  await frame(); await frame()
  await test('panel separator supports keyboard resizing', async () => {
    const separator = host.querySelector<HTMLElement>('[data-testid="resize-sidebar"]')!
    check(separator.getAttribute('role') === 'separator' && separator.tabIndex === 0, 'separator is not keyboard reachable')
    const before = useApp.getState().layout.sidebarW
    flushSync(() => separator.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' })))
    await frame()
    check(useApp.getState().layout.sidebarW > before, 'arrow key did not resize')
  })
  await test('media navigation uses icon-only controls with hover names and selected state', () => {
    const tab = host.querySelector<HTMLElement>('[data-testid="lib-tab-media"]')!
    check(!tab.textContent?.trim(), 'media navigation has a permanent text label')
    check(tab.title === '媒体' && tab.getAttribute('aria-label') === '媒体', 'media tab lacks its hover or accessible name')
    check(tab.getAttribute('aria-pressed') === 'true', 'selected media tab is not exposed')
  })
  await test('scrollbars remain discoverable in long panels', () => {
    const content = host.querySelector<HTMLElement>('.inspector-body, .tab-row')!
    check(getComputedStyle(content).scrollbarWidth !== 'none', 'scrollbars are globally hidden')
  })
  await test('property sections disclose their state and reopen without changing clip values', async () => {
    const clip = useApp.getState().seq().clips[0]
    flushSync(() => useApp.getState().selectClips([clip.id]))
    await frame()
    const section = host.querySelector<HTMLElement>('.inspector-body .prop-section')!
    const button = section.querySelector<HTMLButtonElement>(':scope > button')!
    check(button.getAttribute('aria-expanded') === 'true', 'expanded property state is missing')
    const before = JSON.stringify(useApp.getState().seq().clips)
    flushSync(() => button.click())
    check(button.getAttribute('aria-expanded') === 'false' && !section.querySelector('.prop-section-body'), 'section did not collapse')
    flushSync(() => button.click())
    check(section.querySelector('.prop-section-body') && JSON.stringify(useApp.getState().seq().clips) === before, 'reopening changed property values')
    flushSync(() => useApp.getState().selectClips([]))
  })
  ;(window as any).workspaceCheck = async () => {
    await frame(); await frame()
    const monitor = host.querySelector<HTMLElement>('[data-testid="monitor-area"]')!.getBoundingClientRect()
    const inspector = host.querySelector<HTMLElement>('[data-testid="inspector-panel"]')
    const toggle = host.querySelector<HTMLElement>('[data-testid="inspector-toggle"]')
    return { width: innerWidth, monitorWidth: monitor.width, monitorHeight: monitor.height,
      inspectorVisible: !!inspector && getComputedStyle(inspector).display !== 'none', inspectorToggle: !!toggle,
      fits: monitor.width >= Math.min(240, innerWidth * .4) && monitor.right <= innerWidth && monitor.height > 100 && (innerWidth > 900 || !!toggle) }
  }
  ;(window as any).workspaceOverlayCheck = async () => {
    const index = results.length
    await test('compact resizing responds immediately even when saved width exceeds viewport cap', async () => {
      flushSync(() => useApp.getState().setLayout({ sidebarW: 420 }))
      await frame()
      const panel = host.querySelector<HTMLElement>('[data-testid="dock-left"]')!.parentElement!
      const before = panel.getBoundingClientRect().width
      const separator = host.querySelector<HTMLElement>('[data-testid="resize-sidebar"]')!
      flushSync(() => separator.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowLeft' })))
      await frame()
      check(panel.getBoundingClientRect().width < before, 'resizing has an invisible dead zone')
      useApp.getState().setLayout({ sidebarW: 248 })
    })
    await test('compact inspector opens and closes; short media panel remains scrollable', async () => {
    const toggle = host.querySelector<HTMLButtonElement>('[data-testid="inspector-toggle"]')!
    flushSync(() => toggle.click())
    await frame()
    const inspector = host.querySelector<HTMLElement>('[data-testid="inspector-panel"]')!
    check(inspector && inspector.getBoundingClientRect().right <= innerWidth, 'compact inspector is clipped')
    flushSync(() => inspector.querySelector<HTMLButtonElement>('[aria-label="收起属性栏"]')!.click())
    await frame()
    check(!host.querySelector('[data-testid="inspector-panel"]'), 'compact inspector did not close')
    const body = host.querySelector<HTMLElement>('.library-content')!
    body.scrollTop = body.scrollHeight
    check(body.scrollHeight <= body.clientHeight || body.scrollTop > 0, 'short media panel cannot scroll to its contents')
    })
    return results.slice(index)
  }
  ;(window as any).workspaceApp = async () => {
    host.style.cssText = 'height:100vh;width:100%;'
    useApp.setState({ started: true, toast: null, monitorView: 'edit', selectedClipIds: [useApp.getState().seq().clips.find(c => c.text)?.id ?? useApp.getState().seq().clips[0].id] })
    flushSync(() => root.render(<App />))
    await frame(); await frame()
    const index = results.length
    await test('separator arrow keys in the full app do not seek or nudge clips', async () => {
      const separator = host.querySelector<HTMLElement>('[data-testid="resize-sidebar"]')!
      const playhead = useApp.getState().playhead
      const clips = JSON.stringify(useApp.getState().seq().clips)
      const width = useApp.getState().layout.sidebarW
      flushSync(() => separator.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight', code: 'ArrowRight' })))
      flushSync(() => separator.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true })))
      await frame()
      check(useApp.getState().layout.sidebarW > width, 'separator did not resize')
      check(useApp.getState().playhead === playhead && JSON.stringify(useApp.getState().seq().clips) === clips, 'resize triggered timeline shortcuts')
    })
    await test('panel resize paints each frame and commits layout only when the gesture ends', async () => {
      const separator = host.querySelector<HTMLElement>('[data-testid="resize-sidebar"]')!
      separator.setPointerCapture = () => {}
      const panel = host.querySelector<HTMLElement>('[data-testid="dock-left"]')!.parentElement!
      const before = panel.getBoundingClientRect().width
      const origin = useApp.getState().layout.sidebarW
      let commits = 0
      const unsubscribe = useApp.subscribe((state, prev) => { if (state.layout !== prev.layout) commits++ })
      try {
        pointer(separator, 'pointerdown', 0, 41)
        for (let i = 1; i <= 12; i++) {
          pointer(window, 'pointermove', i * 4, 41)
          await frame()
        }
        const liveWidth = panel.getBoundingClientRect().width
        check(liveWidth >= before + 44, `visual resize lagged: ${before} -> ${liveWidth}`)
        check(commits === 0 && useApp.getState().layout.sidebarW === origin, `drag triggered ${commits} global layout commits`)
        pointer(window, 'pointerup', 48, 41)
        await frame()
        check(Number(commits) === 1, `release committed ${commits} times`)
        check(Math.abs(useApp.getState().layout.sidebarW - liveWidth) < 1, 'released width was not saved')
        return { frames: 12, commits }
      } finally {
        pointer(window, 'pointerup', 48, 41)
        unsubscribe()
        flushSync(() => useApp.getState().setLayout({ sidebarW: origin }))
      }
    })
    await test('clicking a capped panel separator without dragging preserves the saved size', async () => {
      const original = useApp.getState().layout.sidebarW
      const separator = host.querySelector<HTMLElement>('[data-testid="resize-sidebar"]')!
      const panel = host.querySelector<HTMLElement>('[data-testid="dock-left"]')!.parentElement!
      separator.setPointerCapture = () => {}
      const maxWidth = panel.style.maxWidth
      try {
        panel.style.maxWidth = '240px'
        flushSync(() => useApp.getState().setLayout({ sidebarW: 420 }))
        pointer(separator, 'pointerdown', 0, 45)
        pointer(window, 'pointerup', 0, 45)
        check(useApp.getState().layout.sidebarW === 420, 'clicking the separator overwrote the uncapped saved width')
        pointer(separator, 'pointerdown', 0, 46)
        pointer(window, 'pointermove', -12, 46)
        await frame()
        pointer(window, 'pointermove', 0, 46)
        pointer(window, 'pointerup', 0, 46)
        panel.style.maxWidth = maxWidth
        check(panel.getBoundingClientRect().width === 420, 'a reversible drag lost the original width when the viewport cap was removed')
      } finally {
        panel.style.maxWidth = maxWidth
        flushSync(() => useApp.getState().setLayout({ sidebarW: original }))
      }
    })
    await test('timeline resize flushes pending distance on cancellation and commits once', async () => {
      const separator = host.querySelector<HTMLElement>('[data-testid="resize-timeline"]')!
      separator.setPointerCapture = () => {}
      const original = useApp.getState().layout.timelineH
      let commits = 0
      const unsubscribe = useApp.subscribe((state, prev) => { if (state.layout !== prev.layout) commits++ })
      try {
        pointer(separator, 'pointerdown', 0, 42)
        window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 42, clientX: 0, clientY: 70 }))
        // Cancel before the next frame: the pending -30px must still be applied.
        window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 42 }))
        window.dispatchEvent(new Event('blur'))
        await frame()
        check(useApp.getState().layout.timelineH === original + 30, 'timeline lost pending movement')
        check(commits === 1, `cancel/blur committed ${commits} times`)
        const timeline = host.querySelector<HTMLElement>('[data-testid="timeline"]')!
        check(Math.abs(timeline.getBoundingClientRect().height - (original + 30)) < 1, 'timeline jumped on cancellation')
      } finally {
        unsubscribe()
        flushSync(() => useApp.getState().setLayout({ timelineH: original }))
      }
    })
    await test('right and bottom docks preview sizes, save on blur, and respect limits', async () => {
      const original = useApp.getState().layout
      try {
        for (const slot of ['right', 'bottom'] as const) {
          flushSync(() => useApp.getState().setLayout({ panelDock: { media: slot, ai: 'tab' }, rightW: 280, dockH: 220 }))
          await frame()
          const separator = host.querySelector<HTMLElement>(`[data-testid="resize-${slot === 'right' ? 'right' : 'dock-bottom'}"]`)!
          separator.setPointerCapture = () => {}
          const key = slot === 'right' ? 'rightW' : 'dockH'
          const dimension = slot === 'right' ? 'width' : 'height'
          const panel = slot === 'right' ? host.querySelector<HTMLElement>('[data-testid="dock-right"]')!.parentElement! : host.querySelector<HTMLElement>('[data-testid="dock-bottom"]')!
          const before = panel.getBoundingClientRect()[dimension]
          pointer(separator, 'pointerdown', 0, 43)
          window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 43, clientX: slot === 'right' ? -24 : 0, clientY: slot === 'bottom' ? 76 : 100 }))
          await frame()
          check(Math.abs(panel.getBoundingClientRect()[dimension] - (before + 24)) < 1, `${slot} dock did not preview movement`)
          check(useApp.getState().layout[key] === before, `${slot} dock wrote global state while dragging`)
          window.dispatchEvent(new Event('blur'))
          await frame()
          check(useApp.getState().layout[key] === before + 24, `${slot} dock did not save on blur`)
          pointer(separator, 'pointerdown', 0, 44)
          window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 44, clientX: slot === 'right' ? -2000 : 0, clientY: slot === 'bottom' ? -1900 : 100 }))
          pointer(window, 'pointerup', -2000, 44)
          await frame()
          check(useApp.getState().layout[key] === (slot === 'right' ? 420 : 360), `${slot} dock exceeded its maximum`)
        }
      } finally {
        window.dispatchEvent(new Event('blur'))
        flushSync(() => useApp.getState().setLayout(original))
        await frame()
      }
    })
    return results.slice(index)
  }
  return { results, failed: results.filter(r => !r.ok).length }
}
;(window as any).workspaceTests = run()
