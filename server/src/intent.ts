/**
 * 薄意图：只决定「本轮给模型哪些工具」，不替代 RAG 内时间/图片意图，也不绕过 Agent。
 *
 * Live / Mock / 代码团队 explore 共用这一份，避免三处正则漂移。
 * 词表来自原先 agent.ts mock 分支与 codeTeam KNOWLEDGE_HINT，优先级：
 *   mcp → time → calc → git → workspace → knowledge → chat
 * workspace 必须排在 knowledge 前，否则「这个项目是干什么的」会被 search_notes 抢走。
 * MCP 元问题（有哪些 mcp）必须走 chat：收紧白名单会把已连接的 MCP 工具裁掉。
 */
import type { ChatCompletionTool } from 'openai/resources/chat/completions'
import { isMcpTool, queryMatchesMcpTools } from './mcp.js'

export type ChatIntent = 'time' | 'calc' | 'git' | 'workspace' | 'knowledge' | 'chat'

/** 问「连上了哪些 MCP」——这是连接状态，不是工作区目录里的 mcp 文件夹 */
const MCP_RE = /\bmcp\b|模型上下文|已连接的?工具|mcp\s*tools?/i
const TIME_RE = /几点|时间|日期|\bnow\b|\btime\b/i
// 不要裸写「算」：「预算 / 结算 / 总算」都会误伤，整轮被收成 calculator。
// 「算一下」也要带 lookbehind，否则「结算一下」照样命中。
const CALC_RE =
  /计算|等于多少|(?<![预结清总算核推])算(?:一下|一算|算)?|\d+\s*[\+\-\*\/]\s*\d+/
const GIT_RE = /改了什么|当前改动|未提交|git status|git diff|有哪些改|看一下 diff/i
const WORKSPACE_HINT_RE =
  /readme|\.md|工作区|这个项目|这个仓库|这个代码库|当前代码库|本仓库|读一下.*文件|打开.*文件|workspace_read/i
const WORKSPACE_ACTION_RE = /读|看|打开|列出|list|readme|项目|仓库|代码库/i
/**
 * 知识库词。不要裸写 tool/agent/项目：会误伤「mcp tools」「这个项目有哪些 mcp」。
 */
const KNOWLEDGE_RE =
  /知识库|文档|手册|wiki|周报|月报|纪要|简历|面经|学习路线|怎么学|技术栈|sse|rag|tool calling|function calling/i

/** null = 不收紧，整表工具都给（含 MCP） */
const TOOL_NAMES: Record<ChatIntent, string[] | null> = {
  time: ['get_current_time'],
  calc: ['calculator'],
  git: ['git_status', 'git_diff'],
  workspace: [
    'workspace_list',
    'workspace_read',
    'workspace_write',
    'git_status',
    'git_diff',
  ],
  knowledge: ['search_notes', 'load_skill'],
  chat: null,
}

/** 元问题：直接读 publicMcp，不要让模型去 workspace_list 翻「mcp」目录 */
export function isMcpStatusQuery(text: string): boolean {
  return MCP_RE.test(text.trim().toLowerCase())
}

export function routeIntent(text: string): ChatIntent {
  const raw = text.trim()
  if (!raw) return 'chat'
  const lower = raw.toLowerCase()
  // 问「有哪些 mcp」必须全量工具；否则白名单一收，模型侧只剩 search_notes / 工作区
  if (isMcpStatusQuery(raw)) return 'chat'
  if (TIME_RE.test(lower)) return 'time'
  if (CALC_RE.test(raw)) return 'calc'
  if (GIT_RE.test(lower)) return 'git'
  if (WORKSPACE_HINT_RE.test(raw) && WORKSPACE_ACTION_RE.test(raw)) return 'workspace'
  if (KNOWLEDGE_RE.test(raw)) return 'knowledge'
  return 'chat'
}

export function toolNamesForIntent(intent: ChatIntent): string[] | null {
  return TOOL_NAMES[intent]
}

/** 代码团队 explore：只有知识库意图才额外放开 search_notes */
export function wantsKnowledge(text: string): boolean {
  return routeIntent(text) === 'knowledge'
}

export function filterToolsByIntent(
  tools: ChatCompletionTool[],
  intent: ChatIntent,
  userQuery?: string,
): ChatCompletionTool[] {
  const names = TOOL_NAMES[intent]
  const allow = names ? new Set(names) : null
  // MCP 始终保留：意图只收紧本地工具，不能把已连接的远端工具静默裁掉
  let filtered = tools.filter(
    (t) =>
      t.type === 'function' &&
      (allow === null || allow.has(t.function.name) || isMcpTool(t.function.name)),
  )
  // 问句命中 MCP 能力时拿掉 search_notes：弱模型会先搜知识库，规则 7 一命中就收尾，业务 MCP 没机会
  if (userQuery && queryMatchesMcpTools(userQuery)) {
    filtered = filtered.filter(
      (t) => t.type === 'function' && t.function.name !== 'search_notes',
    )
  }
  return filtered
}
