/**
 * 本地工具定义 + 执行
 * - toolDefinitions：告诉模型「有哪些工具、参数长什么样」（OpenAI tools schema）
 * - executeTool：服务端真正跑工具，返回 JSON 字符串
 */
import type { ChatCompletionTool } from 'openai/resources/chat/completions'
// 引用 RAG：检索逻辑在 knowledge.ts，这里只负责「工具入口 + 格式化 JSON 返回」
import { searchChunks } from './knowledge.js'

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
        '在本地知识库中检索文档片段（含项目说明与求职补充手册）。当用户问项目、SSE、tool calling、技术栈、简历缺口、怎么学、求职规划等问题时调用。',
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
 * 流程：query → searchChunks(Top3，本轮 citation=1..K) → JSON 给模型 / 前端卡片
 */
function searchNotes(query: string): string {
  // 从 knowledge 模块拿最相关的 3 个 chunk（已带本轮局部 citation）
  const hits = searchChunks(query, 3)

  // 没命中：告诉模型别瞎编，换关键词
  if (hits.length === 0) {
    return JSON.stringify(
      { hits: [], message: '知识库未命中，请换个关键词试试。' },
      null,
      2,
    )
  }

  // citation：仅对本轮 hits 有效；id：稳定 chunk id，角标/溯源用这个定位原文
  return JSON.stringify(
    {
      hits: hits.map((h) => ({
        citation: h.citation,
        id: h.id,
        docId: h.docId,
        title: h.title,
        snippet: h.text.length > 160 ? `${h.text.slice(0, 160)}…` : h.text,
      })),
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
      return searchNotes(query);
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
