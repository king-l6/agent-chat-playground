/**
 * PDF 阅读器的后端接口。约定同 src/api/chat.ts：API_BASE 在 dev 下为空（走 vite 代理），
 * 打包后指向 127.0.0.1:8790。
 *
 * 文件本身也用 axios 取成 arraybuffer 再喂给 pdf.js，而不是把 URL 交给它自己 fetch：
 * 鉴权和跨源都交给 axios 这一层，跟别的接口保持一致（pdf.js 自己 fetch 不会带 cookie）。
 */
import axios from 'axios'
import { API_BASE } from '../lib/apiUrl'

export type PdfTocNode = {
  title: string
  /** 1 起 */
  page: number
  /** 页内纵坐标，PDF 用户空间（原点左下） */
  y: number
  level: number
  children?: PdfTocNode[]
}

export type PdfMeta = {
  id: string
  name: string
  storedAs: string
  bytes: number
  /** 0 = 前端还没解析过 */
  pages: number
  hasToc: boolean
  tocSource: 'outline' | 'infer' | null
  /** 目录顶级条目数 */
  tocRoots: number
  addedAt: number
}

/** 把 axios 的报错换成后端给的 error 文案，跟 chat.ts 里的写法一致 */
function rethrow(err: unknown): never {
  if (axios.isAxiosError(err)) {
    const msg = (err.response?.data as { error?: string } | undefined)?.error
    throw new Error(msg || err.message)
  }
  throw err
}

export async function fetchPdfs() {
  try {
    const { data } = await axios.get<{ pdfs: PdfMeta[] }>(`${API_BASE}/api/pdfs`)
    return data.pdfs
  } catch (err) {
    rethrow(err)
  }
}

export async function uploadPdf(file: File) {
  const body = new FormData()
  body.append('file', file)
  try {
    const { data } = await axios.post<{ ok: boolean; pdf: PdfMeta }>(
      `${API_BASE}/api/pdfs`,
      body,
      // 上百 MB 的书，走默认 100s 超时可能不够
      { timeout: 0 },
    )
    return data.pdf
  } catch (err) {
    rethrow(err)
  }
}

/** 取原文件字节。pdf.js 会接管这块 buffer（可能 detach），每次打开都得重新取 */
export async function fetchPdfBytes(id: string) {
  try {
    const { data } = await axios.get<ArrayBuffer>(
      `${API_BASE}/api/pdfs/${encodeURIComponent(id)}/file`,
      { responseType: 'arraybuffer', timeout: 0 },
    )
    return data
  } catch (err) {
    rethrow(err)
  }
}

/** 读已缓存的目录；没算过返回 null */
export async function fetchPdfToc(id: string) {
  try {
    const { data } = await axios.get<{
      toc: { source: 'outline' | 'infer'; nodes: PdfTocNode[] } | null
    }>(`${API_BASE}/api/pdfs/${encodeURIComponent(id)}/toc`)
    return data.toc
  } catch (err) {
    rethrow(err)
  }
}

/** 目录缓存：pdf.js 在浏览器里解得出来，算完存回服务端，下次打开不用重扫 */
export async function savePdfToc(
  id: string,
  payload: { source: 'outline' | 'infer'; nodes: PdfTocNode[]; pages: number },
) {
  try {
    const { data } = await axios.put<{ ok: boolean; pdf: PdfMeta }>(
      `${API_BASE}/api/pdfs/${encodeURIComponent(id)}/toc`,
      payload,
    )
    return data.pdf
  } catch (err) {
    rethrow(err)
  }
}

export async function deletePdf(id: string) {
  try {
    const { data } = await axios.delete<{ ok: boolean; pdfs: PdfMeta[] }>(
      `${API_BASE}/api/pdfs/${encodeURIComponent(id)}`,
    )
    return data.pdfs
  } catch (err) {
    rethrow(err)
  }
}
