/**
 * 图片字节的落盘缓存：一张图只从网上拉一次。
 *
 * 入库时同一张图有两个地方要用它的字节：
 *   1. imageText —— 发给视觉模型读出图中的字
 *   2. imageIndex —— 喂给 CLIP 编成图片向量
 * 以前两边各写一个 fetch，同一张图走两遍网络、下两遍 6MB。
 * 现在统一走这里，谁先到谁下载，后到的直接读本地文件。
 *
 * 文件名 = sha256(url) 前 16 位 + 按 content-type 推出的扩展名。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './paths.js'

export const IMAGE_CACHE_DIR = path.join(DATA_DIR, 'images')

/** 单张图上限，超了就不要（企微文档里的截图一般几百 KB） */
const MAX_BYTES = 6_000_000

const EXT_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/**
 * content-type → 扩展名。认不出来返回 null。
 *
 * 别拿 png 当兜底：企微文档里混着 image/svg+xml（图标、矢量图），
 * 存成 .png 之后 mimeOf 会声称它是 image/png，
 * 视觉网关收到「号称 PNG 实为 SVG」的请求体就直接拒：
 * "the request was rejected by an internal MaaS component"
 * —— 实测 600 张里有 15 张是这么被坑的。宁可跳过也不冒充。
 */
function extFromMime(mime: string): string | null {
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg'
  if (mime.includes('png')) return '.png'
  if (mime.includes('webp')) return '.webp'
  if (mime.includes('gif')) return '.gif'
  return null
}

/** 图片在缓存和索引里的稳定标识（同一个 URL 永远同一个值） */
export function imageCacheId(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 16)
}

/**
 * 缓存文件名。
 * 前缀 img_ 是历史命名，别去掉——已经落盘的 59 张图就叫这个名字，
 * 换了前缀它们会全部认不出来，白重下一遍。
 */
function cacheFile(url: string, ext: string): string {
  return path.join(IMAGE_CACHE_DIR, `img_${imageCacheId(url)}${ext}`)
}

/** 缓存里已经有的那份，没有就 null */
export function findCachedImage(url: string): string | null {
  for (const ext of Object.keys(EXT_MIME)) {
    const file = cacheFile(url, ext)
    if (fs.existsSync(file)) return file
  }
  return null
}

/**
 * 取这张图的本地路径，没有就下载一次。
 * 失败返回 null，且不写任何东西——下次入库会重试。
 */
export async function downloadToCache(url: string): Promise<string | null> {
  const cached = findCachedImage(url)
  if (cached) return cached

  fs.mkdirSync(IMAGE_CACHE_DIR, { recursive: true })
  const res = await fetch(url, {
    headers: { Referer: 'https://doc.weixin.qq.com/' },
    signal: AbortSignal.timeout(20_000),
    redirect: 'follow',
  })
  if (!res.ok) return null
  const mime = (res.headers.get('content-type') || '').split(';')[0].trim()
  const ext = mime.startsWith('image/') ? extFromMime(mime) : null
  // 认不出的格式（svg 等）直接跳过：既不能给视觉模型，也不能喂 CLIP
  if (!ext) return null
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length === 0 || buf.length > MAX_BYTES) return null

  const file = cacheFile(url, ext)
  fs.writeFileSync(file, buf)
  return file
}

/**
 * 缓存文件的 MIME，拼 data: URL 给视觉模型用。
 * 只有 EXT_MIME 里那几种会被写进缓存，所以扩展名反推 MIME 是可靠的。
 */
export function mimeOf(file: string): string {
  return EXT_MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}
