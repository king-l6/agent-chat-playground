/**
 * 迷你知识库（引用 RAG）
 *
 * 整条链路：
 *   读文档（内置 + 手册 + uploads）→ overlap 切块 →（retrieve.ts）embedding → TopK
 *   citation 在本轮 hits 里临时编成 1..K；跨文档定位靠 chunk.id
 *
 * 被谁调用：tools.ts 的 searchNotes → executeTool('search_notes')
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

/** 知识库里的一块文本（入库后的稳定结构，不含 citation） */
export type KnowledgeChunk = {
  /** 块唯一 id：{docId}-c{序号}，不跟文件名走 */
  id: string
  /** 文档稳定 id：内置 project/handbook，上传 d_xxxxxxxx */
  docId: string
  /** 块标题，一般来自 Markdown 的 ## 标题 */
  title: string
  /** 块正文（检索和引用都靠这段） */
  text: string
}

/**
 * 本轮检索命中：在 TopK 结果上临时编号
 * citation = 1 表示本轮 hits 的第 1 条，不是全库第 1 块
 */
export type SearchHit = KnowledgeChunk & {
  citation: number
  /** 本轮打分，方便工具卡片里对照「为什么留下 / 为什么当没中」 */
  score: number
}

// ESM 模块没有 __dirname，用当前文件 URL 推算所在目录
const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 仓库根目录：knowledge.ts 在 server/src/，往上两级就是项目根
const ROOT = path.resolve(__dirname, '../..')

export const DATA_DIR = path.join(ROOT, 'server', 'data')
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads')
export const INDEX_PATH = path.join(DATA_DIR, 'index.json')
const MANIFEST_PATH = path.join(DATA_DIR, 'manifest.json')

export function ensureDataDirs() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true })
}

type ManifestDoc = {
  id: string
  /** 磁盘上的文件名，等于 {id}.md，避免中文/乱码当路径 */
  storedAs: string
  /** 给人看的原名 */
  originalName: string
}

type ManifestFile = { docs: ManifestDoc[] }

/** 内置文档占用的 id，上传的 d_* 不能撞上 */
const RESERVED_DOC_IDS = new Set(['project', 'handbook'])

/**
 * 8 字节随机 + 对照已有 id。
 * 只 randomBytes(4) 且不查表：生日悖论下量一大就可能撞；「几乎不重复」≠ 唯一。
 */
function newDocId(used: Set<string>): string {
  for (let i = 0; i < 32; i += 1) {
    const id = `d_${randomBytes(8).toString('hex')}`
    if (!used.has(id) && !RESERVED_DOC_IDS.has(id)) return id
  }
  throw new Error('无法生成唯一文档 id')
}

function readManifest(): ManifestFile {
  try {
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf8')
    const parsed = JSON.parse(raw) as ManifestFile
    if (Array.isArray(parsed.docs)) return parsed
  } catch {
    // 没有清单就当空
  }
  return { docs: [] }
}

function writeManifest(file: ManifestFile) {
  ensureDataDirs()
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(file, null, 2))
}

/** 把旧的「按文件名当 id」的上传，迁到 d_xxx + manifest */
function migrateLegacyUploads(keepTmpPath?: string) {
  ensureDataDirs()
  const file = readManifest()
  const known = new Set(file.docs.map((d) => d.storedAs))
  let changed = false
  const keepTmp = keepTmpPath ? path.basename(keepTmpPath) : ''

  for (const name of fs.readdirSync(UPLOAD_DIR)) {
    if (name.startsWith('tmp-')) {
      // 正在 commit 的临时文件不能删，否则后面 rename 会 ENOENT → 上传 500
      if (name === keepTmp) continue
      try {
        fs.unlinkSync(path.join(UPLOAD_DIR, name))
      } catch {
        // ignore
      }
      continue
    }
    if (!/\.(md|txt|markdown)$/i.test(name)) continue
    if (known.has(name)) continue

    const existing = name.match(/^(d_[a-f0-9]{8,})(\.[a-z0-9]+)$/i)
    if (existing) {
      file.docs.push({
        id: existing[1],
        storedAs: name,
        originalName: name,
      })
      known.add(name)
      changed = true
      continue
    }

    const ext = path.extname(name) || '.md'
    const usedIds = new Set(file.docs.map((d) => d.id))
    const id = newDocId(usedIds)
    const storedAs = `${id}${ext}`
    fs.renameSync(path.join(UPLOAD_DIR, name), path.join(UPLOAD_DIR, storedAs))
    file.docs.push({ id, storedAs, originalName: name })
    known.add(storedAs)
    changed = true
    console.log(`[knowledge] 迁移上传 ${name} → ${id}`)
  }

  if (changed) writeManifest(file)
}

export function listUploadRecords(): ManifestDoc[] {
  migrateLegacyUploads()
  return readManifest().docs
}

/**
 * 上传落盘：每次都是新文档（新 d_xxx）。
 * 文件名只是标签，两份都叫 简历.md 但内容不同，必须是两条，不能按文件名覆盖。
 * 要换掉旧的：在文档页删掉再传。
 */
export function commitUpload(tmpPath: string, originalName: string): ManifestDoc {
  migrateLegacyUploads(tmpPath)
  const file = readManifest()
  const ext = path.extname(originalName).toLowerCase() || '.md'
  const used = new Set(file.docs.map((d) => d.id))
  const rec: ManifestDoc = {
    id: newDocId(used),
    storedAs: '',
    originalName,
  }
  rec.storedAs = `${rec.id}${ext}`
  file.docs.push(rec)

  const dest = path.join(UPLOAD_DIR, rec.storedAs)
  fs.renameSync(tmpPath, dest)
  writeManifest(file)
  return rec
}

export function deleteUploadByDocId(docId: string): void {
  const file = readManifest()
  const rec = file.docs.find((d) => d.id === docId)
  if (!rec) throw new Error('文档不存在')
  const full = path.join(UPLOAD_DIR, rec.storedAs)
  if (fs.existsSync(full)) fs.unlinkSync(full)
  writeManifest({ docs: file.docs.filter((d) => d.id !== docId) })
}

/** 丢掉内存切块缓存，上传/删除后必须调，否则还在用旧文档 */
let cached: KnowledgeChunk[] | null = null

export function invalidateChunks() {
  cached = null
}

/**
 * multer 常把 UTF-8 中文文件名当成 latin1，于是「手册.md」变成乱码，
 * 再被下面的白名单替换成 __________________.md。先按 latin1→utf8 救回来。
 */
export function decodeMulterName(raw: string): string {
  const utf8 = Buffer.from(raw, 'latin1').toString('utf8')
  const han = (s: string) => (s.match(/[\u4e00-\u9fff]/g) ?? []).length
  return han(utf8) > han(raw) ? utf8 : raw
}

/** 落盘用的临时名；真正文件名在 commitUpload 里改成 {docId}.md */
export function tempUploadFilename(): string {
  return `tmp-${Date.now()}-${randomBytes(3).toString('hex')}`
}

export type KnowledgeDoc = {
  docId: string
  source: 'builtin' | 'upload'
  filename?: string
  title: string
  chunkCount: number
  bytes?: number
}

/** 知识库页用：内置文档 + 上传文件 */
export function listDocuments(): KnowledgeDoc[] {
  const chunks = getChunks()
  const uploads = new Map(listUploadRecords().map((d) => [d.id, d]))
  const map = new Map<string, KnowledgeDoc>()
  for (const chunk of chunks) {
    const rec = uploads.get(chunk.docId)
    const source = rec ? 'upload' : 'builtin'
    const prev = map.get(chunk.docId)
    if (prev) {
      prev.chunkCount += 1
      continue
    }
    map.set(chunk.docId, {
      docId: chunk.docId,
      source,
      filename: rec?.originalName,
      title: rec?.originalName || chunk.title,
      chunkCount: 1,
    })
  }
  ensureDataDirs()
  for (const rec of Array.from(uploads.values())) {
    const row = map.get(rec.id)
    if (!row) continue
    const full = path.join(UPLOAD_DIR, rec.storedAs)
    if (fs.existsSync(full)) row.bytes = fs.statSync(full).size
  }
  return Array.from(map.values())
}

/** 单块最大字符数，太长就再切一刀 */
const MAX_CHUNK_CHARS = 280
/** 相邻块重叠字数：避免一句被切两半后两边都检索不到完整语义 */
const CHUNK_OVERLAP = 60
/** 太短的块丢掉，避免空片段污染检索 */
const MIN_CHUNK_CHARS = 20
/**
 * 低于这个分当「没中」，返回空 hits，模型才被允许再搜一次。
 * 和「score > 0 就算命中」的差别：弱匹配（正文里碰巧出现一个词 +2）不再锁死答案。
 *
 * 对照打分：整句 +10 必过；标题词 +4 且正文同词 +2 = 6 刚过；只中正文一词 +2 不过。
 */
const MIN_HIT_SCORE = 6

/**
 * 知识库里会出现的词，按「长的优先」排列，避免 tool 吃掉 tool calling。
 * 演示版改写：从用户原句里抽出这些词，而不是再调一次模型。
 */
const DOMAIN_TERMS = [
  'tool calling',
  'function calling',
  '简历缺口',
  '学习规划',
  '技术栈',
  '工具调用',
  '知识库',
  'websocket',
  'typescript',
  'agent',
  'sse',
  'rag',
  'mcp',
  'react',
  'node',
  'vite',
  '前端',
  '简历',
  '缺口',
  '求职',
  '流式',
  '检索',
  '引用',
  '面试',
  '部署',
  '画布',
  '编排',
  '作品',
  '项目',
]

/** 改写结果：原句 / 实际拿去打分的词 / 抽到的术语 */
export type RewrittenQuery = {
  original: string
  rewritten: string
  terms: string[]
}

/**
 * 把整句问题收成检索词。
 * 「我投 Agent 前端缺什么」→ 「agent 前端 缺口」这类，整句匹配 +10 才有机会，分词也不会被「我投/什么」稀释。
 * 抽不到任何术语时退回原句，后面 MIN_HIT_SCORE 仍可能判空。
 *
 * 生产里这一步常是多一次 LLM 改写，或 HyDE（先让模型写一段假想答案再去 embed）。
 * 这里用词表抽取，故意不增加 Agent 轮次；词表外的同义词会漏（「短板」≠「缺口」）。
 */
export function rewriteQuery(query: string): RewrittenQuery {
  const original = query.trim()
  const lower = original.toLowerCase()
  const terms: string[] = []
  const seen = new Set<string>()

  for (const term of DOMAIN_TERMS) {
    const key = term.toLowerCase()
    if (!lower.includes(key) || seen.has(key)) continue
    seen.add(key)
    terms.push(term)
  }

  // 演示用同义：问句里的「缺什么」对不上词表里的「缺口」
  if (lower.includes('缺') && !seen.has('缺口')) {
    seen.add('缺口')
    terms.push('缺口')
  }

  const rewritten = terms.join(' ') || original
  return { original, rewritten, terms }
}

/**
 * 写死在代码里的项目说明（原来 DEMO_NOTES 的内容，改成 md 格式）
 * 这样问「技术栈 / SSE」即使不读手册也能命中
 */
const BUILTIN_DOCS: Array<{ docId: string; title: string; body: string }> = [
  {
    docId: 'project',
    title: '项目说明',
    body: [
      '## 项目目标',
      'agent-chat-playground 是一个可演示的 AI Agent 前端作品：流式 Chat（SSE）+ tool calling 卡片 + 简易检索。',
      '',
      '## 技术栈',
      '前端 React + TypeScript + Vite；后端 Express + OpenAI 兼容 API；支持公司网关 / DeepSeek。无 Key 时可走 mock 模式。',
      '',
      '## SSE',
      '服务端用 text/event-stream 推送 text_delta、tool_start、tool_result 等事件；前端 ReadableStream 边收边渲染，按空行拆包并用 buffer 拼半截。',
      '',
      '## Tool calling',
      '模型返回 tool_calls 后，服务端执行本地工具，把结果写回 messages，再继续向模型要最终回答，UI 用卡片展示调用过程。',
    ].join('\n'),
  },
]

/**
 * 把一段过长的正文按字数窗口切开
 * @param text  某一节下的正文
 * @param title 这一节标题（切出来的每块共用同一个 title）
 */
function splitOversized(
  text: string,
  title: string,
): Array<{ title: string; text: string }> {
  if (text.length <= MAX_CHUNK_CHARS) return [{ title, text }]

  const parts: Array<{ title: string; text: string }> = []
  const step = MAX_CHUNK_CHARS - CHUNK_OVERLAP
  for (let i = 0; i < text.length; i += step) {
    const slice = text.slice(i, i + MAX_CHUNK_CHARS).trim()
    if (slice.length >= MIN_CHUNK_CHARS) parts.push({ title, text: slice })
    if (i + MAX_CHUNK_CHARS >= text.length) break
  }
  return parts
}

/**
 * 把一篇 Markdown 切成多个 KnowledgeChunk
 * @param docId          文档 id，写入 chunk.docId / id 前缀
 * @param raw            整篇 md 原文
 * @param fallbackTitle  某节没有 ## 标题时的默认标题
 */
function chunkMarkdown(
  docId: string,
  raw: string,
  fallbackTitle: string,
): KnowledgeChunk[] {
  // 在「行首的 ## 」处切开，保留 ## 在每一段里
  const sections = raw.split(/\n(?=##\s+)/)
  const pieces: Array<{ title: string; text: string }> = []

  for (const section of sections) {
    const trimmed = section.trim()
    if (!trimmed) continue

    const lines = trimmed.split('\n')
    // 第一行若是 ## xxx，则 xxx 当本节 title
    const heading = lines[0]?.match(/^##\s+(.+)$/)
    const title = heading?.[1]?.trim() || fallbackTitle
    // 有标题则正文从第二行起；否则整段都是正文
    const body = (heading ? lines.slice(1).join('\n') : trimmed).trim()
    if (!body) continue

    // 本节正文可能仍太长，再按字数切
    pieces.push(...splitOversized(body, title))
  }

  return pieces.map((p, i) => ({
    id: `${docId}-c${i + 1}`,
    docId,
    title: p.title,
    text: p.text,
  }))
}

/** 启动时加载全部文档并切块（内置说明 + 手册 + uploads） */
function loadAllChunks(): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = []

  // 1) 内置项目说明
  for (const doc of BUILTIN_DOCS) {
    chunks.push(...chunkMarkdown(doc.docId, doc.body, doc.title))
  }

  // 2) 仓库根目录的求职补充手册（读失败只 warn，不阻断服务）
  const handbookPath = path.join(ROOT, '求职补充手册.md')
  try {
    const raw = fs.readFileSync(handbookPath, 'utf8')
    chunks.push(...chunkMarkdown('handbook', raw, '求职补充手册'))
  } catch (err) {
    console.warn('[knowledge] 读取求职补充手册.md 失败:', err)
  }

  // 3) 用户上传：磁盘文件是 {docId}.md，原名在 manifest 里
  try {
    for (const rec of listUploadRecords()) {
      const full = path.join(UPLOAD_DIR, rec.storedAs)
      if (!fs.existsSync(full)) continue
      const raw = fs.readFileSync(full, 'utf8')
      chunks.push(...chunkMarkdown(rec.id, raw, rec.originalName))
    }
  } catch (err) {
    console.warn('[knowledge] 读取 uploads 失败:', err)
  }

  return chunks
}

/** 拿到全部 chunk（懒加载 + 缓存；invalidateChunks 之后会重新 load） */
export function getChunks(): KnowledgeChunk[] {
  if (!cached) cached = loadAllChunks()
  return cached
}

/**
 * 关键词检索 TopK（演示版 RAG，还没上向量库）
 *
 * 打分规则（可调）：
 *   - 整句 query 命中 title/text → +10
 *   - 每个 token（≥2 字）命中 title → +4，命中 text → +2
 *   - score >= MIN_HIT_SCORE 才算命中（弱匹配当没中，允许再搜）
 *   - 对本轮结果临时 citation = 1..K（局部编号）
 *
 * 生产里 searchChunks 整段通常被换成：
 *   embed(query) → 向量库 ANN TopK → （可选）交叉编码器 rerank
 * 字面匹配解决不了的：同义、语序、跨语言；向量解决不了的：必须还能点开原文（你们的 citation / chunk.id）。
 *
 * @param query 用户问题或模型传入的检索词
 * @param topK  最多返回几条，默认 3
 */
export function searchChunks(query: string, topK = 3): SearchHit[] {
  const q = query.toLowerCase().trim()
  if (!q) return []

  // 把问题拆成 token（中英文标点都当分隔符）
  const tokens = q
    .split(/[\s,，、?？!！。；;]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 1)

  const scored = getChunks()
    .map((chunk) => {
      const title = chunk.title.toLowerCase()
      const text = chunk.text.toLowerCase()
      let score = 0

      // 整句匹配权重最高
      if (title.includes(q) || text.includes(q)) score += 10

      // 分词匹配：标题命中比正文命中分更高
      for (const token of tokens) {
        if (token.length < 2) continue
        if (title.includes(token)) score += 4
        if (text.includes(token)) score += 2
      }

      return { chunk, score }
    })
    .filter((x) => x.score >= MIN_HIT_SCORE)
    .sort((a, b) => b.score - a.score) // 分数从高到低

  // 本轮局部编号：第 1 名 → [1]，第 2 名 → [2]…
  return scored.slice(0, topK).map((x, i) => ({
    ...x.chunk,
    citation: i + 1,
    score: x.score,
  }))
}
