/**
 * 把一个 HTTP MCP 接到 Agent 循环：tools/list → OpenAI function calling。
 * Cookie / Bearer 只写 DATA_DIR/mcp.json（打包后是 userData），不进 git。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import type { ChatCompletionFunctionTool } from 'openai/resources/chat/completions'
import { DATA_DIR } from './paths.js'

const FILE = path.join(DATA_DIR, 'mcp.json')
const MAX_TOOLS = 40
const CONNECT_MS = 8_000

export type McpSettings = {
  enabled: boolean
  url: string
  headers: Record<string, string>
}

export type McpPublic = {
  enabled: boolean
  connected: boolean
  url: string
  hasAuth: boolean
  tools: string[]
  error: string | null
}

type Cache = {
  client: Client | null
  tools: ChatCompletionFunctionTool[]
  /** OpenAI 工具名 → MCP 原名 */
  names: Map<string, string>
  instructions: string
  error: string | null
}

const emptySettings = (): McpSettings => ({
  enabled: false,
  url: '',
  headers: {},
})

let settings = readDisk() ?? fromEnv()
let cache: Cache = blankCache()

function blankCache(): Cache {
  return {
    client: null,
    tools: [],
    names: new Map(),
    instructions: '',
    error: null,
  }
}

function readDisk(): McpSettings | null {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Partial<McpSettings>
    return {
      enabled: raw.enabled === true,
      url: typeof raw.url === 'string' ? raw.url.trim() : '',
      headers:
        raw.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers)
          ? Object.fromEntries(
              Object.entries(raw.headers).filter(
                (kv): kv is [string, string] => typeof kv[1] === 'string',
              ),
            )
          : {},
    }
  } catch {
    return null
  }
}

function fromEnv(): McpSettings {
  const url = process.env.MCP_URL?.trim() ?? ''
  const cookie = process.env.MCP_COOKIE?.trim() ?? ''
  const auth = process.env.MCP_AUTHORIZATION?.trim() ?? ''
  const headers: Record<string, string> = {}
  if (cookie) headers.Cookie = cookie
  if (auth) headers.Authorization = auth
  return { enabled: Boolean(url), url, headers }
}

function persist(next: McpSettings) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), 'utf8')
  settings = next
}

export function publicMcp(): McpPublic {
  return {
    enabled: settings.enabled,
    connected: Boolean(cache.client),
    url: settings.url,
    hasAuth: Object.keys(settings.headers).length > 0,
    tools: cache.tools.map((t) => t.function.name),
    error: cache.error,
  }
}

export function mcpToolDefinitions(): ChatCompletionFunctionTool[] {
  return cache.tools
}

export function mcpInstructions(): string {
  return cache.instructions
}

export function isMcpTool(name: string) {
  return cache.names.has(name)
}

export function parseAuthInput(raw: string): Record<string, string> {
  const t = raw.trim()
  if (!t) return {}
  if (/^cookie\s*:/i.test(t)) return { Cookie: t.replace(/^cookie\s*:\s*/i, '').trim() }
  if (/^authorization\s*:/i.test(t)) {
    return { Authorization: t.replace(/^authorization\s*:\s*/i, '').trim() }
  }
  if (/^bearer\s+/i.test(t)) return { Authorization: t }
  return { Cookie: t }
}

type HttpServer = { name: string; url: string; headers: Record<string, string> }

function serversFromMcpServers(raw: unknown): HttpServer[] {
  if (!raw || typeof raw !== 'object') return []
  const out: HttpServer[] = []
  for (const [name, cfg] of Object.entries(raw as Record<string, unknown>)) {
    if (!cfg || typeof cfg !== 'object') continue
    const c = cfg as { url?: unknown; headers?: unknown }
    if (typeof c.url !== 'string' || !/^https?:\/\//i.test(c.url)) continue
    const headers: Record<string, string> = {}
    if (c.headers && typeof c.headers === 'object' && !Array.isArray(c.headers)) {
      for (const [k, v] of Object.entries(c.headers as Record<string, unknown>)) {
        if (typeof v === 'string' && v.trim()) headers[k] = v
      }
    }
    out.push({ name, url: c.url.trim(), headers })
  }
  return out
}

/** 从本机 Claude Code 配置里挑一个 HTTP MCP（优先带鉴权、名字像 ai-mcp）。 */
export function pickClaudeHttpMcp(): HttpServer | null {
  const found: HttpServer[] = []
  const home = os.homedir()
  for (const file of [path.join(home, '.claude', '.mcp.json')]) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers?: unknown }
      found.push(...serversFromMcpServers(raw.mcpServers))
    } catch {
      /* 文件不存在就跳过 */
    }
  }
  try {
    const claude = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')) as {
      mcpServers?: unknown
      projects?: Record<string, { mcpServers?: unknown }>
    }
    found.push(...serversFromMcpServers(claude.mcpServers))
    for (const proj of Object.values(claude.projects ?? {})) {
      found.push(...serversFromMcpServers(proj?.mcpServers))
    }
  } catch {
    /* 没有 Claude 配置 */
  }

  if (found.length === 0) return null
  found.sort((a, b) => scoreClaude(b) - scoreClaude(a))
  return found[0] ?? null
}

function scoreClaude(s: HttpServer) {
  let n = 0
  if (Object.keys(s.headers).length > 0) n += 10
  if (/ai-mcp|pegasus|prod-ai-mcp/i.test(s.name) || /ai-fe\.bilibili|pegasus/i.test(s.url)) n += 5
  return n
}

function toParameters(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} }
  }
  const s = { ...(schema as Record<string, unknown>) }
  delete s.$schema
  delete s.$id
  if (s.type !== 'object') s.type = 'object'
  if (!s.properties || typeof s.properties !== 'object') s.properties = {}
  return s
}

function openaiName(raw: string, used: Set<string>, reserved: Set<string>) {
  let base = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
  if (!base) base = 'mcp_tool'
  if (reserved.has(base)) base = `mcp_${base}`.slice(0, 64)
  let out = base
  let i = 2
  while (used.has(out)) {
    out = `${base.slice(0, 60)}_${i}`
    i += 1
  }
  used.add(out)
  return out
}

const RESERVED = new Set([
  'get_current_time',
  'calculator',
  'search_notes',
  'load_skill',
  'workspace_list',
  'workspace_read',
  'workspace_write',
  'git_status',
  'git_diff',
  'roll_dice',
])

async function openClient(url: string, headers: Record<string, string>) {
  const opts = { requestInit: { headers } }
  try {
    const client = new Client({ name: 'agent-chat-playground', version: '0.2.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(url), opts))
    return client
  } catch {
    const client = new Client({ name: 'agent-chat-playground', version: '0.2.0' })
    await client.connect(new SSEClientTransport(new URL(url), opts))
    return client
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string) {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}超时（${ms / 1000}s）`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (err) => {
        clearTimeout(t)
        reject(err)
      },
    )
  })
}

async function closeQuiet(client: Client | null) {
  if (!client) return
  try {
    await client.close()
  } catch {
    /* 关掉即可 */
  }
}

export async function reconnectMcp(): Promise<McpPublic> {
  await closeQuiet(cache.client)
  cache = blankCache()

  if (!settings.enabled || !settings.url) {
    return publicMcp()
  }

  try {
    const client = await withTimeout(
      openClient(settings.url, settings.headers),
      CONNECT_MS,
      '连接 MCP',
    )
    const listed = await client.listTools()
    const used = new Set<string>()
    const names = new Map<string, string>()
    const tools: ChatCompletionFunctionTool[] = []
    for (const tool of listed.tools.slice(0, MAX_TOOLS)) {
      const name = openaiName(tool.name, used, RESERVED)
      names.set(name, tool.name)
      tools.push({
        type: 'function',
        function: {
          name,
          description: `[MCP] ${tool.description || tool.name}`.slice(0, 350),
          parameters: toParameters(tool.inputSchema),
        },
      })
    }
    cache = {
      client,
      tools,
      names,
      instructions: (client.getInstructions() ?? '').trim(),
      error: listed.tools.length > MAX_TOOLS ? `工具太多，只接入前 ${MAX_TOOLS} 个` : null,
    }
  } catch (err) {
    cache.error = err instanceof Error ? err.message : String(err)
    cache.client = null
  }
  return publicMcp()
}

export function saveMcpSettings(input: {
  enabled: boolean
  url?: string
  auth?: string
}): Promise<McpPublic> {
  const next: McpSettings = {
    enabled: input.enabled,
    url: input.url !== undefined ? input.url.trim() : settings.url,
    headers: settings.headers,
  }
  if (input.auth !== undefined) {
    const parsed = parseAuthInput(input.auth)
    if (Object.keys(parsed).length > 0 || input.auth.trim() === '') {
      next.headers = parsed
    }
  }
  if (next.enabled && !next.url) {
    throw new Error('启用 MCP 需要 URL')
  }
  persist(next)
  return reconnectMcp()
}

export async function importClaudeMcp(): Promise<McpPublic> {
  const picked = pickClaudeHttpMcp()
  if (!picked) {
    throw new Error('本机 ~/.claude/.mcp.json 和 ~/.claude.json 里没有 HTTP MCP')
  }
  persist({
    enabled: true,
    url: picked.url,
    headers: picked.headers,
  })
  return reconnectMcp()
}

export async function callMcpTool(
  openaiName: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (!cache.client) {
    await reconnectMcp()
  }
  const client = cache.client
  const mcpName = cache.names.get(openaiName)
  if (!client || !mcpName) {
    throw new Error(cache.error || 'MCP 未连接。到配置页导入 Claude 的 MCP，或填 URL。')
  }
  const result = await client.callTool({ name: mcpName, arguments: args })
  const text = result.content
    ?.filter((b) => b.type === 'text')
    .map((b) => ('text' in b ? b.text : ''))
    .join('\n')
    .trim()
  if (result.isError) {
    throw new Error(text || 'MCP 工具返回错误')
  }
  if (result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent)
  }
  return text || JSON.stringify(result)
}
