/**
 * 多模态向量：本地 CLIP（Xenova/clip-vit-base-patch32）
 * 图和查询文本在同一 512 维空间，和 BGE 文字索引分开，检索时再融合。
 * 网关 qwen3-vl-embedding 无集群，所以走本机 ONNX。
 */
import path from 'node:path'
import { DATA_DIR } from './paths.js'

const MODEL_CACHE = path.join(DATA_DIR, 'models')
export const VL_EMBEDDING_MODEL = 'Xenova/clip-vit-base-patch32'

type ClipKit = {
  processor: { (image: unknown): Promise<Record<string, unknown>> }
  tokenizer: (
    texts: string[],
    opts: { padding: boolean; truncation: boolean },
  ) => Record<string, unknown>
  vision: (inputs: Record<string, unknown>) => Promise<{ image_embeds: TensorLike }>
  text: (inputs: Record<string, unknown>) => Promise<{ text_embeds: TensorLike }>
}

type TensorLike = { data: ArrayLike<number>; dims: number[] }

let kit: ClipKit | null = null
let loadError: string | null = null

export function getVlEmbedError() {
  return loadError
}

function l2Normalize(v: number[]): number[] {
  let n = 0
  for (const x of v) n += x * x
  const denom = Math.sqrt(n) || 1
  return v.map((x) => x / denom)
}

function row(tensor: TensorLike, i = 0): number[] {
  const dim = tensor.dims[tensor.dims.length - 1]
  const data = Array.from(tensor.data)
  return data.slice(i * dim, (i + 1) * dim)
}

async function getKit(): Promise<ClipKit> {
  if (kit) return kit
  if (loadError) throw new Error(loadError)

  const {
    AutoProcessor,
    AutoTokenizer,
    CLIPVisionModelWithProjection,
    CLIPTextModelWithProjection,
    env,
  } = await import('@huggingface/transformers')

  env.cacheDir = MODEL_CACHE
  env.allowLocalModels = true
  env.remoteHost = process.env.HF_ENDPOINT?.trim() || 'https://hf-mirror.com/'

  console.log(`[vl-embed] 加载 ${VL_EMBEDDING_MODEL}`)
  try {
    const [processor, tokenizer, vision, text] = await Promise.all([
      AutoProcessor.from_pretrained(VL_EMBEDDING_MODEL),
      AutoTokenizer.from_pretrained(VL_EMBEDDING_MODEL),
      CLIPVisionModelWithProjection.from_pretrained(VL_EMBEDDING_MODEL),
      CLIPTextModelWithProjection.from_pretrained(VL_EMBEDDING_MODEL),
    ])
    kit = {
      processor: processor as ClipKit['processor'],
      tokenizer: tokenizer as ClipKit['tokenizer'],
      vision: vision as ClipKit['vision'],
      text: text as ClipKit['text'],
    }
    return kit
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err)
    throw new Error(loadError)
  }
}

export async function tryLoadVlEmbedder(): Promise<boolean> {
  try {
    await getKit()
    return true
  } catch {
    return false
  }
}

/** 本地图片路径 → CLIP 图像向量（已 L2 normalize） */
export async function embedImageFile(filePath: string): Promise<number[]> {
  const { RawImage } = await import('@huggingface/transformers')
  const k = await getKit()
  const image = await RawImage.read(filePath)
  const inputs = await k.processor(image)
  const { image_embeds } = await k.vision(inputs)
  return l2Normalize(row(image_embeds))
}

/** 查询文本 → CLIP 文本向量（已 L2 normalize） */
export async function embedVlQuery(query: string): Promise<number[]> {
  const k = await getKit()
  const inputs = k.tokenizer([query], { padding: true, truncation: true })
  const { text_embeds } = await k.text(inputs)
  return l2Normalize(row(text_embeds))
}
