/**
 * 入库前把 Markdown 图片里的字读出来，写在图片下面。
 * 向量模型仍然只吃文字；看图只发生在这一步，用网关视觉模型。
 * 结果按图片 URL 落盘，同一张图不会重复打模型。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { resolveLlmConfig } from './agent.js'
import { downloadToCache, mimeOf } from './imageCache.js'
import { DATA_DIR } from './paths.js'

const VISION_MODEL = process.env.VISION_MODEL?.trim() || 'deepseek-v4-flash-vision'
const CACHE_DIR = path.join(DATA_DIR, 'image-text')
const IMG = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g
const MAX_CHARS = 800

const PROMPT =
  '提取这张图里所有可见文字，按从上到下、从左到右的顺序输出。只输出文字本身，不要描述画面，不要解释。图里没有文字就什么都不要输出。'

type CacheFile = { url: string; text: string }

function cachePath(url: string) {
  const name = createHash('sha256').update(url).digest('hex').slice(0, 32)
  return path.join(CACHE_DIR, `${name}.json`)
}

function readCache(url: string): string | null {
  try {
    const file = JSON.parse(fs.readFileSync(cachePath(url), 'utf8')) as CacheFile
    if (file.url !== url || typeof file.text !== 'string') return null
    return file.text
  } catch {
    return null
  }
}

function writeCache(url: string, text: string) {
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  const body: CacheFile = { url, text }
  fs.writeFileSync(cachePath(url), JSON.stringify(body), 'utf8')
}

function cleanText(raw: string) {
  const text = raw
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/\n?```$/i, '')
    .trim()
  if (!text || /^(无|没有文字|无文字|空)$/.test(text)) return ''
  return text.slice(0, MAX_CHARS)
}

/**
 * 取图片字节。走 imageCache 的公共缓存——同一张图 CLIP 那边也要用，
 * 以前是各下一遍，现在谁先到谁下载，另一个直接读本地文件。
 */
async function loadImage(url: string): Promise<{ mime: string; b64: string } | null> {
  const file = await downloadToCache(url)
  if (!file) return null
  const buf = await fs.promises.readFile(file)
  if (buf.length === 0) return null
  return { mime: mimeOf(file), b64: buf.toString('base64') }
}

async function askVision(mime: string, b64: string): Promise<string> {
  const { apiKey, baseURL } = resolveLlmConfig()
  if (!apiKey || !baseURL) throw new Error('没有可用的视觉模型配置')
  const res = await fetch(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({
      model: VISION_MODEL,
      temperature: 0,
      max_tokens: 800,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
          ],
        },
      ],
    }),
  })
  const data = (await res.json()) as {
    error?: { message?: string }
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>
  }
  if (!res.ok) {
    throw new Error(data.error?.message || `视觉模型 ${res.status}`)
  }
  const content = data.choices?.[0]?.message?.content
  if (typeof content === 'string') return cleanText(content)
  if (Array.isArray(content)) {
    return cleanText(content.map((part) => part.text || '').join('\n'))
  }
  return ''
}

/** 读一张图里的字。失败不缓存，下次入库会再试。 */
export async function readImageText(url: string): Promise<string> {
  const cached = readCache(url)
  if (cached !== null) return cached
  const image = await loadImage(url)
  if (!image) {
    writeCache(url, '')
    return ''
  }
  const text = await askVision(image.mime, image.b64)
  writeCache(url, text)
  if (text) console.log(`[vision] ${text.length} 字 ${url.slice(0, 80)}`)
  return text
}

/**
 * 并发上限。
 *
 * 单张图的 2.7s 几乎全是在等网关的视觉模型返回，本地既不吃 CPU 也不吃内存。
 * 串行跑全库 1690 张要 74 分钟；并发 6 条压到十几分钟。
 * 峰值内存 = 在飞的图片 base64，单张最多 8MB，6 条约 50MB，可接受。
 * 被网关限流了就调小：VISION_CONCURRENCY=2。
 */
const VISION_CONCURRENCY = Math.max(1, Number(process.env.VISION_CONCURRENCY ?? '') || 6)

/** 并发跑，结果按输入顺序返回 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor
      cursor += 1
      if (i >= items.length) return
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return out
}

/** 在每张图下面插入「图中文字：…」。已经插过的跳过。 */
export async function annotateImageText(markdown: string): Promise<string> {
  const urls = Array.from(new Set(Array.from(markdown.matchAll(IMG), (m) => m[2])))
  if (urls.length === 0) return markdown

  const started = Date.now()
  let done = 0
  const results = await mapLimit(urls, VISION_CONCURRENCY, async (url) => {
    let text = ''
    try {
      text = (await readImageText(url)).replace(/\s*\n\s*/g, ' ').trim()
    } catch (err) {
      console.warn(
        `[vision] 跳过 ${url.slice(0, 80)}:`,
        err instanceof Error ? err.message : err,
      )
    }
    done += 1
    if (urls.length >= 8 && done % 8 === 0) {
      console.log(`[vision] ${done}/${urls.length} 已用 ${Math.round((Date.now() - started) / 1000)}s`)
    }
    return text
  })

  const texts = new Map<string, string>()
  urls.forEach((url, i) => {
    if (results[i]) texts.set(url, results[i])
  })
  if (texts.size === 0) return markdown

  return markdown.replace(IMG, (full, _alt: string, url: string, offset: number, whole: string) => {
    const text = texts.get(url)
    if (!text) return full
    const after = whole.slice(offset + full.length)
    if (/^\n*图中文字：/.test(after)) return full
    return `${full}\n图中文字：${text}`
  })
}
