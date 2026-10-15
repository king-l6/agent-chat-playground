/**
 * 浏览器侧的令牌门禁客户端。
 *
 * 后端配了 PLAYGROUND_ACCESS_TOKENS 才会「要令牌」；没配（Electron / 本地开发）
 * authRequired 为 false，AuthGate 直接放行，行为跟改造前一模一样。
 *
 * 身份凭证是 httpOnly cookie，JS 读不到内容 —— 所以「当前是谁」只能问服务端。
 * 这也意味着前端不能再自报家门（旧版 X-Playground-User 自拟头在令牌模式下被后端忽略）。
 */
import { API_BASE } from './apiUrl'

export type SessionInfo = {
  /** 服务端是否启用了令牌门禁 */
  authRequired: boolean
  /** 现在能不能用（未启用门禁时恒为 true） */
  authenticated: boolean
  /** 归属人；未登录时为 null */
  user: string | null
}

/**
 * 一律带 credentials：
 * 同源时是空操作，但一旦 VITE_API_BASE 指到别的源（nginx 拆端口那种），
 * 不带就不会发 cookie，表现为「登录成功了但每个请求都 401」。
 */
const WITH_CREDS: RequestInit = { credentials: 'include' }

async function readError(res: Response, fallback: string) {
  const text = await res.text().catch(() => '')
  if (!text) return `${fallback} HTTP ${res.status}`
  try {
    const parsed = JSON.parse(text) as { error?: string }
    return parsed.error || text
  } catch {
    return text
  }
}

export async function fetchSession(): Promise<SessionInfo> {
  const res = await fetch(`${API_BASE}/api/auth/session`, WITH_CREDS)
  if (!res.ok) throw new Error(await readError(res, '取会话失败'))
  return (await res.json()) as SessionInfo
}

export async function loginWithToken(token: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    ...WITH_CREDS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  if (!res.ok) throw new Error(await readError(res, '登录失败'))
  const data = (await res.json()) as { user?: string }
  return data.user ?? ''
}

export async function logoutSession(): Promise<void> {
  await fetch(`${API_BASE}/api/auth/logout`, { ...WITH_CREDS, method: 'POST' }).catch(() => {
    /* 退出失败无所谓，前端照样清干净 */
  })
}
