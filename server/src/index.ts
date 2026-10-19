/**
 * Express 入口：健康检查 + SSE 聊天接口
 * 真正的 Agent 逻辑在 agent.ts
 */
import cors, { type CorsOptions } from 'cors'
import dotenv from 'dotenv'
import express, { type NextFunction, type Request, type Response } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import multer from 'multer'
import { resolveLlmConfig, runAgentChat } from './agent.js'
import { settleApproval, runCodeTeamChat } from './codeTeam.js'
import {
  importClaudeMcp,
  publicMcp,
  reconnectMcp,
  saveMcpSettings,
} from './mcp.js'
import { currentUserId, parseUserId, runWithUser } from './requestContext.js'
import { publicUserEnv, saveUserEnv } from './userEnv.js'
import {
  deleteSession,
  getSession,
  isValidId,
  listSessions,
  upsertSession,
  type SessionVisibility,
} from './sessions.js'
import {
  publicLlmSettings,
  resolveContextWindow,
  saveLlmSettings,
  type LlmMode,
} from './settings.js'
import { IMAGE_ROUTE, imageFileById, isImageId, mimeOf } from './imageCache.js'
import {
  activateRun,
  applyGate,
  bindRunWorkspace,
  changeSeat,
  deleteDeliveryRun,
  publicDelivery,
  publicDeliveryArtifacts,
  publicRuns,
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
  PDF_DIR,
  commitPdf,
  deletePdf,
  ensurePdfDir,
  getPdf,
  isPdfId,
  listPdfs,
  pdfFilePath,
  readPdfToc,
  savePdfToc,
  tempPdfFilename,
  type PdfTocNode,
} from './pdfs.js'
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
import { pickFolderNative } from './nativePick.js'
import { getWorkspaceRoot, listAllowedRoots, setWorkspaceRoot, suggestedHere } from './workspace.js'
import { DATA_DIR, REPO_ROOT } from './paths.js'
import { sweepStaleTmp } from './jsonStore.js'
import { appendChatTrace, shortId, type ChatTrace } from './trace.js'
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
import { dropTask, filmPath, isGuardError, openTask, publicVideo, resumeVideoTasks, retryTask, stillPath } from './video/runtime.js'
import { addSpend } from './video/store.js'
import { drawRevision, IMAGE_CENTS, renderReference } from './video/still.js'
import { bibleImageFile, fileDigest, readBible, readLibrary, addLibraryImage, saveBibleImage, writeBible, type SeriesBible } from './video/bible.js'
import { reviseLook, type LookKind } from './video/look.js'
import { buildStoryboard, draftScript } from './video/storyboard.js'
import { addVoice, listVoices, removeVoice, renameVoice, voicePath } from './video/voice.js'
import {
  assertSafeExposure,
  authRequired,
  clearLoginFails,
  clearSessionCookie,
  loginLocked,
  matchToken,
  noteLoginFail,
  resolveIdentity,
  setSessionCookie,
} from './auth.js'
import { cleanupOrphanContainers, sandboxStatus } from './sandbox/docker.js'
import { sandboxMode } from './sandbox/config.js'
import { bookMeeting, scanMeetingRooms } from './meeting.js'

dotenv.config({ path: path.join(REPO_ROOT, '.env'), override: true })
if (process.env.PLAYGROUND_DATA) {
  dotenv.config({
    path: path.join(process.env.PLAYGROUND_DATA, '.env'),
    override: true,
  })
}

const app = express()
const PORT = Number(process.env.PLAYGROUND_PORT || process.env.PORT || 8790)

/*
 * CORS：默认**关闭**。
 *
 * 原来是 origin: true（反射任意来源）—— 在「谁都能调」的前提下只是松松垮垮，
 * 但一旦身份改由 cookie 承载，反射来源就变成「任意网页都能带着用户 cookie 打这个后端」，
 * 性质完全不同，必须收敛。
 * 同源部署（前端由本服务托管）根本不需要 CORS；开发时 Vite 是**代理**到本进程，也是同源。
 * 真要放行别的来源，用 PLAYGROUND_CORS_ORIGIN 显式列白名单（逗号分隔）。
 *
 * **但不能一刀切成 false**：打包后的 Electron 是从 file:// 加载 dist 的，
 * 再回来调 http://127.0.0.1:8790（见 package.json 的 pack:app），这是跨源，
 * Origin 头是字符串 "null"。以前靠 origin:true 反射着，直接关掉会让桌面壳所有请求被拦。
 * 所以：没配令牌（＝桌面壳 / 本地开发）时放行 "null"；配了令牌（＝服务形态）时只认显式白名单。
 *
 * 本地开发也不全是同源：.env 里 VITE_API_BASE=http://127.0.0.1:8790 时，
 * Vite 页面（5176）会绕过代理直连本进程（为了躲代理吞 SSE），同样是跨源，一并放行。
 */
const DEV_ORIGINS = ['http://127.0.0.1:5176', 'http://localhost:5176']
const CORS_ORIGINS = (process.env.PLAYGROUND_CORS_ORIGIN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const corsOrigin: CorsOptions['origin'] = CORS_ORIGINS.length
  ? CORS_ORIGINS
  : authRequired()
    ? false
    : ['null', ...DEV_ORIGINS]
app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  }),
)
/*
 * 解析 JSON body。
 * 上限从 1MB 提到 8MB：PUT /api/sessions/:id 会把整条会话（含工具结果里的文件片段）
 * 一次性传上来，长会话 / 代码团队会话用 1MB 会 413。其余接口的 body 都很小。
 */
app.use(express.json({ limit: '8mb' }))

/*
 * 反代后面取真实客户端 IP。
 * 登录限流按 IP 计数，不设这个的话 nginx 转发后所有人都是 127.0.0.1，
 * 一个人试错会把所有人一起锁住。只在确实有反代时开。
 */
if (process.env.PLAYGROUND_TRUST_PROXY === '1') app.set('trust proxy', 1)

/* ===================== 访问令牌门禁 ===================== */

/**
 * 免鉴权白名单：登录本身、探活、以及「前端问自己登没登录」。
 * 按 originalUrl 判而不是 req.path —— 这个中间件挂在 '/api' 上，
 * 挂载点内的 req.path 是去掉前缀的相对路径，用它判极易写错。
 */
const AUTH_EXEMPT = ['/api/auth/login', '/api/auth/session', '/api/health']

function requireAuth(req: Request, res: Response, next: NextFunction) {
  // 没配令牌 = Electron / 本地开发，行为完全不变
  if (!authRequired()) return next()
  const p = req.originalUrl.split('?')[0]
  if (AUTH_EXEMPT.includes(p)) return next()
  if (resolveIdentity(req)) return next()
  res.status(401).json({ error: '需要访问令牌', code: 'unauthorized' })
}

app.post('/api/auth/login', (req, res) => {
  if (!authRequired()) {
    res.status(400).json({ error: '这个服务没有启用访问令牌，直接打开即可' })
    return
  }
  const ip = req.ip || 'unknown'
  if (loginLocked(ip)) {
    res.status(429).json({ error: '尝试次数过多，请等一分钟再试' })
    return
  }
  const token = String((req.body as { token?: unknown })?.token ?? '').trim()
  const who = matchToken(token)
  if (!who) {
    const left = noteLoginFail(ip)
    console.warn(`[auth] 登录失败 ip=${ip} 剩余尝试=${Math.max(left, 0)}`)
    res.status(401).json({ error: '令牌不对' })
    return
  }
  clearLoginFails(ip)
  // 内网多半是 http，Secure 属性会让浏览器直接丢掉 cookie，所以默认不开
  const secure = req.secure || process.env.PLAYGROUND_COOKIE_SECURE === '1'
  setSessionCookie(res, token, secure)
  console.log(`[auth] 登录成功 user=${who.name} ip=${ip}`)
  res.json({ ok: true, user: who.name })
})

app.post('/api/auth/logout', (_req, res) => {
  clearSessionCookie(res)
  res.json({ ok: true })
})

app.get('/api/auth/session', (req, res) => {
  const who = resolveIdentity(req)
  res.json({
    authRequired: authRequired(),
    authenticated: Boolean(who) || !authRequired(),
    user: who?.name ?? (authRequired() ? null : currentUserId()),
  })
})

/* 只挂 '/api'：静态资源不带这个前缀 → 登录页天然免鉴权。
   否则会出现「登录页自己要鉴权」的死循环。 */
app.use('/api', requireAuth)

/**
 * 身份来源。这是本次改造的核心一步：
 *   配了令牌 → 只认认证结果（cookie / Bearer），**彻底不再读 x-playground-user**；
 *   没配令牌 → 才回落到前端自报的头（本地开发的老行为）。
 * 原来无条件信任请求头，等于把「读别人 LLM Key / 会话」的权利交给任何会改头的人。
 */
app.use((req, _res, next) => {
  const id = authRequired()
    ? (resolveIdentity(req)?.name ?? 'local')
    : parseUserId(req.header('x-playground-user'))
  runWithUser(id, next)
})

/* ===================== 请求日志 ===================== */

/**
 * 一行一条，按前缀 grep 就能定位。
 *
 * 脱敏是硬要求，不是「顺手」：Authorization / Cookie / body 一律不进日志，
 * query 里的 token / key 之类抹成 ***。日志文件常常是权限最松的地方，
 * 把令牌或 API Key 写进去等于把门禁白做了。
 * user 能取到是因为上面的身份中间件把后续处理都裹在了 als.run 里。
 */
const SECRET_QUERY = /([?&](?:token|key|api_?key|authorization|password|cookie)=)[^&]*/gi

function redactUrl(url: string): string {
  return url.replace(SECRET_QUERY, '$1***')
}

app.use((req, res, next) => {
  const started = Date.now()
  res.on('finish', () => {
    console.log(
      `[req] ${req.method} ${redactUrl(req.originalUrl)} ${res.statusCode} ` +
        `${Date.now() - started}ms user=${currentUserId()} ip=${req.ip || '-'}`,
    )
  })
  next()
})

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

/** 版本号，健康检查里报出来。读不到就算了，不该因为读 package.json 让服务起不来 */
const VERSION = (() => {
  try {
    return String(
      JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version ?? '?',
    )
  } catch {
    return '?'
  }
})()

/**
 * GET /api/health：前端徽章用，看 live/mock、模型名、RAG 索引。
 * 也是探活接口（免鉴权），所以只出非敏感项：不报 workspace 绝对路径之外的用户数据，
 * 沙箱状态也**不触发 docker 探活**（理由见 sandbox/docker.sandboxStatus 的注释）。
 */
app.get('/api/health', (_req, res) => {
  const { apiKey, model } = resolveLlmConfig()
  res.json({
    ok: true,
    version: VERSION,
    uptime: Math.round(process.uptime()),
    mode: apiKey ? 'live' : 'mock',
    model,
    /*
     * 前端「上下文用量」环的分母（token）。
     * 优先级（面板 → 环境变量 → 32k 兜底）只在 settings.resolveContextWindow 里算一次，
     * 这里不重复判断，前端也不自己猜。
     */
    contextWindow: resolveContextWindow(),
    rag: getRagStatus(),
    skills: listSkills(),
    mcp: publicMcp(),
    workspace: { root: getWorkspaceRoot() },
    auth: { required: authRequired() },
    sandbox: { mode: sandboxMode(), ...sandboxStatus() },
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

/**
 * 面板传来的上下文窗口：数字或数字串都收。
 * 不传 / 传 null → undefined（＝不动这个字段）；空串、0、乱写 → 数字，由
 * settings.saveLlmSettings 按「收不成正整数就清掉、回落环境变量或默认」处理。
 */
function parseContextWindow(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string') return Number(value.trim() || 0)
  return undefined
}

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
      // 原样透传：undefined 语义就是「不改」，别在这里填默认值
      contextWindow: parseContextWindow(req.body?.contextWindow),
    })
    res.json(saved)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(400).json({ error: message })
  }
})

app.get('/api/env', (_req, res) => {
  res.json(publicUserEnv())
})

app.put('/api/env', async (req, res) => {
  const rows = Array.isArray(req.body?.vars) ? req.body.vars : null
  if (!rows) {
    res.status(400).json({ error: '需要 vars: [{ key, value?, keep? }]' })
    return
  }
  try {
    const saved = saveUserEnv(
      rows.map((row: { key?: unknown; value?: unknown; keep?: unknown }) => ({
        key: typeof row?.key === 'string' ? row.key : '',
        value: typeof row?.value === 'string' ? row.value : undefined,
        keep: row?.keep === true,
      })),
    )
    // Cookie 等变了要重连 MCP
    if (publicMcp().enabled) await reconnectMcp()
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

/** 需求 id；缺省（没传/不合法）由 store 回落到当前激活那条 */
function parseRunId(raw: unknown): string | undefined {
  const s = typeof raw === 'string' ? raw.trim() : ''
  return /^[a-z0-9][a-z0-9-]{0,63}$/i.test(s) ? s : undefined
}

app.get('/api/video', (_req, res) => {
  res.json(publicVideo())
})

app.post('/api/video/draft', async (req, res) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : []
  const talk = messages
    .filter((m: { role?: unknown; content?: unknown }) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m: { role: 'user' | 'assistant'; content?: unknown }) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : '',
    }))
    .filter((m: { content: string }) => m.content.trim())
  if (!talk.some((m: { role: string }) => m.role === 'user')) {
    res.status(400).json({ error: '先说你想拍什么' })
    return
  }
  try {
    const draft = await draftScript(talk, typeof req.body?.script === 'string' ? req.body.script : '')
    res.json(draft)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})

app.get('/api/video/bible', (_req, res) => {
  res.json(readBible())
})

app.put('/api/video/bible', (req, res) => {
  const body = req.body
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: '设定格式不对' })
    return
  }
  res.json(writeBible(body as SeriesBible))
})

const bibleUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } })

app.post('/api/video/bible/images', (req, res) => {
  bibleUpload.single('file')(req, res, (err) => {
    if (err || !req.file) {
      res.status(400).json({ error: '图片请小于 8MB 的 png、jpg 或 webp' })
      return
    }
    try {
      res.json({ image: saveBibleImage(req.file.buffer) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      res.status(400).json({ error: message })
    }
  })
})

app.get('/api/video/bible/images/:name', (req, res) => {
  const file = bibleImageFile(req.params.name)
  if (!file) {
    res.status(404).json({ error: '没有这张参考图' })
    return
  }
  res.sendFile(file)
})

app.post('/api/video/bible/images/generate', async (req, res) => {
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : ''
  const size = req.body?.size === '1536x1024' ? '1536x1024' : '1024x1024'
  if (prompt.length < 4) {
    res.status(400).json({ error: '先写外形或场景，再生成参考图' })
    return
  }
  try {
    const bytes = await renderReference(prompt, size)
    const image = saveBibleImage(bytes)
    addSpend(IMAGE_CENTS)
    res.json({ image })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[bible-image]', message)
    res.status(500).json({ error: message })
  }
})

app.post('/api/video/bible/images/draw', async (req, res) => {
  const kind = req.body?.kind
  const look = typeof req.body?.look === 'string' ? req.body.look.trim() : ''
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : ''
  if ((kind !== 'character' && kind !== 'outfit' && kind !== 'place') || look.length < 4) {
    res.status(400).json({ error: '先有描述，再出图' })
    return
  }
  const base = typeof req.body?.base === 'string' ? bibleImageFile(req.body.base) : null
  const listed = Array.isArray(req.body?.images) ? req.body.images.filter((name: unknown) => typeof name === 'string') : []
  const refs = base ? [base] : listed.map((name: string) => bibleImageFile(name)).filter((file: string | null): file is string => Boolean(file)).slice(0, 4)
  const lead = kind === 'character' ? '角色定妆，单人正面半身，纯色浅灰背景' : kind === 'outfit' ? '单件服装平铺，纯色浅灰背景，不要人物' : '空镜场景，不要人物'
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
  const prompt = [lead, name, look, message ? `按这个要求改：${message}` : ''].filter(Boolean).join('。')
  try {
    const bytes = await drawRevision(prompt, kind === 'place' ? '1536x1024' : '1024x1024', refs)
    const image = saveBibleImage(bytes)
    addSpend(IMAGE_CENTS)
    res.json({ image })
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: messageText })
  }
})

app.get('/api/video/bible/library', (_req, res) => {
  res.json({ images: readLibrary() })
})

app.post('/api/video/bible/library', (req, res) => {
  const name = typeof req.body?.image === 'string' ? req.body.image : ''
  try {
    res.json({ images: addLibraryImage(name) })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(400).json({ error: message })
  }
})

app.post('/api/video/bible/look', async (req, res) => {
  const kind = req.body?.kind
  if (kind !== 'character' && kind !== 'outfit' && kind !== 'place') {
    res.status(400).json({ error: '不知道要写角色、衣服还是场景' })
    return
  }
  const images = Array.isArray(req.body?.images) ? req.body.images.filter((name: unknown) => typeof name === 'string') : []
  try {
    const look = await reviseLook({
      kind: kind as LookKind,
      name: typeof req.body?.name === 'string' ? req.body.name : '',
      look: typeof req.body?.look === 'string' ? req.body.look : '',
      images,
      message: typeof req.body?.message === 'string' ? req.body.message : '',
    })
    res.json({ look })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(400).json({ error: message })
  }
})

app.post('/api/video/bible/images/used', (req, res) => {
  const names = Array.isArray(req.body?.images) ? req.body.images.filter((name: unknown) => typeof name === 'string') : []
  const shots = Array.isArray(req.body?.shots) ? req.body.shots : []
  const byDigest = new Map<string, string>()
  for (const name of names) {
    const file = bibleImageFile(name)
    if (file && !byDigest.has(fileDigest(file))) byDigest.set(fileDigest(file), name)
  }
  const used: Array<{ key: string; image: string }> = []
  for (const shot of shots) {
    const taskId = typeof shot?.taskId === 'string' ? shot.taskId : ''
    const index = Number(shot?.index)
    const file = stillPath(taskId, index)
    if (!file) continue
    const image = byDigest.get(fileDigest(file))
    if (!image) continue
    used.push({ key: `${taskId}-${index}`, image })
  }
  res.json({ used })
})

app.post('/api/video/bible/images/from-shot', (req, res) => {
  const taskId = typeof req.body?.taskId === 'string' ? req.body.taskId : ''
  const index = Number(req.body?.index)
  const file = stillPath(taskId, index)
  if (!file) {
    res.status(404).json({ error: '这镜还没有图' })
    return
  }
  try {
    res.json({ image: saveBibleImage(fs.readFileSync(file)) })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(400).json({ error: message })
  }
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

app.get('/api/video/voices', (_req, res) => {
  res.json({ voices: listVoices() })
})

app.post('/api/video/voices', async (req, res) => {
  const url = typeof req.body?.url === 'string' ? req.body.url : ''
  const name = typeof req.body?.name === 'string' ? req.body.name : ''
  try {
    const voice = await addVoice(name, url)
    res.status(201).json(voice)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(400).json({ error: message })
  }
})

app.patch('/api/video/voices/:id', (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name : ''
  try {
    const voice = renameVoice(req.params.id, name)
    if (!voice) {
      res.status(404).json({ error: '没有这段音色' })
      return
    }
    res.json({ voices: listVoices() })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(400).json({ error: message })
  }
})

app.delete('/api/video/voices/:id', (req, res) => {
  removeVoice(req.params.id)
  res.json({ voices: listVoices() })
})

app.get('/api/video/voices/:id/audio', (req, res) => {
  const file = voicePath(req.params.id)
  if (!fs.existsSync(file)) {
    res.status(404).json({ error: '没有这段音色' })
    return
  }
  res.sendFile(file)
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

app.delete('/api/video/tasks/:id', (req, res) => {
  try {
    dropTask(req.params.id)
    res.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(message === '任务不存在' ? 404 : 400).json({ error: message })
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

app.get('/api/video/tasks/:id/shots/:index', (req, res) => {
  const file = stillPath(req.params.id, Number(req.params.index))
  if (!file) {
    res.status(404).json({ error: '这镜还没有图' })
    return
  }
  res.sendFile(file)
})

app.get('/api/video/tasks/:id/film', (req, res) => {
  const file = filmPath(req.params.id)
  if (!file) {
    res.status(404).json({ error: '成片还没有' })
    return
  }
  res.sendFile(file)
})

app.get('/api/delivery', (req, res) => {
  res.json(publicDelivery(parseRunId(req.query?.id)))
})

/** 预览用的产物包。可能很大（几百个文件），所以单独一条，不塞进 /api/delivery */
app.get('/api/delivery/artifacts', (req, res) => {
  try {
    res.json(publicDeliveryArtifacts(parseRunId(req.query?.id)))
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.get('/api/delivery/runs', (_req, res) => {
  res.json(publicRuns())
})

app.post('/api/delivery/runs', (req, res) => {
  const root = typeof req.body?.workspaceRoot === 'string' ? req.body.workspaceRoot : undefined
  try {
    startNewRun(root ? { workspaceRoot: root } : undefined)
    res.json(publicDelivery())
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.post('/api/delivery/runs/activate', (req, res) => {
  const id = parseRunId(req.body?.id)
  if (!id) {
    res.status(400).json({ error: '缺少 id' })
    return
  }
  activateRun(id)
  res.json(publicDelivery())
})

app.post('/api/delivery/runs/delete', (req, res) => {
  const id = parseRunId(req.body?.id)
  if (!id) {
    res.status(400).json({ error: '缺少 id' })
    return
  }
  deleteDeliveryRun(id)
  res.json(publicDelivery())
})

app.put('/api/delivery/runs/workspace', (req, res) => {
  const id = parseRunId(req.body?.id)
  if (!id) {
    res.status(400).json({ error: '缺少 id' })
    return
  }
  const root = typeof req.body?.root === 'string' ? req.body.root : undefined
  try {
    bindRunWorkspace(id, root)
    res.json(publicDelivery(id))
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// 老前端仍在调；语义变成「新开一条需求」，不再覆盖当前那条
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
  changeSeat(seat, parseRunId(req.body?.id))
  res.json(publicDelivery(parseRunId(req.body?.id)))
})

app.put('/api/delivery/prd', (req, res) => {
  const actor = parseSeat(req.body?.actor)
  const id = parseRunId(req.body?.id)
  if (!actor) {
    res.status(400).json({ error: 'actor 必须是 pm / dev / qa' })
    return
  }
  try {
    updatePrd(
      actor,
      {
        title: typeof req.body?.title === 'string' ? req.body.title : undefined,
        oneLiner: typeof req.body?.oneLiner === 'string' ? req.body.oneLiner : undefined,
        body: typeof req.body?.body === 'string' ? req.body.body : undefined,
        acceptance: Array.isArray(req.body?.acceptance) ? req.body.acceptance : undefined,
      },
      id,
    )
    res.json(publicDelivery(id))
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
  const id = parseRunId(req.body?.id)
  if (!actor) {
    res.status(400).json({ error: 'actor 必须是 pm / dev / qa' })
    return
  }
  try {
    applyGate(
      actor,
      action,
      {
        reason: typeof req.body?.reason === 'string' ? req.body.reason : undefined,
        questions: Array.isArray(req.body?.questions) ? req.body.questions.map(String) : undefined,
      },
      id,
    )
    res.json(publicDelivery(id))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(err instanceof GateError ? 400 : 500).json({
      error: message,
      gate: err instanceof GateError ? err.gate : undefined,
    })
  }
})

/**
 * SSE 心跳。
 *
 * 为什么必须有：中间隔一层 nginx，proxy_read_timeout 默认 60s。模型思考期间
 * 可能几十秒不吐 token，代理会认定连接死了直接掐断，前端看到的就是「莫名中断」。
 * 定期写一行 SSE **注释**（`:...`）能把连接顶住 —— 注释不是事件，前端解析器会忽略。
 * unref 是为了别让这个定时器拖住进程退出。
 */
function heartbeat(res: Response, isClosed: () => boolean): NodeJS.Timeout {
  const t = setInterval(() => {
    if (isClosed() || res.writableEnded) return
    res.write(':\n\n')
  }, 15_000)
  t.unref?.()
  return t
}

app.post('/api/delivery/turn', async (req, res) => {
  const actor = parseSeat(req.body?.actor)
  const message = typeof req.body?.message === 'string' ? req.body.message : ''
  const id = parseRunId(req.body?.id)
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
  // 开场那 2KB padding 只负责顶穿代理缓冲；研发/测试动辄几十秒不出字，还得靠周期心跳
  const hb = heartbeat(res, () => closed)
  res.on('close', () => {
    closed = true
    clearInterval(hb)
  })
  const send = (event: SseEvent) => {
    if (closed || res.writableEnded) return
    res.write(`data: ${JSON.stringify(event)}\n\n`)
    const flushable = res as typeof res & { flush?: () => void }
    flushable.flush?.()
  }
  send({ type: 'text_delta', delta: '研发回合已接上。\n' })
  try {
    await runDeliveryTurn(actor, message, send, id)
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

/**
 * 服务器形态下「从列表选仓库」的数据源。
 *
 * 只列白名单根 + 它们的直接子目录（像仓库的那些），**不接受前端传任意路径** ——
 * 没有自由浏览，就没有路径穿越面。这是刻意收窄的：宁可功能少一点，
 * 也不给「持令牌者把工作区指到 /etc」留口子。
 */
app.get('/api/workspace/allowed', (_req, res) => {
  const isRepoRoot = (p: string) =>
    fs.existsSync(path.join(p, '.git')) || fs.existsSync(path.join(p, 'package.json'))
  const allowed = listAllowedRoots().map((root) => {
    let repos: { name: string; path: string }[] = []
    try {
      repos = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => ({ name: e.name, path: path.join(root, e.name) }))
        .filter((e) => isRepoRoot(e.path))
    } catch {
      /* 读不动就只给根本身 */
    }
    return { root, name: path.basename(root) || root, isRepo: isRepoRoot(root), repos }
  })
  res.json({ allowed, allowlistEnabled: allowed.length > 0 })
})

/**
 * 弹系统目录选择器，只返回选中的路径（不落任何状态，调用方自己决定绑到哪儿）。
 * 阻塞到用户选完或取消；取消返回 { root: null }。
 *
 * 只有 macOS 有（nativePick 走 osascript）。服务器上没这回事，直接 501 说清替代路径，
 * 别让前端拿到一个看不懂的报错。
 */
app.post('/api/workspace/pick', async (req, res) => {
  if (process.platform !== 'darwin') {
    res.status(501).json({
      error:
        '服务形态下没有系统目录选择器。请从「可用仓库列表」里选，' +
        '或让管理员把目录加进 PLAYGROUND_WORKSPACE_ALLOWLIST。',
    })
    return
  }
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.slice(0, 40) : '选择目录'
  try {
    res.json({ root: await pickFolderNative(prompt) })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
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
 * PDF 阅读器：只存不检索，所以**不碰 index.json**，跟 wiki 批量入库互不干扰。
 *
 * 目录不在服务端算：pdf.js 已经在浏览器里解析这份文件了，书签（getOutline）和
 * 文本层（getTextContent 带字号）都是现成的，再让 Node 端装一套解析器纯属重复劳动。
 * 前端算完 PUT 回来缓存，下次打开直接读。
 */
const pdfUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      ensurePdfDir()
      cb(null, PDF_DIR)
    },
    filename: (_req, _file, cb) => cb(null, tempPdfFilename()),
  }),
  // 面试指南这类书动辄上百 MB，但也不能不设上限
  limits: { fileSize: 200 * 1024 * 1024 },
})

/** 目录是前端传上来的外部输入：层级、长度、节点数都得自己夹一遍再落盘 */
const MAX_TOC_NODES = 5000
function normalizeToc(raw: unknown): PdfTocNode[] {
  let budget = MAX_TOC_NODES
  const walk = (list: unknown, level: number): PdfTocNode[] => {
    if (!Array.isArray(list) || level > 6) return []
    const out: PdfTocNode[] = []
    for (const item of list) {
      if (budget <= 0) break
      if (!item || typeof item !== 'object') continue
      const node = item as Record<string, unknown>
      const title = String(node.title ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200)
      const page = Math.trunc(Number(node.page))
      if (!title || !Number.isFinite(page) || page < 1) continue
      budget -= 1
      const y = Number(node.y)
      const kids = walk(node.children, level + 1)
      const rec: PdfTocNode = { title, page, y: Number.isFinite(y) ? y : 0, level }
      if (kids.length > 0) rec.children = kids
      out.push(rec)
    }
    return out
  }
  return walk(raw, 1)
}

app.get('/api/pdfs', (_req, res) => {
  res.json({ pdfs: listPdfs() })
})

/** POST /api/pdfs 表单字段名 file，只收 .pdf */
app.post('/api/pdfs', pdfUpload.single('file'), (req, res) => {
  const file = req.file
  if (!file) {
    res.status(400).json({ error: '请选择文件' })
    return
  }
  const name = decodeMulterName(file.originalname)
  const discard = () => {
    try {
      fs.unlinkSync(file.path)
    } catch {
      /* 清理失败不该盖掉真正的错因 */
    }
  }
  if (!/\.pdf$/i.test(name)) {
    discard()
    res.status(400).json({ error: '仅支持 .pdf' })
    return
  }
  // multer 只看请求头里的文件名，改个后缀什么都能塞进来；再认一下文件头
  let head = ''
  try {
    const fd = fs.openSync(file.path, 'r')
    try {
      const buf = Buffer.alloc(5)
      fs.readSync(fd, buf, 0, 5, 0)
      head = buf.toString('latin1')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    /* 读不到就按不合规处理 */
  }
  if (!head.startsWith('%PDF-')) {
    discard()
    res.status(400).json({ error: '这不是有效的 PDF 文件' })
    return
  }
  try {
    res.json({ ok: true, pdf: commitPdf(file.path, name, file.size) })
  } catch (err) {
    discard()
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})

/** 前端用 axios 取 arraybuffer 再喂给 pdf.js，所以这里只当静态文件吐 */
app.get('/api/pdfs/:id/file', (req, res) => {
  const id = String(req.params.id)
  const rec = getPdf(id)
  const file = pdfFilePath(id)
  if (!rec || !file) {
    res.status(404).json({ error: 'PDF 不存在' })
    return
  }
  // 中文名直接写 filename= 会变乱码，用 RFC 5987 的 filename*
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(rec.name)}`)
  res.sendFile(file, (err) => {
    // 读到一半关页面会让 sendFile 报 aborted，那不是服务端错误
    if (err && !res.headersSent) res.status(500).json({ error: '读取失败' })
  })
})

app.get('/api/pdfs/:id/toc', (req, res) => {
  const id = String(req.params.id)
  if (!getPdf(id)) {
    res.status(404).json({ error: 'PDF 不存在' })
    return
  }
  res.json({ toc: readPdfToc(id) })
})

app.put('/api/pdfs/:id/toc', (req, res) => {
  const id = String(req.params.id)
  if (!isPdfId(id) || !getPdf(id)) {
    res.status(404).json({ error: 'PDF 不存在' })
    return
  }
  const source = req.body?.source === 'outline' ? 'outline' : 'infer'
  const pages = Math.trunc(Number(req.body?.pages ?? 0)) || 0
  const nodes = normalizeToc(req.body?.nodes)
  try {
    res.json({ ok: true, pdf: savePdfToc(id, source, nodes, pages) })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})

app.delete('/api/pdfs/:id', (req, res) => {
  try {
    deletePdf(String(req.params.id))
    res.json({ ok: true, pdfs: listPdfs() })
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
          const rec = item as {
            id?: unknown
            kind?: unknown
            expression?: unknown
            topK?: unknown
            retrieval?: unknown
            query?: unknown
          }
          const kind = rec.kind
          if (kind !== 'search' && kind !== 'answer' && kind !== 'calc') return null
          const topK = Number(rec.topK)
          const retrieval = rec.retrieval === 'keyword' ? 'keyword' : rec.retrieval === 'hybrid' ? 'hybrid' : undefined
          const query = typeof rec.query === 'string' ? rec.query : undefined
          return {
            id: String(rec.id ?? kind),
            kind,
            expression: rec.expression != null ? String(rec.expression) : undefined,
            ...(Number.isFinite(topK) ? { topK } : {}),
            ...(retrieval ? { retrieval } : {}),
            ...(query ? { query } : {}),
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
  if (req.body?.stream === true) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()
    let closed = false
    const hb = heartbeat(res, () => closed)
    res.on('close', () => {
      closed = true
      clearInterval(hb)
    })
    const send = (event: unknown) => {
      if (closed || res.writableEnded) return
      res.write(`data: ${JSON.stringify(event)}\n\n`)
    }
    try {
      const result = await runWorkflow(question, pipeline, {
        onStart: (id) => send({ type: 'step_start', id }),
        onDone: (step) => send({ type: 'step_done', ...step }),
      })
      send({ type: 'done', answer: result.answer })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      send({ type: 'error', message })
    } finally {
      if (!closed) res.end()
    }
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
 * 会话存取（见 sessions.ts）。
 *
 * 会话永远是「归属人自己的」：写入一律落在 currentUserId() 名下，
 * **不接受代写别人的会话**；读取时只有归属人本人、或对方把这条设为 shared，才放行。
 *
 *   GET    /api/sessions                 列自己的会话（含 messages，前端一次拉全量）
 *   GET    /api/sessions/:ownerId/:id    按归属人读 —— 分享链接 #/c/<ownerId>/<id> 走这条
 *   PUT    /api/sessions/:id             落盘一条（owner = 自己）
 *   DELETE /api/sessions/:id             删一条（owner = 自己）
 */

/** 把 PUT 上来的 body 收成一条会话。ownerId 用当前用户，**忽略 body 里的 ownerId**（否则能代写别人） */
function sessionFromBody(req: express.Request, ownerId: string, id: string) {
  const body = (req.body ?? {}) as Record<string, unknown>
  return {
    id,
    ownerId,
    title: typeof body.title === 'string' ? body.title : '新对话',
    lastUserAt: typeof body.lastUserAt === 'number' ? body.lastUserAt : Date.now(),
    updatedAt: typeof body.updatedAt === 'number' ? body.updatedAt : Date.now(),
    visibility: (body.visibility === 'shared' ? 'shared' : 'private') as SessionVisibility,
    messages: Array.isArray(body.messages) ? body.messages : [],
  }
}

app.get('/api/sessions', (_req, res) => {
  res.json({ sessions: listSessions(currentUserId()) })
})

app.get('/api/sessions/:ownerId/:id', (req, res) => {
  const { ownerId, id } = req.params
  if (!isValidId(ownerId) || !isValidId(id)) {
    res.status(400).json({ error: 'id 不合法' })
    return
  }
  const session = getSession(ownerId, id)
  if (!session) {
    res.status(404).json({ error: '会话不存在' })
    return
  }
  /*
   * 别人的会话：只有设成 shared 才可读，否则 403。
   * 这里用 403 而不是 404，是为了让「分享链接打不开」的人看到「对方未分享」，
   * 而不是含糊的「不存在」——本地单机场景，不值得为防探测牺牲可诊断性。
   */
  if (ownerId !== currentUserId() && session.visibility !== 'shared') {
    res.status(403).json({ error: '对方未分享这条会话' })
    return
  }
  res.json({ session })
})

app.put('/api/sessions/:id', (req, res) => {
  const id = req.params.id
  if (!isValidId(id)) {
    res.status(400).json({ error: 'id 不合法' })
    return
  }
  try {
    const saved = upsertSession(sessionFromBody(req, currentUserId(), id))
    res.json({ ok: true, session: saved })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.delete('/api/sessions/:id', (req, res) => {
  const id = req.params.id
  if (!isValidId(id)) {
    res.status(400).json({ error: 'id 不合法' })
    return
  }
  res.json({ ok: deleteSession(currentUserId(), id) })
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

  const chatMode = req.body?.mode === 'code_team' ? 'code_team' : 'default'
  /*
   * 「自动批准写入」开关：打开后本轮后续 workspace_write 不再逐条挂起等人点。
   * 高风险文件（.env / 密钥 / CI）后端仍会拦，见 codeTeam.canAutoApprove。
   */
  const autoApprove = req.body?.autoApprove === true
  /*
   * 会话 id：标记「这一轮属于哪个会话」，供按 [chat][<sid>] 查链路。
   * 不合法 / 没带就是空串——老前端、脚本调用都不会因此报错。
   */
  const sid = isValidId(req.body?.sessionId) ? (req.body.sessionId as string) : ''

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
  const abort = new AbortController()
  // 三个 SSE 口里最容易长时间沉默的一个：Agent 循环 + 工具调用，中间没有 token 输出
  const hb = heartbeat(res, () => closed)
  // 注意：不要用 req.on('close') —— POST body 读完就可能触发，会误停 SSE
  res.on('close', () => {
    closed = true
    clearInterval(hb)
    abort.abort()
  })

  /*
   * trace 旁路采集：只观察流过的 SSE 事件，不参与对话逻辑（见 trace.ts）。
   * tools 收 tool_start 的 name，model 收 meta.model，error 收 error.message。
   */
  const traceTools: string[] = []
  let traceModel: string | undefined
  let traceError: string | undefined

  /** 写一条 SSE：data: {...}\n\n */
  const send = (event: SseEvent) => {
    if (event.type === 'tool_start') traceTools.push(event.name)
    else if (event.type === 'meta') traceModel = event.model
    else if (event.type === 'error') traceError = event.message
    if (closed || res.writableEnded) return
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  /*
   * 链路日志：按 [chat][<sid>] 前缀过滤，就能捞出某个会话的全部回合。
   * 界面显示的短 id、URL 里的 id 与这里的 sid 必须是同一个值。
   */
  console.log('[chat][%s] start mode=%s messages=%d', sid || '-', chatMode, normalized.length)
  const startedAt = Date.now()
  try {
    if (chatMode === 'code_team') {
      await runCodeTeamChat({
        messages: normalized,
        send,
        signal: abort.signal,
        autoApprove,
        sessionId: sid,
      })
    } else {
      await runAgentChat({ messages: normalized, send, sessionId: sid })
    }
    console.log('[chat][%s] done %dms', sid || '-', Date.now() - startedAt)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    traceError = message
    console.log('[chat][%s] error %dms %s', sid || '-', Date.now() - startedAt, message)
    send({ type: 'error', message })
    send({ type: 'done' })
  } finally {
    if (!closed) res.end()
    // trace 落盘：一行 JSONL，fail-open（trace.ts 内部吞异常），不影响已结束的响应
    const trace: ChatTrace = {
      ts: new Date().toISOString(),
      sessionId: sid || shortId(),
      mode: chatMode,
      model: traceModel,
      tools: traceTools,
      durationMs: Date.now() - startedAt,
      turns: normalized.filter((m) => m.role === 'user').length,
      ok: !traceError,
      error: traceError,
    }
    appendChatTrace(trace)
  }
})

/**
 * 批准或拒绝代码团队挂起的 workspace_write（热重载后仍可按磁盘记录落盘）
 * body.all = true 表示「全部批准」：这一条放行的同时，本轮后续低/中风险写入也不再逐条问。
 */
app.post('/api/chat/approve', async (req, res) => {
  const id = typeof req.body?.id === 'string' ? req.body.id : ''
  const decision = req.body?.decision === 'deny' ? 'deny' : req.body?.decision === 'approve' ? 'approve' : ''
  if (!id || !decision) {
    res.status(400).json({ error: '需要 id 和 decision（approve / deny）' })
    return
  }
  try {
    const settled = await settleApproval(id, decision, { all: req.body?.all === true })
    if (!settled.ok) {
      res.status(404).json({ error: settled.error })
      return
    }
    res.json(settled)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
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

/* ===================== 会议室预定 ===================== */

app.post('/api/meeting/scan', async (req, res) => {
  const body = req.body as { cookie?: unknown; date?: unknown }
  try {
    const result = await scanMeetingRooms(String(body?.cookie ?? ''), String(body?.date ?? ''))
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : '查询会议室失败' })
  }
})

app.post('/api/meeting/book', async (req, res) => {
  const body = req.body as {
    cookie?: unknown
    roomId?: unknown
    start?: unknown
    end?: unknown
    subject?: unknown
    reminderTime?: unknown
  }
  try {
    const result = await bookMeeting({
      cookie: String(body?.cookie ?? ''),
      roomId: Number(body?.roomId),
      start: String(body?.start ?? ''),
      end: String(body?.end ?? ''),
      subject: String(body?.subject ?? ''),
      reminderTime: body?.reminderTime == null || body.reminderTime === '' ? 2 : Number(body.reminderTime),
    })
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : '预定失败' })
  }
})

/* ===================== 前端静态托管 ===================== */

const DIST_DIR = path.join(REPO_ROOT, 'dist')

/*
 * 交付页的产品预览要在浏览器里跑 WebContainer，它依赖 SharedArrayBuffer，
 * 页面必须处于「跨源隔离」状态 —— 也就是下面这两个头。
 *
 * 原来它们只配在 vite.config.ts 的 dev server 上（server.headers），换成 Express
 * 托管之后必须原样搬过来。漏了的症状很阴：**不报错**，只是预览功能悄悄起不来。
 * 用 credentialless 而不是文档主推的 require-corp —— Monaco 从 CDN 拉脚本、
 * 聊天页有一堆远程图，require-corp 会把它们全裂掉。
 *
 * 注册在所有路由之后：只让「落到静态资源」的请求拿到这两个头，
 * /api 的响应不需要（也就不会给 SSE 添乱）。
 */
export function attachStaticFrontend() {
  if (process.env.PLAYGROUND_EMBEDDED === '1') return // Electron 从 file:// 加载，不走这里
  app.use((_req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless')
    next()
  })
  if (fs.existsSync(DIST_DIR)) {
    // 前端是纯 hash 路由（#/... 不会发给服务器），所以**不需要 SPA fallback**，
    // 只要能返回 index.html 即可，express.static 的默认行为就够。
    app.use(express.static(DIST_DIR))
    console.log(`[static] 托管前端：${DIST_DIR}`)
  } else {
    console.warn(`[static] 没找到 ${DIST_DIR}，只提供 /api。先跑 npm run build。`)
  }
}

attachStaticFrontend()

export function startServer(): Promise<void> {
  // 默认只绑回环。要挂到内网让别的机器访问，必须显式设 PLAYGROUND_LISTEN_HOST=0.0.0.0，
  // 且必须先配好令牌 —— 见下面 assertSafeExposure。
  const host = process.env.PLAYGROUND_LISTEN_HOST?.trim() || '127.0.0.1'
  // 上次被 kill 时漏下的 .<pid>.tmp（索引落盘是 tmp+rename，SIGKILL 时 catch 不执行）。
  // 趁还没开始写就扫一遍；够老的才删，见 sweepStaleTmp 的说明。
  try {
    const swept = sweepStaleTmp(DATA_DIR)
    if (swept) console.log(`[data] 清掉 ${swept} 个上次残留的 .tmp`)
  } catch {
    /* 打扫卫生失败不影响启动 */
  }
  return new Promise((resolve, reject) => {
    try {
      assertSafeExposure(host)
    } catch (err) {
      reject(err)
      return
    }
    const server = app.listen(PORT, host, () => {
      const { apiKey, model } = resolveLlmConfig()
      const mode = apiKey ? 'live' : 'mock'
      const wiki = listWikiTree()
      const shown = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
      console.log(`[agent-chat] http://${shown}:${PORT}  (listen ${host})  mode=${mode}  model=${model}`)
      console.log(
        `[auth] ${authRequired() ? '已启用访问令牌' : '没配令牌 —— 只适合本机自用，别对外暴露'}`,
      )
      if (sandboxMode() === 'docker') {
        console.log('[sandbox] docker 模式：交付的测试命令跑在一次性容器里')
        // 上次被 kill 时漏下的容器（正常路径有 --rm 会自己消失）
        try {
          cleanupOrphanContainers()
        } catch (err) {
          console.warn('[sandbox] 清理残留容器失败:', err instanceof Error ? err.message : err)
        }
      } else {
        console.log('[sandbox] off 模式：命令直接在宿主机上跑（本地开发）')
      }
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
      runWithUser('local', () => {
        void reconnectMcp().then((mcp) => {
          if (!mcp.enabled) return
          if (mcp.connected) {
            console.log(`[mcp] ${mcp.tools.length} tools @ ${mcp.url}`)
          } else {
            console.warn('[mcp] 未连上:', mcp.error)
          }
        })
      })
      resolve()
    })
    server.on('error', reject)
  })
}

if (process.env.PLAYGROUND_EMBEDDED !== '1') {
  void startServer()
}
