/**
 * 检索入口：优先向量，失败或低分则回退关键词
 *
 * 生产对应：embed(query) → 向量库 ANN TopK → 关键词 RRF → 对候选 rerank

 * 本课向量库 = 内存 + server/data/index.json，文档量小时和 ANN 效果等价，便于看清公式。
 */
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import {
  EMBEDDING_MODEL,
  embedDocuments,
  embedQuery,
  getEmbedError,
  tryLoadEmbedder,
} from './embed.js'
import {
  INDEX_PATH,
  chunkDocSource,
  chunkOnDiskDoc,
  deleteUploadByDocId,
  ensureDataDirs,
  getChunks,
  getDocMetaMap,
  listDocSources,
  readUploadContent,
  removeDocChunks,
  replaceDocChunks,
  rewriteQuery,
  searchChunks,
  upsertWikiUpload,
  type KnowledgeChunk,
  type ManifestDoc,
  type SearchHit,
} from './knowledge.js'
import { annotateImageText } from './imageText.js'
import {
  getImageIndexStatus,
  indexDocImages,
  removeDocImages,
  searchImages,
} from './imageIndex.js'
import { listWikiFiles, readWikiDoc } from './wiki.js'
import { normalizeWeworkMarkdown } from './weworkMarkdown.js'
import { VECTOR_ENCODING, decodeVector, encodeVector } from './vectorCodec.js'

type IndexItem = KnowledgeChunk & { embedding: number[] }

/** 落盘形态：向量编码成 base64，不用 float 文本数组（体积和解析都差好几倍） */
type StoredItem = {
  id: string
  docId: string
  title: string
  text: string
  /** base64 的 float32；老索引这里是 embedding: number[]，读取时兼容 */
  v?: string
  embedding?: number[]
}

/**
 * 一篇文档在索引里的状态。
 * version = 正文内容的 sha1 前 16 位。内容没变就是同一个版本，
 * 启动对账时整篇原样复用——不切块、不编码、不写向量。
 */
type DocVersion = {
  version: string
  /** 这篇文档上一次索引时有几块，用来发现「块数对不上」的异常 */
  chunks: number
  indexedAt?: string
}

type IndexFile = {
  embeddingModel: string
  vectorEncoding?: string
  /** docId → 版本。老索引没这个字段，当成「全部未知」重算一次即可 */
  docVersions?: Record<string, DocVersion>
  items: StoredItem[]
}

/** 余弦相似度下限（向量已 L2 normalize 时，余弦 = 点积） */
const MIN_COSINE = 0.32

let memory: IndexItem[] | null = null
/** docId → 该文档的向量块；persist 时重建，分页按文档过滤时 O(该文档) 而不是扫全库 */
let memoryByDoc: Map<string, IndexItem[]> = new Map()
let readyMode: 'hybrid' | 'keyword' = 'keyword'
/** docId → 版本指纹；写索引文件时一起落盘 */
let docVersions: Record<string, DocVersion> = {}

/** 上传和启动建索引可能重叠，串行化避免后写的全量结果把刚 upsert 的文档盖掉 */
let indexChain: Promise<void> = Promise.resolve()

function rebuildMemoryByDoc(items: IndexItem[]) {
  const map = new Map<string, IndexItem[]>()
  for (const item of items) {
    const list = map.get(item.docId)
    if (list) list.push(item)
    else map.set(item.docId, [item])
  }
  memoryByDoc = map
}

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
  const images = getImageIndexStatus()
  return {
    chunks: chunks.length,
    docs: memoryByDoc.size || ensureDocCountFallback(chunks),
    retrieval: readyMode,
    embedding: EMBEDDING_MODEL,
    indexed: memory?.length ?? 0,
    dim,
    embedError: getEmbedError(),
    images: images.images,
    imageModel: images.model,
    imageDim: images.dim,
  }
}

function ensureDocCountFallback(chunks: KnowledgeChunk[]): number {
  const seen = new Set<string>()
  for (const c of chunks) seen.add(c.docId)
  return seen.size
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
  return (memory ?? []).map(toIndexRow)
}

function toIndexRow(item: IndexItem): IndexRow {
  return {
    id: item.id,
    docId: item.docId,
    title: item.title,
    ...headAndTail(item.text),
    dim: item.embedding.length,
    // 色条只要 16 维够了，少传一半 JSON
    vectorHead: item.embedding.slice(0, 16).map((n) => Math.round(n * 1000) / 1000),
  }
}

export function listIndexRowsPage(options: {
  docId?: string | null
  q?: string
  offset?: number
  limit?: number
}): { total: number; offset: number; limit: number; chunks: IndexRow[] } {
  const q = (options.q ?? '').trim().toLowerCase()
  const docId = options.docId || null
  const offset = Math.max(0, options.offset ?? 0)
  const limit = Math.min(200, Math.max(1, options.limit ?? 50))

  const pool = docId ? memoryByDoc.get(docId) ?? [] : memory ?? []
  let filtered: IndexItem[]
  if (!q) {
    filtered = pool
  } else {
    filtered = []
    for (const item of pool) {
      const hit =
        item.id.toLowerCase().includes(q) ||
        item.docId.toLowerCase().includes(q) ||
        item.title.toLowerCase().includes(q) ||
        item.text.toLowerCase().includes(q)
      if (hit) filtered.push(item)
    }
  }
  return {
    total: filtered.length,
    offset,
    limit,
    chunks: filtered.slice(offset, offset + limit).map(toIndexRow),
  }
}

export async function deleteUploadedFile(docId: string): Promise<void> {
  deleteUploadByDocId(docId)
  removeDocChunks(docId)
  removeDocImages(docId)
  await withIndexLock(async () => {
    if (readyMode === 'keyword' && memory !== null && memory.length === 0) return
    const items = memory ?? readIndexItems()
    delete docVersions[docId]
    await persistItems(items.filter((it) => it.docId !== docId))
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

/** 读：base64 解码；老格式的 float 数组照样读得进来，下次落盘自动转成 base64 */
function fromStored(item: StoredItem): IndexItem {
  return {
    id: item.id,
    docId: item.docId,
    title: item.title,
    text: item.text,
    embedding: item.v ? decodeVector(item.v) : item.embedding ?? [],
  }
}

function toStored(item: IndexItem): StoredItem {
  return {
    id: item.id,
    docId: item.docId,
    title: item.title,
    text: item.text,
    v: encodeVector(item.embedding),
  }
}

/** 内容的版本指纹。只哈希正文，和切块方式无关 */
export function docVersion(content: string): string {
  return createHash('sha1').update(content).digest('hex').slice(0, 16)
}

/**
 * 读一次索引文件（32MB，解析要几十毫秒，别读两遍）。
 * 模型换了就当没有——不同模型的向量不能混用。
 */
function readIndexFile(): IndexFile | null {
  try {
    if (!fs.existsSync(INDEX_PATH)) return null
    const file = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')) as IndexFile
    if (file.embeddingModel !== EMBEDDING_MODEL || !Array.isArray(file.items)) return null
    return file
  } catch {
    return null
  }
}

function readIndexItems(): IndexItem[] {
  return readIndexFile()?.items.map(fromStored) ?? []
}

/** 只写索引文件，不动内存；既给最终落盘用，也给中途断点用 */
async function writeIndexFile(items: IndexItem[]): Promise<void> {
  // 先写临时文件再 rename：写到一半被 Ctrl-C / 重启，也不会留下半截 JSON 把索引读废。
  //
  // 临时名必须带 pid：改名只对「单写者」是原子的。tsx watch 改一次源码就重启一次，
  // 每次启动都跑 ensureIndex → 写 35.9MB，两个实例叠一起时
  // A 写 tmp、B 写同一个 tmp、A rename 成功、B rename 就 ENOENT
  // ——实测踩过（服务日志里 rename 报 ENOENT，索引本身没坏，但那次启动的
  // readyMode 停在 keyword，整个检索退化成纯关键词）。withIndexLock 是进程内的锁，
  // 跨进程不管用，只能靠文件名分开。pid 会随进程退出被回收，不会攒垃圾。
  const tmp = `${INDEX_PATH}.${process.pid}.tmp`
  try {
    await fs.promises.writeFile(
      tmp,
      JSON.stringify({
        embeddingModel: EMBEDDING_MODEL,
        vectorEncoding: VECTOR_ENCODING,
        docVersions,
        items: items.map(toStored),
      }),
    )
    await fs.promises.rename(tmp, INDEX_PATH)
  } catch (err) {
    // 写失败不能把 tmp 留在盘上（下次启动会看见一个假的 index.json.*.tmp）
    await fs.promises.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

async function persistItems(items: IndexItem[]): Promise<void> {
  memory = items
  rebuildMemoryByDoc(items)
  await writeIndexFile(items)
}

/** 编码中断点落盘间隔。编码要跑几分钟，中途存一次，重启用不着从头再来 */
const CHECKPOINT_MS = 30_000

/**
 * 向量缓存的键只看文本。
 * 不能用 chunk.id：它是 {docId}-c{序号}，文档中间插一段，后面所有块的序号都位移，
 * 按 id 查会全部落空，明明内容没变的块也得重算。内容的哈希才是「同一个块」的正确定义。
 */
export function contentKey(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16)
}

/** 把已索引的块按内容哈希建成缓存表 */
function buildCache(items: IndexItem[]): Map<string, IndexItem> {
  return new Map(items.map((it) => [contentKey(it.text), it]))
}

async function embedMissing(
  chunks: KnowledgeChunk[],
  prev: Map<string, IndexItem>,
): Promise<{ items: IndexItem[]; embedded: number }> {
  const next: IndexItem[] = []
  const toEmbed: KnowledgeChunk[] = []
  for (const chunk of chunks) {
    const old = prev.get(contentKey(chunk.text))
    if (old && old.embedding?.length) {
      // 向量能复用，但标题等元数据要以这次切块为准，否则改标题不会生效
      next.push({ ...chunk, embedding: old.embedding })
    } else {
      toEmbed.push(chunk)
    }
  }
  if (!toEmbed.length) return { items: next, embedded: 0 }

  console.log(`[rag] 编码 ${toEmbed.length} 个新/变更 chunk（共 ${chunks.length}）`)
  const started = Date.now()
  for (let i = 0; i < toEmbed.length; i += 1) {
    const [vector] = await embedDocuments([toEmbed[i].text])
    next.push({ ...toEmbed[i], embedding: vector })
    if ((i + 1) % 200 === 0) {
      console.log(
        `[rag]   …${i + 1}/${toEmbed.length}，已用 ${Math.round((Date.now() - started) / 1000)}s`,
      )
    }
  }
  return { items: next, embedded: toEmbed.length }
}

export type ResyncStats = {
  /** 磁盘上的文档总数 */
  docs: number
  /** 内容指纹没变、整篇复用的文档数 */
  reused: number
  /** 指纹变了、重新切块编码的文档数 */
  reindexed: number
  /** 真正跑了模型的 chunk 数 */
  embedded: number
  /** 磁盘上已经没有、从索引里丢掉的文档数 */
  dropped: number
  /** 这次变动的文档名（最多 20 个，够看是谁在动） */
  changed: string[]
  elapsedMs: number
}

/**
 * 启动对账 + 「重新扫描」都走这里。
 *
 * 按文档对账，不是按 chunk：先用正文的 sha1 比版本指纹，
 * 没变的文档整篇连块带向量搬过来（不切块、不编码、不写），
 * 只有指纹变了的文档才重新切块 + 编码。
 * 一篇 wiki 改动 → 只重算那一篇，其余 556 篇零开销。
 *
 * 上传/删除单篇不要走这里，走 ingestUploadedDoc / deleteUploadedFile。
 */
async function rebuildIndex(): Promise<ResyncStats> {
  const started = Date.now()
  const stats: ResyncStats = {
    docs: 0,
    reused: 0,
    reindexed: 0,
    embedded: 0,
    dropped: 0,
    changed: [],
    elapsedMs: 0,
  }
  ensureDataDirs()
  const ok = await tryLoadEmbedder()
  if (!ok) {
    readyMode = 'keyword'
    memory = []
    memoryByDoc = new Map()
    docVersions = {}
    return stats
  }

  const file = readIndexFile()
  const prevItems = file?.items.map(fromStored) ?? []
  const savedVersions = file?.docVersions ?? {}

  // 上一次的块按文档分好：重算某一篇时，只喂它自己的旧块做内容缓存
  const prevByDoc = new Map<string, IndexItem[]>()
  for (const it of prevItems) {
    const list = prevByDoc.get(it.docId)
    if (list) list.push(it)
    else prevByDoc.set(it.docId, [it])
  }

  const sources = listDocSources()
  stats.docs = sources.length

  // 以旧索引为底，逐篇原位替换。这样中途落盘时，还没轮到的文档
  // 仍是旧的完好数据 + 旧的版本号，重启后不会被判成「未知」而白算一遍。
  const next: IndexItem[] = [...prevItems]
  const versions: Record<string, DocVersion> = { ...savedVersions }
  const onDisk = new Set<string>()
  let lastSave = started

  for (const src of sources) {
    onDisk.add(src.docId)
    const saved = savedVersions[src.docId]
    const old = prevByDoc.get(src.docId) ?? []
    const version = docVersion(src.content)

    // 版本一致 + 块数对得上 → 这篇一个字没动，next 里已经是它的旧向量
    if (saved?.version === version && old.length === saved.chunks) {
      stats.reused += 1
      continue
    }

    const chunks = chunkDocSource(src)
    const { items, embedded } = await embedMissing(chunks, buildCache(old))
    for (let i = next.length - 1; i >= 0; i -= 1) {
      if (next[i].docId === src.docId) next.splice(i, 1)
    }
    next.push(...items)
    versions[src.docId] = {
      version,
      chunks: items.length,
      indexedAt: new Date().toISOString(),
    }
    stats.reindexed += 1
    stats.embedded += embedded
    if (stats.changed.length < 20) stats.changed.push(src.title || src.docId)

    // 篇粒度落盘：每篇都是完整的，随时中断都不会留下半篇
    if (Date.now() - lastSave >= CHECKPOINT_MS) {
      lastSave = Date.now()
      await writeIndexFile(next)
      console.log(
        `[rag] 断点：重算 ${stats.reindexed} 篇，落盘 ${next.length} 条，已用 ${Math.round((Date.now() - started) / 1000)}s`,
      )
    }
  }

  // 磁盘上已经没有的文档：块和版本号一起丢掉
  for (const docId of Object.keys(versions)) {
    if (onDisk.has(docId)) continue
    for (let i = next.length - 1; i >= 0; i -= 1) {
      if (next[i].docId === docId) next.splice(i, 1)
    }
    delete versions[docId]
    stats.dropped += 1
  }

  docVersions = versions
  await persistItems(next)
  readyMode = 'hybrid'
  stats.elapsedMs = Date.now() - started

  if (stats.reindexed || stats.dropped) {
    console.log(
      `[rag] 变动文档 ${stats.reindexed} 篇（编码 ${stats.embedded} 块）：${stats.changed.join('、')}${stats.reindexed > stats.changed.length ? ' …' : ''}`,
    )
    if (stats.dropped) console.log(`[rag] 移除已删除文档 ${stats.dropped} 篇`)
  }
  console.log(
    `[rag] 索引就绪 文档=${stats.docs}（复用 ${stats.reused} / 重算 ${stats.reindexed}）chunks=${next.length} 用时=${stats.elapsedMs}ms`,
  )
  return stats
}

/** 启动时按需建索引（内存空的时候才真跑） */
export async function ensureIndex(): Promise<void> {
  return withIndexLock(async () => {
    await rebuildIndex()
  })
}

/**
 * 手动「重新扫描」：重新对账磁盘上的文档，只重算内容变了的那些。
 * 定时器或接口都可以直接调，重复调没副作用（没变就什么都不编码）。
 */
export async function resyncIndex(): Promise<ResyncStats> {
  return withIndexLock(rebuildIndex)
}

export function getDocVersions(): Record<string, DocVersion> {
  return docVersions
}

export type DocVersionRow = {
  docId: string
  title: string
  /** 索引里记录的版本；null = 还没索引过 */
  version: string | null
  /** 当前磁盘内容的版本 */
  current: string
  chunks: number
  indexedAt: string | null
  /** 磁盘内容变了、还没重算 */
  stale: boolean
}

/** 每篇文档的版本对照：哪篇被改过、还没重新向量化，一眼能看出来 */
export function listDocVersionRows(): DocVersionRow[] {
  return listDocSources().map((src) => {
    const saved = docVersions[src.docId]
    const current = docVersion(src.content)
    return {
      docId: src.docId,
      title: src.title,
      version: saved?.version ?? null,
      current,
      chunks: saved?.chunks ?? 0,
      indexedAt: saved?.indexedAt ?? null,
      stale: saved?.version !== current,
    }
  })
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
    const prev = buildCache(current)
    const { items: upserted } = await embedMissing(chunks, prev)
    // 顺手记版本：下次启动对账就能认出这篇没变，整篇跳过
    docVersions[rec.id] = {
      version: docVersion(readUploadContent(rec)),
      chunks: upserted.length,
      indexedAt: new Date().toISOString(),
    }
    await persistItems([...kept, ...upserted])
    readyMode = 'hybrid'
    console.log(
      `[rag] upsert ${rec.id} chunks=${chunks.length} indexed=${memory?.length ?? 0}`,
    )
  })
}

export type WikiIngestStatus = {
  running: boolean
  done: number
  total: number
  current: string
  ok: number
  failed: number
  error: string | null
  finishedAt: string | null
}

let wikiJob: WikiIngestStatus = {
  running: false,
  done: 0,
  total: 0,
  current: '',
  ok: 0,
  failed: 0,
  error: null,
  finishedAt: null,
}

export function getWikiIngestStatus(): WikiIngestStatus {
  return { ...wikiJob }
}

/** 单篇 wiki → 规范化 → 读图里的字 → uploads → 切块编码 → CLIP 图片索引 */
export async function ingestWikiPath(relPath: string): Promise<{ docId: string; chunks: number }> {
  const doc = readWikiDoc(relPath)
  const normalized = normalizeWeworkMarkdown(doc.content)
  if (normalized.length < 20) throw new Error('正文太短，跳过')
  const content = await annotateImageText(normalized)
  const rec = upsertWikiUpload(doc.path, content)
  await ingestUploadedDoc(rec)
  const chunks = chunkOnDiskDoc(rec)
  await indexDocImages(rec.id, content, rec.originalName)
  return { docId: rec.id, chunks: chunks.length }
}

/**
 * 批量入库。prefix 空=整库；limit 限制篇数（本机 BGE 很慢，先小批量试）。
 * 后台跑，用 getWikiIngestStatus 看进度。
 */
export function startWikiIngest(options: { prefix?: string; limit?: number } = {}): WikiIngestStatus {
  if (wikiJob.running) throw new Error('已有入库任务在跑')
  let files = listWikiFiles(options.prefix ?? '')
  if (options.limit && options.limit > 0) files = files.slice(0, options.limit)
  if (files.length === 0) throw new Error('没有可入库的文档')

  wikiJob = {
    running: true,
    done: 0,
    total: files.length,
    current: '',
    ok: 0,
    failed: 0,
    error: null,
    finishedAt: null,
  }

  void (async () => {
    for (const rel of files) {
      wikiJob.current = rel
      try {
        await ingestWikiPath(rel)
        wikiJob.ok += 1
      } catch (err) {
        wikiJob.failed += 1
        console.warn(`[wiki-ingest] 失败 ${rel}:`, err instanceof Error ? err.message : err)
      }
      wikiJob.done += 1
    }
    wikiJob.running = false
    wikiJob.current = ''
    wikiJob.finishedAt = new Date().toISOString()
    console.log(`[wiki-ingest] 完成 ok=${wikiJob.ok} failed=${wikiJob.failed}`)
  })()

  return getWikiIngestStatus()
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
  return (await embedMissing(chunks, new Map())).items
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
/** 聚合后每篇最多留几块：够拼出这一篇的上下文就行，多了会把别的篇挤掉 */
const CHUNKS_PER_DOC = 2

/**
 * 要凑够 topK 篇，先得捞多少条块级候选。
 * 同一篇的多个块会被聚合成一个名额，按 3 倍留余量，再多和 RRF 池取大。
 */
export function HYBRID_CANDIDATES(topK: number): number {
  return Math.max(topK * 3, HYBRID_POOL)
}

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

/** 标题去掉序号和括号补充，只留正文词：「2. 我当前具备 vs 缺口（表）」→「我当前具备 vs 缺口」 */
function titleCore(title: string): string {
  return title.replace(/^\d+\.\s*/, '').replace(/[（(].*$/, '')
}

/**
 * 标题和问句的字面重叠（3 字滑动窗口的交集大小）。
 *
 * 为什么不用 rewriteQuery 的词表：词表只有 28 个词，问句里出现表外的词
 * （「平台工程」「周报」）时 terms 为空，标题加权就恒等于 0，等于没有。
 * 3-gram 不看词表，任何中文问句都能算。
 */
export function titleOverlap(query: string, title: string): number {
  const qg = new Set(charNgrams(query, 3))
  if (qg.size === 0) return 0
  let hits = 0
  for (const g of new Set(charNgrams(titleCore(title), 3))) if (qg.has(g)) hits += 1
  return hits
}

/**
 * 问句和块的字面重叠（3 字滑动窗口）。
 * 标题匹配权重大：learn 的「每天优先学」在第 5 节标题里，不在第 1 节标题里。
 * 生产里这一步常换成交叉编码器 rerank（query+chunk 成对打分）。
 */
export function rerankScore(query: string, hit: SearchHit): number {
  const qg = new Set(charNgrams(query, 3))
  if (qg.size === 0) return 0
  let bodyHits = 0
  for (const g of charNgrams(hit.text.slice(0, 160), 3)) if (qg.has(g)) bodyHits += 1
  return titleOverlap(query, hit.title) * 3 + bodyHits
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
 * 向量原句 + 关键词改写 → RRF。标题和问句有字面重叠的往前（救 stack）。
 */
export async function searchHybrid(
  query: string,
  items: IndexItem[],
  topK: number,
): Promise<SearchHit[]> {
  const fused = await hybridPool(query, items, Math.max(topK, HYBRID_POOL))
  const titleHit = (h: SearchHit) => (titleOverlap(query, h.title) > 0 ? 1 : 0)
  return fused
    .sort((a, b) => titleHit(b) - titleHit(a) || b.score - a.score)
    .slice(0, topK)
    .map((h, i) => ({ ...h, citation: i + 1 }))
}

/**
 * 在 hybrid 候选上按「原句和标题/正文的字面重叠」重排。
 * 评测里应能把 learn 从第 1 节改排到第 5 节。
 *
 * score 保持 RRF 融合分，字面重叠分另放 rerank：两路分混成一个数，
 * 工具卡片和模型就只能看到 0，看不出「为什么留下」。
 */
export async function searchRerank(
  query: string,
  items: IndexItem[],
  topK: number,
): Promise<SearchHit[]> {
  const fused = await hybridPool(query, items, Math.max(topK, HYBRID_POOL))
  const titleTerm = (h: SearchHit) => (titleOverlap(query, h.title) > 0 ? 1 : 0)
  return fused
    .map((h) => ({ h, t: titleTerm(h), n: rerankScore(query, h) }))
    .sort((a, b) => b.t - a.t || b.n - a.n || b.h.score - a.h.score)
    .slice(0, topK)
    .map((x, i) => ({ ...x.h, citation: i + 1, rerank: x.n }))
}

/**
 * 一篇文档只占一个名额，篇内保留最相关的 perDoc 块。
 *
 * 按块召回时，一篇 30 块的长文档很容易把 topK 名额全占满：问「平台工程的周报」，
 * 三条命中可能全是同一篇「工作进展」里的三个窗口，既不跨篇，也答不全。
 * 入参已按分数排好，所以文档顺序 = 该篇最好一块的名次。
 */
export function groupByDoc(hits: SearchHit[], perDoc = CHUNKS_PER_DOC): SearchHit[] {
  const byDoc = new Map<string, SearchHit[]>()
  for (const h of hits) {
    const kept = byDoc.get(h.docId)
    if (!kept) {
      byDoc.set(h.docId, [h])
      continue
    }
    if (kept.length < perDoc) kept.push(h)
  }
  return Array.from(byDoc.values()).flat()
}

/**
 * 时间的软加权：同一批候选里越新的分越高，但有下限。
 *
 * 只做 tie-break，不硬过滤：同体裁的文档（几百篇周报）语义分本来就咬得很紧，
 * RRF 差通常只有 1~2%，一点点衰减就能把最新那篇顶上来；
 * 而语义差别大的查询（问「简历缺口」）分差远大于 5%，不会被翻掉。
 *
 * 基准取候选里最新的一篇，不取「今天」：知识库本身是历史资料，
 * 最新一篇也可能已经是几周前的，按今天算会全部衰减到下限、等于没算。
 */
const RECENCY_FLOOR = 0.95
const RECENCY_WEEK_DECAY = 0.01
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

export function applyRecency(hits: SearchHit[]): SearchHit[] {
  const times = hits.map((h) => h.docTime).filter((t): t is number => typeof t === 'number')
  if (times.length < 2) return hits
  const newest = Math.max(...times)
  return hits.map((h) => {
    if (typeof h.docTime !== 'number') return h
    const weeks = Math.max(0, (newest - h.docTime) / WEEK_MS)
    const factor = Math.max(RECENCY_FLOOR, 1 - weeks * RECENCY_WEEK_DECAY)
    return { ...h, score: Math.round(h.score * factor * 1000) / 1000 }
  })
}

/** 补上来源文档：模型靠它才知道命中来自哪一篇（哪一期周报） */
function attachDocMeta(hits: SearchHit[]): SearchHit[] {
  const meta = getDocMetaMap()
  return hits.map((h) => {
    const m = meta.get(h.docId)
    if (!m) return h
    return {
      ...h,
      docName: m.name,
      docPath: m.path || undefined,
      docTime: m.time ?? undefined,
      via: h.via ?? 'recall',
    }
  })
}

/** 「最近/最新/上周」这类时间意图：出现时按时间约束候选，而不是靠语义碰运气 */
const TIME_INTENT_RE = /最近|最新|近期|近几[天周月]|近[一两三]?[周月]|上[周月个]|本[周月]|这[周月]/

/** 分期文档：问句点了「周报/月报」这类词，「最近」才是在说「最新一期」 */
const PERIODICAL_RE = /周报|月报|季报|年报|日报|双周|周会/

/**
 * 问句里已经点明了具体期次（「2026年8月W1」「2025Q1」「3月W2」）。
 * 点明了就不是在问「最新」——那时候补召最新一期反而会把正主挤下去：
 * 问「2025年3月W2 讲了什么」，补召会把 2026年8月W1 顶到第一位。
 */
const EXPLICIT_ISSUE_RE = /20\d{2}\s*年|20\d{2}\s*[QH]|\bW\d|\d{1,2}\s*月|\d{1,2}\s*日/i

/**
 * 时间意图的强度。none 不补召；weak 只补最新一期；strong 补最新两期。
 *
 * 判定必须挂在**用户自己的话**上，不能只看喂进检索的那句 query。
 * search_notes 的 query 是模型自己组的，它会丢词：实测问「平台工程周报讲了什么」，
 * 模型组出来的是「平台工程周报 讲了什么」——「最近」没了，按 query 判就永远不触发，
 * 退化成纯语义召回；而周报是同一套模板的，语义召回给哪几期基本随机
 * （实测捞出 2026年1月W2/W4，真正最新的 8月W1 全库排 #193）。
 *
 * 所以：**期刊名词必须出自用户原话**（「我最近投 Agent 前端还缺什么」里没有周报，不触发）；
 * 时间词则两句里有一句就算——模型自己补出「最近」是帮忙，不是噪声。
 */
export type RecencyIntent = 'none' | 'weak' | 'strong'

export function recencyIntent(query: string, userQuery?: string): RecencyIntent {
  const own = userQuery?.trim() || query
  if (!PERIODICAL_RE.test(own)) return 'none'
  const both = own === query ? query : `${own} ${query}`
  if (EXPLICIT_ISSUE_RE.test(both)) return 'none'
  return TIME_INTENT_RE.test(both) ? 'strong' : 'weak'
}

/**
 * 要不要走「按时间取最新几期」这条路。
 * 只有用户原话里出现分期文档（周报/月报…）才可能触发；见 recencyIntent。
 */
export function wantsLatestIssue(query: string, userQuery?: string): boolean {
  return recencyIntent(query, userQuery) !== 'none'
}

/**
 * 「平台工作周报-2026年8月W1」→「平台工作周报」：抹掉期次，同一份周报的每一期算一族。
 * 族是时间意图的落点：问「最近的周报」，得先知道「最近」是相对哪一族说的。
 *
 * 年份必须带「年」或在 Q/H 前面：不然「2025年12月W4」里的 12 会被当成年份吃掉，
 * 留下一个孤零零的「月」，10/11/12 月那几期就自成一族了。
 */
export function docFamily(name: string): string {
  return name
    .replace(/(?:19|20)?\d{2}\s*年/g, '')
    .replace(/\d{1,2}\s*月/g, '')
    .replace(/\d{1,2}\s*日/g, '')
    .replace(/(?:19|20)?\d{2}(?=\s*[QH])/gi, '')
    .replace(/W\d+/gi, '')
    .replace(/Q[1-4]/gi, '')
    .replace(/H[12]/g, '')
    .replace(/[\s\-_—－.]+/g, '')
}

/**
 * 时间意图时补召最新几期。
 *
 * 强意图（用户说了「最近/最新」）补两期：他要的就是「最近的动态」，一期不够。
 * 弱意图（只点了「周报」没点时间，如「平台工程周报讲了什么」）只补最新一期：
 * 用户问的是**内容**，不是「最新」，补进来一期只是保证他拿到的是现役那期；
 * 补两期就占了 6 个名额里的 4 个，会把语义召回的正主挤掉。
 * 每期仍按 CHUNKS_PER_DOC 给块，和别的文档一个待遇。
 */
const TIME_KEEP_ISSUES = 2
const WEAK_KEEP_ISSUES = 1

/**
 * 「最近」这一问，只能用时间约束来答，不能靠相似度。
 *
 * 实测过为什么：同一份周报的每一期共用一套模板（「平台渗透率 & 质量报表」「本周」「上周」），
 * 在向量空间里几乎不可分——2025年1月 和 2026年1月 的余弦都是 0.657，
 * 而最新一期只排到全库 #193（0.565）。也就是说无论加多重的时间衰减，
 * 「先按相似度捞池子、再重排」这条路都捞不到最新一期：池子里根本没有它。
 *
 * 所以这里反过来做：先看语义命中的是哪个族（候选里 ≥2 篇同族才算），
 * 再到全库把这个族最新的几期直接捞出来，最后在这几期里按语义选块。
 * 只对带时间词的问句生效，其余查询一个字都不改。
 */
async function freshIssueHits(
  query: string,
  fused: SearchHit[],
  pool: IndexItem[],
  keepIssues: number,
): Promise<SearchHit[]> {
  const meta = getDocMetaMap()
  const perFamily = new Map<string, Set<string>>()
  for (const h of fused) {
    const name = meta.get(h.docId)?.name
    if (!name) continue
    const family = docFamily(name)
    const seen = perFamily.get(family)
    if (seen) seen.add(h.docId)
    else perFamily.set(family, new Set([h.docId]))
  }

  // 选族：问句和族名的字面重叠优先，重叠一样才比谁在候选里多。
  // 不能只看「候选里哪个族文档多」——周报是同一套模板，同一族的块又多又像，
  // 问「搜索工程周报」也能被「平台工作周报」的数量压过去。
  let hit: { family: string; docs: Set<string> } | null = null
  let bestOverlap = -1
  for (const [family, docs] of perFamily) {
    if (docs.size < 2) continue
    const overlap = titleOverlap(query, family)
    if (overlap > bestOverlap || (overlap === bestOverlap && hit && docs.size > hit.docs.size)) {
      bestOverlap = overlap
      hit = { family, docs }
    }
  }
  if (!hit) return []

  const issues = Array.from(meta.entries())
    .filter(([, m]) => m.time !== null && docFamily(m.name) === hit.family)
    .sort((a, b) => (b[1].time ?? 0) - (a[1].time ?? 0))
    .slice(0, keepIssues)
  if (issues.length === 0) return []

  // 这几期多半不在候选池里（最新一期排 #193），只能重新按语义挑块
  const qv = await embedQuery(query)
  const out: SearchHit[] = []
  for (const [docId] of issues) {
    const chunks = pool
      .filter((c) => c.docId === docId)
      .map((c) => ({ c, s: c.embedding?.length ? cosine(qv, c.embedding) : 0 }))
      .sort((a, b) => b.s - a.s)
      .slice(0, CHUNKS_PER_DOC)
    for (const { c, s } of chunks) {
      out.push({
        id: c.id,
        docId: c.docId,
        title: c.title,
        text: c.text,
        citation: 0,
        score: Math.round(s * 1000) / 1000,
        via: 'recency',
      })
    }
  }
  // 补召的块也要带上 docName：不然白补——模型照样看不出这是哪一期
  return attachDocMeta(out)
}

/**
 * 候选 → 最终给模型看的 hits。
 *
 * 顺序：补来源 → （时间意图补召最新几期，排在前面）→ 按文档聚合 → 时间软加权
 * → 取名次 → 扩邻接 → 重编引用号。
 *
 * 补召的几期和语义召回的块**分开排序**再拼：两边的分数不是一个量纲
 * （余弦 0~1 vs RRF 0.01 量级），混在一起排等于偷偷让一路压死另一路。
 *
 * 单独抽出来是为了能被脚本直接调用（只读 index.json 就能验全链路），
 * 不用为了测一次检索去跑 retrieve 里的建索引。
 *
 * @param query     真正喂给检索的 query（在 Agent 链路里是模型自己组的那句）
 * @param userQuery 用户原话。时间意图必须判它，不能判 query——模型转述会丢词，
 *                  丢了「最近」就等于悄悄关掉了整条时间补召通道
 */
export async function assembleHits(
  fused: SearchHit[],
  topK: number,
  pool: IndexItem[],
  query: string,
  userQuery?: string,
): Promise<SearchHit[]> {
  const enriched = attachDocMeta(fused)
  // 意图判在用户原话上：query 是模型转述的，会丢掉「最近」这类词（见 recencyIntent）
  const intent = recencyIntent(query, userQuery)
  const fresh =
    intent === 'none'
      ? []
      : await freshIssueHits(
          query,
          enriched,
          pool,
          intent === 'strong' ? TIME_KEEP_ISSUES : WEAK_KEEP_ISSUES,
        )
  const freshIds = new Set(fresh.map((h) => h.id))
  const rest = applyRecency(groupByDoc(enriched.filter((h) => !freshIds.has(h.id))))
    .sort((a, b) => b.score - a.score)

  const budget = Math.max(topK, 1) * CHUNKS_PER_DOC
  const picked = [...fresh, ...rest].slice(0, budget)
  return expandWithNeighbors(picked, pool).map((h, i) => ({ ...h, citation: i + 1 }))
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
 *
 * topK 数的是**篇数**：候选先按文档聚合，每篇最多留 2 块，
 * 所以问「某某文档讲了什么」时不会三条命中全落在同一篇的中间，
 * 而最终的 hits 条数最多是 topK × 2。
 */
export async function retrieve(
  query: string,
  topK = 3,
  userQuery?: string,
): Promise<RetrieveResult> {
  const rewritten = rewriteQuery(query)
  if (memory === null) await ensureIndex()

  if (readyMode === 'hybrid' && memory && memory.length > 0) {
    // 候选要比 topK 多：聚合会把同一篇的多个块并成一个名额，留够才不会缩水
    const pool = HYBRID_CANDIDATES(topK)
    const textRanked = await searchRerank(query, memory, pool)
    const imageRanked = await searchImages(query, Math.max(topK * 2, 5))
    const imageHits: SearchHit[] = imageRanked.map((h) => ({
      id: h.id,
      docId: h.docId,
      title: h.title,
      text: h.text,
      citation: h.citation,
      score: h.score,
    }))
    const fused =
      imageHits.length > 0 ? fuseRrf([textRanked, imageHits], pool, [1, 0.85]) : textRanked
    const hits = await assembleHits(fused, topK, memory, query, userQuery)

    if (hits.length > 0) {
      return {
        mode: 'hybrid',
        query: rewritten.original,
        query_used: query,
        rewrite_terms: rewritten.terms,
        hits,
      }
    }
  }

  const hits = attachDocMeta(searchChunks(rewritten.rewritten, topK))
  return {
    mode: 'keyword',
    query: rewritten.original,
    query_used: rewritten.rewritten,
    rewrite_terms: rewritten.terms,
    hits,
  }
}
