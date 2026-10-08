/**
 * 请求级用户上下文：多用户各自一份 llm.json / mcp.json。
 * 前端用 X-Playground-User 标识（浏览器生成），无登录态。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './paths.js'

type Store = { userId: string }

const als = new AsyncLocalStorage<Store>()

export function parseUserId(raw: unknown): string {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
  if (/^[a-z0-9][a-z0-9_-]{1,63}$/.test(s)) return s
  return 'local'
}

export function runWithUser(userId: string, next: () => void) {
  als.run({ userId: parseUserId(userId) }, next)
}

export function currentUserId(): string {
  return als.getStore()?.userId || 'local'
}

/** 当前用户的配置目录：server/data/users/<id>/ */
export function userConfigDir(): string {
  const dir = path.join(DATA_DIR, 'users', currentUserId())
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 用户配置文件路径。若用户目录里还没有、但根 data 下有旧文件，则拷一份过去
 * （兼容升级前的单机 llm.json / mcp.json）。
 */
export function userConfigFile(name: 'llm.json' | 'mcp.json'): string {
  const dest = path.join(userConfigDir(), name)
  if (!fs.existsSync(dest)) {
    const legacy = path.join(DATA_DIR, name)
    if (fs.existsSync(legacy)) {
      try {
        fs.copyFileSync(legacy, dest)
      } catch {
        /* 拷失败就当新用户，走默认 */
      }
    }
  }
  return dest
}
