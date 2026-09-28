/**
 * 记忆的两层 API 客户端。
 *
 *   长期 = /api/memory/long，跨会话、跨刷新，落成 server/data/memory/<id>.md
 *   召回 = /api/memory/recall，只读预览「这句话会命中哪几条、cos 多少」
 *
 * 短期记忆（会话内那层）由服务端的 /api/sessions 负责，等 P3 接上再补到这里。
 */
import axios from 'axios'

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? ''

export type MemoryType = 'user' | 'preference' | 'project' | 'reference'
export type MemoryStatus = 'active' | 'archived' | 'superseded'

/** 和 server/src/memory/store.ts 的 MemoryEntry 对应 */
export type MemoryEntry = {
  id: string
  description: string
  type: MemoryType
  salience: number
  createdAt: number
  updatedAt: number
  sourceSession: string | null
  sourceQuote: string | null
  supersedes: string | null
  expires: number | null
  accessCount: number
  lastAccess: number | null
  status: MemoryStatus
  text: string
}

export type MemoryStats = {
  total: number
  active: number
  archived: number
  superseded: number
  byType: Record<MemoryType, number>
  topAccessed: Array<{ id: string; description: string; accessCount: number }>
  embedded: number
  model: string
}

export type MemoryLogRow = {
  ts: number
  action: 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP' | 'ARCHIVE' | 'RESTORE' | 'MANUAL'
  id: string
  reason: string
  session?: string | null
  candidate?: string
}

export type RecallHit = {
  id: string
  description: string
  type: MemoryType
  status: MemoryStatus
  cos: number
  score: number
  /** 和这条 query 的基线（对全部记忆的 cos 均值）比高多少 */
  gap: number
  pass: boolean
  via: 'vector' | 'keyword'
}

export type RecallPreview = {
  query: string
  minCosine: number
  topK: number
  /** 区分度主要在 query 一侧：基线高说明这句话跟什么都像 */
  baseline: number
  blocked: number
  hits: RecallHit[]
}

/** 类型标签，页面上直接显示中文 */
export const MEMORY_TYPE_LABEL: Record<MemoryType, string> = {
  user: '关于用户',
  preference: '偏好',
  project: '项目事实',
  reference: '参考资料',
}

export const MEMORY_STATUS_LABEL: Record<MemoryStatus, string> = {
  active: '生效中',
  archived: '已归档',
  superseded: '已被取代',
}

/** axios 的错误体是 { error }，取出来给人看；取不到就退回通用文案 */
function fail(err: unknown, what: string): never {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { error?: string } | undefined
    throw new Error(data?.error ?? `${what}失败 HTTP ${err.response?.status ?? ''}`.trim())
  }
  throw err instanceof Error ? err : new Error(String(err))
}

export async function fetchMemoryStats(): Promise<MemoryStats> {
  try {
    const res = await axios.get(`${API_BASE}/api/memory/stats`)
    return res.data as MemoryStats
  } catch (err) {
    return fail(err, '读取记忆统计')
  }
}

export async function fetchMemories(params: {
  q?: string
  type?: MemoryType | 'all'
  status?: MemoryStatus | 'all'
  offset?: number
  limit?: number
} = {}): Promise<{ total: number; offset: number; limit: number; items: MemoryEntry[] }> {
  try {
    const res = await axios.get(`${API_BASE}/api/memory/long`, { params })
    return res.data as { total: number; offset: number; limit: number; items: MemoryEntry[] }
  } catch (err) {
    return fail(err, '读取长期记忆')
  }
}

export async function fetchMemoryLog(limit = 100): Promise<MemoryLogRow[]> {
  try {
    const res = await axios.get(`${API_BASE}/api/memory/log`, { params: { limit } })
    return (res.data as { items: MemoryLogRow[] }).items
  } catch (err) {
    return fail(err, '读取记忆日志')
  }
}

export async function previewRecall(q: string, topK?: number): Promise<RecallPreview> {
  try {
    const res = await axios.get(`${API_BASE}/api/memory/recall`, { params: { q, topK } })
    return res.data as RecallPreview
  } catch (err) {
    return fail(err, '召回预览')
  }
}

export async function createMemory(input: {
  description: string
  text?: string
  type: MemoryType
  salience?: number
  expires?: string | null
}): Promise<MemoryEntry> {
  try {
    const res = await axios.post(`${API_BASE}/api/memory/long`, input)
    return (res.data as { item: MemoryEntry }).item
  } catch (err) {
    return fail(err, '新增记忆')
  }
}

export async function updateMemory(
  id: string,
  patch: Partial<Pick<MemoryEntry, 'description' | 'text' | 'type' | 'salience' | 'expires'>>,
): Promise<MemoryEntry> {
  try {
    const res = await axios.put(`${API_BASE}/api/memory/long/${encodeURIComponent(id)}`, patch)
    return (res.data as { item: MemoryEntry }).item
  } catch (err) {
    return fail(err, '更新记忆')
  }
}

export async function deleteMemory(id: string): Promise<void> {
  try {
    await axios.delete(`${API_BASE}/api/memory/long/${encodeURIComponent(id)}`)
  } catch (err) {
    return fail(err, '删除记忆')
  }
}

/** 归档 = 不参与召回但留在页面上；恢复是反操作 */
export async function setMemoryArchived(id: string, archived: boolean): Promise<MemoryEntry> {
  try {
    const res = await axios.post(
      `${API_BASE}/api/memory/long/${encodeURIComponent(id)}/${archived ? 'archive' : 'restore'}`,
    )
    return (res.data as { item: MemoryEntry }).item
  } catch (err) {
    return fail(err, archived ? '归档记忆' : '恢复记忆')
  }
}

export async function sweepMemories(): Promise<{ expired: string[]; stale: string[] }> {
  try {
    const res = await axios.post(`${API_BASE}/api/memory/sweep`)
    return res.data as { expired: string[]; stale: string[] }
  } catch (err) {
    return fail(err, '衰减扫描')
  }
}
