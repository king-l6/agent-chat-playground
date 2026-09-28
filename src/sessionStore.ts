/**
 * 多会话存在浏览器本地。刷新后还在；各会话的消息互不影响。
 */
import type { UiMessage } from './types'

const KEY = 'agentos.sessions.v1'

export type ChatSession = {
  id: string
  title: string
  updatedAt: number
  messages: UiMessage[]
}

export function uid() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function blankSession(): ChatSession {
  return { id: uid(), title: '新对话', updatedAt: Date.now(), messages: [] }
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
  return {
    id: row.id,
    title: typeof row.title === 'string' && row.title ? row.title : sessionTitle(messages),
    updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : Date.now(),
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
