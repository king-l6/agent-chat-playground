/**
 * 「一键生成美女图片」API 层。
 *
 * 对应 server/src/index.ts 里的两条路由：
 *   GET  /api/image/styles   风格预设 + 尺寸 + 提示词上限
 *   POST /api/image/generate 按风格出图，返回可直接 <img src> 的地址
 * 页面在 src/components/BeautyImagePage.tsx（此前这个文件被页面代码占用了，
 * 页面第一行 `from './api/image'` 指向不存在的 ./api/api/image，等于断链，
 * 现在两边各归其位）。
 */
import axios from 'axios'

/** 后端地址；.env 里 VITE_API_BASE，空则走当前域名（开发时配合 Vite 代理） */
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? ''

export type BeautyStyleOption = {
  id: string
  name: string
  description: string
  tags: string[]
}

export type BeautyImageItem = {
  id: string
  url: string
  dataUrl?: string
  styleName: string
  width?: number
  height?: number
  createdAt?: string
}

export type BeautyImageResult = {
  images: BeautyImageItem[]
  styleName: string
}

/**
 * 拉不到风格列表时的兜底，字段与后端 BEAUTY_STYLE_DEFAULT 对齐。
 * 后端没起或接口挂了时页面还能显示一个可选风格，而不是空的按钮区。
 */
export const BEAUTY_STYLE_FALLBACK: BeautyStyleOption[] = [
  {
    id: 'realistic',
    name: '清新人像写真',
    description: '柔和自然光 + 浅景深虚化，适合头像与壁纸',
    tags: ['写真', '自然光', '高清'],
  },
]

/** 生成失败的可读错误；页面按它区分「业务失败」与「网络/超时」 */
export class BeautyImageRequestError extends Error {
  readonly code: string

  constructor(message: string, code = 'IMAGE_FAILED') {
    super(message)
    this.name = 'BeautyImageRequestError'
    this.code = code
  }
}

type BeautyStylesResponse = {
  styles?: Array<Partial<BeautyStyleOption>>
}

type BeautyGenerateResponse = {
  id?: string
  url?: string
  imageUrl?: string
  path?: string
  styleName?: string
  width?: number
  height?: number
  createdAt?: string
}

function toStyleOption(raw: Partial<BeautyStyleOption>): BeautyStyleOption | null {
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!id || !name) return null
  return {
    id,
    name,
    description: typeof raw.description === 'string' ? raw.description : '',
    tags: Array.isArray(raw.tags) ? raw.tags.filter((tag) => typeof tag === 'string') : [],
  }
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: string }).name === 'AbortError'
}

/** 优先用后端写的 error 文案，抠不到再退回通用话术 */
function messageOf(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as { error?: string } | undefined
    if (typeof data?.error === 'string' && data.error) return data.error
  }
  if (error instanceof Error && error.message) return error.message
  return fallback
}

/**
 * 风格预设。失败不抛：调用方（useEffect）没有 catch，
 * 抛出去只会变成未捕获的 rejection，所以这里直接退回兜底列表。
 */
export async function fetchBeautyStyles(signal?: AbortSignal): Promise<BeautyStyleOption[]> {
  try {
    const { data } = await axios.get<BeautyStylesResponse>(`${API_BASE}/api/image/styles`, { signal })
    const list = (Array.isArray(data?.styles) ? data.styles : [])
      .map(toStyleOption)
      .filter((item): item is BeautyStyleOption => item !== null)
    return list.length > 0 ? list : BEAUTY_STYLE_FALLBACK
  } catch {
    return BEAUTY_STYLE_FALLBACK
  }
}

/** 按风格出图；后端一次只返回一张，这里统一成数组交给结果画廊 */
export async function generateBeautyImage(
  input: { prompt: string; style?: string; size?: string },
  options: { signal?: AbortSignal } = {},
): Promise<BeautyImageResult> {
  try {
    const { data } = await axios.post<BeautyGenerateResponse>(
      `${API_BASE}/api/image/generate`,
      { prompt: input.prompt ?? '', styleId: input.style ?? '', size: input.size ?? '' },
      { signal: options.signal },
    )
    const url = data.imageUrl || data.url || (data.path ? `${API_BASE}${data.path}` : '')
    if (!url) throw new BeautyImageRequestError('后端没有返回图片地址，请稍后重试')
    const styleName = typeof data.styleName === 'string' ? data.styleName : ''
    return {
      styleName,
      images: [
        {
          id: data.id || url,
          url,
          styleName,
          width: data.width,
          height: data.height,
          createdAt: data.createdAt,
        },
      ],
    }
  } catch (error) {
    // 取消 / 超时原样抛出：页面按 AbortError 显示「生成超时」
    if (isAbortError(error) || axios.isCancel(error)) throw error
    if (error instanceof BeautyImageRequestError) throw error
    throw new BeautyImageRequestError(messageOf(error, '图片生成失败，请稍后重试'))
  }
}
