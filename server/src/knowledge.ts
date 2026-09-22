/**
 * 迷你知识库（引用 RAG）
 *
 * 整条链路：
 *   启动：读全部文档切块并建索引
 *   上传/删除：只切这一篇，按 chunk.id upsert / 按 docId 删向量，其它文档不动
 *   citation 在本轮 hits 里临时编成 1..K；跨文档定位靠 chunk.id
 *
 * 被谁调用：tools.ts 的 searchNotes → executeTool('search_notes')
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { DATA_DIR, HANDBOOK_PATH } from './paths.js'

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
  /**
   * 命中块左右邻接拼起来，给模型当上下文（small-to-big）。
   * 没有邻接时就是 text 本身。评测仍看 text（命中块）。
   */
  context?: string
  /**
   * 来源文档的可读名（已去目录和后缀），如「平台工作周报-2026年8月W1」。
   * docId 是哈希、title 是文内小节名，模型光看这两个看不出「这是哪一篇」，
   * 答「最近的周报」就只能编期次。由 retrieve 组装时补，底层检索函数不带。
   */
  docName?: string
  /** 来源文档的完整路径，前端角标想展开看时用 */
  docPath?: string
  /** 从文档名解析出的时间戳；解析不出来就是 undefined，不参与排序 */
  docTime?: number
  /** rerank 的字面重叠分；score 是 RRF 融合分，两个分开看才看得出「为什么留下」 */
  rerank?: number
  /**
   * 这条是怎么进来的：
   * recall  = 正常召回（向量 / 关键词 / RRF 融合；score 是 RRF 融合分）
   * recency = 「最近/最新」时间意图补召的最新几期（score 是该块对问句的余弦）
   * 两条通道的分不是一个量纲，标出来免得看的人以为分低就是差。
   */
  via?: 'recall' | 'recency'
}

export { DATA_DIR }
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads')
export const INDEX_PATH = path.join(DATA_DIR, 'index.json')
const MANIFEST_PATH = path.join(DATA_DIR, 'manifest.json')

export function ensureDataDirs() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true })
}

export type ManifestDoc = {
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

/** wiki 路径 → 稳定 docId，重复入库会覆盖同一篇，不会越积越多 */
export function wikiDocId(relPath: string): string {
  const key = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  return `w_${createHash('sha256').update(key).digest('hex').slice(0, 16)}`
}

/**
 * 把一篇 wiki md 写进 uploads（按路径稳定 id）。
 * originalName 用相对路径，向量库页能看出是哪篇 wiki。
 */
export function upsertWikiUpload(relPath: string, content: string): ManifestDoc {
  migrateLegacyUploads()
  const id = wikiDocId(relPath)
  const file = readManifest()
  let rec = file.docs.find((d) => d.id === id)
  if (!rec) {
    rec = { id, storedAs: `${id}.md`, originalName: relPath }
    file.docs.push(rec)
  } else {
    rec.originalName = relPath
  }
  ensureDataDirs()
  fs.writeFileSync(path.join(UPLOAD_DIR, rec.storedAs), content, 'utf8')
  writeManifest(file)
  return rec
}

/**
 * 进程内切块列表。启动时全量 load；之后上传/删除只改这一篇，不再 invalidate 整袋。
 */
let cached: KnowledgeChunk[] | null = null

/** 只切磁盘上这一篇（不扫其它文档） */
export function chunkOnDiskDoc(rec: ManifestDoc): KnowledgeChunk[] {
  const full = path.join(UPLOAD_DIR, rec.storedAs)
  if (!fs.existsSync(full)) return []
  const raw = fs.readFileSync(full, 'utf8')
  return chunkMarkdown(rec.id, raw, rec.originalName)
}

/** 缓存已热时原地替换该文档的块；还没 load 则不动，下次 getChunks 会从盘读到 */
export function replaceDocChunks(docId: string, chunks: KnowledgeChunk[]): void {
  docMeta = null
  if (!cached) return
  cached = cached.filter((c) => c.docId !== docId).concat(chunks)
  docAgg = null
}

export function removeDocChunks(docId: string): void {
  docMeta = null
  if (!cached) return
  cached = cached.filter((c) => c.docId !== docId)
  docAgg = null
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
  source: 'builtin' | 'upload' | 'wiki'
  filename?: string
  title: string
  chunkCount: number
  bytes?: number
}

type DocAgg = { count: number; title: string }

/** docId → chunk 数；随 getChunks / replace / remove 维护，避免每次扫 1.6 万块 */
let docAgg: Map<string, DocAgg> | null = null

function rebuildDocAgg(chunks: KnowledgeChunk[]): Map<string, DocAgg> {
  const map = new Map<string, DocAgg>()
  for (const chunk of chunks) {
    const prev = map.get(chunk.docId)
    if (prev) prev.count += 1
    else map.set(chunk.docId, { count: 1, title: chunk.title })
  }
  docAgg = map
  return map
}

function ensureDocAgg(): Map<string, DocAgg> {
  if (docAgg) return docAgg
  return rebuildDocAgg(getChunks())
}

function displayNsName(label: string) {
  return label.replace(/\.(md|markdown|txt)$/i, '')
}

/**
 * 从文档名里读期次 → 时间戳。返回毫秒，读不出来返回 null。
 *
 * 知识库里带期次的文档（周报/月报/季度小结）时间只写在名字里：
 * 「平台工作周报-2026年8月W1」「搜索工程周报2025Q1」。切块后这条信息就没了，
 * 所以在这里从名字还原，给排序做个「越新越靠前」的软信号。
 *
 * 只用来排序，不要求精确到日：W1 落在这个月 1 号那一周就够比大小了。
 */
export function docTimeFromName(name: string): number | null {
  // 2026年8月W1 / 2025年10月W2 → 该月第 W 周的周一
  const week = name.match(/(20\d{2})年(\d{1,2})月\s*W(\d)/)
  if (week) return Date.UTC(Number(week[1]), Number(week[2]) - 1, 1 + (Number(week[3]) - 1) * 7)

  // 2026年1月15日
  const day = name.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日/)
  if (day) return Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]))

  // 2026 H1 / 2025 H2 → 半年初
  const half = name.match(/(20\d{2})\s*H([12])/i)
  if (half) return Date.UTC(Number(half[1]), (Number(half[2]) - 1) * 6, 1)

  // 搜索工程周报2025Q1 → 季初
  const quarter = name.match(/(20\d{2})Q([1-4])/i)
  if (quarter) return Date.UTC(Number(quarter[1]), (Number(quarter[2]) - 1) * 3, 1)

  // 2025年11月
  const month = name.match(/(20\d{2})年(\d{1,2})月/)
  if (month) return Date.UTC(Number(month[1]), Number(month[2]) - 1, 1)

  return null
}

/** 交给模型/前端看的来源信息：可读名 + 完整路径 + 时间 */
export type DocMeta = {
  /** 已去目录和后缀，如「平台工作周报-2026年8月W1」 */
  name: string
  /** wiki 相对路径或上传原名；内置文档为空 */
  path: string
  time: number | null
}

/** docId → 来源信息；靠 replaceDocChunks / removeDocChunks 失效 */
let docMeta: Map<string, DocMeta> | null = null

/**
 * docId → 文档可读名 + 时间。
 * 检索出参里只有哈希 docId，模型看不出「这是哪一篇」，这个表就是补那一环的。
 */
export function getDocMetaMap(): Map<string, DocMeta> {
  if (docMeta) return docMeta
  const map = new Map<string, DocMeta>()

  for (const rec of listUploadRecords()) {
    // 只用最后一段当可读名：全路径太长，而且期次就在最后一段里
    const base = rec.originalName.split(/[/\\]/).pop() ?? rec.originalName
    const name = displayNsName(base)
    let time = docTimeFromName(name)
    if (time === null) {
      // 名字里没有期次的（方案、流程、文档类），退回文件时间。爬虫落盘时间，信号弱
      try {
        time = fs.statSync(path.join(UPLOAD_DIR, rec.storedAs)).mtimeMs
      } catch {
        time = null
      }
    }
    map.set(rec.id, { name, path: rec.originalName, time })
  }

  // 内置文档不在 manifest 里，得单独补：否则会从首个块的标题（如「项目目标」）当名字
  for (const doc of BUILTIN_DOCS) map.set(doc.docId, { name: doc.title, path: '', time: null })
  if (!map.has('handbook')) map.set('handbook', { name: '求职补充手册', path: '', time: null })

  docMeta = map
  return map
}

function docPathParts(doc: KnowledgeDoc): string[] {
  const label = doc.filename || doc.title || doc.docId
  if (doc.source === 'builtin') return ['内置', displayNsName(label)]
  return label
    .split(/[/\\]/)
    .filter(Boolean)
    .map((p, i, arr) => (i === arr.length - 1 ? displayNsName(p) : p))
}

/** 知识库页用：内置文档 + 上传文件（含 wiki 入库） */
export function listDocuments(options?: { includeBytes?: boolean }): KnowledgeDoc[] {
  const agg = ensureDocAgg()
  const uploads = new Map(listUploadRecords().map((d) => [d.id, d]))
  const out: KnowledgeDoc[] = []
  for (const [docId, { count, title }] of Array.from(agg.entries())) {
    const rec = uploads.get(docId)
    const source: KnowledgeDoc['source'] = rec
      ? rec.id.startsWith('w_')
        ? 'wiki'
        : 'upload'
      : 'builtin'
    out.push({
      docId,
      source,
      filename: rec?.originalName,
      title: rec?.originalName || title,
      chunkCount: count,
    })
  }
  if (options?.includeBytes) {
    ensureDataDirs()
    for (const row of out) {
      const rec = uploads.get(row.docId)
      if (!rec) continue
      const full = path.join(UPLOAD_DIR, rec.storedAs)
      if (fs.existsSync(full)) row.bytes = fs.statSync(full).size
    }
  }
  return out
}

export type NamespaceChild = {
  kind: 'dir' | 'file'
  name: string
  path: string
  count: number
  id?: string
  source?: string
}

/** 向量库侧栏：只返回某一层子节点，展开时再拉下一层 */
export function listNamespaceChildren(prefix = ''): NamespaceChild[] {
  const pref = prefix.replace(/^\/+|\/+$/g, '')
  const prefParts = pref ? pref.split('/') : []
  const docs = listDocuments()
  const dirs = new Map<string, { name: string; path: string; count: number }>()
  const files: NamespaceChild[] = []

  for (const doc of docs) {
    const parts = docPathParts(doc)
    if (prefParts.length > 0) {
      if (parts.length <= prefParts.length) continue
      if (!prefParts.every((p, i) => parts[i] === p)) continue
    }
    const rest = parts.slice(prefParts.length)
    if (rest.length === 0) continue
    if (rest.length === 1) {
      files.push({
        kind: 'file',
        name: rest[0],
        path: [...prefParts, rest[0]].join('/'),
        count: doc.chunkCount,
        id: doc.docId,
        source: doc.source,
      })
      continue
    }
    const name = rest[0]
    const pathKey = [...prefParts, name].join('/')
    const prev = dirs.get(pathKey)
    if (prev) prev.count += doc.chunkCount
    else dirs.set(pathKey, { name, path: pathKey, count: doc.chunkCount })
  }

  const dirNodes: NamespaceChild[] = Array.from(dirs.values())
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    .map((d) => ({ kind: 'dir' as const, name: d.name, path: d.path, count: d.count }))
  files.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  return [...dirNodes, ...files]
}

/** 单块最大字符数；评测脚本会改，线上默认 280 */
let chunkMaxChars = 280
/** 相邻块重叠字数；评测脚本会改，线上默认 60 */
let chunkOverlap = 60
/** 太短的块丢掉，避免空片段污染检索 */
const MIN_CHUNK_CHARS = 20
/**
 * 低于这个分当「没中」，返回空 hits，模型才被允许再搜一次。
 * 和「score > 0 就算命中」的差别：弱匹配（正文里碰巧出现一个词 +2）不再锁死答案。
 *
 * 对照打分：整句 +10 必过；标题词 +6 必过；标题 +6 且正文同词 +2 更高；只中正文一词 +2 不过。
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
 * 把一段过长的正文按字数窗口切开（只用于普通段落）
 * @param text  某一节下的正文
 * @param title 这一节标题（切出来的每块共用同一个 title）
 */
function splitOversized(
  text: string,
  title: string,
): Array<{ title: string; text: string }> {
  if (text.length <= chunkMaxChars) return [{ title, text }]

  const parts: Array<{ title: string; text: string }> = []
  const step = chunkMaxChars - chunkOverlap
  for (let i = 0; i < text.length; i += step) {
    const slice = text.slice(i, i + chunkMaxChars).trim()
    if (slice.length >= MIN_CHUNK_CHARS) parts.push({ title, text: slice })
    if (i + chunkMaxChars >= text.length) break
  }
  return parts
}

type Atom = { kind: 'table' | 'image' | 'prose'; text: string }

function isTableLine(line: string) {
  return /^\s*\|/.test(line)
}

function isImageLine(line: string) {
  return /^\s*!\[[^\]]*\]\([^)]+\)/.test(line)
}

function isImageCaption(line: string) {
  return /^\s*图中文字：/.test(line)
}

/**
 * 先抽出不可拆的原子块：整张表、整张图（含「图中文字」），其余才是可窗口切的散文。
 * 表/图一旦被字数窗口拦腰切断，行列对齐和 OCR 上下文都会丢。
 */
function segmentAtoms(body: string): Atom[] {
  const lines = body.split('\n')
  const atoms: Atom[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (isTableLine(line)) {
      const start = i
      while (i < lines.length && isTableLine(lines[i])) i += 1
      const text = lines.slice(start, i).join('\n').trim()
      if (text) atoms.push({ kind: 'table', text })
      continue
    }
    if (isImageLine(line)) {
      const parts = [line]
      i += 1
      while (i < lines.length && lines[i].trim() === '') {
        parts.push(lines[i])
        i += 1
      }
      if (i < lines.length && isImageCaption(lines[i])) {
        parts.push(lines[i])
        i += 1
      }
      const text = parts.join('\n').trim()
      if (text) atoms.push({ kind: 'image', text })
      continue
    }
    const start = i
    while (i < lines.length && !isTableLine(lines[i]) && !isImageLine(lines[i])) {
      i += 1
    }
    const text = lines.slice(start, i).join('\n').trim()
    if (text) atoms.push({ kind: 'prose', text })
  }
  return atoms
}

/** 表/图整块入库（可超过窗口）；散文仍走字数切分 */
function piecesFromBody(
  body: string,
  sectionTitle: string,
): Array<{ title: string; text: string }> {
  const pieces: Array<{ title: string; text: string }> = []
  for (const atom of segmentAtoms(body)) {
    if (atom.kind === 'table') {
      pieces.push({ title: `${sectionTitle} · 表`, text: atom.text })
      continue
    }
    if (atom.kind === 'image') {
      pieces.push({ title: `${sectionTitle} · 图`, text: atom.text })
      continue
    }
    pieces.push(...splitOversized(atom.text, sectionTitle))
  }
  return pieces
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

    pieces.push(...piecesFromBody(body, title))
  }

  return pieces
    .filter((p) => p.text.length >= MIN_CHUNK_CHARS || p.title.endsWith('· 图'))
    .map((p, i) => ({
      id: `${docId}-c${i + 1}`,
      docId,
      title: p.title,
      text: p.text,
    }))
}

/** 一篇文档的原始来源：还没切块的正文 */
export type DocSource = {
  docId: string
  title: string
  content: string
}

/**
 * 读全部文档的原始正文，但**不切块**。
 *
 * 定点更新就靠这个：先对内容算版本指纹，和索引里记的一致就整篇跳过，
 * 连切块都不用做。切块本身也要读文件 + 正则 + 分片，能省则省。
 */
export function listDocSources(): DocSource[] {
  const out: DocSource[] = []

  // 1) 内置项目说明
  for (const doc of BUILTIN_DOCS) {
    out.push({ docId: doc.docId, title: doc.title, content: doc.body })
  }

  // 2) 仓库根目录的求职补充手册（读失败只 warn，不阻断服务）
  try {
    out.push({
      docId: 'handbook',
      title: '求职补充手册',
      content: fs.readFileSync(HANDBOOK_PATH, 'utf8'),
    })
  } catch (err) {
    console.warn('[knowledge] 读取求职补充手册.md 失败:', err)
  }

  // 3) 用户上传：磁盘文件是 {docId}.md，原名在 manifest 里
  try {
    for (const rec of listUploadRecords()) {
      const content = readUploadContent(rec)
      if (content) out.push({ docId: rec.id, title: rec.originalName, content })
    }
  } catch (err) {
    console.warn('[knowledge] 读取 uploads 失败:', err)
  }

  return out
}

/** 读一篇上传文档的原始正文；文件不在返回空串 */
export function readUploadContent(rec: ManifestDoc): string {
  const full = path.join(UPLOAD_DIR, rec.storedAs)
  if (!fs.existsSync(full)) return ''
  return fs.readFileSync(full, 'utf8')
}

/** 只切这一篇 */
export function chunkDocSource(src: DocSource): KnowledgeChunk[] {
  return chunkMarkdown(src.docId, src.content, src.title)
}

/** 启动时加载全部文档并切块（内置说明 + 手册 + uploads） */
function loadAllChunks(): KnowledgeChunk[] {
  return listDocSources().flatMap(chunkDocSource)
}

/** 评测用：只切内置说明 + 手册，不掺用户上传（否则黄金集随你传的文件飘） */
export function loadCoreChunks(): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = []
  for (const doc of BUILTIN_DOCS) {
    chunks.push(...chunkMarkdown(doc.docId, doc.body, doc.title))
  }
  const handbookPath = HANDBOOK_PATH
  try {
    const raw = fs.readFileSync(handbookPath, 'utf8')
    chunks.push(...chunkMarkdown('handbook', raw, '求职补充手册'))
  } catch (err) {
    console.warn('[knowledge] 读取求职补充手册.md 失败:', err)
  }
  return chunks
}

/** 拿到全部 chunk（懒加载；启动后靠 replace/removeDocChunks 增量维护） */
export function getChunks(): KnowledgeChunk[] {
  if (!cached) {
    cached = loadAllChunks()
    rebuildDocAgg(cached)
  }
  return cached
}

export function getChunkParams() {
  return { maxChars: chunkMaxChars, overlap: chunkOverlap }
}

/**
 * 评测换窗口时调用：丢掉切块缓存，下次 getChunks 按新参数重切。
 * 不碰磁盘上的 index.json；重建向量由调用方决定。
 */
export function configureChunking(maxChars: number, overlap: number) {
  if (maxChars < 40) throw new Error('块长太小')
  if (overlap < 0 || overlap >= maxChars) throw new Error('overlap 必须 ≥0 且小于块长')
  chunkMaxChars = maxChars
  chunkOverlap = overlap
  cached = null
  docAgg = null
}

/**
 * 关键词检索 TopK（演示版 RAG，还没上向量库）
 *
 * 打分规则（可调）：
 *   - 整句 query 命中 title/text → +10
 *   - 每个 token（≥2 字）命中 title → +6，命中 text → +2
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
export function searchChunks(
  query: string,
  topK = 3,
  pool?: KnowledgeChunk[],
  minScore = MIN_HIT_SCORE,
): SearchHit[] {
  const q = query.toLowerCase().trim()
  if (!q) return []

  // 把问题拆成 token（中英文标点都当分隔符）
  const tokens = q
    .split(/[\s,，、?？!！。；;]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 1)

  const scored = (pool ?? getChunks())
    .map((chunk) => {
      const title = chunk.title.toLowerCase()
      const text = chunk.text.toLowerCase()
      let score = 0

      // 整句匹配权重最高
      if (title.includes(q) || text.includes(q)) score += 10

      // 分词匹配：标题命中比正文命中分更高
      for (const token of tokens) {
        if (token.length < 2) continue
        if (title.includes(token)) score += 6
        if (text.includes(token)) score += 2
      }

      return { chunk, score }
    })
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score) // 分数从高到低

  // 本轮局部编号：第 1 名 → [1]，第 2 名 → [2]…
  return scored.slice(0, topK).map((x, i) => ({
    ...x.chunk,
    citation: i + 1,
    score: x.score,
  }))
}
