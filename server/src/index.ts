/**
 * Express 入口：健康检查 + SSE 聊天接口
 * 真正的 Agent 逻辑在 agent.ts
 */
import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import multer from 'multer'
import { resolveLlmConfig, runAgentChat } from './agent.js'
import { runWorkflow } from './workflow.js'
import {
  UPLOAD_DIR,
  commitUpload,
  decodeMulterName,
  ensureDataDirs,
  listDocuments,
  tempUploadFilename,
} from './knowledge.js'
import {
  deleteUploadedFile,
  ensureIndex,
  getRagStatus,
  ingestUploadedDoc,
  listIndexRows,
} from './retrieve.js'
import type { ChatMessageInput, SseEvent } from './types.js'

// ESM 下没有 __dirname，用当前模块 URL 推出来
const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 加载仓库根目录 .env；override:true 避免被 shell 里旧 OPENAI_* 盖掉
const portFromShell = process.env.PORT
dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: true })

const app = express()
const PORT = Number(portFromShell || process.env.PORT || 8790)

app.use(
  cors({
    origin: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  }),
)
app.use(express.json({ limit: '1mb' }))

ensureDataDirs()

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, _file, cb) => {
      cb(null, tempUploadFilename())
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
})

/** GET /api/health：前端徽章用，看 live/mock、模型名、RAG 索引 */
app.get('/api/health', (_req, res) => {
  const { apiKey, model } = resolveLlmConfig()
  res.json({
    ok: true,
    mode: apiKey ? 'live' : 'mock',
    model,
    rag: getRagStatus(),
  })
})

app.get('/api/knowledge', (_req, res) => {
  const rag = getRagStatus()
  res.json({
    rag,
    documents: listDocuments(),
    index: {
      model: rag.embedding,
      dim: rag.dim,
      chunks: listIndexRows(),
    },
  })
})

/**
 * POST /api/knowledge/upload
 * 表单字段名 file，仅 .md / .txt。每次上传新建文档，不按文件名覆盖。
 */
app.post('/api/knowledge/upload', upload.single('file'), async (req, res) => {
  const file = req.file
  if (!file) {
    res.status(400).json({ error: '请选择文件' })
    return
  }
  const original = decodeMulterName(file.originalname)
  if (!/\.(md|txt|markdown)$/i.test(original)) {
    fs.unlinkSync(file.path)
    res.status(400).json({ error: '仅支持 .md / .txt' })
    return
  }
  try {
    const rec = commitUpload(file.path, path.basename(original))
    await ingestUploadedDoc(rec)
    res.json({
      ok: true,
      filename: rec.originalName,
      docId: rec.id,
      rag: getRagStatus(),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})

app.delete('/api/knowledge/docs/:docId', async (req, res) => {
  try {
    await deleteUploadedFile(decodeURIComponent(String(req.params.docId)))
    res.json({ ok: true, rag: getRagStatus(), documents: listDocuments() })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(404).json({ error: message })
  }
})

/**
 * POST /api/workflow/run
 * body: { question, pipeline: [{ id, kind, expression? }] }
 */
app.post('/api/workflow/run', async (req, res) => {
  const question = String(req.body?.question ?? '').trim()
  if (!question) {
    res.status(400).json({ error: 'question 不能为空' })
    return
  }
  const raw = req.body?.pipeline
  const pipeline = Array.isArray(raw)
    ? raw
        .map((item: unknown) => {
          if (!item || typeof item !== 'object') return null
          const rec = item as { id?: unknown; kind?: unknown; expression?: unknown }
          const kind = rec.kind
          if (kind !== 'search' && kind !== 'answer' && kind !== 'calc') return null
          return {
            id: String(rec.id ?? kind),
            kind,
            expression: rec.expression != null ? String(rec.expression) : undefined,
          }
        })
        .filter((s): s is { id: string; kind: 'search' | 'answer' | 'calc'; expression?: string } => s != null)
    : [
        { id: 'search', kind: 'search' as const },
        { id: 'answer', kind: 'answer' as const },
      ]
  if (pipeline.length === 0) {
    res.status(400).json({ error: '请从「提问」连出至少一步' })
    return
  }
  try {
    const result = await runWorkflow(question, pipeline)
    res.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
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

const distDir = path.resolve(__dirname, '../../dist')
const indexHtml = path.join(distDir, 'index.html')
if (fs.existsSync(indexHtml)) {
  app.use(express.static(distDir))
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next()
      return
    }
    if (req.path.startsWith('/api')) {
      next()
      return
    }
    res.sendFile(indexHtml)
  })
}

app.listen(PORT, '0.0.0.0', () => {
  const { apiKey, model } = resolveLlmConfig()
  const mode = apiKey ? 'live' : 'mock'
  console.log(`[agent-chat] http://0.0.0.0:${PORT}  mode=${mode}  model=${model}`)
  void ensureIndex().catch((err) => {
    console.warn('[rag] 启动索引失败，先走关键词:', err)
  })
})
