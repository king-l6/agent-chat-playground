/**
 * Express 入口：健康检查 + SSE 聊天接口
 * 真正的 Agent 逻辑在 agent.ts
 */
import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import multer from 'multer'
import { resolveLlmConfig, runAgentChat } from './agent.js'
import { publicLlmSettings, saveLlmSettings, type LlmMode } from './settings.js'
import {
  applyGate,
  changeSeat,
  currentRun,
  runDeliveryTurn,
  updatePrd,
} from './delivery/runtime.js'
import { GateError, type GateAction, type Seat } from './delivery/types.js'
import { listSkills } from './skills.js'
import { runWorkflow, type PipelineStep } from './workflow.js'
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
import { getWorkspaceRoot, setWorkspaceRoot } from './workspace.js'
import { REPO_ROOT } from './paths.js'

dotenv.config({ path: path.join(REPO_ROOT, '.env'), override: true })
if (process.env.PLAYGROUND_DATA) {
  dotenv.config({
    path: path.join(process.env.PLAYGROUND_DATA, '.env'),
    override: true,
  })
}

const app = express()
const PORT = Number(process.env.PLAYGROUND_PORT || process.env.PORT || 8790)

// 允许前端跨域（开发时 Vite 5176 → 后端 8790）
app.use(
  cors({
    origin: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  }),
)
// 解析 JSON body，限制 1MB
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
    skills: listSkills(),
    workspace: { root: getWorkspaceRoot() },
  })
})

app.get('/api/settings', (_req, res) => {
  res.json(publicLlmSettings())
})

app.put('/api/settings', (req, res) => {
  const mode = req.body?.mode
  if (mode !== 'mock' && mode !== 'live') {
    res.status(400).json({ error: 'mode 必须是 mock 或 live' })
    return
  }
  try {
    const saved = saveLlmSettings({
      mode: mode as LlmMode,
      apiKey: typeof req.body?.apiKey === 'string' ? req.body.apiKey : undefined,
      baseURL: typeof req.body?.baseURL === 'string' ? req.body.baseURL : undefined,
      model: typeof req.body?.model === 'string' ? req.body.model : undefined,
    })
    res.json(saved)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(400).json({ error: message })
  }
})

function parseSeat(raw: unknown): Seat | null {
  return raw === 'pm' || raw === 'dev' || raw === 'qa' ? raw : null
}

app.get('/api/delivery', (_req, res) => {
  res.json(currentRun())
})

app.put('/api/delivery/seat', (req, res) => {
  const seat = parseSeat(req.body?.seat)
  if (!seat) {
    res.status(400).json({ error: 'seat 必须是 pm / dev / qa' })
    return
  }
  res.json(changeSeat(seat))
})

app.put('/api/delivery/prd', (req, res) => {
  const actor = parseSeat(req.body?.actor)
  if (!actor) {
    res.status(400).json({ error: 'actor 必须是 pm / dev / qa' })
    return
  }
  try {
    res.json(
      updatePrd(actor, {
        title: typeof req.body?.title === 'string' ? req.body.title : undefined,
        oneLiner: typeof req.body?.oneLiner === 'string' ? req.body.oneLiner : undefined,
        body: typeof req.body?.body === 'string' ? req.body.body : undefined,
        acceptance: Array.isArray(req.body?.acceptance) ? req.body.acceptance : undefined,
      }),
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(err instanceof GateError ? 400 : 500).json({
      error: message,
      gate: err instanceof GateError ? err.gate : undefined,
    })
  }
})

app.post('/api/delivery/gate', (req, res) => {
  const actor = parseSeat(req.body?.actor)
  const action = req.body?.action as GateAction
  if (!actor) {
    res.status(400).json({ error: 'actor 必须是 pm / dev / qa' })
    return
  }
  try {
    res.json(
      applyGate(actor, action, {
        reason: typeof req.body?.reason === 'string' ? req.body.reason : undefined,
        questions: Array.isArray(req.body?.questions) ? req.body.questions.map(String) : undefined,
      }),
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(err instanceof GateError ? 400 : 500).json({
      error: message,
      gate: err instanceof GateError ? err.gate : undefined,
    })
  }
})

app.post('/api/delivery/turn', async (req, res) => {
  const actor = parseSeat(req.body?.actor)
  const message = typeof req.body?.message === 'string' ? req.body.message : ''
  if (!actor) {
    res.status(400).json({ error: 'actor 必须是 pm / dev / qa' })
    return
  }
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()
  let closed = false
  res.on('close', () => {
    closed = true
  })
  const send = (event: SseEvent) => {
    if (closed || res.writableEnded) return
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }
  try {
    await runDeliveryTurn(actor, message, send)
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err)
    if (err instanceof GateError) {
      send({ type: 'gate_blocked', gate: err.gate, message: messageText })
    } else {
      send({ type: 'error', message: messageText })
    }
    send({ type: 'done' })
  } finally {
    if (!closed) res.end()
  }
})

app.get('/api/workspace', (_req, res) => {
  res.json({ root: getWorkspaceRoot() })
})

app.post('/api/workspace', (req, res) => {
  const raw = String(req.body?.root ?? '').trim()
  if (!raw) {
    res.status(400).json({ error: 'root 不能为空' })
    return
  }
  try {
    const root = setWorkspaceRoot(raw)
    res.json({ ok: true, root })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(400).json({ error: message })
  }
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
  const pipeline: PipelineStep[] = Array.isArray(raw)
    ? raw
        .map((item: unknown): PipelineStep | null => {
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
        .filter((s): s is PipelineStep => s != null)
    : [
        { id: 'search', kind: 'search' },
        { id: 'answer', kind: 'answer' },
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

export function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = app.listen(PORT, '127.0.0.1', () => {
      const { apiKey, model } = resolveLlmConfig()
      const mode = apiKey ? 'live' : 'mock'
      console.log(`[agent-chat] http://127.0.0.1:${PORT}  mode=${mode}  model=${model}`)
      void ensureIndex().catch((err) => {
        console.warn('[rag] 启动索引失败，先走关键词:', err)
      })
      resolve()
    })
    server.on('error', reject)
  })
}

if (process.env.PLAYGROUND_EMBEDDED !== '1') {
  void startServer()
}
