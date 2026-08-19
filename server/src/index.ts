/**
 * Express 入口：健康检查 + SSE 聊天接口
 * 真正的 Agent 逻辑在 agent.ts
 */
import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveLlmConfig, runAgentChat } from './agent.js'
import type { ChatMessageInput, SseEvent } from './types.js'

// ESM 下没有 __dirname，用当前模块 URL 推出来
const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 加载仓库根目录 .env；override:true 避免被 shell 里旧 OPENAI_* 盖掉
dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: true })

const app = express()
const PORT = Number(process.env.PORT || 8790)

// 允许前端跨域（开发时 Vite 5176 → 后端 8790）
app.use(
  cors({
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
  }),
)
// 解析 JSON body，限制 1MB
app.use(express.json({ limit: '1mb' }))

/** GET /api/health：前端徽章用，看 live/mock 和模型名 */
app.get('/api/health', (_req, res) => {
  const { apiKey, model } = resolveLlmConfig()
  res.json({
    ok: true,
    mode: apiKey ? 'live' : 'mock',
    model,
  })
})

/**
 * POST /api/chat：开一条 SSE，把 Agent 事件不断 write 给前端
 * Content-Type: text/event-stream
 */
app.post('/api/chat', async (req, res) => {
  const messages = (req.body?.messages ?? []) as ChatMessageInput[]
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'messages 不能为空' })
    return
  }

  // 只保留合法 user/assistant，并截断过长 content，防滥用
  const normalized = messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }))

  if (normalized.length === 0) {
    res.status(400).json({ error: '没有有效 messages' })
    return
  }

  // —— 切换成 SSE 响应头 ——
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  // 告诉 nginx 类反向代理不要缓冲，否则前端会「一下出来一大段」
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  let closed = false
  // 注意：不要用 req.on('close') —— POST body 读完就可能触发，会误停 SSE
  res.on('close', () => {
    closed = true
  })

  /** 写一条 SSE：data: {...}\n\n */
  const send = (event: SseEvent) => {
    if (closed || res.writableEnded) return
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  try {
    // 把 send 交给 Agent：它负责推 meta / text / tool / done
    await runAgentChat({ messages: normalized, send })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    send({ type: 'error', message })
    send({ type: 'done' })
  } finally {
    if (!closed) res.end()
  }
})

app.listen(PORT, () => {
  const { apiKey, model } = resolveLlmConfig()
  const mode = apiKey ? 'live' : 'mock'
  console.log(`[agent-chat] http://127.0.0.1:${PORT}  mode=${mode}  model=${model}`)
})
