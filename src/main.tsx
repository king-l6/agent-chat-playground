/**
 * 应用入口：把 <App /> 挂到 index.html 的 #root 上
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { AuthGate } from './components/AuthGate'
import { installUserHeader } from './lib/userProfile'
import './index.css'

installUserHeader()

// createRoot：React 18+ 创建根节点；StrictMode 开发期会多跑一遍副作用帮查问题
// AuthGate 包在最外层：服务端没配令牌时它直接放行，所以桌面壳 / 本地开发行为不变。
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </StrictMode>,
)
