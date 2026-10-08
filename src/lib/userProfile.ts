/**
 * 浏览器侧「环境档案」：多用户共用一台服务时，用本地 userId 区分各自的
 * LLM Key / MCP Cookie。无登录，换浏览器或清站点数据即新档案。
 */
import axios from 'axios'

const ID_KEY = 'playground.userId'
const NAME_KEY = 'playground.userName'

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
}
