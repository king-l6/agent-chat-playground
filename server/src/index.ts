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
  publicDelivery,
  runDeliveryTurn,
  startNewRun,
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
import { browseDisk, getWorkspaceRoot, setWorkspaceRoot, suggestedHere } from './workspace.js'
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
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
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

/* ===================== 一键生成美女图片 ===================== */

type BeautyImagePalette = {
  from: string
  to: string
  hair: string
  cloth: string
}

type BeautyImageStyle = {
  id: string
  name: string
  description: string
  tags: string[]
  prompt: string
  palette: BeautyImagePalette
}

type BeautyImageSize = {
  id: string
  width: number
  height: number
}

type BeautyImageRecord = {
  id: string
  prompt: string
  styleId: string
  styleName: string
  width: number
  height: number
  createdAt: number
}

type BeautyGenerateInput = {
  prompt: string
  styleId: string
  size: string
  host: string
  protocol: string
}

const BEAUTY_STYLE_DEFAULT: BeautyImageStyle = {
  id: 'realistic',
  name: '清新人像写真',
  description: '柔和自然光 + 浅景深虚化，适合头像与壁纸',
  tags: ['写真', '自然光', '高清'],
  prompt: '一位气质清新的年轻女性人像写真，柔和自然光，浅景深虚化背景，皮肤质感细腻，高清细节，专业摄影',
  palette: { from: '#f9c9dd', to: '#8a76d9', hair: '#3b2a3f', cloth: '#ffe7f1' },
}

const BEAUTY_IMAGE_STYLES: BeautyImageStyle[] = [
  BEAUTY_STYLE_DEFAULT,
  {
    id: 'guofeng',
    name: '东方古风',
    description: '汉服园林意境，水墨与暖金配色',
    tags: ['古风', '汉服', '水墨'],
    prompt: '一位身着汉服的东方女子，古典园林背景，水墨意境，暖金色柔光，优雅端庄，国风插画质感',
    palette: { from: '#f7e2c2', to: '#7b5a3a', hair: '#241a16', cloth: '#fff4d8' },
  },
  {
    id: 'street',
    name: '都市街拍',
    description: '城市街景抓拍，胶片颗粒与时尚穿搭',
    tags: ['街拍', '胶片', '时尚'],
    prompt: '都市街头抓拍，时尚穿搭的年轻女性，自然行走姿态，胶片颗粒质感，暖色路灯与霓虹背景',
    palette: { from: '#ffd7a1', to: '#2f3b6b', hair: '#241d1a', cloth: '#ffb4a2' },
  },
  {
    id: 'ins',
    name: 'INS 清新风',
    description: '明亮通透的日系小清新色调',
    tags: ['小清新', '日系', '通透'],
    prompt: '日系小清新风格的女生，明亮通透的色调，蓝天白云与绿植背景，自然微笑，杂志封面质感',
    palette: { from: '#cdeffd', to: '#7fc9f0', hair: '#33261f', cloth: '#ffffff' },
  },
  {
    id: 'cyber',
    name: '赛博霓虹',
    description: '未来都市霓虹光效，科技感十足',
    tags: ['赛博', '霓虹', '未来'],
    prompt: '未来都市赛博朋克风格的女生，霓虹灯光映照，机械感配饰，蓝紫色调，电影级光影',
    palette: { from: '#2b1a52', to: '#0b1030', hair: '#f472b6', cloth: '#22d3ee' },
  },
]

const BEAUTY_SIZE_DEFAULT: BeautyImageSize = { id: '1024x1024', width: 1024, height: 1024 }

const BEAUTY_IMAGE_SIZES: BeautyImageSize[] = [
  BEAUTY_SIZE_DEFAULT,
  { id: '768x1152', width: 768, height: 1152 },
  { id: '1152x768', width: 1152, height: 768 },
]

const BEAUTY_PROMPT_MAX_LENGTH = 200
const BEAUTY_GENERATE_TIMEOUT_MS = 45000
const BEAUTY_MOCK_DELAY_MS = 420
const BEAUTY_RENDER_TTL_MS = 6 * 60 * 60 * 1000

/** 命中即拦截：色情 / 擦边、未成年人、暴力血腥、真人换脸等 */
const BEAUTY_BLOCK_WORDS: string[] = [
  '裸',
  '色情',
  '情色',
  '淫',
  '脱衣',
  '走光',
  '露点',
  '露乳',
  '巨乳',
  '性爱',
  '做爱',
  '性交',
  '口交',
  '成人视频',
  '成人内容',
  '黄图',
  '黄色网站',
  '幼女',
  '未成年',
  '小学生',
  '儿童色情',
  '萝莉',
  '血腥',
  '尸体',
  '自杀',
  '虐待',
  '换脸',
  'deepfake',
  '真人照片',
  '明星脸',
  'nude',
  'naked',
  'nsfw',
  'porn',
  'hentai',
  'xxx',
  'sex',
]

const BEAUTY_BLOCK_PATTERNS: RegExp[] = [
  /(?:真人|明星|名人|公众人物|网红|主播)[^。！？\s]{0,8}(?:换脸|肖像|写真|照片|脸)/,
  /(?:儿童|小孩|幼童|小学生|未成年|幼女|萝莉)[^。！？\s]{0,8}(?:裸|性|色情|内衣|写真)/,
]

const BEAUTY_RENDER_CACHE = new Map<string, BeautyImageRecord>()

/** 内容安全校验：返回 blocked 为 true 时不产出任何图片 */
function checkBeautyPrompt(text: string): { blocked: boolean; reason: string } {
  const normalized = text.toLowerCase()
  const hit = BEAUTY_BLOCK_WORDS.find((word) => normalized.includes(word.toLowerCase()))
  if (hit) {
    return {
      blocked: true,
      reason: `提示词包含违规内容「${hit}」，已被内容安全拦截，本次未生成图片，请修改后重试。`,
    }
  }
  const matched = BEAUTY_BLOCK_PATTERNS.some((pattern) => pattern.test(text))
  if (matched) {
    return {
      blocked: true,
      reason: '提示词疑似涉及真人肖像、换脸或未成年人相关内容，已被内容安全拦截，本次未生成图片。',
    }
  }
  return { blocked: false, reason: '' }
}

function normalizeBeautySize(sizeId: string): BeautyImageSize {
  return BEAUTY_IMAGE_SIZES.find((item) => item.id === sizeId) ?? BEAUTY_SIZE_DEFAULT
}

function hashBeautySeed(input: string): number {
  let hash = 2166136261
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function createBeautyRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function pruneBeautyCache(): void {
  const now = Date.now()
  BEAUTY_RENDER_CACHE.forEach((record, key) => {
    if (now - record.createdAt > BEAUTY_RENDER_TTL_MS) {
      BEAUTY_RENDER_CACHE.delete(key)
    }
  })
}

/** 离线渲染：输出一张可访问、可下载的 SVG 图片（接入真实图像模型时替换此处即可） */
function buildBeautySvg(record: BeautyImageRecord): string {
  const style = BEAUTY_IMAGE_STYLES.find((item) => item.id === record.styleId) ?? BEAUTY_STYLE_DEFAULT
  const random = createBeautyRandom(hashBeautySeed(record.id))
  const round = (value: number): number => Math.round(value)
  const width = record.width
  const height = record.height
  const base = Math.min(width, height)
  const cx = round(width / 2)
  const headRx = round(base * 0.12)
  const headRy = round(headRx * 1.16)
  const headCy = round(height * 0.34)
  const shoulderTop = headCy + headRy + round(base * 0.05)
  const shoulderSpan = round(base * 0.42)
  const glowX = round(cx + (random() - 0.5) * base * 0.24)
  const glowY = round(height * 0.26)
  const hairSweep = round(base * 0.04 + random() * base * 0.05)
  const strokeWidth = Math.max(2, round(base * 0.01))

  const sparkles = Array.from({ length: 16 }, () => {
    const x = round(random() * width)
    const y = round(random() * height * 0.82)
    const radius = round(2 + random() * 5)
    const opacity = (0.12 + random() * 0.35).toFixed(2)
    return `<circle cx="${x}" cy="${y}" r="${radius}" fill="#ffffff" opacity="${opacity}" />`
  }).join('')

  const body = [
    `M ${round(cx - shoulderSpan)} ${height}`,
    `C ${round(cx - shoulderSpan)} ${round(shoulderTop + base * 0.2)} ${round(cx - base * 0.2)} ${shoulderTop} ${cx} ${shoulderTop}`,
    `C ${round(cx + base * 0.2)} ${shoulderTop} ${round(cx + shoulderSpan)} ${round(shoulderTop + base * 0.2)} ${round(cx + shoulderSpan)} ${height}`,
    'Z',
  ].join(' ')

  const hair = [
    `M ${round(cx - headRx * 1.16)} ${round(headCy + headRy * 0.55)}`,
    `C ${round(cx - headRx * 1.4)} ${round(headCy - headRy * 1.6)} ${round(cx + headRx * 1.4)} ${round(headCy - headRy * 1.6)} ${round(cx + headRx * 1.16)} ${round(headCy + headRy * 0.55)}`,
    `C ${round(cx + headRx * 0.9)} ${round(headCy - headRy * 0.1)} ${round(cx - headRx * 0.9)} ${round(headCy - headRy * 0.1)} ${round(cx - headRx * 1.16)} ${round(headCy + headRy * 0.55)}`,
    'Z',
  ].join(' ')

  const fringe = [
    `M ${round(cx - headRx * 0.2)} ${round(headCy - headRy * 1.15)}`,
    `Q ${cx} ${round(headCy - headRy * 1.35 - hairSweep)} ${round(cx + headRx * 0.3)} ${round(headCy - headRy * 0.95)}`,
  ].join(' ')

  const smile = [
    `M ${round(cx - headRx * 0.24)} ${round(headCy + headRy * 0.42)}`,
    `Q ${cx} ${round(headCy + headRy * 0.62)} ${round(cx + headRx * 0.24)} ${round(headCy + headRy * 0.42)}`,
  ].join(' ')

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    '  <defs>',
    '    <linearGradient id="beautyBg" x1="0%" y1="0%" x2="100%" y2="100%">',
    `      <stop offset="0%" stop-color="${style.palette.from}" />`,
    `      <stop offset="100%" stop-color="${style.palette.to}" />`,
    '    </linearGradient>',
    '    <radialGradient id="beautyGlow" cx="50%" cy="35%" r="55%">',
    '      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.55" />',
    '      <stop offset="100%" stop-color="#ffffff" stop-opacity="0" />',
    '    </radialGradient>',
    '  </defs>',
    `  <rect width="${width}" height="${height}" fill="url(#beautyBg)" />`,
    `  <ellipse cx="${glowX}" cy="${glowY}" rx="${round(base * 0.54)}" ry="${round(base * 0.48)}" fill="url(#beautyGlow)" />`,
    `  ${sparkles}`,
    `  <path d="${body}" fill="${style.palette.cloth}" opacity="0.94" />`,
    `  <rect x="${round(cx - headRx * 0.22)}" y="${round(headCy + headRy * 0.55)}" width="${round(headRx * 0.44)}" height="${round(base * 0.1)}" fill="#f4c9ad" />`,
    `  <ellipse cx="${cx}" cy="${headCy}" rx="${headRx}" ry="${headRy}" fill="#f8d6bd" />`,
    `  <path d="${hair}" fill="${style.palette.hair}" />`,
    `  <path d="${fringe}" stroke="${style.palette.hair}" stroke-width="${round(headRx * 0.16)}" fill="none" stroke-linecap="round" />`,
    `  <ellipse cx="${round(cx - headRx * 0.38)}" cy="${round(headCy + headRy * 0.02)}" rx="${round(headRx * 0.11)}" ry="${round(headRy * 0.07)}" fill="#3b2b33" />`,
    `  <ellipse cx="${round(cx + headRx * 0.38)}" cy="${round(headCy + headRy * 0.02)}" rx="${round(headRx * 0.11)}" ry="${round(headRy * 0.07)}" fill="#3b2b33" />`,
    `  <path d="${smile}" stroke="#c7557a" stroke-width="${strokeWidth}" fill="none" stroke-linecap="round" />`,
    `  <text x="${cx}" y="${round(height - base * 0.05)}" font-family="system-ui, -apple-system, 'PingFang SC', sans-serif" font-size="${round(base * 0.036)}" fill="#ffffff" fill-opacity="0.86" text-anchor="middle">AI IMAGE · ${style.name}</text>`,
    '</svg>',
  ].join('\n')
}

function createBeautyRecord(
  style: BeautyImageStyle,
  prompt: string,
  width: number,
  height: number,
): BeautyImageRecord {
  const id = `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const record: BeautyImageRecord = {
    id,
    prompt,
    styleId: style.id,
    styleName: style.name,
    width,
    height,
    createdAt: Date.now(),
  }
  BEAUTY_RENDER_CACHE.set(id, record)
  pruneBeautyCache()
  return record
}

async function runBeautyGeneration(
  style: BeautyImageStyle,
  prompt: string,
  width: number,
  height: number,
): Promise<BeautyImageRecord> {
  // 模拟图像模型推理耗时；接入真实模型时替换为实际请求
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve()
    }, BEAUTY_MOCK_DELAY_MS)
  })
  return createBeautyRecord(style, prompt, width, height)
}

function withBeautyTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('BEAUTY_IMAGE_TIMEOUT'))
    }, timeoutMs)
    task.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

async function handleBeautyGenerate(
  input: BeautyGenerateInput,
  respond: (status: number, body: Record<string, unknown>) => void,
): Promise<void> {
  const rawPrompt = input.prompt.trim()
  if (rawPrompt.length > BEAUTY_PROMPT_MAX_LENGTH) {
    respond(400, { error: `描述请控制在 ${BEAUTY_PROMPT_MAX_LENGTH} 字以内`, code: 'PROMPT_TOO_LONG' })
    return
  }

  const style = BEAUTY_IMAGE_STYLES.find((item) => item.id === input.styleId) ?? BEAUTY_STYLE_DEFAULT
  const size = normalizeBeautySize(input.size)
  const finalPrompt = rawPrompt.length > 0 ? `${style.prompt}；补充描述：${rawPrompt}` : style.prompt

  const safety = checkBeautyPrompt(`${rawPrompt} ${finalPrompt}`)
  if (safety.blocked) {
    respond(400, { error: safety.reason, code: 'CONTENT_BLOCKED', blocked: true })
    return
  }

  try {
    const record = await withBeautyTimeout(
      runBeautyGeneration(style, finalPrompt, size.width, size.height),
      BEAUTY_GENERATE_TIMEOUT_MS,
    )
    const path = `/api/image/render/${record.id}`
    const host = input.host.length > 0 ? input.host : 'localhost'
    const absoluteUrl = `${input.protocol}://${host}${path}`
    respond(200, {
      ok: true,
      id: record.id,
      url: absoluteUrl,
      imageUrl: absoluteUrl,
      path,
      prompt: record.prompt,
      userPrompt: rawPrompt,
      styleId: style.id,
      styleName: style.name,
      styleTags: style.tags,
      width: record.width,
      height: record.height,
      createdAt: new Date(record.createdAt).toISOString(),
      safety: { passed: true, blocked: false },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (message === 'BEAUTY_IMAGE_TIMEOUT') {
      respond(504, { error: '图片生成超时，请稍后重试', code: 'IMAGE_TIMEOUT' })
      return
    }
    respond(502, { error: '图片生成失败，请稍后重试', code: 'IMAGE_FAILED' })
  }
}

app.get('/api/image/styles', (_req, res) => {
  res.json({
    ok: true,
    styles: BEAUTY_IMAGE_STYLES.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      tags: item.tags,
      prompt: item.prompt,
    })),
    sizes: BEAUTY_IMAGE_SIZES.map((item) => ({ id: item.id, width: item.width, height: item.height })),
    maxPromptLength: BEAUTY_PROMPT_MAX_LENGTH,
  })
})

app.post(['/api/image/generate', '/api/images/generate'], async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  await handleBeautyGenerate(
    {
      prompt: typeof body.prompt === 'string' ? body.prompt : '',
      styleId: typeof body.styleId === 'string' ? body.styleId : '',
      size: typeof body.size === 'string' ? body.size : '',
      host: req.get('host') ?? '',
      protocol: req.protocol,
    },
    (status, payload) => {
      res.status(status).json(payload)
    },
  )
})

app.get(['/api/image/generate', '/api/images/generate'], async (req, res) => {
  await handleBeautyGenerate(
    {
      prompt: typeof req.query.prompt === 'string' ? req.query.prompt : '',
      styleId: typeof req.query.styleId === 'string' ? req.query.styleId : '',
      size: typeof req.query.size === 'string' ? req.query.size : '',
      host: req.get('host') ?? '',
      protocol: req.protocol,
    },
    (status, payload) => {
      res.status(status).json(payload)
    },
  )
})

app.get('/api/image/render/:id', (req, res) => {
  const id = String(req.params.id ?? '')
  const record = BEAUTY_RENDER_CACHE.get(id)
  if (!record) {
    res.status(404).json({ error: '图片不存在或已过期，请重新生成', code: 'IMAGE_NOT_FOUND' })
    return
  }
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8')
  res.setHeader('Cache-Control', 'public, max-age=3600')
  res.send(buildBeautySvg(record))
})

// 挂载「一键生成美女图片」路由（实现见 server/src/image.ts）
const beautyImageRoutes = BEAUTY_RENDER_CACHE as unknown as {
  registerRoutes?: (app: unknown) => void
}
beautyImageRoutes.registerRoutes?.(app)

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
  res.json(publicDelivery())
})

app.post('/api/delivery/reset', (_req, res) => {
  startNewRun()
  res.json(publicDelivery())
})

app.put('/api/delivery/seat', (req, res) => {
  const seat = parseSeat(req.body?.seat)
  if (!seat) {
    res.status(400).json({ error: 'seat 必须是 pm / dev / qa' })
    return
  }
  changeSeat(seat)
  res.json(publicDelivery())
})

app.put('/api/delivery/prd', (req, res) => {
  const actor = parseSeat(req.body?.actor)
  if (!actor) {
    res.status(400).json({ error: 'actor 必须是 pm / dev / qa' })
    return
  }
  try {
    updatePrd(actor, {
      title: typeof req.body?.title === 'string' ? req.body.title : undefined,
      oneLiner: typeof req.body?.oneLiner === 'string' ? req.body.oneLiner : undefined,
      body: typeof req.body?.body === 'string' ? req.body.body : undefined,
      acceptance: Array.isArray(req.body?.acceptance) ? req.body.acceptance : undefined,
    })
    res.json(publicDelivery())
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
    applyGate(actor, action, {
      reason: typeof req.body?.reason === 'string' ? req.body.reason : undefined,
      questions: Array.isArray(req.body?.questions) ? req.body.questions.map(String) : undefined,
    })
    res.json(publicDelivery())
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
  res.setHeader('Content-Encoding', 'identity')
  res.socket?.setNoDelay(true)
  res.flushHeaders?.()
  res.write(`:${' '.repeat(2048)}\n\n`)
  let closed = false
  res.on('close', () => {
    closed = true
  })
  const send = (event: SseEvent) => {
    if (closed || res.writableEnded) return
    res.write(`data: ${JSON.stringify(event)}\n\n`)
    const flushable = res as typeof res & { flush?: () => void }
    flushable.flush?.()
  }
  send({ type: 'text_delta', delta: '研发回合已接上。\n' })
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
  res.json({ root: getWorkspaceRoot(), here: suggestedHere() })
})

app.get('/api/workspace/browse', (req, res) => {
  const dir = typeof req.query.dir === 'string' ? req.query.dir : ''
  try {
    res.json(browseDisk(dir || undefined))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(400).json({ error: message })
  }
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
