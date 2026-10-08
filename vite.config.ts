import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: process.env.ELECTRON_BUILD === '1' ? './' : '/',
  server: {
    host: '127.0.0.1',
    port: 5176,
    strictPort: true,
    headers: {
      // 交付页的产物预览要在浏览器里跑 WebContainer，它要 SharedArrayBuffer，必须先跨源隔离。
      // 用 credentialless 而不是文档主推的 require-corp：Monaco 是从 cdn.jsdelivr.net 拉的
      // 跨域脚本与 worker，聊天页还有一堆 no-cors 的远程图，require-corp 会把它们全裂掉。
      // 代价是 Firefox 不支持 credentialless —— 预览在 Firefox 下落降级提示，其余功能照常。
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
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
