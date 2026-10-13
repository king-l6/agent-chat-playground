/**
 * 浏览器侧「环境档案」：多用户共用一台服务时，用本地 userId 区分各自的
 * LLM Key / MCP Cookie。
 *
 * **服务形态下这层档案不再由用户自选**：身份来自访问令牌（AuthGate 登录后
 * adoptServerUser 把归属人写进来），后端也只认认证结果、不读 X-Playground-User。
 * 本地 / 桌面壳（没配令牌）仍走老的自拟 ID，换浏览器就是新档案。
 */
import axios from 'axios'

const ID_KEY = 'playground.userId'
const NAME_KEY = 'playground.userName'

/** 服务端认证出来的归属人。null = 没登录 / 服务端没开令牌门禁 */
let serverUser: string | null = null

export function serverIdentity(): string | null {
  return serverUser
}

/**
 * 把服务端给的归属人落成「当前档案」。
 * 只覆盖本地 ID，不动 NAME_KEY —— 显示名是用户自己起的，跟令牌无关。
 */
export function adoptServerUser(name: string): string | null {
  const id = name.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(id)) return null
  serverUser = id
  try {
    localStorage.setItem(ID_KEY, id)
  } catch {
    /* private mode：只在内存里认这个身份，刷新后回到默认 */
  }
  axios.defaults.headers.common['X-Playground-User'] = id
  return id
}

function randomId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `u_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
  }
  return `u_${Date.now().toString(36)}`
}

export function getUserId(): string {
  try {
    const existing = localStorage.getItem(ID_KEY)?.trim().toLowerCase()
    if (existing && /^[a-z0-9][a-z0-9_-]{1,63}$/.test(existing)) return existing
    const id = randomId()
    localStorage.setItem(ID_KEY, id)
    return id
  } catch {
    return 'local'
  }
}

export function setUserId(raw: string): string {
  if (serverUser) {
    throw new Error('服务形态下身份由访问令牌决定，改不了。')
  }
  const id = raw.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(id)) {
    throw new Error('档案 ID 只用小写字母、数字、_、-，2～64 位')
  }
  localStorage.setItem(ID_KEY, id)
  axios.defaults.headers.common['X-Playground-User'] = id
  return id
}

export function getUserName(): string {
  try {
    return localStorage.getItem(NAME_KEY)?.trim() || ''
  } catch {
    return ''
  }
}

export function setUserName(name: string) {
  try {
    localStorage.setItem(NAME_KEY, name.trim().slice(0, 40))
  } catch {
    /* private mode */
  }
}

/** 在应用启动时挂上默认请求头，之后所有 axios 都会带上。 */
export function installUserHeader() {
  axios.defaults.headers.common['X-Playground-User'] = getUserId()
  /*
   * 凭证 cookie 要跨源携带。同源时这是空操作，但 VITE_API_BASE 指到别的源
   * （桌面壳的 file:// → http://127.0.0.1:8790 就是）时不设就没 cookie，
   * 表现为「登录页过了，之后每个请求 401」。
   */
  axios.defaults.withCredentials = true
}
