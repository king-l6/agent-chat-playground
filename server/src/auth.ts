/**
 * 一层共享访问令牌。
 *
 * 定位：这个服务要挂到内网给几个人用，而原来的「身份」是前端自己生成的
 * X-Playground-User 请求头（见 requestContext.parseUserId，只做格式校验）。
 * 那等于把「读别人 LLM Key / 会话」的权利交给任何会改请求头的人。
 * 这里加的不是账号体系，是一道门：持令牌者进，并留下「谁在用」的痕迹。
 *
 * 令牌只从环境变量读，不落盘、不进库：
 *   PLAYGROUND_ACCESS_TOKENS=alice:<t1>,bob:<t2>   一人一把（推荐）
 *   PLAYGROUND_ACCESS_TOKEN=<t>                    单把，归属人记作 shared
 * 两个都不配 = authRequired() 为 false，行为退回改造前（Electron / 本地开发走这条）。
 *
 * Cookie 里存的是 HMAC(token) 而不是 token 本身：
 *   1) 换掉 env 里的令牌 = 立刻作废所有已发出的 cookie，不需要会话表、不需要 DB；
 *   2) httpOnly，页面脚本读不到，XSS 也偷不走原文。
 * 令牌是 openssl rand -hex 24 那种高熵随机串，所以 HMAC 用固定盐就够安全，
 * 不必再引入一个「部署级密钥」——少一个必须保管、必须轮换的东西。
 */
import crypto from 'node:crypto'
import type { Request, Response } from 'express'

export const SESSION_COOKIE = 'pg_session'

/** 固定盐，只在版本升级时装一次新的。改它 = 作废所有人的 cookie。 */
const SALT = 'pg-session-v1'

/** 登录失败限流：每 IP 每分钟 10 次。放进程内即可——单实例部署，重启清零可接受。 */
const LOGIN_WINDOW_MS = 60_000
const LOGIN_MAX_FAILS = 10
const loginFails = new Map<string, { count: number; resetAt: number }>()

export type Identity = { name: string }

/**
 * 解析 PLAYGROUND_ACCESS_TOKENS / PLAYGROUND_ACCESS_TOKEN。
 * 返回 token -> 归属人名。名字只用 [a-z0-9_-]，因为要拼进用户目录路径
 * （users/<name>/），非法字符就是路径穿越。
 */
let tokenCache: Map<string, string> | null = null

export function loadTokens(): Map<string, string> {
  if (tokenCache) return tokenCache
  const map = new Map<string, string>()
  const many = process.env.PLAYGROUND_ACCESS_TOKENS?.trim()
  if (many) {
    for (const pair of many.split(',')) {
      const idx = pair.indexOf(':')
      if (idx <= 0) continue
      const name = pair.slice(0, idx).trim().toLowerCase()
      const token = pair.slice(idx + 1).trim()
      if (!token) continue
      if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(name)) {
        console.warn(`[auth] 忽略非法归属人名：${name}（只用小写字母/数字/_/-，2～64 位）`)
        continue
      }
      map.set(token, name)
    }
  }
  // 单令牌兜底。和上面可以并存。
  const single = process.env.PLAYGROUND_ACCESS_TOKEN?.trim()
  if (single) map.set(single, 'shared')
  tokenCache = map
  if (map.size) {
    console.log(`[auth] 已启用访问令牌，归属人：${[...map.values()].join(', ')}`)
  }
  return map
}

/** 配了令牌才需要登录。没配 = Electron / 本地开发，行为不变。 */
export function authRequired(): boolean {
  return loadTokens().size > 0
}

/** 测试或热重载后想重读 env 时用；生产不会调。 */
export function resetTokenCache() {
  tokenCache = null
}

function hmac(token: string): Buffer {
  return crypto.createHmac('sha256', SALT).update(token).digest()
}

/** 定长比较。两边都是 32 字节 HMAC，长度必然相等；长度不等直接判否，不进 timingSafeEqual。 */
function sameHmac(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/** cookie 值：v1.<base64url(HMAC)>。带版本前缀是为了将来能改算法而不误判老 cookie。 */
export function cookieValue(token: string): string {
  return `v1.${hmac(token).toString('base64url')}`
}

/**
 * 从 cookie 值还原归属人。
 *
 * 不把归属人写进 cookie：cookie 的**全部内容**都是攻击者可改的输入，能不解析就不解析。
 * 这里改成「遍历已配置的令牌，比 HMAC」。用户数是几个人，O(n) 无所谓，
 * 换来的是 cookie 里没有任何需要校验的结构。
 */
export function verifyCookie(raw: string | undefined): Identity | null {
  if (!raw || !raw.startsWith('v1.')) return null
  let got: Buffer
  try {
    got = Buffer.from(raw.slice(3), 'base64url')
  } catch {
    return null
  }
  for (const [token, name] of loadTokens()) {
    if (sameHmac(hmac(token), got)) return { name }
  }
  return null
}

/** 从 Authorization: Bearer 还原归属人。给 curl / 脚本用，浏览器走 cookie。 */
export function parseBearer(header: string | undefined): Identity | null {
  if (!header) return null
  const m = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!m) return null
  return matchToken(m[1].trim())
}

/**
 * 拿明文令牌换归属人（登录用）。
 * 比的是 HMAC 而不是明文，所以这里也不会因为提前 return 泄漏「前几位对了」。
 */
export function matchToken(token: string): Identity | null {
  if (!token) return null
  const got = hmac(token)
  for (const [known, name] of loadTokens()) {
    if (sameHmac(hmac(known), got)) return { name }
  }
  return null
}

/**
 * 手写 cookie 解析，只取我们要的那一个。
 * 不引 cookie-parser：只为读一个键，多一个依赖不值得。这里不解析嵌套、不解码百分号
 * ——我们的值是自己发的 base64url，不含这些。
 */
export function readSessionCookie(req: Request): string | undefined {
  const header = req.headers.cookie
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      return part.slice(eq + 1).trim() || undefined
    }
  }
  return undefined
}

/** 请求身份：cookie 优先，其次 Bearer。都没有返回 null。 */
export function resolveIdentity(req: Request): Identity | null {
  return verifyCookie(readSessionCookie(req)) ?? parseBearer(req.headers.authorization)
}

/**
 * 写会话 cookie。
 * httpOnly：JS 读不到，XSS 偷不走。
 * SameSite=Lax：挡掉跨站 POST（改状态的请求），同时不影响从内网聊天工具点链接进来。
 * secure 只在明确走 https 时开——内网多半是 http，开了 cookie 直接被浏览器丢掉。
 */
export function setSessionCookie(res: Response, token: string, secure: boolean) {
  const attrs = [
    `${SESSION_COOKIE}=${cookieValue(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${60 * 60 * 24 * 30}`,
  ]
  if (secure) attrs.push('Secure')
  res.append('Set-Cookie', attrs.join('; '))
}

export function clearSessionCookie(res: Response) {
  res.append('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

/** 登录限流：同一 IP 一分钟内失败超过阈值就拒。返回剩余可试次数，负数表示已锁。 */
export function noteLoginFail(ip: string): number {
  const now = Date.now()
  const row = loginFails.get(ip)
  if (!row || now > row.resetAt) {
    loginFails.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS })
    return LOGIN_MAX_FAILS - 1
  }
  row.count += 1
  return LOGIN_MAX_FAILS - row.count
}

export function loginLocked(ip: string): boolean {
  const row = loginFails.get(ip)
  if (!row) return false
  if (Date.now() > row.resetAt) {
    loginFails.delete(ip)
    return false
  }
  return row.count >= LOGIN_MAX_FAILS
}

export function clearLoginFails(ip: string) {
  loginFails.delete(ip)
}

/**
 * 启动前的保险：监听非回环地址却没配令牌 = 把这个后端裸奔在内网。
 * 与其启动后等人发现，不如直接拒绝启动。Electron / 本地开发绑 127.0.0.1，不受影响。
 */
export function assertSafeExposure(host: string) {
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
  if (loopback || authRequired()) return
  throw new Error(
    `拒绝启动：监听 ${host}（对其它机器可见）但没有配访问令牌。` +
      `请设置 PLAYGROUND_ACCESS_TOKENS=名字:令牌 或 PLAYGROUND_ACCESS_TOKEN=令牌；` +
      `本机自用请改 PLAYGROUND_LISTEN_HOST=127.0.0.1。`,
  )
}
