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
import { currentUserId, userConfigFile } from './requestContext.js'
import { mcpHeadersFromUserEnv, userEnvGet } from './userEnv.js'

function mcpFile() {
  return userConfigFile('mcp.json')
}
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

type UserMcp = { settings: McpSettings; cache: Cache }

const byUser = new Map<string, UserMcp>()

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
    const raw = JSON.parse(fs.readFileSync(mcpFile(), 'utf8')) as Partial<McpSettings>
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

function slot(): UserMcp {
  const id = currentUserId()
  let row = byUser.get(id)
  if (!row) {
    row = { settings: readDisk() ?? fromEnv(), cache: blankCache() }
    byUser.set(id, row)
  }
  return row
}

function fromEnv(): McpSettings {
  const url = process.env.MCP_URL?.trim() ?? ''
  const cookie = process.env.MCP_COOKIE?.trim() ?? ''
  const auth = process.env.MCP_AUTHORIZATION?.trim() ?? ''
  const headersRaw = process.env.MCP_HEADERS?.trim() ?? ''
  const headers: Record<string, string> = {}
  if (headersRaw) Object.assign(headers, parseAuthInput(headersRaw))
  if (cookie) headers.Cookie = cookie
  if (auth) headers.Authorization = auth
  return { enabled: Boolean(url), url, headers }
}

function persist(next: McpSettings) {
  const file = mcpFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8')
  const row = slot()
  row.settings = next
}

export function publicMcp(): McpPublic {
  const { settings, cache } = slot()
  return {
    enabled: settings.enabled,
    connected: Boolean(cache.client),
    url: settings.url,
    hasAuth: Object.keys(settings.headers).length > 0,
    tools: slot().cache.tools.map((t) => t.function.name),
    error: cache.error,
  }
}

export function mcpToolDefinitions(): ChatCompletionFunctionTool[] {
  return slot().cache.tools
}

export function mcpInstructions(): string {
  return slot().cache.instructions
}

export function isMcpTool(name: string) {
  return slot().cache.names.has(name)
}

/** 描述里太泛的词，避免「查询/列表」把任意问句都判成 MCP */
const MCP_MATCH_STOP = new Set([
  '查询',
  '检索',
  '列表',
  '情况',
  '根据',
  '返回',
  '可以',
  '指定',
  '过滤',
  '全部',
  '所有',
  '获取',
  '创建',
  '删除',
  '更新',
  '支持',
  '可选',
  '用户',
  '工具',
  '接口',
  '用于',
  '进行',
  '相关',
  '信息',
  '数据',
  '详情',
  '包括',
  '以及',
  '或者',
  '如果',
  '需要',
  '必须',
  '调用',
  '通过',
  '是否',
  '默认',
  '格式',
  '字段',
  '参数',
  '状态',
  '名称',
  '时间',
  '开始',
  '结束',
  '危险',
  '操作',
  '权限',
  '当用',
  '本工',
])

/**
 * 用户问句是否落在已连接 MCP 的能力上（词干/中文描述命中）。
 * 命中时知识库应让路：业务实时数据优先走 MCP，避免 search_notes 抢走。
 */
export function queryMatchesMcpTools(query: string): boolean {
  const tools = mcpToolDefinitions()
  if (!tools.length) return false
  const q = query.trim()
  if (!q) return false
  const qLower = q.toLowerCase()
  for (const t of tools) {
    const name = t.function.name.toLowerCase()
    for (const part of name.split('_')) {
      if (part.length >= 4 && qLower.includes(part)) return true
    }
    const desc = t.function.description || ''
    for (const chunk of desc.match(/[\u4e00-\u9fff]{2,10}/g) ?? []) {
      if (!MCP_MATCH_STOP.has(chunk) && q.includes(chunk)) return true
      for (let i = 0; i <= chunk.length - 2; i += 1) {
        const bi = chunk.slice(i, i + 2)
        if (MCP_MATCH_STOP.has(bi)) continue
        if (q.includes(bi)) return true
      }
    }
  }
  return false
}

/**
 * 解析鉴权输入 → 请求头。支持：
 * - 任意 `Header-Name: value`（可多行，如 Cookie / Authorization / x-token）
 * - JSON：`{"x-token":"…","Cookie":"…"}`
 * - `Bearer …` → Authorization
 * - 其它单行无冒号文本 → 默认当 Cookie（兼容旧用法）
 */
export function parseAuthInput(raw: string): Record<string, string> {
  const t = raw.trim()
  if (!t) return {}

  if (t.startsWith('{')) {
    try {
      const obj = JSON.parse(t) as unknown
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        return Object.fromEntries(
          Object.entries(obj as Record<string, unknown>).filter(
            (kv): kv is [string, string] =>
              typeof kv[0] === 'string' && typeof kv[1] === 'string' && kv[1].trim() !== '',
          ),
        )
      }
    } catch {
      /* 不是 JSON 就走下面 */
    }
  }

  const lines = t
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const headers: Record<string, string> = {}
  let sawHeaderLine = false
  for (const line of lines) {
    const m = line.match(/^([A-Za-z0-9!#$%&'*+.^_`|~-]+)\s*:\s*(.*)$/)
    if (!m) continue
    headers[m[1]] = m[2].trim()
    sawHeaderLine = true
  }
  if (sawHeaderLine) return headers

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

function resolvedMcpUrl(settings: McpSettings) {
  return settings.url.trim() || userEnvGet('MCP_URL')
}

function resolvedMcpHeaders(settings: McpSettings) {
  // 环境变量页里的 Cookie 等覆盖 mcp.json，方便多用户各自配
  return { ...settings.headers, ...mcpHeadersFromUserEnv() }
}

export async function reconnectMcp(): Promise<McpPublic> {
  const row = slot()
  await closeQuiet(row.cache.client)
  row.cache = blankCache()

  const url = resolvedMcpUrl(row.settings)
  if (!row.settings.enabled || !url) {
    return publicMcp()
  }

  try {
    const client = await withTimeout(
      openClient(url, resolvedMcpHeaders(row.settings)),
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
    row.cache = {
      client,
      tools,
      names,
      instructions: (client.getInstructions() ?? '').trim(),
      error: listed.tools.length > MAX_TOOLS ? `工具太多，只接入前 ${MAX_TOOLS} 个` : null,
    }
  } catch (err) {
    row.cache.error = err instanceof Error ? err.message : String(err)
    row.cache.client = null
  }
  return publicMcp()
}

export function saveMcpSettings(input: {
  enabled: boolean
  url?: string
  auth?: string
}): Promise<McpPublic> {
  const { settings } = slot()
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

export type McpMissingField = { name: string; description?: string }

function toolParamProps(openaiName: string): Record<string, { description?: unknown }> {
  const tool = slot().cache.tools.find((t) => t.function.name === openaiName)
  if (!tool?.function.parameters || typeof tool.function.parameters !== 'object') return {}
  const params = tool.function.parameters as { properties?: Record<string, { description?: unknown }> }
  return params.properties && typeof params.properties === 'object' ? params.properties : {}
}

function fieldMeta(openaiName: string, key: string): McpMissingField {
  const desc = toolParamProps(openaiName)[key]?.description
  return {
    name: key,
    description: typeof desc === 'string' && desc.trim() ? desc.trim().slice(0, 120) : undefined,
  }
}

function isBlankArg(v: unknown): boolean {
  return v === undefined || v === null || v === ''
}

/** schema 上形如 foo_id / fooId 的参数（用来自动找 list、追问用户）。 */
function idPropertyFields(openaiName: string): McpMissingField[] {
  return Object.keys(toolParamProps(openaiName))
    .filter((k) => /(_id|Id)$/.test(k))
    .map((k) => fieldMeta(openaiName, k))
}

/**
 * 缺参 = schema.required 未填
 *        + 其它未填的 *_id（仅当能匹配到 list MCP 时一并追问，不写死业务字段）
 */
export function mcpMissingRequired(
  openaiName: string,
  args: Record<string, unknown>,
): McpMissingField[] {
  const tool = slot().cache.tools.find((t) => t.function.name === openaiName)
  if (!tool?.function.parameters || typeof tool.function.parameters !== 'object') return []
  const params = tool.function.parameters as { required?: unknown }
  const required = Array.isArray(params.required)
    ? params.required.filter((k): k is string => typeof k === 'string')
    : []
  const missing: McpMissingField[] = []
  for (const key of required) {
    if (isBlankArg(args[key])) missing.push(fieldMeta(openaiName, key))
  }
  for (const field of idPropertyFields(openaiName)) {
    if (missing.some((m) => m.name === field.name)) continue
    if (!isBlankArg(args[field.name])) continue
    if (suggestListTools([field], openaiName).length > 0) missing.push(field)
  }
  return missing
}

/** 从远端 -32602 文案里抠 path，兜底本地 schema 没标 required 的情况。 */
export function parseMcpValidationMissing(message: string): string[] {
  const names: string[] = []
  const re = /"path"\s*:\s*\[\s*"([^"]+)"\s*\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(message))) {
    if (!names.includes(m[1])) names.push(m[1])
  }
  return names
}

/** 词干：period_id → period/periods；少量近义补分，不绑具体工具名。 */
function fieldStems(field: string): string[] {
  const key = field.toLowerCase()
  const base = key.replace(/_?id$/i, '').replace(/id$/, '')
  const out = new Set<string>()
  if (base.length >= 2) {
    out.add(base)
    if (!base.endsWith('s')) out.add(`${base}s`)
  }
  for (const part of base.split(/_/)) {
    if (part.length >= 2) {
      out.add(part)
      if (!part.endsWith('s')) out.add(`${part}s`)
    }
  }
  const synonyms: Record<string, string[]> = {
    plan: ['project', 'projects', 'delivery'],
    group: ['business_group'],
  }
  for (const s of [...out]) {
    for (const extra of synonyms[s] ?? []) out.add(extra)
  }
  return [...out]
}

function isListLikeTool(name: string, desc: string): boolean {
  const n = name.toLowerCase()
  const d = desc.toLowerCase()
  return (
    /(^|_)(list|lists|periods|departments|resources)(_|$)/.test(n) ||
    /list|lists/.test(n) ||
    /列表|枚举|全部|所有|检索/.test(d)
  )
}

/** 按缺参词干给 list 类 MCP 打分；每个缺参最多带 2 个候选 list。 */
function suggestListTools(missing: McpMissingField[], excludeTool: string): string[] {
  const picked: string[] = []
  for (const field of missing) {
    const stems = fieldStems(field.name)
    const scored: Array<{ name: string; score: number }> = []
    for (const t of slot().cache.tools) {
      if (t.function.name === excludeTool) continue
      const n = t.function.name.toLowerCase()
      const desc = (t.function.description || '').toLowerCase()
      if (!isListLikeTool(n, desc)) continue
      const required = Array.isArray(
        (t.function.parameters as { required?: unknown } | undefined)?.required,
      )
        ? ((t.function.parameters as { required: unknown[] }).required.filter(
            (k): k is string => typeof k === 'string',
          ))
        : []
      let score = 0
      for (const stem of stems) {
        if (n === stem || n.endsWith(`_${stem}`) || n.includes(`_${stem}_`)) score += 8
        else if (n.includes(stem)) score += 6
        if (desc.includes(stem)) score += 2
      }
      if (score === 0) continue
      if (required.length === 0) score += 3
      else if (required.length <= 2) score += 1
      else score -= 2
      scored.push({ name: t.function.name, score })
    }
    scored.sort((a, b) => b.score - a.score)
    for (const hit of scored.slice(0, 2)) {
      if (!picked.includes(hit.name)) picked.push(hit.name)
    }
  }
  return picked.slice(0, 6)
}

function inferYear(userQuery?: string): number | null {
  const y = new Date().getFullYear()
  const q = (userQuery || '').trim()
  if (!q) return null
  if (/今年|本年|这一年/.test(q)) return y
  if (/去年/.test(q)) return y - 1
  if (/明年/.test(q)) return y + 1
  const m = q.match(/(20\d{2})\s*年?/)
  return m ? Number(m[1]) : null
}

/** 给项目/计划列表带上用户时间意图，方便捞「今年」的 plan。 */
function listArgsForTool(listName: string, userQuery?: string): Record<string, unknown> {
  const n = listName.toLowerCase()
  if (!/project|plan|delivery/.test(n)) return {}
  const year = inferYear(userQuery)
  if (!year) return { page_size: 50, page_num: 1 }
  return {
    start_time: `${year}-01-01`,
    end_time: `${year}-12-31`,
    page_size: 50,
    page_num: 1,
  }
}

function looksEmptyMcpPayload(raw: string): boolean {
  const t = raw.trim()
  if (!t) return true
  if (t === '[]' || t === '{}' || t === 'null') return true
  try {
    const v = JSON.parse(t) as unknown
    if (Array.isArray(v)) return v.length === 0
    if (v && typeof v === 'object') {
      const obj = v as Record<string, unknown>
      const keys = Object.keys(obj)
      if (keys.length === 0) return true
      for (const key of ['data', 'list', 'items', 'result', 'groups', 'records', 'rows']) {
        if (Array.isArray(obj[key]) && (obj[key] as unknown[]).length === 0) return true
      }
      const vals = Object.values(obj)
      if (vals.length > 0 && vals.every((x) => Array.isArray(x) && x.length === 0)) return true
    }
  } catch {
    /* 非 JSON 不当空 */
  }
  return false
}

/** 不走 empty 包装 / 缺参追问，给编排内部拉列表用。 */
async function callMcpToolRaw(
  openaiName: string,
  args: Record<string, unknown>,
): Promise<string> {
  let { cache } = slot()
  if (!cache.client) await reconnectMcp()
  cache = slot().cache
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
  if (result.isError) throw new Error(text || 'MCP 工具返回错误')
  if (result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent)
  }
  return text || JSON.stringify(result)
}

type McpCandidate = { id: number; label: string }

function collectCandidatesForField(
  field: string,
  listTools: string[],
  autoLists: Record<string, unknown>,
): McpCandidate[] {
  const stems = fieldStems(field)
  const matched = listTools.filter((n) => {
    const lower = n.toLowerCase()
    return stems.some((s) => lower.includes(s))
  })
  const sources = matched.length ? matched : listTools
  const idKeys = new Set(
    [field, field.replace(/Id$/, '_id'), 'id', `${field.replace(/_id$/i, '')}_id`].map((k) =>
      k.toLowerCase(),
    ),
  )
  const labelKeys = ['name', 'title', 'label', 'dept_name', 'department_name', 'plan_name', 'period_name']
  const out: McpCandidate[] = []
  const seen = new Set<number>()

  const walkItems = (v: unknown) => {
    if (Array.isArray(v)) {
      for (const item of v) {
        if (!item || typeof item !== 'object') continue
        const obj = item as Record<string, unknown>
        let id: number | null = null
        for (const [k, val] of Object.entries(obj)) {
          if (!idKeys.has(k.toLowerCase())) continue
          if (typeof val === 'number' && Number.isFinite(val) && val > 0) id = val
          else if (typeof val === 'string' && /^\d+$/.test(val)) id = Number(val)
        }
        if (id == null || seen.has(id)) continue
        let label = ''
        for (const lk of labelKeys) {
          const lv = obj[lk]
          if (typeof lv === 'string' && lv.trim()) {
            label = lv.trim()
            break
          }
        }
        if (!label && typeof obj.start_time === 'number' && typeof obj.end_time === 'number') {
          label = `${obj.start_time}–${obj.end_time}`
        }
        seen.add(id)
        out.push({ id, label: label || String(id) })
      }
      return
    }
    if (v && typeof v === 'object') {
      const obj = v as Record<string, unknown>
      for (const key of ['data', 'list', 'items', 'result', 'groups', 'records', 'rows']) {
        if (key in obj) walkItems(obj[key])
      }
    }
  }

  for (const name of sources) {
    const entry = autoLists[name]
    if (!entry || typeof entry !== 'object') continue
    const e = entry as { data?: unknown; error?: unknown }
    if (e.error) continue
    walkItems(e.data !== undefined ? e.data : e)
  }
  return out
}

function listFetchFailed(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return true
  const e = entry as { error?: unknown; empty?: unknown; data?: unknown }
  if (e.error) return true
  if (e.empty === true) return true
  const data = e.data !== undefined ? e.data : e
  try {
    return looksEmptyMcpPayload(JSON.stringify(data))
  } catch {
    return true
  }
}

/**
 * 通用缺参编排（不写死业务）：
 * 拉齐匹配到的 list → 每项唯一则自动填回重调；多项则 need_user_input 让模型列给用户选。
 */
export async function mcpAskUserPayload(
  tool: string,
  fields: McpMissingField[],
  ctx?: { userQuery?: string; args?: Record<string, unknown> },
): Promise<string> {
  const detail = fields
    .map((f) => (f.description ? `- ${f.name}：${f.description}` : `- ${f.name}`))
    .join('\n')
  const listTools = suggestListTools(fields, tool)
  const year = inferYear(ctx?.userQuery)
  const autoLists: Record<string, unknown> = {}
  for (const listName of listTools) {
    const listArgs = listArgsForTool(listName, ctx?.userQuery)
    try {
      const raw = await callMcpToolRaw(listName, listArgs)
      let data: unknown = raw
      try {
        data = JSON.parse(raw)
      } catch {
        /* 纯文本 */
      }
      autoLists[listName] = {
        args: listArgs,
        empty: looksEmptyMcpPayload(raw),
        data,
      }
    } catch (err) {
      autoLists[listName] = {
        args: listArgs,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  const mergedArgs: Record<string, unknown> = { ...(ctx?.args ?? {}) }
  const candidates: Record<string, McpCandidate[]> = {}
  for (const field of fields) {
    if (!isBlankArg(mergedArgs[field.name])) continue
    const opts = collectCandidatesForField(field.name, listTools, autoLists)
    candidates[field.name] = opts
    if (opts.length === 1) mergedArgs[field.name] = opts[0].id
  }

  const still = fields.filter((f) => isBlankArg(mergedArgs[f.name]))
  if (still.length === 0) {
    try {
      return await callMcpToolRaw(tool, mergedArgs)
    } catch (err) {
      return JSON.stringify(
        {
          ok: false,
          terminal: true,
          tool,
          tried_args: mergedArgs,
          auto_lists: autoLists,
          error: err instanceof Error ? err.message : String(err),
          instruction:
            '服务端已按列表唯一项补全参数并重试，但调用失败。请如实告诉用户，不要再空转索要 ID，也不要再提议「先查列表」。',
        },
        null,
        2,
      )
    }
  }

  const allListsDead =
    listTools.length === 0 || listTools.every((n) => listFetchFailed(autoLists[n]))

  if (allListsDead) {
    return JSON.stringify(
      {
        ok: false,
        terminal: true,
        tool,
        missing: still.map((f) => f.name),
        fields,
        suggested_list_tools: listTools,
        user_year: year,
        auto_lists: autoLists,
        instruction: [
          `缺少 ${still.map((f) => f.name).join('、')}，且对应列表 MCP 为空或报错（见 auto_lists）。`,
          '请用中文告诉用户：当前环境拿不到候选列表，无法继续。',
          '禁止再提议「我可以先查列表」；仅当用户主动提供具体 ID 时再调原工具。',
        ].join(''),
      },
      null,
      2,
    )
  }

  const timeHint = year ? `用户时间意图约 ${year} 年：展示候选时优先标出该年相关项。` : ''
  return JSON.stringify(
    {
      ok: false,
      need_user_input: true,
      tool,
      missing: still.map((f) => f.name),
      fields,
      suggested_list_tools: listTools,
      user_year: year,
      auto_lists: autoLists,
      auto_filled: mergedArgs,
      candidates,
      instruction: [
        `仍缺：${still.map((f) => f.name).join('、')}。服务端已拉过：${Object.keys(autoLists).join('、') || '（无）'}。`,
        timeHint,
        '请用中文把 candidates 里每个缺参的可选项列出来（名称 + ID），请用户选定后再调用原工具。',
        '唯一项已写入 auto_filled，不必再问；多项必须问；禁止编造 ID；禁止再说「我可以先查列表」。',
        detail ? `字段说明：\n${detail}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    },
    null,
    2,
  )
}

function emptyTerminal(tool: string, raw: unknown): string {
  return JSON.stringify(
    {
      ok: false,
      empty: true,
      terminal: true,
      tool,
      raw,
      instruction: [
        `「${tool}」返回空列表。`,
        '请用中文告诉用户：当前查不到数据。',
        '禁止再提议「我可以先查列表」；禁止反复索要 ID。',
      ].join(''),
    },
    null,
    2,
  )
}

export async function callMcpTool(
  openaiName: string,
  args: Record<string, unknown>,
  ctx?: { userQuery?: string },
): Promise<string> {
  try {
    const body = await callMcpToolRaw(openaiName, args)
    try {
      const parsed = JSON.parse(body) as { need_user_input?: boolean; terminal?: boolean }
      if (parsed?.need_user_input || parsed?.terminal) return body
    } catch {
      /* 业务 JSON */
    }
    if (!looksEmptyMcpPayload(body)) return body
    // 空结果且还有未填、能匹配 list 的 *_id → 当缺参编排，而不是直接 terminal
    const unsetIds = idPropertyFields(openaiName).filter((f) => isBlankArg(args[f.name]))
    const askFields = unsetIds.filter((f) => suggestListTools([f], openaiName).length > 0)
    if (askFields.length > 0) {
      return await mcpAskUserPayload(openaiName, askFields, {
        userQuery: ctx?.userQuery,
        args,
      })
    }
    let parsed: unknown = body
    try {
      parsed = JSON.parse(body)
    } catch {
      parsed = body
    }
    return emptyTerminal(openaiName, parsed)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const missing = parseMcpValidationMissing(message)
    if (missing.length) {
      return await mcpAskUserPayload(
        openaiName,
        missing.map((name) => fieldMeta(openaiName, name)),
        { userQuery: ctx?.userQuery, args },
      )
    }
    throw err
  }
}
