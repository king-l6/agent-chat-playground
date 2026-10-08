import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: process.env.ELECTRON_BUILD === '1' ? './' : '/',
  server: {
    host: '127.0.0.1',
    port: 5176,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8790',
        changeOrigin: true,
        // 代码团队 / 长 SSE 常超过默认代理超时，否则收尾会变 Network Error
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },
})
