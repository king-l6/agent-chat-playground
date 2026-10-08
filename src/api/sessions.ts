/**
 * 会话的服务端存取。
 *
 * 会话按**归属人**存在 server/data/users/<userId>/sessions/<id>.json；
 * 归属人由请求头 X-Playground-User 决定 —— lib/userProfile.installUserHeader()
 * 已在启动时全局挂上，这里不用手动带。
 *
 * 分享链接 #/c/<ownerId>/<sessionId> 打开时走 fetchSharedSession：读的是**别人**的会话，
 * 要求对方把这条设成了 visibility === 'shared'，否则后端 403（见 server/src/index.ts）。
 */
import axios from 'axios'
import { API_BASE } from '../lib/apiUrl'

export type SessionVisibility = 'private' | 'shared'

/** 后端存储形态；messages 是不透明 JSON（就是前端的 UiMessage[]，后端不解释） */
export type StoredSession = {
  id: string
  ownerId: string
  title: string
  lastUserAt: number
  updatedAt: number
  visibility: SessionVisibility
  messages: unknown[]
}

/** PUT 上去的载荷。**不带 ownerId**：归属人由后端按当前请求头填，带上也无效 */
export type SessionPayload = {
  id: string
  title: string
  lastUserAt: number
  updatedAt: number
  visibility: SessionVisibility
  messages: unknown[]
}

/** 从 axios 错误里抠出后端给的 error 文案，抠不到就退回原消息 */
export function sessionErrorText(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = (err.response?.data as { error?: string } | undefined)?.error
    return msg || err.message || fallback
  }
  return err instanceof Error ? err.message : fallback
}

/** 拉当前用户自己的全部会话（一次拉全量，含 messages） */
export async function listSessions(): Promise<StoredSession[]> {
  const { data } = await axios.get<{ sessions: StoredSession[] }>(`${API_BASE}/api/sessions`)
  return Array.isArray(data.sessions) ? data.sessions : []
}

/**
 * 按归属人读一条会话 —— 分享链接走这条。
 * 对方未分享时后端 403，这里抛成带后端文案的 Error，调用方直接展示。
 */
export async function fetchSharedSession(ownerId: string, id: string): Promise<StoredSession> {
  try {
    const { data } = await axios.get<{ session: StoredSession }>(
      `${API_BASE}/api/sessions/${encodeURIComponent(ownerId)}/${encodeURIComponent(id)}`,
    )
    return data.session
  } catch (err) {
    throw new Error(sessionErrorText(err, '读取会话失败'))
  }
}

/** 落盘一条会话（整条覆盖）。失败会让调用方知道，但不该打断界面 */
export async function saveSession(session: SessionPayload): Promise<void> {
  await axios.put(`${API_BASE}/api/sessions/${encodeURIComponent(session.id)}`, session)
}

export async function deleteRemoteSession(id: string): Promise<void> {
  try {
    await axios.delete(`${API_BASE}/api/sessions/${encodeURIComponent(id)}`)
  } catch (err) {
    throw new Error(sessionErrorText(err, '删除会话失败'))
  }
}
