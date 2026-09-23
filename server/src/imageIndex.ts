/**
 * 图片多模态索引：和 index.json（BGE 文字块）分开存。
 * 入库时 CLIP 编码像素；检索时用同一 CLIP 编查询，和文字命中 RRF 融合。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './paths.js'
import { downloadToCache, imageCacheId } from './imageCache.js'
import { VECTOR_ENCODING, decodeVector, encodeVector } from './vectorCodec.js'
import { embedImageFile, embedVlQuery, tryLoadVlEmbedder, VL_EMBEDDING_MODEL } from './vlEmbed.js'

export const IMAGE_INDEX_PATH = path.join(DATA_DIR, 'image-index.json')

const IMG = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g
/** CLIP 图文相似度阈值（normalize 后点积）；中文相关问大约 ≥0.28，无关常 <0.26 */
const MIN_IMAGE_COSINE = 0.26

export type ImageIndexItem = {
  id: string
  docId: string
  url: string
  title: string
  file: string
  dim: number
  embedding: number[]
  ocr?: string
}

/** 落盘形态：向量 base64 编码，理由同 vectorCodec（体积和解析都省几倍） */
type StoredImageItem = Omit<ImageIndexItem, 'embedding'> & {
  v?: string
  embedding?: number[]
}

type ImageIndexFile = {
  model: string
  vectorEncoding?: string
  items: StoredImageItem[]
}

function fromStored(item: StoredImageItem): ImageIndexItem {
  const { v, embedding, ...rest } = item
  return { ...rest, embedding: v ? decodeVector(v) : embedding ?? [] }
}

function toStored(item: ImageIndexItem): StoredImageItem {
  const { embedding, ...rest } = item
  return { ...rest, v: encodeVector(embedding) }
}

let memory: ImageIndexItem[] | null = null

/** 图片项 id = 缓存文件名的同一份哈希，历史 59 条对得上 */
function imageId(url: string) {
  return `img_${imageCacheId(url)}`
}

function readDisk(): ImageIndexItem[] {
  try {
    if (!fs.existsSync(IMAGE_INDEX_PATH)) return []
    const file = JSON.parse(fs.readFileSync(IMAGE_INDEX_PATH, 'utf8')) as ImageIndexFile
    if (file.model !== VL_EMBEDDING_MODEL || !Array.isArray(file.items)) return []
    return file.items.map(fromStored)
  } catch {
    return []
  }
}

function persist(items: ImageIndexItem[]) {
  memory = items
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const body: ImageIndexFile = {
    model: VL_EMBEDDING_MODEL,
    vectorEncoding: VECTOR_ENCODING,
    items: items.map(toStored),
  }
  // 先写临时文件再 rename：中途挂掉不会留下半截 JSON。
  // 临时名带 pid，理由同 retrieve.ts 的 writeIndexFile：rename 只对单写者原子，
  // tsx watch 重启重叠时两个实例会抢同一个 .tmp 名。
  const tmp = `${IMAGE_INDEX_PATH}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(body))
    fs.renameSync(tmp, IMAGE_INDEX_PATH)
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* 清不掉就算了，别把原始错误盖掉 */
    }
    throw err
  }
}

export function ensureImageIndexLoaded(): ImageIndexItem[] {
  if (memory === null) memory = readDisk()
  return memory
}

export function getImageIndexStatus() {
  const items = ensureImageIndexLoaded()
  return {
    model: VL_EMBEDDING_MODEL,
    images: items.length,
    dim: items[0]?.dim ?? 512,
  }
}

export function listMarkdownImageUrls(markdown: string): string[] {
  const urls: string[] = []
  const seen = new Set<string>()
  for (const match of markdown.matchAll(IMG)) {
    const url = match[2]
    if (seen.has(url)) continue
    seen.add(url)
    urls.push(url)
  }
  return urls
}

function ocrNearUrl(markdown: string, url: string): string | undefined {
  const idx = markdown.indexOf(url)
  if (idx < 0) return undefined
  const after = markdown.slice(idx + url.length, idx + url.length + 400)
  const m = after.match(/图中文字：([^\n]+)/)
  return m?.[1]?.trim() || undefined
}

function titleNearUrl(markdown: string, url: string, fallback: string): string {
  const idx = markdown.indexOf(url)
  if (idx < 0) return fallback
  const before = markdown.slice(0, idx)
  const heads = before.match(/^##\s+(.+)$/gm)
  if (!heads?.length) return fallback
  return heads[heads.length - 1].replace(/^##\s+/, '').trim() || fallback
}

/** 一篇文档里的图片：下载 → CLIP → 写入 image-index（按 doc 覆盖） */
export async function indexDocImages(
  docId: string,
  markdown: string,
  fallbackTitle: string,
): Promise<number> {
  const urls = listMarkdownImageUrls(markdown)
  const ok = await tryLoadVlEmbedder()
  if (!ok) {
    console.warn('[vl-index] CLIP 不可用，跳过图片向量')
    return 0
  }

  const prev = ensureImageIndexLoaded().filter((it) => it.docId !== docId)
  const next: ImageIndexItem[] = [...prev]

  for (const url of urls) {
    try {
      const file = await downloadToCache(url)
      if (!file) continue
      const embedding = await embedImageFile(file)
      const id = imageId(url)
      const item: ImageIndexItem = {
        id,
        docId,
        url,
        title: titleNearUrl(markdown, url, fallbackTitle),
        file: path.basename(file),
        dim: embedding.length,
        embedding,
        ocr: ocrNearUrl(markdown, url),
      }
      const i = next.findIndex((x) => x.id === id)
      if (i >= 0) next[i] = item
      else next.push(item)
    } catch (err) {
      console.warn(
        `[vl-index] 跳过 ${url.slice(0, 80)}:`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  persist(next)
  const count = next.filter((it) => it.docId === docId).length
  if (count) console.log(`[vl-index] ${docId} images=${count} total=${next.length}`)
  return count
}

export function removeDocImages(docId: string): void {
  const items = ensureImageIndexLoaded().filter((it) => it.docId !== docId)
  persist(items)
}

export type ImageSearchHit = {
  id: string
  docId: string
  title: string
  text: string
  url: string
  score: number
  citation: number
}

/**
 * 某篇文档里的图，按索引里的顺序（≈ 正文出现顺序）。
 *
 * 给「按文档挂图」那条通道用：**不碰 CLIP**。理由见 retrieve.ts 的 attachDocImages——
 * 中文问句对图的余弦没有判别力，用余弦挑图会挑错；而「这篇文档里有哪几张图」
 * 是确定的事实，不需要任何模型。
 */
export function listDocImages(docId: string): ImageIndexItem[] {
  return ensureImageIndexLoaded().filter((it) => it.docId === docId)
}

export async function searchImages(
  query: string,
  topK: number,
  minCosine = MIN_IMAGE_COSINE,
): Promise<ImageSearchHit[]> {
  const items = ensureImageIndexLoaded()
  if (items.length === 0) return []
  if (!(await tryLoadVlEmbedder())) return []

  const qv = await embedVlQuery(query)
  return items
    .map((item) => {
      let score = 0
      const n = Math.min(qv.length, item.embedding.length)
      for (let i = 0; i < n; i += 1) score += qv[i] * item.embedding[i]
      return { item, score }
    })
    .filter((x) => x.score >= minCosine)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((x, i) => ({
      id: x.item.id,
      docId: x.item.docId,
      title: `图片 · ${x.item.title}`,
      text: [
        `图片: ${x.item.url}`,
        x.item.ocr ? `图中文字：${x.item.ocr}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
      url: x.item.url,
      score: Math.round(x.score * 1000) / 1000,
      citation: i + 1,
    }))
}
