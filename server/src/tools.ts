/**
 * 本地工具定义 + 执行
 * - toolDefinitions：告诉模型「有哪些工具、参数长什么样」（OpenAI tools schema）
 * - executeTool：服务端真正跑工具，返回 JSON 字符串
 */
import type { ChatCompletionTool } from 'openai/resources/chat/completions'

/** 交给大模型的工具清单（function calling schema） */
export const toolDefinitions: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: '获取当前日期与时间（上海时区）。当用户询问现在几点、今天日期时调用。',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculator',
      description: '计算一个简单的算术表达式，仅支持数字与 + - * / ( ) 。',
      parameters: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: '算术表达式，例如 "123 * 456" 或 "(10+2)/3"',
          },
        },
        required: ['expression'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_notes',
      description:
        '在本地演示知识库中检索笔记片段（模拟 RAG）。当用户问项目、简历、Agent、SSE 等相关问题时调用。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '检索关键词或问题',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
]

/** 演示用「知识库」几条笔记（真 RAG 会换成切分后的文档块） */
const DEMO_NOTES: Array<{ id: string; title: string; text: string }> = [
  {
    id: '1',
    title: '项目目标',
    text: 'agent-chat-playground 是一个可演示的 AI Agent 前端作品：流式 Chat（SSE）+ tool calling 卡片 + 简易检索。',
  },
  {
    id: '2',
    title: '技术栈',
    text: '前端 React + TypeScript + Vite；后端 Express + OpenAI 兼容 API；支持 DeepSeek / OpenAI。无 Key 时可走 mock 模式。',
  },
  {
    id: '3',
    title: 'SSE',
    text: '服务端用 text/event-stream 推送 text_delta、tool_start、tool_result 等事件；前端 ReadableStream 边收边渲染。',
  },
  {
    id: '4',
    title: 'Tool calling',
    text: '模型返回 tool_calls 后，服务端执行本地工具，把结果写回 messages，再继续向模型要最终回答，UI 用卡片展示调用过程。',
  },
]

/**
 * 安全一点的四则运算：先白名单校验字符，再用 Function 求值
 * （演示用；生产应换更严的表达式解析器）
 */
function safeCalculate(expression: string): string {
  const normalized = expression.replace(/\s+/g, '')
  if (!/^[\d+\-*/().]+$/.test(normalized)) {
    throw new Error('表达式含有非法字符，仅允许数字和 + - * / ( )')
  }
  // eslint-disable-next-line no-new-func
  const value = Function(`"use strict"; return (${normalized})`)()
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('计算结果无效')
  }
  return String(value)
}

/**
 * 关键词命中 DEMO_NOTES，最多返回 3 条
 * 返回值是 JSON 字符串，方便模型阅读并引用
 */
function searchNotes(query: string): string {
  const q = query.toLowerCase()
  const hits = DEMO_NOTES.filter(
    (note) =>
      note.title.toLowerCase().includes(q) ||
      note.text.toLowerCase().includes(q) ||
      q.split(/\s+/).some((token) => token && note.text.toLowerCase().includes(token)),
  ).slice(0, 3)

  if (hits.length === 0) {
    return JSON.stringify({ hits: [], message: '知识库未命中，请换个关键词试试。' }, null, 2)
  }

  return JSON.stringify(
    {
      hits: hits.map((h) => ({ id: h.id, title: h.title, snippet: h.text })),
    },
    null,
    2,
  )
}

/**
 * 按工具名分发执行
 * @param name    工具名（来自模型 tool_calls）
 * @param rawArgs 参数 JSON 字符串
 * @returns       给模型 / 前端看的结果字符串（一般是 JSON）
 */
export async function executeTool(
  name: string,
  rawArgs: string,
): Promise<string> {
  let args: Record<string, unknown> = {}
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {}
  } catch {
    throw new Error(`无法解析工具参数: ${rawArgs}`)
  }

  switch (name) {
    case 'get_current_time': {
      const now = new Date()
      const text = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
      return JSON.stringify({ timezone: 'Asia/Shanghai', now: text })
    }
    case 'calculator': {
      const expression = String(args.expression ?? '')
      if (!expression) throw new Error('缺少 expression')
      return JSON.stringify({ expression, result: safeCalculate(expression) })
    }
    case 'search_notes': {
      const query = String(args.query ?? '')
      if (!query) throw new Error('缺少 query')
      return searchNotes(query)
    }
    default:
      throw new Error(`未知工具: ${name}`)
  }
}
