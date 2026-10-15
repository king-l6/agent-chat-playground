/**
 * 会话状态。
 *
 * 存储口径：**服务端为准**（server/data/users/<userId>/sessions/<id>.json，见 server/src/sessions.ts），
 * localStorage 只当两件事用：
 *   1) 首帧缓存 —— 刷新时先拿它秒开，再等服务端结果覆盖；
 *   2) 离线兜底 —— 服务端连不上时仍能看历史。
 * 启动时两边做一次**并集**合并（同一个 id 取 updatedAt 更新的那条），本地更新的会被推回服务端。
 *
 * 分享：会话有 visibility。链接形如 #/c/<ownerId>/<sessionId>，
 * 别人打开只能只读；归属人点「分享」把它置成 shared 后对方才读得到。
 */
import type { UiMessage } from './types'
import type { SessionPayload, SessionVisibility, StoredSession } from './api/sessions'

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
  /** private = 只有自己能看；shared = 有链接的人都能只读打开 */
  visibility: SessionVisibility
  messages: UiMessage[]
}

export function uid() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function blankSession(): ChatSession {
  const now = Date.now()
  return {
    id: uid(),
    title: '新对话',
    lastUserAt: now,
    updatedAt: now,
    visibility: 'private',
    messages: [],
  }
}

export function sessionTitle(messages: UiMessage[]) {
  const first = messages.find((m) => m.role === 'user' && m.content.trim())
  if (!first) return '新对话'
  const text = first.content.trim().replace(/\s+/g, ' ')
  return text.length > 24 ? `${text.slice(0, 24)}…` : text
}

/**
 * 消息数组的修复：上次流到一半就被打断（刷新 / 崩溃）的那条要收尾成 done，
 * 否则会永久停在 streaming，界面上一直转圈。
 * 本地缓存和服务端记录共用这一处，两边口径必须一致。
 */
function reviveMessages(raw: unknown): UiMessage[] {
  if (!Array.isArray(raw)) return []
  return (raw as UiMessage[]).map((m) =>
    m && m.status === 'streaming'
      ? { ...m, status: 'done' as const, content: m.content || '（已中断）' }
      : m,
  )
}

/** 服务端记录 → 内存会话。丢掉 ownerId：归属人由请求头决定，不属于会话正文 */
export function hydrate(row: StoredSession): ChatSession {
  const updatedAt = typeof row.updatedAt === 'number' ? row.updatedAt : Date.now()
  return {
    id: row.id,
    title: typeof row.title === 'string' && row.title ? row.title : '新对话',
    // 老数据没有 lastUserAt：回退到 updatedAt，至少保证排序键存在且稳定
    lastUserAt: typeof row.lastUserAt === 'number' ? row.lastUserAt : updatedAt,
    updatedAt,
    visibility: row.visibility === 'shared' ? 'shared' : 'private',
    messages: reviveMessages(row.messages),
  }
}

/** 内存会话 → 落盘载荷 */
export function toPayload(s: ChatSession): SessionPayload {
  return {
    id: s.id,
    title: s.title,
    lastUserAt: s.lastUserAt,
    updatedAt: s.updatedAt,
    visibility: s.visibility,
    messages: s.messages,
  }
}

function revive(raw: unknown): ChatSession | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Partial<ChatSession>
  if (typeof row.id !== 'string' || !Array.isArray(row.messages)) return null
  const messages = reviveMessages(row.messages)
  const updatedAt = typeof row.updatedAt === 'number' ? row.updatedAt : Date.now()
  return {
    id: row.id,
    title: typeof row.title === 'string' && row.title ? row.title : sessionTitle(messages),
    lastUserAt: typeof row.lastUserAt === 'number' ? row.lastUserAt : updatedAt,
    updatedAt,
    visibility: row.visibility === 'shared' ? 'shared' : 'private',
    messages,
  }
}

/** 同步读 localStorage 缓存。首帧就用它渲染，别等网络 */
export function loadCached(): { activeId: string; sessions: ChatSession[] } {
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

/** 同步写 localStorage 缓存。配额满就丢掉这次写入，界面仍可用 */
export function saveCached(activeId: string, sessions: ChatSession[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ activeId, sessions }))
  } catch {
    /* 忽略 */
  }
}

/**
 * 启动合并：本地缓存 × 服务端列表，按 id 取 updatedAt 更新的那条。
 *
 * @returns merged 合并后的列表；push 需要推回服务端的那几条（本地有、或本地更新）
 *
 * 为什么要 push 而不是「服务端有数据就无脑用它」：localStorage 是写后缓存，
 * 关页/崩溃前没来得及 PUT 的那次改动只存在本地，无脑用服务端就把它丢了。
 */
export function reconcile(
  local: ChatSession[],
  remote: ChatSession[],
): { merged: ChatSession[]; push: ChatSession[] } {
  const byId = new Map<string, ChatSession>()
  for (const s of remote) byId.set(s.id, s)
  const push: ChatSession[] = []
  for (const s of local) {
    const r = byId.get(s.id)
    if (!r || s.updatedAt > r.updatedAt) {
      byId.set(s.id, s)
      push.push(s)
    }
  }
  const merged = [...byId.values()].sort((a, b) => b.lastUserAt - a.lastUserAt)
  return { merged, push }
}
