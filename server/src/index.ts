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
import {
  importClaudeMcp,
  publicMcp,
  reconnectMcp,
  saveMcpSettings,
} from './mcp.js'
import { publicLlmSettings, saveLlmSettings, type LlmMode } from './settings.js'
import { IMAGE_ROUTE, imageFileById, isImageId, mimeOf } from './imageCache.js'
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
  listNamespaceChildren,
  tempUploadFilename,
} from './knowledge.js'
import {
  deleteUploadedFile,
  ensureIndex,
  getRagStatus,
  getWikiIngestStatus,
  ingestUploadedDoc,
  ingestWikiPath,
  listDocVersionRows,
  listIndexRowsPage,
  resyncIndex,
  startWikiIngest,
} from './retrieve.js'
import type { ChatMessageInput, SseEvent } from './types.js'
import { browseDisk, getWorkspaceRoot, setWorkspaceRoot, suggestedHere } from './workspace.js'
import { REPO_ROOT } from './paths.js'
import { getWikiRoot, listWikiTree, readWikiDoc } from './wiki.js'
import {
  MEMORY_TYPES,
  deleteMemory,
  getMemory,
  listMemories,
  logMemoryAction,
  memoryStats,
  readMemoryLog,
  saveMemory,
  setMemoryStatus,
  sweepMemories,
  type MemoryStatus,
  type MemoryType,
} from './memory/store.js'
import { MEMORY_TOP_K, MIN_MEMORY_COSINE, rankMemories } from './memory/recall.js'
import { filmPath, isGuardError, openTask, publicVideo, resumeVideoTasks, retryTask } from './video/runtime.js'
import { buildStoryboard } from './video/storyboard.js'

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
    mcp: publicMcp(),
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

/**
 * GET /api/image/cache/:id —— 把入库时缓存的企微原图直接发给前端。
 *
 * 纯读本地字节：不联网、不查 image-index、不碰 CLIP，所以可以被回答里的
 * markdown 图片反复请求。检索侧拼给模型的地址见 imageCache.imageServePath()。
 */
app.get(`${IMAGE_ROUTE}/:id`, (req, res) => {
  const id = String(req.params.id ?? '')
  if (!isImageId(id)) {
    // 形状不对的 id 不可能对应缓存文件（也挡住了 ..%2f 这类越界尝试）
    res.status(400).json({ error: '图片 id 非法', code: 'IMAGE_ID_INVALID' })
    return
  }
  const file = imageFileById(id)
  if (!file) {
    res.status(404).json({ error: '图片未缓存', code: 'IMAGE_NOT_FOUND' })
    return
  }
  try {
    res.setHeader('Content-Type', mimeOf(file))
    // 文件名是源 URL 的 sha256，而 findCachedImage 命中即复用、从不覆写，
    // 所以同一个 id 的字节不会变，可以 immutable。真要换了（前缀升 v2 即可）。
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    res.send(fs.readFileSync(file))
  } catch {
    // 索引有、盘上没有（被删/权限）：如实 404，别用 500 糊过去
    res.status(404).json({ error: '图片文件缺失', code: 'IMAGE_NOT_FOUND' })
  }
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

app.get('/api/mcp', (_req, res) => {
  res.json(publicMcp())
})

app.put('/api/mcp', async (req, res) => {
  const enabled = req.body?.enabled
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled 必须是 boolean' })
    return
  }
  try {
    const saved = await saveMcpSettings({
      enabled,
      url: typeof req.body?.url === 'string' ? req.body.url : undefined,
      auth: typeof req.body?.auth === 'string' ? req.body.auth : undefined,
    })
    res.json(saved)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(400).json({ error: message })
  }
})

app.post('/api/mcp/import-claude', async (_req, res) => {
  try {
    const saved = await importClaudeMcp()
    res.json(saved)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(400).json({ error: message })
  }
})

function parseSeat(raw: unknown): Seat | null {
  return raw === 'pm' || raw === 'dev' || raw === 'qa' ? raw : null
}

app.get('/api/video', (_req, res) => {
  res.json(publicVideo())
})

app.post('/api/video/storyboard', async (req, res) => {
  const script = typeof req.body?.script === 'string' ? req.body.script.trim() : ''
  if (script.length < 8) {
    res.status(400).json({ error: '剧本至少写一句，8 个字以上' })
    return
  }
  try {
    const board = await buildStoryboard(script)
    res.json(board)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})

app.post('/api/video/tasks', async (req, res) => {
  const script = typeof req.body?.script === 'string' ? req.body.script : ''
  try {
    const opened = await openTask(script)
    res.status(opened.reused ? 200 : 201).json(opened)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(isGuardError(err) ? 429 : 400).json({ error: message })
  }
})

app.post('/api/video/tasks/:id/retry', (req, res) => {
  try {
    res.json({ task: retryTask(req.params.id) })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const missing = message === '任务不存在'
    res.status(missing ? 404 : isGuardError(err) ? 429 : 400).json({ error: message })
  }
})

app.get('/api/video/tasks/:id/film', (req, res) => {
  const file = filmPath(req.params.id)
  if (!file) {
    res.status(404).json({ error: '成片还没有' })
    return
  }
  res.sendFile(file)
})

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

app.get('/api/wiki/tree', (_req, res) => {
  res.json(listWikiTree())
})

app.get('/api/wiki/doc', (req, res) => {
  const rel = String(req.query.path ?? '').trim()
  if (!rel) {
    res.status(400).json({ error: '缺少 path' })
    return
  }
  try {
    res.json(readWikiDoc(rel))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(404).json({ error: message })
  }
})

/**
 * POST /api/wiki/ingest
 * body: { path } 入库一篇；或 { all: true, prefix?, limit? } 批量（后台跑）
 */
app.post('/api/wiki/ingest', async (req, res) => {
  const pathRel = String(req.body?.path ?? '').trim()
  const all = Boolean(req.body?.all)
  const prefix = String(req.body?.prefix ?? '').trim()
  const limit = Number(req.body?.limit ?? 0)
  try {
    if (pathRel) {
      const result = await ingestWikiPath(pathRel)
      res.json({ ok: true, mode: 'one', ...result, rag: getRagStatus() })
      return
    }
    if (all) {
      const status = startWikiIngest({
        prefix: prefix || undefined,
        limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
      })
      res.json({ ok: true, mode: 'batch', status })
      return
    }
    res.status(400).json({ error: '传 path 入库一篇，或 all:true 批量' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(400).json({ error: message })
  }
})

app.get('/api/wiki/ingest/status', (_req, res) => {
  res.json(getWikiIngestStatus())
})

app.get('/api/knowledge', (req, res) => {
  const rag = getRagStatus()
  const lite = String(req.query.lite ?? '') === '1'
  res.json({
    rag,
    documents: lite ? [] : listDocuments(),
    index: {
      model: rag.embedding,
      dim: rag.dim,
      // 全量 chunks 太大，列表走 /api/knowledge/chunks 分页
      chunks: [],
    },
  })
})

/** GET /api/knowledge/chunks?doc=&q=&offset=&limit= */
app.get('/api/knowledge/chunks', (req, res) => {
  const doc = String(req.query.doc ?? '').trim() || null
  const q = String(req.query.q ?? '').trim()
  const offset = Number(req.query.offset ?? 0)
  const limit = Number(req.query.limit ?? 50)
  const page = listIndexRowsPage({
    docId: doc,
    q,
    offset: Number.isFinite(offset) ? offset : 0,
    limit: Number.isFinite(limit) ? limit : 50,
  })
  res.json(page)
})

/**
 * GET /api/knowledge/doc-versions
 * 每篇文档的版本指纹对照。stale=true 就是「磁盘改了但向量还没更新」。
 */
app.get('/api/knowledge/doc-versions', (_req, res) => {
  const rows = listDocVersionRows()
  res.json({
    docs: rows.length,
    stale: rows.filter((r) => r.stale).length,
    items: rows.sort((a, b) => Number(b.stale) - Number(a.stale) || b.chunks - a.chunks),
  })
})

/**
 * POST /api/knowledge/resync
 * 重新扫描：只重算内容变了的文档。没变的一篇都不碰，重复调用没副作用。
 */
let resyncing = false
app.post('/api/knowledge/resync', async (_req, res) => {
  if (resyncing) {
    res.status(409).json({ ok: false, error: '已有重新扫描在跑' })
    return
  }
  resyncing = true
  try {
    const stats = await resyncIndex()
    res.json({ ok: true, ...stats, rag: getRagStatus() })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
  } finally {
    resyncing = false
  }
})

/** GET /api/knowledge/namespaces?path=  — 侧栏懒展开，只返回一层 */
app.get('/api/knowledge/namespaces', (req, res) => {
  const prefix = String(req.query.path ?? '').trim()
  const doc = String(req.query.doc ?? '').trim()
  if (doc) {
    const docs = listDocuments()
    const hit = docs.find((d) => d.docId === doc)
    if (!hit) {
      res.json({ path: '', children: [], resolve: null })
      return
    }
    const label = hit.filename || hit.title || hit.docId
    const parts =
      hit.source === 'builtin'
        ? ['内置', label.replace(/\.(md|markdown|txt)$/i, '')]
        : label
            .split(/[/\\]/)
            .filter(Boolean)
            .map((p, i, arr) =>
              i === arr.length - 1 ? p.replace(/\.(md|markdown|txt)$/i, '') : p,
            )
    res.json({ path: parts.join('/'), children: [], resolve: parts })
    return
  }
  res.json({ path: prefix, children: listNamespaceChildren(prefix) })
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

/* ===================== 长期记忆 ===================== */

/** 前端可能传 ISO 串、毫秒数或空串（清空）；解析不了就当没传 */
function parseExpires(value: unknown): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const ms = Date.parse(String(value))
  return Number.isNaN(ms) ? undefined : ms
}

function memoryTypeOf(value: unknown, fallback?: string) {
  const raw = String(value ?? fallback ?? '').trim() as MemoryType
  return MEMORY_TYPES.includes(raw) ? raw : null
}

/** GET /api/memory/stats：页面头部统计（总数/按类型/归档/召回榜） */
app.get('/api/memory/stats', (_req, res) => {
  res.json(memoryStats())
})

/**
 * GET /api/memory/long?q=&type=&status=&offset=&limit=
 * 长期记忆列表。status 默认 all —— 归档的也要能看见（归档只是不参与召回）
 */
app.get('/api/memory/long', (req, res) => {
  const offset = Number(req.query.offset ?? 0)
  const limit = Number(req.query.limit ?? 50)
  const type = String(req.query.type ?? 'all')
  const status = String(req.query.status ?? 'all')
  res.json(
    listMemories({
      q: String(req.query.q ?? ''),
      type: (MEMORY_TYPES as string[]).includes(type) ? (type as MemoryType) : 'all',
      status: (['active', 'archived', 'superseded'] as string[]).includes(status)
        ? (status as MemoryStatus)
        : 'all',
      offset: Number.isFinite(offset) ? offset : 0,
      limit: Number.isFinite(limit) ? limit : 50,
    }),
  )
})

/**
 * GET /api/memory/recall?q=
 * 召回预览：这条问题会命中哪几条记忆、cos 多少、走的是向量还是关键词。
 * 页面和断言脚本都靠它回答「为什么这条进了 system prompt」。
 */
app.get('/api/memory/recall', async (req, res) => {
  const q = String(req.query.q ?? '').trim()
  if (!q) {
    res.status(400).json({ error: 'q 不能为空' })
    return
  }
  try {
    // 用 rankMemories 而不是 recallMemories：要连没过线的条目一起返回，
    // 页面才能回答「为什么这条没进 system」。顺便不写 access_count。
    const ranked = await rankMemories(q)
    const baseline = ranked.length
      ? Number((ranked.reduce((s, h) => s + h.cos, 0) / ranked.length).toFixed(4))
      : 0
    res.json({
      query: q,
      minCosine: MIN_MEMORY_COSINE,
      topK: MEMORY_TOP_K,
      /** 这条 query 对所有记忆的 cos 均值。区分度主要在 query 一侧，这个数就是「基线」 */
      baseline,
      blocked: ranked.filter((h) => h.cos < MIN_MEMORY_COSINE).length,
      hits: ranked.slice(0, Math.max(1, Number(req.query.topK ?? MEMORY_TOP_K) || MEMORY_TOP_K)).map((h) => ({
        id: h.entry.id,
        description: h.entry.description,
        type: h.entry.type,
        status: h.entry.status,
        cos: Number(h.cos.toFixed(4)),
        score: Number(h.score.toFixed(4)),
        /** 和基线比高多少：过召回时靠这个数判断是不是只是 query 基线高 */
        gap: Number((h.cos - baseline).toFixed(4)),
        pass: h.cos >= MIN_MEMORY_COSINE,
        via: h.via,
      })),
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

/** POST /api/memory/long：手动新增一条（页面上「手动记录」走这里） */
app.post('/api/memory/long', async (req, res) => {
  const description = String(req.body?.description ?? '').trim()
  const text = String(req.body?.text ?? '').trim()
  if (!description) {
    res.status(400).json({ error: 'description 不能为空' })
    return
  }
  const type = memoryTypeOf(req.body?.type)
  if (!type) {
    res.status(400).json({ error: `type 必须是 ${MEMORY_TYPES.join(' / ')}` })
    return
  }
  try {
    const item = await saveMemory({
      description,
      text: text || description,
      type,
      salience: Number(req.body?.salience ?? 0.7),
      sourceSession: req.body?.sourceSession ?? null,
      sourceQuote: req.body?.sourceQuote ?? null,
      expires: parseExpires(req.body?.expires) ?? null,
    })
    logMemoryAction({
      action: 'MANUAL',
      id: item.id,
      reason: '页面手动新增',
      session: item.sourceSession,
    })
    res.json({ ok: true, item })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})

/** PUT /api/memory/long/:id：编辑（内容变了会自动重算向量） */
app.put('/api/memory/long/:id', async (req, res) => {
  const prev = getMemory(req.params.id)
  if (!prev) {
    res.status(404).json({ ok: false, error: `记忆不存在：${req.params.id}` })
    return
  }
  const description = String(req.body?.description ?? prev.description).trim()
  if (!description) {
    res.status(400).json({ error: 'description 不能为空' })
    return
  }
  try {
    const item = await saveMemory({
      id: prev.id,
      description,
      text: String(req.body?.text ?? prev.text).trim(),
      type: memoryTypeOf(req.body?.type, prev.type) ?? prev.type,
      salience: Number(req.body?.salience ?? prev.salience),
      sourceSession: prev.sourceSession,
      sourceQuote: req.body?.sourceQuote ?? prev.sourceQuote,
      expires: parseExpires(req.body?.expires) ?? prev.expires,
    })
    logMemoryAction({ action: 'MANUAL', id: item.id, reason: '页面编辑', session: item.sourceSession })
    res.json({ ok: true, item })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})

/** DELETE /api/memory/long/:id：真删（连同向量）。想留痕用归档 */
app.delete('/api/memory/long/:id', (req, res) => {
  if (!deleteMemory(req.params.id)) {
    res.status(404).json({ ok: false, error: `记忆不存在：${req.params.id}` })
    return
  }
  logMemoryAction({ action: 'DELETE', id: req.params.id, reason: '页面删除' })
  res.json({ ok: true })
})

/** POST /api/memory/long/:id/archive|restore：归档只是不参与召回，不删 */
for (const [path, status, action, reason] of [
  ['archive', 'archived', 'ARCHIVE', '页面归档'],
  ['restore', 'active', 'RESTORE', '页面恢复'],
] as const) {
  app.post(`/api/memory/long/:id/${path}`, (req, res) => {
    const item = setMemoryStatus(req.params.id, status)
    if (!item) {
      res.status(404).json({ ok: false, error: `记忆不存在：${req.params.id}` })
      return
    }
    logMemoryAction({ action, id: item.id, reason })
    res.json({ ok: true, item })
  })
}

/**
 * POST /api/memory/sweep：手动扫一遍衰减归档（过期 / 从没被召回且 60 天没动）。
 * 项目里没有定时器，所以启动时跑一次 + 页面给个按钮。
 */
app.post('/api/memory/sweep', (_req, res) => {
  const result = sweepMemories()
  for (const id of [...result.expired, ...result.stale]) {
    logMemoryAction({
      action: 'ARCHIVE',
      id,
      reason: result.expired.includes(id) ? '过了 expires' : `60 天没被召回`,
    })
  }
  res.json({ ok: true, ...result, stats: memoryStats() })
})

/** GET /api/memory/log：写入决策时间线（ADD/UPDATE/DELETE/NOOP…） */
app.get('/api/memory/log', (req, res) => {
  const limit = Number(req.query.limit ?? 100)
  res.json({ items: readMemoryLog(Number.isFinite(limit) ? limit : 100) })
})

export function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = app.listen(PORT, '127.0.0.1', () => {
      const { apiKey, model } = resolveLlmConfig()
      const mode = apiKey ? 'live' : 'mock'
      const wiki = listWikiTree()
      console.log(`[agent-chat] http://127.0.0.1:${PORT}  mode=${mode}  model=${model}`)
      console.log(`[wiki] ${wiki.exists ? `${wiki.count} 篇 @ ${getWikiRoot()}` : `目录不存在 ${getWikiRoot()}`}`)
      void ensureIndex().catch((err) => {
        console.warn('[rag] 启动索引失败，先走关键词:', err)
      })
      // 遗忘：每次启动扫一遍衰减归档（没有定时器，启动时跑最省事）
      try {
        const swept = sweepMemories()
        if (swept.expired.length + swept.stale.length > 0) {
          console.log(`[memory] 归档 ${swept.expired.length} 条过期 / ${swept.stale.length} 条久未召回`)
        }
      } catch (err) {
        console.warn('[memory] 启动归档扫描失败:', err instanceof Error ? err.message : err)
      }
      try {
        resumeVideoTasks()
      } catch (err) {
        console.warn('[video] 恢复中断任务失败:', err instanceof Error ? err.message : err)
      }
      void reconnectMcp().then((mcp) => {
        if (!mcp.enabled) return
        if (mcp.connected) {
          console.log(`[mcp] ${mcp.tools.length} tools @ ${mcp.url}`)
        } else {
          console.warn('[mcp] 未连上:', mcp.error)
        }
      })
      resolve()
    })
    server.on('error', reject)
  })
}

if (process.env.PLAYGROUND_EMBEDDED !== '1') {
  void startServer()
}
