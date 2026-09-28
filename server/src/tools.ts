/**
 * 本地工具定义 + 执行
 * - toolDefinitions：告诉模型「有哪些工具、参数长什么样」（OpenAI tools schema）
 * - executeTool：服务端真正跑工具，返回 JSON 字符串
 *
 * 注意 ask_user（「需要你拍板」）不在 toolDefinitions 里，它是**代码团队专属**的人机停点：
 * 答案必须由人在界面上填，本地执行语义（立刻返回字符串）装不下「等人」。
 * 真实挂起点在 codeTeam.ts 的 runOneTool（发 ask 事件 → await waitForAnswer → 回填 tool 结果）。
 * 这样默认对话模式 / MCP 的工具集和以前一模一样，不会平白多出一个会卡住的工具。
 */
import type { ChatCompletionTool } from 'openai/resources/chat/completions'
// 引用 RAG：retrieve.ts 负责向量/关键词，这里只做工具入口 + JSON
import { retrieve } from './retrieve.js'
import { readSkill } from './skills.js'
import { workspaceList, workspaceRead, workspaceWrite } from './workspace.js'
import { gitDiff, gitStatus } from './git.js'
import { callMcpTool, isMcpTool, mcpToolDefinitions } from './mcp.js'

/** 本地工具 + 已连接 MCP。对话循环用这个，不要只用下面的静态表。 */
export function getToolDefinitions(): ChatCompletionTool[] {
  return [...toolDefinitions, ...mcpToolDefinitions()]
}

/**
 * ask_user 的工具 schema（代码团队专用，见文件头注释）。
 *
 * 描述里必须写清「什么时候该问、什么时候别问」，否则模型要么从不调用（
 * 于是又变成在回答里写「需要你拍板」这种不会真的停下来的文字），
 * 要么每件小事都来问一遍。
 */
export const askUserToolDefinition: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'ask_user',
    description:
      '把决定权交给用户：你缺关键信息、或存在两个都说得通的方案而取舍取决于用户口味/业务约束时调用。调用后本轮会**真的停下**，界面上出现提问卡片，用户回答后你才继续。禁止在回答正文里写「需要你拍板 / 请你确认」却不调用这个工具——那不会停下来，等于自己替用户拍板。不要用来问能自己读文件搞清的事（例如文件里写了什么、代码怎么组织），也不要在可以按最小改动先做一版时调用。一次只问一个决策点，问题要短，能给出候选就把 options 填上。',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: '要用户拍板的那个问题，一句话，中文，具体到「选 A 还是 B」这一级',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description:
            '可选：2~4 个候选答案，用户点一下就回你。留空则用户自由输入。候选项要写成完整可执行的答复（例如「按方案 A 改，只动 App.tsx」）。',
        },
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
}

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
        '在本地知识库中检索文档片段（内置说明、求职手册、用户上传的 md/txt），也会返回文档里带的图片条目。当用户问项目、SSE、简历缺口、上传文档内容、怎么学等问题时调用；用户要原图、截图、配图时必须调用它——图片条目（title 以「图片 · 」开头）带 imageUrl，没查过就别说自己给不出图。query 可以是原句或关键词。',
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
 *
 * @param query     模型自己组的检索词，可以和用户原话不一样
 * @param userQuery 用户原话。检索层判时间意图（「最近的周报」）要用它——
 *                  模型转述时会丢词，实测问「平台工程周报讲了什么」组出来的 query 里
 *                  「最近」已经没了，判 query 就等于把那一路关掉
 */
async function searchNotes(query: string, userQuery?: string): Promise<string> {
  const result = await retrieve(query, 3, userQuery)
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
          /** 来源文档可读名（含期次，如「平台工作周报-2026年8月W1」）；模型靠它说清「这是哪一篇」 */
          docName: h.docName,
          docPath: h.docPath,
          title: h.title,
          via: h.via,
          /** 图片命中才有：本站直出的原图地址，可以贴进回答里 */
          imageUrl: h.imageUrl,
          snippet: matched.length > 200 ? `${matched.slice(0, 200)}…` : matched,
          text: forModel.length > 900 ? `${forModel.slice(0, 900)}…` : forModel,
          score: h.score,
          rerank: h.rerank,
        }
      }),
      instruction:
        '已有检索结果。请立即根据 hits[].text 给出最终中文回答，句末标注 [citation]，不要再次调用 search_notes。text 可能含命中块的前后邻接，引用编号仍对应该条 id。回答时用 hits[].docName 说明来源文档；带期次的文档（周报/月报/季度小结）必须写清是哪一期，不要含糊成「最近的周报」。命中里 title 以「图片 · 」开头的是图片条目（score 是 0 属正常，不是「不相关」）。这两种情况都要用 markdown 图片语法贴出该条的 hits[].imageUrl，例如 ![](/api/image/cache/img_xxxxxxxxxxxxxxxx)：①用户要原图、配图、截图；②该图是某条命中正文自己引用的（那条的结论就是靠这张图来的，它的 text 写着「原图见 imageUrl」）——这种不用等用户开口，直接贴出来，别让答案缺一半。一次最多贴 2 张，贴哪一张看该条的 title 与图中文字跟问题对不对得上；贴图那句仍要标 [citation]；不要贴 hits[].text 里的远程链接，也不要说「我拿不到图片」。',
    },
    null,
    2,
  )
}

/**
 * 按工具名分发执行
 * @param name    工具名（来自模型 tool_calls）
 * @param rawArgs 参数 JSON 字符串
 * @param ctx     调用方的上下文。目前只有 userQuery（用户原话），
 *                search_notes 用它判时间意图，别的工具用不上
 * @returns       给模型 / 前端看的结果字符串（一般是 JSON）
 */
export async function executeTool(
  name: string,
  rawArgs: string,
  ctx?: { userQuery?: string },
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
      return await searchNotes(query, ctx?.userQuery);
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
    case 'ask_user': {
      /*
       * 到这说明有人跳过了人机通道直接执行它。只有 codeTeam.runOneTool 知道怎么
       * 「停下等界面上的回答」，别的链路（默认模式 / MCP 同名）没有回答入口。
       * 这里如实回一条结构化错误，让模型改说「我无法在没有人机通道的情况下获得回答」，
       * 绝不能让这里返回一段编造的答案（那比报错更糟：模型会当真）。
       */
      const question = String(args.question ?? '').trim()
      return JSON.stringify(
        {
          error:
            'ask_user 需要人机通道（代码团队模式会弹提问卡片）。当前上下文没有回答入口，这一问没有得到任何用户答复。',
          answered: false,
          question,
        },
        null,
        2,
      )
    }
    default:
      if (isMcpTool(name)) {
        return await callMcpTool(name, args)
      }
      throw new Error(`未知工具: ${name}`);
  }
}
