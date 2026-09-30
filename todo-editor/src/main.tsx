import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { useApp } from './store'
import { markPreviewInteractive } from './lib/previewCache'

// Input and navigation have priority over speculative whole-sequence caching.
const interactionEvents = ['keydown', 'beforeinput', 'compositionupdate', 'pointerdown', 'wheel'] as const
const markInteraction = () => markPreviewInteractive(600)
for (const event of interactionEvents) document.addEventListener(event, markInteraction, { capture: true, passive: true })
if (import.meta.hot) import.meta.hot.dispose(() => {
  for (const event of interactionEvents) document.removeEventListener(event, markInteraction, true)
})

// VITE_EXPOSE_STORE=1 打的正式包也挂 store，给性能基准注入大工程用
if (import.meta.env.DEV || import.meta.env.VITE_EXPOSE_STORE) {
  ;(window as unknown as { __TODO__: typeof useApp }).__TODO__ = useApp
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
