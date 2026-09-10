/**
 * 应用入口：把 <App /> 挂到 index.html 的 #root 上
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

// createRoot：React 18+ 创建根节点；StrictMode 开发期会多跑一遍副作用帮查问题
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
