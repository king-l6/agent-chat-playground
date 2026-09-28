import type { ToolCallView } from '../types'

export type SearchHitView = {
  citation: number
  title: string
  docName?: string
  snippet: string
  score?: number
  rerank?: number
}

export type ToolSummary =
  | {
      kind: 'search'
      query: string
      retrieval: string
      rewrite: string[]
      hits: SearchHitView[]
      empty?: string
    }
  | { kind: 'calc'; expression: string; result?: string }
  | { kind: 'skill'; name: string; description: string }
  | { kind: 'text'; line: string }

function readJson(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function str(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 检索分：RRF 是零点零几，重排是整数，各按自己的量级显示 */
export function formatScore(value: number | undefined) {
  if (value == null) return ''
  if (value === 0) return '0'
  if (Math.abs(value) >= 10) return String(Math.round(value))
  const text = value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
  return text
}

export function retrievalLabel(mode: string) {
  if (mode === 'hybrid') return '向量 + 关键词'
  if (mode === 'keyword') return '关键词'
  return mode
}

/** 工具卡片上先看这一句，原始 JSON 收进折叠 */
export function summarizeTool(tool: ToolCallView): ToolSummary {
  const args = readJson(tool.arguments)
  const result = readJson(tool.result)

  if (tool.name === 'search_notes') {
    const hitsRaw = Array.isArray(result?.hits) ? result.hits : []
    const hits: SearchHitView[] = []
    for (const item of hitsRaw) {
      if (!item || typeof item !== 'object') continue
      const hit = item as Record<string, unknown>
      if (typeof hit.citation !== 'number') continue
      hits.push({
        citation: hit.citation,
        title: str(hit.title) || str(hit.id),
        docName: str(hit.docName) || undefined,
        snippet: str(hit.snippet),
        score: num(hit.score),
        rerank: num(hit.rerank),
      })
    }
    const rewrite = Array.isArray(result?.rewrite_terms)
      ? result.rewrite_terms.filter((t): t is string => typeof t === 'string')
      : []
    return {
      kind: 'search',
      query: str(result?.query_used) || str(result?.query) || str(args?.query),
      retrieval: str(result?.retrieval),
      rewrite,
      hits,
      empty: hits.length === 0 ? str(result?.message) || '未命中' : undefined,
    }
  }

  if (tool.name === 'calculator') {
    return {
      kind: 'calc',
      expression: str(result?.expression) || str(args?.expression),
      result: str(result?.result) || undefined,
    }
  }

  if (tool.name === 'load_skill') {
    return {
      kind: 'skill',
      name: str(result?.name) || str(args?.name),
      description: str(result?.description),
    }
  }

  if (tool.name === 'get_current_time') {
    return { kind: 'text', line: str(result?.now) || '读取当前时间' }
  }

  if (tool.name === 'workspace_read' || tool.name === 'workspace_write' || tool.name === 'workspace_list') {
    const path = str(result?.path) || str(args?.path) || '.'
    return { kind: 'text', line: path }
  }

  if (tool.name === 'git_status' || tool.name === 'git_diff') {
    return { kind: 'text', line: tool.name === 'git_status' ? '工作区状态' : '未提交的 diff' }
  }

  const query = str(args?.query)
  if (query) return { kind: 'text', line: query }
  return { kind: 'text', line: '' }
}

const STEP_LABEL: Record<string, string> = {
  search_notes: '检索',
  load_skill: '读 Skill',
  calculator: '计算',
  get_current_time: '时间',
  workspace_read: '读文件',
  workspace_write: '写文件',
  workspace_list: '列目录',
  git_status: 'Git',
  git_diff: 'Git',
}

export function stepLabel(tools: ToolCallView[]) {
  const names = [...new Set(tools.map((t) => STEP_LABEL[t.name] ?? t.name))]
  return names.join('、')
}
