/**
 * 检索入口：优先向量，失败或低分则回退关键词
 *
 * 生产对应：embed(query) → 向量库 ANN TopK → 关键词 RRF → 对候选 rerank

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
  chunkOnDiskDoc,
  deleteUploadByDocId,
  ensureDataDirs,
  getChunks,
  removeDocChunks,
  replaceDocChunks,
  rewriteQuery,
  searchChunks,
  type KnowledgeChunk,
  type ManifestDoc,
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
let readyMode: 'hybrid' | 'keyword' = 'keyword'

/** 上传和启动建索引可能重叠，串行化避免后写的全量结果把刚 upsert 的文档盖掉 */
let indexChain: Promise<void> = Promise.resolve()

function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = indexChain.then(fn)
  indexChain = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

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
  removeDocChunks(docId)
  await withIndexLock(async () => {
    if (readyMode === 'keyword' && memory !== null && memory.length === 0) return
    const items = memory ?? readIndexItems()
    persistItems(items.filter((it) => it.docId !== docId))
    console.log(`[rag] 删除 ${docId} 其余 chunks=${memory?.length ?? 0}`)
  })
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

function readIndexItems(): IndexItem[] {
  try {
    if (!fs.existsSync(INDEX_PATH)) return []
    const file = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')) as IndexFile
    if (file.embeddingModel !== EMBEDDING_MODEL || !Array.isArray(file.items)) return []
    return file.items
  } catch {
    return []
  }
}

function persistItems(items: IndexItem[]): void {
  memory = items
  fs.writeFileSync(
    INDEX_PATH,
    JSON.stringify({ embeddingModel: EMBEDDING_MODEL, items }),
  )
}

async function embedMissing(
  chunks: KnowledgeChunk[],
  prev: Map<string, IndexItem>,
): Promise<IndexItem[]> {
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
  return next
}

/**
 * 启动全量对账：磁盘有的块都在索引里，磁盘没有的从索引丢掉。
 * 上传/删除不要走这里，走 ingestUploadedDoc / deleteUploadedFile。
 */
export async function ensureIndex(): Promise<void> {
  return withIndexLock(rebuildIndex)
}

async function rebuildIndex(): Promise<void> {
  ensureDataDirs()
  const ok = await tryLoadEmbedder()
  if (!ok) {
    readyMode = 'keyword'
    memory = []
    return
  }

  const chunks = getChunks()
  const prev = new Map(readIndexItems().map((it) => [it.id, it]))
  persistItems(await embedMissing(chunks, prev))
  readyMode = 'hybrid'
  console.log(`[rag] 索引就绪 chunks=${memory?.length ?? 0} mode=hybrid`)
}

/** 只切并索引这一篇，其它文档的块和向量原样保留 */
export async function ingestUploadedDoc(rec: ManifestDoc): Promise<void> {
  const chunks = chunkOnDiskDoc(rec)
  replaceDocChunks(rec.id, chunks)
  await withIndexLock(async () => {
    const ok = await tryLoadEmbedder()
    if (!ok) {
      readyMode = 'keyword'
      return
    }
    const current = memory ?? readIndexItems()
    const kept = current.filter((it) => it.docId !== rec.id)
    const prev = new Map(current.map((it) => [it.id, it]))
    const upserted = await embedMissing(chunks, prev)
    persistItems([...kept, ...upserted])
    readyMode = 'hybrid'
    console.log(
      `[rag] upsert ${rec.id} chunks=${chunks.length} indexed=${memory?.length ?? 0}`,
    )
  })
}

export type RetrieveResult = {
  mode: 'hybrid' | 'keyword'
  query: string
  query_used: string
  rewrite_terms: string[]
  hits: SearchHit[]
}

/** 只编码进内存，不写 index.json。评测扫切块参数时用，避免把线上索引打乱。 */
export async function indexChunksInMemory(
  chunks: KnowledgeChunk[],
): Promise<IndexItem[]> {
  const ok = await tryLoadEmbedder()
  if (!ok) {
    throw new Error(getEmbedError() || 'embedding 模型不可用')
  }
  return embedMissing(chunks, new Map())
}

export async function searchVectors(
  query: string,
  items: IndexItem[],
  topK: number,
  minCosine = MIN_COSINE,
): Promise<SearchHit[]> {
  if (items.length === 0) return []
  const qv = await embedQuery(query)
  return items
    .map((item) => ({ item, score: cosine(qv, item.embedding) }))
    .filter((x) => x.score >= minCosine)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((x, i) => ({
      id: x.item.id,
      docId: x.item.docId,
      title: x.item.title,
      text: x.item.text,
      citation: i + 1,
      score: Math.round(x.score * 1000) / 1000,
    }))
}

/** RRF：两路排名各自 1/(k+rank)，同分相加。不用把余弦和关键词分硬加成一个数。 */
const RRF_K = 60
const HYBRID_POOL = 10

export function fuseRrf(
  lists: SearchHit[][],
  topK: number,
  weights?: number[],
): SearchHit[] {
  const scores = new Map<string, { hit: SearchHit; rrf: number; vecRank: number }>()
  lists.forEach((list, li) => {
    const w = weights?.[li] ?? 1
    list.forEach((hit, rank) => {
      const add = w / (RRF_K + rank + 1)
      const prev = scores.get(hit.id)
      if (prev) {
        prev.rrf += add
        if (li === 0) prev.vecRank = rank
      } else {
        scores.set(hit.id, {
          hit,
          rrf: add,
          vecRank: li === 0 ? rank : 999,
        })
      }
    })
  })
  return Array.from(scores.values())
    .sort((a, b) => b.rrf - a.rrf || a.vecRank - b.vecRank)
    .slice(0, topK)
    .map((x, i) => ({
      ...x.hit,
      citation: i + 1,
      score: Math.round(x.rrf * 1000) / 1000,
    }))
}

/**
 * 问句和块的字面重叠（3 字滑动窗口）。
 * 标题匹配权重大：learn 的「每天优先学」在第 5 节标题里，不在第 1 节标题里。
 * 生产里这一步常换成交叉编码器 rerank（query+chunk 成对打分）。
 */
export function rerankScore(query: string, hit: SearchHit): number {
  const qg = new Set(charNgrams(query, 3))
  if (qg.size === 0) return 0
  const title = hit.title.replace(/^\d+\.\s*/, '').replace(/[（(].*$/, '')
  let titleHits = 0
  for (const g of charNgrams(title, 3)) if (qg.has(g)) titleHits += 1
  let bodyHits = 0
  for (const g of charNgrams(hit.text.slice(0, 160), 3)) if (qg.has(g)) bodyHits += 1
  return titleHits * 3 + bodyHits
}

function charNgrams(raw: string, n: number): string[] {
  const t = raw.toLowerCase().replace(/[\s\d.?？!！。,，、:：;；()（）[\]《》`]/g, '')
  if (t.length === 0) return []
  if (t.length < n) return [t]
  const out: string[] = []
  for (let i = 0; i <= t.length - n; i += 1) out.push(t.slice(i, i + n))
  return out
}

async function hybridPool(
  query: string,
  items: IndexItem[],
  pool: number,
): Promise<SearchHit[]> {
  const rewritten = rewriteQuery(query)
  const vec = await searchVectors(query, items, pool, 0)
  const kw = searchChunks(rewritten.rewritten, pool, items, 4)
  return fuseRrf([vec, kw], pool, [1, 1])
}

/**
 * 向量原句 + 关键词改写 → RRF。标题含改写词的往前（救 stack）。
 */
export async function searchHybrid(
  query: string,
  items: IndexItem[],
  topK: number,
): Promise<SearchHit[]> {
  const rewritten = rewriteQuery(query)
  const terms = rewritten.terms
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2)
  const fused = await hybridPool(query, items, Math.max(topK, HYBRID_POOL))
  const titleHit = (h: SearchHit) =>
    terms.some((t) => h.title.toLowerCase().includes(t)) ? 1 : 0
  return fused
    .sort((a, b) => titleHit(b) - titleHit(a) || b.score - a.score)
    .slice(0, topK)
    .map((h, i) => ({ ...h, citation: i + 1 }))
}

/**
 * 在 hybrid 候选上按「原句和标题/正文的字面重叠」重排。
 * 评测里应能把 learn 从第 1 节改排到第 5 节。
 */
export async function searchRerank(
  query: string,
  items: IndexItem[],
  topK: number,
): Promise<SearchHit[]> {
  const rewritten = rewriteQuery(query)
  const terms = rewritten.terms
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2)
  const fused = await hybridPool(query, items, Math.max(topK, HYBRID_POOL))
  const titleTerm = (h: SearchHit) =>
    terms.some((t) => h.title.toLowerCase().includes(t)) ? 1 : 0
  return fused
    .map((h) => ({ h, t: titleTerm(h), n: rerankScore(query, h) }))
    .sort((a, b) => b.t - a.t || b.n - a.n || b.h.score - a.h.score)
    .slice(0, topK)
    .map((x, i) => ({ ...x.h, citation: i + 1, score: x.n }))
}

/**
 * 检索用小块（准），给模型时带上同一文档的前一块+后一块（上下文）。
 * 生产里常叫 small-to-big / parent document：召回 child，生成用 parent。
 */
export function expandWithNeighbors(
  hits: SearchHit[],
  pool: KnowledgeChunk[],
): SearchHit[] {
  const byId = new Map(pool.map((c) => [c.id, c]))
  return hits.map((h) => {
    const m = h.id.match(/^(.*)-c(\d+)$/)
    if (!m) return { ...h, context: h.text }
    const prefix = m[1]
    const n = Number(m[2])
    const parts: string[] = []
    for (const i of [n - 1, n, n + 1]) {
      const c = byId.get(`${prefix}-c${i}`)
      if (c?.text) parts.push(c.text)
    }
    return { ...h, context: parts.join('\n\n') || h.text }
  })
}

/**
 * 有向量就 hybrid；模型挂了才纯关键词。
 */
export async function retrieve(query: string, topK = 3): Promise<RetrieveResult> {
  const rewritten = rewriteQuery(query)
  if (memory === null) await ensureIndex()

  if (readyMode === 'hybrid' && memory && memory.length > 0) {
    const ranked = await searchRerank(query, memory, topK)
    if (ranked.length > 0) {
      return {
        mode: 'hybrid',
        query: rewritten.original,
        query_used: query,
        rewrite_terms: rewritten.terms,
        hits: expandWithNeighbors(ranked, memory),
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
