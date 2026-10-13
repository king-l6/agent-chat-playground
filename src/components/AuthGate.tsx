/**
 * 令牌门禁：套在 <App /> 外面，未登录时只渲染登录表单。
 *
 * 刻意做成 App 的**外壳**而不是改 App 内部：App.tsx 有一千多行且在同时改动，
 * 而且它自己完全不需要知道认证这回事 —— 认证状态由 httpOnly cookie 承载，
 * 每个请求自动带上，登录成功后无缝换页即可。
 *
 * 三条分支：
 *   checking  会话还没问回来（首屏，避免闪一下登录页再放行）
 *   login     服务端配了令牌且还没登录
 *   ready     放行（含「服务端根本没配令牌」，桌面壳和本地开发走这条）
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { fetchSession, loginWithToken } from '../lib/auth'
import { adoptServerUser } from '../lib/userProfile'
import './AuthGate.css'

type Phase = 'checking' | 'login' | 'ready' | 'unreachable'

export function AuthGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>('checking')
  const [user, setUser] = useState('')
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [why, setWhy] = useState('')

  const check = useCallback(async () => {
    setPhase('checking')
    setError('')
    try {
      const session = await fetchSession()
      if (session.authenticated) {
        /*
         * 只有服务端**真的启用了门禁**时，user 才是「服务端身份」。
         * 没启用时后端回的是兜底的 'local'（见 /api/auth/session），
         * 照收会把 Electron / 本地开发的「换档案 ID」锁死 —— 那是要保留的玩法。
         */
        if (session.authRequired && session.user) {
          adoptServerUser(session.user)
          setUser(session.user)
        }
        setPhase('ready')
        return
      }
      setPhase('login')
    } catch (err) {
      setWhy(err instanceof Error ? err.message : String(err))
      setPhase('unreachable')
    }
  }, [])

  useEffect(() => {
    void check()
  }, [check])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (busy || !token.trim()) return
    setBusy(true)
    setError('')
    try {
      const who = await loginWithToken(token.trim())
      adoptServerUser(who)
      setUser(who)
      setToken('')
      setPhase('ready')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (phase === 'checking') {
    return <div className="authgate authgate--plain">正在连接服务…</div>
  }

  if (phase === 'unreachable') {
    return (
      <div className="authgate authgate--plain">
        <div className="authgate__card">
          <h1 className="authgate__brand">连不上后端</h1>
          <p className="authgate__sub">{why}</p>
          <button type="button" className="authgate__btn" onClick={() => void check()}>
            重试
          </button>
        </div>
      </div>
    )
  }

  if (phase === 'login') {
    return (
      <div className="authgate authgate--plain">
        <form className="authgate__card" onSubmit={onSubmit}>
          <h1 className="authgate__brand">Agent Chat Playground</h1>
          <p className="authgate__sub">内网服务，需要访问令牌。</p>
          <input
            className="authgate__input"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="粘贴你的访问令牌"
            autoFocus
            autoComplete="current-password"
          />
          {error ? <div className="authgate__err">{error}</div> : null}
          <button type="submit" className="authgate__btn" disabled={busy || !token.trim()}>
            {busy ? '验证中…' : '进入'}
          </button>
          <p className="authgate__note">
            令牌由管理员发放，绑定到一个归属人名下。它决定的不是「你能看什么」，
            而是「用哪份 LLM Key / MCP 配置」—— 登录后这些跟着归属人走。
          </p>
        </form>
      </div>
    )
  }

  return (
    <>
      {children}
      {user ? (
        // 挂在右下角，纯提示：身份现在是服务端给的，用户改不了，所以只需要「知道自己是谁」
        <div className="authgate__badge" title="当前登录的归属人">
          {user}
        </div>
      ) : null}
    </>
  )
}
