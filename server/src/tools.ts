/**
 * 本地工具定义 + 执行
 * - toolDefinitions：告诉模型「有哪些工具、参数长什么样」（OpenAI tools schema）
 * - executeTool：服务端真正跑工具，返回 JSON 字符串
 */
import type { ChatCompletionTool } from 'openai/resources/chat/completions'
// 引用 RAG：retrieve.ts 负责向量/关键词，这里只做工具入口 + JSON
import { retrieve } from './retrieve.js'
import { readSkill } from './skills.js'
import { workspaceList, workspaceRead, workspaceWrite } from './workspace.js'
import { gitDiff, gitStatus } from './git.js'

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
      name: 'load_skill',
      description:
        '读取一个已安装 Skill 的完整步骤（SKILL.md 正文）。当用户任务匹配某个 skill 的 description 时必须先调用，再按正文执行。name 必须是已安装 skill 的 id，例如 job-interview。同一 skill 每轮只调用一次。问时间、算术、掷骰子不要调用。',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Skill id，必须与已安装 skill 的 name 完全一致',
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'workspace_list',
      description:
        '列出已选工作区里某个相对路径下的文件和目录。用户要看仓库里有什么、打开某个文件夹时调用。path 省略表示根目录。不能用绝对路径或 .. 逃出工作区。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '相对工作区根的路径，默认 "."',
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'workspace_read',
      description:
        '读取已选工作区里的一个文本文件。用户要看 README、源码、配置时调用。path 必须是相对路径，例如 README.md。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '相对工作区根的文件路径，例如 README.md',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'workspace_write',
      description:
        '向已选工作区写入一个文本文件。path 必须是相对路径。禁止用 .. 或绝对路径写出工作区。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '相对工作区根的文件路径',
          },
          content: {
            type: 'string',
            description: '要写入的全文',
          },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_status',
      description:
        '查看已选工作区的 git 状态（相对 HEAD 的未提交改动列表）。用户问当前改了什么、有哪些未提交文件时先调用。只读。',
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
      name: 'git_diff',
      description:
        '查看已选工作区相对 HEAD 的 diff。用户问具体改了哪些行时调用。path 可省略（整个仓库）；若提供必须是工作区内相对路径。只读，不会 checkout。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '可选，相对工作区根的文件路径',
          },
        },
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

    case 'load_skill': {
      const skillName = String(args.name ?? '').trim()
      if (!skillName) throw new Error('缺少 name')
      const skill = readSkill(skillName)
      return JSON.stringify(
        {
          name: skill.name,
          description: skill.description,
          body: skill.body,
          instruction:
            'Skill 已加载。按 body 逐步执行。需要知识库时再 search_notes。不要再 load 同一个 name。',
        },
        null,
        2,
      )
    }

    case 'workspace_list': {
      const rel = String(args.path ?? '.')
      return JSON.stringify({ entries: workspaceList(rel) }, null, 2)
    }
    case 'workspace_read': {
      const rel = String(args.path ?? '').trim()
      if (!rel) throw new Error('缺少 path')
      return JSON.stringify({ path: rel, content: workspaceRead(rel) }, null, 2)
    }
    case 'workspace_write': {
      const rel = String(args.path ?? '').trim()
      const content = String(args.content ?? '')
      if (!rel) throw new Error('缺少 path')
      return JSON.stringify(workspaceWrite(rel, content), null, 2)
    }
    case 'git_status':
      return JSON.stringify(gitStatus(), null, 2)
    case 'git_diff': {
      const rel = String(args.path ?? '').trim()
      return JSON.stringify(gitDiff(rel || undefined), null, 2)
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
