import OpenAI from 'openai'
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions'
import { executeTool, toolDefinitions } from './tools.js'
import type { ChatMessageInput, SseEvent } from './types.js'

const SYSTEM_PROMPT = `你是「Agent Chat Playground」里的助手，面向求职演示。
规则：
1. 需要准确时间时调用 get_current_time。
2. 需要计算时调用 calculator。
3. 用户问本项目、SSE、tool calling、技术栈、简历作品相关问题时，先调用 search_notes 再基于结果回答，并在回答里引用片段。
4. 用简洁中文回答；调用工具后根据工具结果给出最终结论，不要编造工具没返回的内容。`

type Send = (event: SseEvent) => void

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function streamMock(messages: ChatMessageInput[], send: Send) {
  send({ type: 'meta', mode: 'mock' })

  const last = messages.filter((m) => m.role === 'user').at(-1)?.content ?? ''
  const lower = last.toLowerCase()

  const wantsTime = /几点|时间|日期|now|time/.test(lower)
  const wantsCalc = /算|计算|\d+\s*[\+\-\*\/]/.test(lower)
  const wantsSearch = /项目|sse|tool|agent|技术栈|简历|rag|知识库/.test(lower)

  const streamText = async (text: string) => {
    // 按词/短块推送，既有流式观感又不会太慢
    const parts = text.match(/[\u4e00-\u9fff]{1,2}|[^\u4e00-\u9fff]+/g) ?? [text]
    for (const part of parts) {
      send({ type: 'text_delta', delta: part })
      await sleep(18)
    }
  }

  if (wantsTime) {
    const id = 'mock_time_1'
    const args = '{}'
    send({ type: 'tool_start', id, name: 'get_current_time', arguments: args })
    await sleep(200)
    const result = await executeTool('get_current_time', args)
    send({ type: 'tool_result', id, name: 'get_current_time', result })
    const now = (JSON.parse(result) as { now: string }).now
    await streamText(`（mock）根据工具结果：当前时间为 ${now}。`)
    send({ type: 'done' })
    return
  }

  if (wantsCalc) {
    const match = last.match(/[\d.\s+\-*/()]+/)
    const expression = (match?.[0] ?? '1+1').trim()
    const id = 'mock_calc_1'
    const args = JSON.stringify({ expression })
    send({ type: 'tool_start', id, name: 'calculator', arguments: args })
    await sleep(200)
    try {
      const result = await executeTool('calculator', args)
      send({ type: 'tool_result', id, name: 'calculator', result })
      const value = (JSON.parse(result) as { result: string }).result
      await streamText(`（mock）计算结果：${expression} = ${value}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      send({ type: 'tool_error', id, name: 'calculator', error: message })
      await streamText(`（mock）计算失败：${message}`)
    }
    send({ type: 'done' })
    return
  }

  if (wantsSearch) {
    const id = 'mock_search_1'
    const args = JSON.stringify({ query: last })
    send({ type: 'tool_start', id, name: 'search_notes', arguments: args })
    await sleep(200)
    const result = await executeTool('search_notes', args)
    send({ type: 'tool_result', id, name: 'search_notes', result })
    const parsed = JSON.parse(result) as {
      hits?: Array<{ id: string; title: string; snippet: string }>
    }
    const hits = parsed.hits ?? []
    const text =
      hits.length === 0
        ? '（mock）知识库未命中。你可以问：这个项目是做什么的？SSE 怎么实现？'
        : `（mock）根据知识库：\n${hits
            .map((h) => `- [${h.id}] ${h.title}：${h.snippet}`)
            .join('\n')}`
    await streamText(text)
    send({ type: 'done' })
    return
  }

  await streamText(
    '（mock 模式）当前未配置 API Key。你可以问：现在几点？帮我算 123*456；这个项目的技术栈是什么？\n配置 `.env` 里的 ANTHROPIC_API_KEY（或 OPENAI_API_KEY）后即可走真实模型。',
  )
  send({ type: 'done' })
}

function resolveLlmConfig() {
  const apiKey =
    process.env.OPENAI_API_KEY?.trim() || process.env.ANTHROPIC_API_KEY?.trim() || ''

  const openaiBase = process.env.OPENAI_BASE_URL?.trim()
  const anthropicBase = process.env.ANTHROPIC_BASE_URL?.trim()?.replace(/\/$/, '')
  const baseURL =
    openaiBase || (anthropicBase ? `${anthropicBase}/v1` : undefined)

  const model =
    process.env.OPENAI_MODEL?.trim() ||
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL?.trim() ||
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL?.trim() ||
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL?.trim() ||
    'deepseek-v4-flash'

  return { apiKey, baseURL, model }
}

function collectToolCallDeltas(
  acc: Map<number, { id: string; name: string; arguments: string }>,
  toolCalls: Array<{
    index: number
    id?: string
    function?: { name?: string; arguments?: string }
  }>,
) {
  for (const part of toolCalls) {
    const prev = acc.get(part.index) ?? { id: '', name: '', arguments: '' }
    if (part.id) prev.id = part.id
    if (part.function?.name) prev.name += part.function.name
    if (part.function?.arguments) prev.arguments += part.function.arguments
    acc.set(part.index, prev)
  }
}

async function runLive(
  client: OpenAI,
  model: string,
  messages: ChatMessageInput[],
  send: Send,
) {
  send({ type: 'meta', mode: 'live', model })

  const history: ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...messages.map((m) => ({ role: m.role, content: m.content }) as const),
  ]

  const maxRounds = 4
  for (let round = 0; round < maxRounds; round += 1) {
    const stream = await client.chat.completions.create({
      model,
      messages: history,
      tools: toolDefinitions,
      stream: true,
    })

    let assistantText = ''
    const toolAcc = new Map<number, { id: string; name: string; arguments: string }>()
    let finishReason: string | null = null

    for await (const chunk of stream) {
      const choice = chunk.choices[0]
      if (!choice) continue
      finishReason = choice.finish_reason ?? finishReason
      const delta = choice.delta
      if (delta?.content) {
        assistantText += delta.content
        send({ type: 'text_delta', delta: delta.content })
      }
      if (delta?.tool_calls) {
        collectToolCallDeltas(toolAcc, delta.tool_calls)
      }
    }

    const toolCalls: ChatCompletionMessageToolCall[] = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, t]) => ({
        id: t.id || `call_${t.name}_${Math.random().toString(36).slice(2, 8)}`,
        type: 'function' as const,
        function: { name: t.name, arguments: t.arguments || '{}' },
      }))

    if (toolCalls.length === 0) {
      send({ type: 'done' })
      return
    }

    history.push({
      role: 'assistant',
      content: assistantText || null,
      tool_calls: toolCalls,
    })

    for (const call of toolCalls) {
      const name = call.function.name
      const args = call.function.arguments
      send({ type: 'tool_start', id: call.id, name, arguments: args })
      try {
        const result = await executeTool(name, args)
        send({ type: 'tool_result', id: call.id, name, result })
        history.push({
          role: 'tool',
          tool_call_id: call.id,
          content: result,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        send({ type: 'tool_error', id: call.id, name, error: message })
        history.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: message }),
        })
      }
    }

    if (finishReason === 'stop' && toolCalls.length === 0) {
      send({ type: 'done' })
      return
    }
  }

  send({ type: 'text_delta', delta: '\n\n（已达工具调用轮次上限）' })
  send({ type: 'done' })
}

export async function runAgentChat(options: {
  messages: ChatMessageInput[]
  send: Send
}) {
  const { apiKey, baseURL, model } = resolveLlmConfig()

  if (!apiKey) {
    await streamMock(options.messages, options.send)
    return
  }

  const client = new OpenAI({ apiKey, baseURL })
  await runLive(client, model, options.messages, options.send)
}

export { resolveLlmConfig }
