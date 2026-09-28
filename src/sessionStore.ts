/**
 * 多会话存在浏览器本地。刷新后还在；各会话的消息互不影响。
 */
import type { UiMessage } from './types'

const KEY = 'agentos.sessions.v1'

export type ChatSession = {
  id: string
  title: string
  /**
   * 最后一次「用户提问」的时间。
   * 左侧列表的排序 / 今天-昨天分组 / 列表里的日期都只认这个字段。
   * 坑：不要拿流式回调（text_delta / tool_* / step）去写它——多个会话同时生成时，
   * 每来一个 token 就换一次排序键，列表会上下反复换位。
   */
  lastUserAt: number
  /** 最后一次活动时间（含流式 token 与工具事件）。只用于「最近动过」这类展示，不参与排序。 */
  updatedAt: number
  messages: UiMessage[]
}

export function uid() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function blankSession(): ChatSession {
  const now = Date.now()
  return { id: uid(), title: '新对话', lastUserAt: now, updatedAt: now, messages: [] }
}

export function sessionTitle(messages: UiMessage[]) {
  const first = messages.find((m) => m.role === 'user' && m.content.trim())
  if (!first) return '新对话'
  const text = first.content.trim().replace(/\s+/g, ' ')
  return text.length > 24 ? `${text.slice(0, 24)}…` : text
}

function revive(raw: unknown): ChatSession | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Partial<ChatSession>
  if (typeof row.id !== 'string' || !Array.isArray(row.messages)) return null
  const messages = row.messages.map((m) =>
    m.status === 'streaming'
      ? { ...m, status: 'done' as const, content: m.content || '（已中断）' }
      : m,
  )
  const updatedAt = typeof row.updatedAt === 'number' ? row.updatedAt : Date.now()
  return {
    id: row.id,
    title: typeof row.title === 'string' && row.title ? row.title : sessionTitle(messages),
    // 老数据没有 lastUserAt：回退到 updatedAt，至少保证排序键存在且稳定
    lastUserAt: typeof row.lastUserAt === 'number' ? row.lastUserAt : updatedAt,
    updatedAt,
    messages,
  }
}

export function loadSessions(): { activeId: string; sessions: ChatSession[] } {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) throw new Error('empty')
    const data = JSON.parse(raw) as { activeId?: string; sessions?: unknown[] }
    const sessions = (data.sessions ?? []).map(revive).filter((s): s is ChatSession => s != null)
    if (sessions.length === 0) throw new Error('empty')
    const activeId = sessions.some((s) => s.id === data.activeId) ? data.activeId! : sessions[0].id
    return { activeId, sessions }
  } catch {
    const session = blankSession()
    return { activeId: session.id, sessions: [session] }
  }
}

export function saveSessions(activeId: string, sessions: ChatSession[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ activeId, sessions }))
  } catch {
    /* 配额满时丢掉这次写入，界面仍可用 */
  }
}
