/**
 * 迷你知识库（引用 RAG）
 *
 * 整条链路：
 *   读 .md 文档 → 切成 chunk（稳定 id）→ 改写 query → 关键词打分 → TopK
 *   citation 不在入库时全局编号，而在「本轮检索结果」里临时编成 1..K
 *   回答里的 [1][2] 只对应当次 hits；跨文档定位靠稳定的 chunk.id
 *
 * 被谁调用：tools.ts 的 searchNotes → executeTool('search_notes')
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 知识库里的一块文本（入库后的稳定结构，不含 citation） */
export type KnowledgeChunk = {
  /** 块唯一 id，如 handbook-3、project-2；文档增减时尽量保持稳定 */
  id: string
  /** 来自哪篇文档，如 handbook / project */
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

/** 单块最大字符数，太长就再切一刀 */
const MAX_CHUNK_CHARS = 280
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
  // 没超长：整段就是一块
  if (text.length <= MAX_CHUNK_CHARS) return [{ title, text }]

  const parts: Array<{ title: string; text: string }> = []
  // 步长 = MAX_CHUNK_CHARS，滑动窗口切分（演示用，生产可加 overlap 重叠）
  for (let i = 0; i < text.length; i += MAX_CHUNK_CHARS) {
    const slice = text.slice(i, i + MAX_CHUNK_CHARS).trim()
    if (slice.length >= MIN_CHUNK_CHARS) parts.push({ title, text: slice })
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

  // 稳定 id：同一 doc 内按切块顺序编号（handbook-1, handbook-2…）
  return pieces.map((p, i) => ({
    id: `${docId}-${i + 1}`,
    docId,
    title: p.title,
    text: p.text,
  }))
}

/** 启动时加载全部文档并切块（内置说明 + 求职补充手册.md） */
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

  // 不再做全局 citation=1..N；编号改到 searchChunks 本轮结果里
  return chunks
}

/** 内存缓存：只 load 一次，避免每次 search 都读盘切分 */
let cached: KnowledgeChunk[] | null = null

/** 拿到全部 chunk（懒加载 + 缓存） */
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
