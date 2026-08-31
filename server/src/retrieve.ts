/**
 * 检索入口：优先向量，失败或低分则回退关键词
 *
 * 生产对应：embed(query) → 向量库 ANN TopK → （本课还没有）rerank
 * 本课向量库 = 内存 + server/data/index.json，文档量小时和 ANN 效果等价，便于看清公式。
 */
import fs from 'node:fs'
import {
  EMBEDDING_MODEL,
  embedDocuments,
  embedQuery,
  getEmbedError,
  tryLoadEmbedder,
} from './embed.js'
import {
  INDEX_PATH,
  deleteUploadByDocId,
  ensureDataDirs,
  getChunks,
  invalidateChunks,
  rewriteQuery,
  searchChunks,
  type KnowledgeChunk,
  type SearchHit,
} from './knowledge.js'

type IndexItem = KnowledgeChunk & { embedding: number[] }

type IndexFile = {
  embeddingModel: string
  items: IndexItem[]
}

/** 余弦相似度下限（向量已 L2 normalize 时，余弦 = 点积） */
const MIN_COSINE = 0.32

let memory: IndexItem[] | null = null
let readyMode: 'vector' | 'keyword' = 'keyword'

export function getRagStatus() {
  const chunks = getChunks()
  const dim = memory?.[0]?.embedding.length ?? 0
  return {
    chunks: chunks.length,
    docs: new Set(chunks.map((c) => c.docId)).size,
    retrieval: readyMode,
    embedding: EMBEDDING_MODEL,
    indexed: memory?.length ?? 0,
    dim,
    embedError: getEmbedError(),
  }
}

export type IndexRow = {
  id: string
  docId: string
  title: string
  /** 块开头，用来和下一块的 head 对照 overlap */
  head: string
  /** 块太长才有：结尾。和上一块的 tail 对照能看出怎么切的 */
  tail: string | null
  chars: number
  dim: number
  vectorHead: number[]
}

const PREVIEW_EDGE = 80

function headAndTail(text: string): { head: string; tail: string | null; chars: number } {
  const chars = text.length
  if (chars <= PREVIEW_EDGE * 2 + 10) {
    return { head: text, tail: null, chars }
  }
  return {
    head: text.slice(0, PREVIEW_EDGE),
    tail: text.slice(-PREVIEW_EDGE),
    chars,
  }
}

/** 给向量库页看的索引摘要：不把整条向量吐给前端 */
export function listIndexRows(): IndexRow[] {
  return (memory ?? []).map((item) => ({
    id: item.id,
    docId: item.docId,
    title: item.title,
    ...headAndTail(item.text),
    dim: item.embedding.length,
    vectorHead: item.embedding.slice(0, 48).map((n) => Math.round(n * 1000) / 1000),
  }))
}

export async function deleteUploadedFile(docId: string): Promise<void> {
  deleteUploadByDocId(docId)
  invalidateChunks()
  await ensureIndex()
}

/** 点积 / (|a||b|)；normalize 过的向量 ≈ 点积。写完整公式方便口述 */
export function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

/**
 * 增量建索引：文本没变的 chunk 复用旧向量，只 embed 新增/改动的。
 * 生产里对应向量库 upsert（按 chunk.id）。
 */
export async function ensureIndex(): Promise<void> {
  ensureDataDirs()
  const ok = await tryLoadEmbedder()
  if (!ok) {
    readyMode = 'keyword'
    memory = []
    return
  }

  const chunks = getChunks()
  let file: IndexFile = { embeddingModel: EMBEDDING_MODEL, items: [] }
  try {
    if (fs.existsSync(INDEX_PATH)) {
      file = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')) as IndexFile
    }
  } catch {
    file = { embeddingModel: EMBEDDING_MODEL, items: [] }
  }

  const prev = new Map(
    file.embeddingModel === EMBEDDING_MODEL
      ? file.items.map((it) => [it.id, it])
      : [],
  )

  const next: IndexItem[] = []
  const toEmbed: KnowledgeChunk[] = []
  for (const chunk of chunks) {
    const old = prev.get(chunk.id)
    if (old && old.text === chunk.text && old.embedding?.length) {
      next.push(old)
    } else {
      toEmbed.push(chunk)
    }
  }

  if (toEmbed.length) {
    console.log(`[rag] 编码 ${toEmbed.length} 个新/变更 chunk`)
    const vectors = await embedDocuments(toEmbed.map((c) => c.text))
    for (let i = 0; i < toEmbed.length; i += 1) {
      next.push({ ...toEmbed[i], embedding: vectors[i] })
    }
  }

  memory = next
  fs.writeFileSync(
    INDEX_PATH,
    JSON.stringify({ embeddingModel: EMBEDDING_MODEL, items: next }),
  )
  readyMode = 'vector'
  console.log(`[rag] 索引就绪 chunks=${next.length} mode=vector`)
}

export type RetrieveResult = {
  mode: 'vector' | 'keyword'
  query: string
  query_used: string
  rewrite_terms: string[]
  hits: SearchHit[]
}

/**
 * 向量检索用「原句」（语义能理解短板≈缺口）。
 * 关键词回退才走 rewriteQuery。
 */
export async function retrieve(query: string, topK = 3): Promise<RetrieveResult> {
  const rewritten = rewriteQuery(query)
  await ensureIndex()

  if (readyMode === 'vector' && memory && memory.length > 0) {
    const qv = await embedQuery(query)
    const scored = memory
      .map((item) => ({ item, score: cosine(qv, item.embedding) }))
      .filter((x) => x.score >= MIN_COSINE)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)

    if (scored.length > 0) {
      return {
        mode: 'vector',
        query: rewritten.original,
        query_used: query,
        rewrite_terms: rewritten.terms,
        hits: scored.map((x, i) => ({
          id: x.item.id,
          docId: x.item.docId,
          title: x.item.title,
          text: x.item.text,
          citation: i + 1,
          score: Math.round(x.score * 1000) / 1000,
        })),
      }
    }
  }

  const hits = searchChunks(rewritten.rewritten, topK)
  return {
    mode: 'keyword',
    query: rewritten.original,
    query_used: rewritten.rewritten,
    rewrite_terms: rewritten.terms,
    hits,
  }
}
