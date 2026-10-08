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
  build: { rollupOptions: { input: { main: 'index.html', chalk: 'chalk-render.html' } } },
  server: {
    host: '127.0.0.1',
    // 单独 npm run dev 固定 5173。electron:dev 会另外分配空闲端口并覆盖这里。
    port: 5173,
    strictPort: true,
    // 工具包里的 .html 文档 / 原生构建产物变动会触发整页刷新
    watch: { ignored: ['**/.native-tools/**', '**/native/**'] },
  },
})
