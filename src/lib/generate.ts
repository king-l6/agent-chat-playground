/**
 * 生成结果存储：进程内保存图片记录（含 dataUrl），供 /api/images/<id> 直接读取。
 *
 * 同构实现：浏览器端额外镜像一份到 localStorage（存不下就静默降级），
 * 服务端只在内存里保存最近若干张，保证「生成 → 查看 → 下载」闭环。
 *
 * 现状（本轮核实）：`src/App.tsx`、`src/components/BeautyImagePage.tsx`（两个文件本轮
 * 都读过全文）都没有引用本文件，`src/api/image.ts` 走的是后端 `/api/image/generate`。
 * 也就是说这份存储实现当前没有任何调用方：要么接到某个页面上，要么删掉，
 * 别让它继续半挂着（同一批「美女图」文件见 REPO_MAP 第八条的说明）。
 *
 * 类型定义在这里落地：原来第一行是 `import type { ImageRecord } from './generate'`，
 * 自己 import 自己、且全文件没有任何地方定义过 ImageRecord，等于模块解析直接失败。
 */

/** 一张生成结果：展示 / 下载需要的最小字段 */
export type ImageRecord = {
  id: string
  /** 生成用的完整提示词 */
  prompt: string
  /** data: URL（内联图，演示用）；上游也可能给直出地址 */
  dataUrl: string
  width: number
  height: number
  /** 毫秒时间戳；列表按它倒序、超上限时淘汰最旧的 */
  createdAt: number
}

const ID_PATTERN = /^[a-z0-9_]{4,64}$/i
const STORAGE_KEY = 'agentos.beauty.images'
const MAX_KEEP = 24

type StorageLike = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

type AnchorLike = {
  href: string
  download: string
  style: { display: string }
  click: () => void
}

type DocumentLike = {
  createElement: (tag: string) => AnchorLike
  body: {
    appendChild: (node: AnchorLike) => unknown
    removeChild: (node: AnchorLike) => unknown
  }
}

const memory = new Map<string, ImageRecord>()

/** 取 localStorage，取不到（Node / 无痕 / 被禁用）返回 null */
function safeStorage(): StorageLike | null {
  try {
    const candidate = (globalThis as { localStorage?: unknown }).localStorage
    if (!candidate || typeof candidate !== 'object') return null
    const store = candidate as Partial<StorageLike>
    if (
      typeof store.getItem !== 'function' ||
      typeof store.setItem !== 'function' ||
      typeof store.removeItem !== 'function'
    ) {
      return null
    }
    return store as StorageLike
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is ImageRecord {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<ImageRecord>
  return (
    typeof item.id === 'string' &&
    typeof item.prompt === 'string' &&
    typeof item.dataUrl === 'string' &&
    typeof item.width === 'number' &&
    typeof item.height === 'number' &&
    typeof item.createdAt === 'number'
  )
}

function hydrate(): ImageRecord[] {
  const store = safeStorage()
  if (!store) return []
  try {
    const raw = store.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isRecord)
  } catch {
    return []
  }
}

function persist(): void {
  const store = safeStorage()
  if (!store) return
  try {
    const recent = [...memory.values()]
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, MAX_KEEP)
    store.setItem(STORAGE_KEY, JSON.stringify(recent))
  } catch {
    return
  }
}

export function isImageId(id: string): boolean {
  return ID_PATTERN.test(id)
}

/** 存一张图（超出上限时淘汰最旧的） */
export function saveImage(image: ImageRecord): ImageRecord {
  memory.set(image.id, image)
  if (memory.size > MAX_KEEP) {
    const oldest = [...memory.values()].sort((left, right) => left.createdAt - right.createdAt)[0]
    if (oldest) memory.delete(oldest.id)
  }
  persist()
  return image
}

/** 按 id 取图：先看内存，再看本地镜像 */
export function getImage(id: string): ImageRecord | undefined {
  if (!isImageId(id)) return undefined
  const hit = memory.get(id)
  if (hit) return hit
  return hydrate().find((item) => item.id === id)
}

/** 最近生成的图（新的在前），去重后截断 */
export function listImages(limit = 12): ImageRecord[] {
  const merged: ImageRecord[] = []
  const seen = new Set<string>()
  for (const item of [...memory.values(), ...hydrate()]) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    merged.push(item)
  }
  return merged
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, Math.max(0, limit))
}

export function removeImage(id: string): boolean {
  const existed = memory.delete(id)
  persist()
  return existed
}

export function clearImages(): void {
  memory.clear()
  const store = safeStorage()
  if (!store) return
  try {
    store.removeItem(STORAGE_KEY)
  } catch {
    return
  }
}

export function imageCount(): number {
  return memory.size
}

export function imageFilename(image: Pick<ImageRecord, 'id'>): string {
  return `beauty-${image.id}.svg`
}

/** 浏览器端下载；非浏览器环境返回 false（调用方可以退化成 <a download>） */
export function downloadImage(image: Pick<ImageRecord, 'id' | 'dataUrl'>, filename?: string): boolean {
  const doc = (globalThis as { document?: unknown }).document as unknown as DocumentLike | undefined
  if (!doc) return false
  try {
    const link = doc.createElement('a')
    link.href = image.dataUrl
    link.download = filename ?? imageFilename(image)
    link.style.display = 'none'
    doc.body.appendChild(link)
    link.click()
    doc.body.removeChild(link)
    return true
  } catch {
    return false
  }
}
