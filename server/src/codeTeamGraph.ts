/**
 * 代码团队的 LangGraph 图。
 *
 * explore → implement → review → summary 是固定四段，用 StateGraph 串起来。
 * 每一段里的模型调用走 ChatOpenAI（@langchain/openai）；工具执行、写入批准、
 * SSE 卡片仍在 codeTeam.ts，不搬进 LangGraph 的 interrupt。
 * 主对话循环（agent.ts）和画布（workflow.ts）继续手写。
 *
 * 配了 LANGSMITH_API_KEY 时打开 tracing，四个节点会出现在 LangSmith。
 * 没配 key 时图照常跑，只是不上传。
 */
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import { ChatOpenAI } from '@langchain/openai'
import { END, ReducedValue, START, StateGraph, StateSchema } from '@langchain/langgraph'
import { isTracingEnabled } from 'langsmith'
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions'
import { z } from 'zod'

export const CODE_TEAM_STAGES = ['explore', 'implement', 'review', 'summary'] as const
export type CodeTeamStage = (typeof CODE_TEAM_STAGES)[number]

export type TeamModelDelta = {
  content?: string
  reasoning_content?: string
  tool_calls?: Array<{
    index: number
    id?: string
    function?: { name?: string; arguments?: string }
  }>
}

export type TeamModel = {
  stream: (
    messages: ChatCompletionMessageParam[],
    tools: ChatCompletionTool[],
  ) => AsyncGenerator<TeamModelDelta>
}

const transcriptItem = z.custom<ChatCompletionMessageParam>(() => true)

const CodeTeamState = new StateSchema({
  transcript: new ReducedValue(z.array(transcriptItem).default(() => []), {
    reducer: (current: ChatCompletionMessageParam[], update: ChatCompletionMessageParam[]) =>
      current.concat(update),
  }),
  lastUser: z.string().default(''),
  aborted: z.boolean().default(false),
})

function armLangSmith() {
  const key = process.env.LANGSMITH_API_KEY?.trim()
  if (!key) return false
  if (!process.env.LANGSMITH_TRACING && !process.env.LANGCHAIN_TRACING_V2) {
    process.env.LANGSMITH_TRACING = 'true'
  }
  if (!process.env.LANGSMITH_PROJECT?.trim() && !process.env.LANGCHAIN_PROJECT?.trim()) {
    process.env.LANGSMITH_PROJECT = 'agent-chat-playground'
  }
  return isTracingEnabled()
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
        return part.text
      }
      return ''
    })
    .join('')
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const value = JSON.parse(raw) as unknown
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  } catch {
    // 半截 JSON 出现在历史里时，下一轮不能把整段请求打挂
  }
  return {}
}

function toBaseMessages(messages: ChatCompletionMessageParam[]): BaseMessage[] {
  const out: BaseMessage[] = []
  for (const message of messages) {
    if (message.role === 'system') {
      out.push(new SystemMessage(typeof message.content === 'string' ? message.content : ''))
      continue
    }
    if (message.role === 'user') {
      out.push(new HumanMessage(typeof message.content === 'string' ? message.content : ''))
      continue
    }
    if (message.role === 'tool') {
      out.push(
        new ToolMessage({
          content: typeof message.content === 'string' ? message.content : '',
          tool_call_id: message.tool_call_id,
        }),
      )
      continue
    }
    if (message.role !== 'assistant') continue
    const toolCalls = (message.tool_calls ?? [])
      .filter((call) => call.type === 'function')
      .map((call) => ({
        id: call.id,
        name: call.function.name,
        args: parseArgs(call.function.arguments),
        type: 'tool_call' as const,
      }))
    out.push(
      new AIMessage({
        content: typeof message.content === 'string' ? message.content : '',
        tool_calls: toolCalls.length ? toolCalls : undefined,
      }),
    )
  }
  return out
}

/** 公司网关是 OpenAI 兼容的 chat completions，不要走 Responses API。 */
export function createTeamModel(cfg: {
  apiKey: string
  baseURL?: string
  model: string
}): TeamModel {
  const chat = new ChatOpenAI({
    model: cfg.model,
    apiKey: cfg.apiKey,
    useResponsesApi: false,
    streaming: true,
    configuration: cfg.baseURL ? { baseURL: cfg.baseURL } : undefined,
  })

  return {
    async *stream(messages, tools) {
      const runnable = tools.length ? chat.bindTools(tools) : chat
      const stream = await runnable.stream(toBaseMessages(messages))
      for await (const chunk of stream) {
        if (!AIMessageChunk.isInstance(chunk)) continue
        const delta: TeamModelDelta = {}
        const text = messageText(chunk.content)
        if (text) delta.content = text
        const reasoning = chunk.additional_kwargs?.reasoning_content
        if (typeof reasoning === 'string' && reasoning) delta.reasoning_content = reasoning
        const calls = (chunk.tool_call_chunks ?? [])
          .filter((part) => part.name || part.args || part.id)
          .map((part) => ({
            index: part.index ?? 0,
            id: part.id,
            function: { name: part.name, arguments: part.args },
          }))
        if (calls.length) delta.tool_calls = calls
        if (delta.content || delta.reasoning_content || delta.tool_calls) yield delta
      }
    },
  }
}

function buildCodeTeamGraph(options: {
  signal: AbortSignal
  runStage: (role: CodeTeamStage, transcript: ChatCompletionMessageParam[]) => Promise<string>
}) {
  const run = (role: CodeTeamStage) => async (state: typeof CodeTeamState.State) => {
    if (options.signal.aborted || state.aborted) return { aborted: true }
    const text = await options.runStage(role, state.transcript)
    const aborted = options.signal.aborted
    if (!text.trim()) return { aborted }
    return {
      aborted,
      transcript: [{ role: 'assistant' as const, content: `【${role}】\n${text.trim()}` }],
    }
  }

  return new StateGraph(CodeTeamState)
    .addNode('explore', run('explore'))
    .addNode('implement', run('implement'))
    .addNode('review', run('review'))
    .addNode('summary', run('summary'))
    .addEdge(START, 'explore')
    .addEdge('explore', 'implement')
    .addEdge('implement', 'review')
    .addEdge('review', 'summary')
    .addEdge('summary', END)
    .compile()
}

export async function runCodeTeamGraph(options: {
  messages: ChatCompletionMessageParam[]
  lastUser: string
  signal: AbortSignal
  runStage: (role: CodeTeamStage, transcript: ChatCompletionMessageParam[]) => Promise<string>
}) {
  const tracing = armLangSmith()
  const project = process.env.LANGSMITH_PROJECT || process.env.LANGCHAIN_PROJECT || ''
  console.info(
    tracing
      ? `[code-team] LangSmith tracing on${project ? `, project=${project}` : ''}`
      : '[code-team] 未配置 LANGSMITH_API_KEY，本轮不上传 trace',
  )

  const graph = buildCodeTeamGraph(options)
  await graph.invoke(
    {
      transcript: options.messages,
      lastUser: options.lastUser,
      aborted: options.signal.aborted,
    },
    {
      runName: 'code-team',
      tags: ['code-team'],
    },
  )
}

/** 不调模型，只列出编译后的节点，用来核对四段还在。 */
export async function codeTeamNodeNames() {
  const graph = buildCodeTeamGraph({
    signal: new AbortController().signal,
    runStage: async () => '',
  })
  const drawn = await graph.getGraphAsync()
  return Object.values(drawn.nodes).map((node) => node.id)
}
