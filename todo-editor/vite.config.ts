import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { createAiMiddleware, kickAiWorker } from './server/aiHttp.mjs'

function aiApi(): Plugin {
  return {
    name: 'todo-ai-api',
    configureServer(server) {
      kickAiWorker()
      server.middlewares.use(createAiMiddleware())
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), aiApi()],
  base: './',
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
})
