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
import { isMcpTool } from './mcp.js'

export type ChatIntent = 'time' | 'calc' | 'git' | 'workspace' | 'knowledge' | 'chat'

const MCP_RE = /\bmcp\b|模型上下文|已连接.*工具/i
const TIME_RE = /几点|时间|日期|\bnow\b|\btime\b/i
const CALC_RE = /算|计算|\d+\s*[\+\-\*\/]/
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

export function routeIntent(text: string): ChatIntent {
  const raw = text.trim()
  if (!raw) return 'chat'
  const lower = raw.toLowerCase()
  // 问「有哪些 mcp」必须全量工具；否则白名单一收，模型侧只剩 search_notes / 工作区
  if (MCP_RE.test(lower)) return 'chat'
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
): ChatCompletionTool[] {
  const names = TOOL_NAMES[intent]
  if (!names) return tools
  const allow = new Set(names)
  // MCP 始终保留：意图只收紧本地工具，不能把已连接的远端工具静默裁掉
  return tools.filter(
    (t) =>
      t.type === 'function' &&
      (allow.has(t.function.name) || isMcpTool(t.function.name)),
  )
}
