import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { useApp } from './store'

if (import.meta.env.DEV) {
  ;(window as unknown as { __TODO__: typeof useApp }).__TODO__ = useApp
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

