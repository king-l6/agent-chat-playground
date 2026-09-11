/**
 * 真 embedding（神经网络向量，不是关键词哈希）
 *
 * 公司网关 DeepSeek 只有 chat/completions，没有 /embeddings。
 * 生产里这是常态：生成模型 ≠ 向量模型，要单独接 OpenAI / BGE / TEI。
 * 本课用本地 BGE-small-zh（ONNX），和中文手册同一向量空间，不依赖网关。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')
const MODEL_CACHE = path.join(ROOT, 'server', 'data', 'models')

export const EMBEDDING_MODEL = 'Xenova/bge-small-zh-v1.5'

/** BGE 检索：query 要加指令，document 不加。漏了召回会明显变差 */
const QUERY_INSTRUCTION = '为这个句子生成表示以用于检索：'

type FeaturePipe = (
  text: string,
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<unknown>

let extractor: FeaturePipe | null = null
let loadError: string | null = null

export function getEmbedError() {
  return loadError
}

function tensorToArray(out: unknown): number[] {
  if (out && typeof out === 'object' && 'tolist' in out) {
    const list = (out as { tolist: () => unknown }).tolist()
    const row = Array.isArray(list) && Array.isArray(list[0]) ? list[0] : list
    return (row as number[]).map(Number)
  }
  if (out && typeof out === 'object' && 'data' in out) {
    return Array.from((out as { data: ArrayLike<number> }).data)
  }
  throw new Error('未知 embedding 输出格式')
}

async function getExtractor(): Promise<FeaturePipe> {
  if (extractor) return extractor
  if (loadError) throw new Error(loadError)

  const { pipeline, env } = await import('@huggingface/transformers')
  env.cacheDir = MODEL_CACHE
  env.allowLocalModels = true
  // 国内直连 huggingface.co 经常 fetch failed；可用 HF_ENDPOINT 覆盖
  env.remoteHost = process.env.HF_ENDPOINT?.trim() || 'https://hf-mirror.com/'

  console.error(
    `[embed] 加载 ${EMBEDDING_MODEL} host=${env.remoteHost}（首次会下载 ONNX，之后走缓存）`,
  )
  extractor = (await pipeline(
    'feature-extraction',
    EMBEDDING_MODEL,
  )) as unknown as FeaturePipe
  return extractor
}

export async function embedDocuments(texts: string[]): Promise<number[][]> {
  const ext = await getExtractor()
  const vectors: number[][] = []
  for (const text of texts) {
    const out = await ext(text, { pooling: 'mean', normalize: true })
    vectors.push(tensorToArray(out))
  }
  return vectors
}

export async function embedQuery(query: string): Promise<number[]> {
  const ext = await getExtractor()
  const out = await ext(`${QUERY_INSTRUCTION}${query}`, {
    pooling: 'mean',
    normalize: true,
  })
  return tensorToArray(out)
}

export async function tryLoadEmbedder(): Promise<boolean> {
  try {
    await getExtractor()
    loadError = null
    return true
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err)
    console.warn('[embed] 向量模型不可用，检索将回退关键词:', loadError)
    return false
  }
}
