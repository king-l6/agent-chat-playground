/**
 * 本地工具定义 + 执行
 * - toolDefinitions：告诉模型「有哪些工具、参数长什么样」（OpenAI tools schema）
 * - executeTool：服务端真正跑工具，返回 JSON 字符串
 */
import type { ChatCompletionTool } from 'openai/resources/chat/completions'
// 引用 RAG：retrieve.ts 负责向量/关键词，这里只做工具入口 + JSON
import { retrieve } from './retrieve.js'

/** 交给大模型的工具清单（function calling schema） */
export const toolDefinitions: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description:
        '获取当前日期与时间（上海时区）。当用户询问现在几点、今天日期时调用。',
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
        '在本地知识库中检索文档片段（内置说明、求职手册、用户上传的 md/txt）。当用户问项目、SSE、简历缺口、上传文档内容、怎么学等问题时调用。query 可以是原句或关键词。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              '检索词或原句。向量检索可直接传用户问题；关键词回退时服务端会改写。',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'roll_dice',
      description: '掷骰子。用户说掷骰子、随机点数、roll dice 时调用。',
      parameters: {
        type: 'object',
        properties: {
          sides: {
            type: 'number',
            description: '骰子面数，默认 6',
          },
          count: {
            type: 'number',
            description: '掷几次，默认 1，最多 10',
          },
        },
        additionalProperties: false,
      },
    },
  },
];

/**
 * 安全一点的四则运算：先白名单校验字符，再用 Function 求值
 * （演示用；生产应换更严的表达式解析器）
 */
function safeCalculate(expression: string): string {
  const normalized = expression.replace(/\s+/g, '');
  if (!/^[\d+\-*/().]+$/.test(normalized)) {
    throw new Error('表达式含有非法字符，仅允许数字和 + - * / ( )');
  }
  // eslint-disable-next-line no-new-func
  const value = Function(`"use strict"; return (${normalized})`)();
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('计算结果无效');
  }
  return String(value);
}

/**
 * search_notes 工具的真正实现
 * 流程：retrieve（hybrid + rerank + 邻接扩上下文）→ JSON 给模型 / 前端卡片
 */
async function searchNotes(query: string): Promise<string> {
  const result = await retrieve(query, 3)
  const { hits, mode } = result

  if (hits.length === 0) {
    return JSON.stringify(
      {
        hits: [],
        retrieval: mode,
        query: result.query,
        query_used: result.query_used,
        rewrite_terms: result.rewrite_terms,
        message:
          '知识库未命中或相关度过低。请换更短、更具体的关键词（例如「简历缺口」而不是整句问题）。',
        instruction:
          '未命中。可以换一个更短的中文关键词再搜一次；仍没有则明确说知识库没有，不要继续搜。',
      },
      null,
      2,
    )
  }

  return JSON.stringify(
    {
      retrieval: mode,
      query: result.query,
      query_used: result.query_used,
      rewrite_terms: result.rewrite_terms,
      hits: hits.map((h) => {
        const matched = h.text
        const forModel = h.context ?? h.text
        return {
          citation: h.citation,
          id: h.id,
          docId: h.docId,
          title: h.title,
          snippet: matched.length > 200 ? `${matched.slice(0, 200)}…` : matched,
          text: forModel.length > 900 ? `${forModel.slice(0, 900)}…` : forModel,
          score: h.score,
        }
      }),
      instruction:
        '已有检索结果。请立即根据 hits[].text 给出最终中文回答，句末标注 [citation]，不要再次调用 search_notes。text 可能含命中块的前后邻接，引用编号仍对应该条 id。',
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
  let args: Record<string, unknown> = {};
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch {
    throw new Error(`无法解析工具参数: ${rawArgs}`);
  }

  switch (name) {
    case 'get_current_time': {
      const now = new Date();
      const text = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      return JSON.stringify({ timezone: 'Asia/Shanghai', now: text });
    }
    case 'calculator': {
      const expression = String(args.expression ?? '');
      if (!expression) throw new Error('缺少 expression');
      return JSON.stringify({ expression, result: safeCalculate(expression) });
    }
    case 'search_notes': {
      const query = String(args.query ?? '');
      if (!query) throw new Error('缺少 query');
      return await searchNotes(query);
    }

    case 'roll_dice': {
      const sides = Math.min(Math.max(Number(args.sides ?? 6), 2), 100)
      const count = Math.min(Math.max(Number(args.count ?? 1), 1), 10)
      if (count > 10) throw new Error('掷骰子次数不能超过 10');
      const result = Math.floor(Math.random() * sides) + 1;
      return JSON.stringify({ sides, count, result });
    }
    default:
      throw new Error(`未知工具: ${name}`);
  }
}
