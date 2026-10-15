/**
 * 用户级「环境变量」键值对（配置页可编辑）。
 * 存 users/<id>/env.json；敏感值对外只回 hasValue，不回显原文。
 *
 * 约定会自动接到现有能力上的键：
 * - Cookie / Authorization / 任意其它 → 合并进 MCP 请求头（Cookie、Authorization 优先）
 * - OPENAI_API_KEY / ANTHROPIC_API_KEY → 补 LLM Key（面板没填时）
 * - OPENAI_BASE_URL / ANTHROPIC_BASE_URL → 补网关地址
 */
import fs from 'node:fs'
import path from 'node:path'
import { userConfigDir } from './requestContext.js'

export type EnvPublicRow = {
  key: string
  /** 已保存过值时为 true；原文不回传 */
  hasValue: boolean
  /** 仅本次保存请求里新提交的明文会短暂存在于内存，不用于 GET */
}

function envFile() {
  return path.join(userConfigDir(), 'env.json')
}

function readAll(): Record<string, string> {
  try {
    const raw = JSON.parse(fs.readFileSync(envFile(), 'utf8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const key = k.trim()
      if (!key || typeof v !== 'string') continue
      out[key] = v
    }
    return out
  } catch {
    return {}
  }
}

function writeAll(map: Record<string, string>) {
  const file = envFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(map, null, 2), 'utf8')
}

export function getUserEnvMap(): Record<string, string> {
  return readAll()
}

export function publicUserEnv(): { vars: EnvPublicRow[] } {
  seedCookieFromMcpJson()
  const map = readAll()
  const vars = Object.keys(map)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => ({ key, hasValue: Boolean(map[key]) }))
  return { vars }
}

/** 老用户只有 mcp.json 里的 Cookie 时，第一次打开环境变量页自动带过来。 */
function seedCookieFromMcpJson() {
  const map = readAll()
  if (Object.keys(map).length > 0) return
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(userConfigDir(), 'mcp.json'), 'utf8'),
    ) as { headers?: Record<string, unknown> }
    const headers = raw.headers
    if (!headers || typeof headers !== 'object') return
    const next: Record<string, string> = {}
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v === 'string' && v.trim()) next[k] = v
    }
    if (Object.keys(next).length) writeAll(next)
  } catch {
    /* 没有 mcp.json 就跳过 */
  }
}

/**
 * 保存整表。rows[].value：
 * - 字符串：写入（可空串＝清空该键）
 * - undefined / 省略：若旧表有该键则保留原值（改名/重排时不丢密文）
 * 不在 rows 里的旧键删除。
 */
export function saveUserEnv(
  rows: Array<{ key: string; value?: string; keep?: boolean }>,
): { vars: EnvPublicRow[] } {
  const prev = readAll()
  const next: Record<string, string> = {}
  const seen = new Set<string>()
  for (const row of rows) {
    const key = row.key.trim()
    if (!key) continue
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) {
      throw new Error(`非法变量名：${key}（字母/下划线开头，可含数字 . _ -）`)
    }
    if (seen.has(key)) throw new Error(`变量名重复：${key}`)
    seen.add(key)
    if (typeof row.value === 'string') {
      if (row.value !== '') next[key] = row.value
      // 空串＝删除
    } else if (row.keep && prev[key] !== undefined) {
      next[key] = prev[key]
    } else if (prev[key] !== undefined && row.value === undefined) {
      next[key] = prev[key]
    }
  }
  writeAll(next)
  return publicUserEnv()
}

/** MCP 用：用户环境变量里除 LLM 专用键外，都当请求头（Cookie 等）。 */
export function mcpHeadersFromUserEnv(): Record<string, string> {
  const map = readAll()
  const skip = new Set([
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENAI_BASE_URL',
    'ANTHROPIC_BASE_URL',
    'OPENAI_MODEL',
    'CONTEXT_WINDOW_TOKENS',
    'MCP_URL',
  ])
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(map)) {
    if (!v.trim() || skip.has(k)) continue
    headers[k] = v
  }
  // 也允许 MCP_URL 只当 URL 用，不进 header
  return headers
}

export function userEnvGet(key: string): string {
  return readAll()[key]?.trim() || ''
}
