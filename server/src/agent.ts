/**
 * Agent 核心：
 * - 无 Key → streamMock（规则触发工具，假装流式）
 * - 有 Key → runLive（真模型 stream + tool calling 多轮循环）
 */
import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';
import { resolveLlmFromSettings } from './settings.js';
import { skillsCatalogText } from './skills.js';
import { mcpInstructions, mcpToolDefinitions } from './mcp.js';
import { executeTool, getToolDefinitions } from './tools.js';
import type { ChatMessageInput, SseEvent } from './types.js';

/**
 * 系统提示：告诉模型何时调哪些工具
 *
 * 规则 3–4 是引用 RAG 专用：
 *   - 先 search_notes 拿 hits
 *   - citation 是「本轮检索结果」里的局部编号（1=本轮第一条），不是全库永久编号
 *   - 稳定身份看 hits[].id；回答里仍写 [1][2] 方便阅读
 *
 * 规则 7 是防「搜个没完」：模型拿到 hits 后必须直接回答。
 * 规则 8 是 Skill：system 里只放目录，正文靠 load_skill。
 * Prompt 是软约束（模型可能不听）；下面 runLive 的 maxRounds 是硬上限。
 */
function buildSystemPrompt() {
  return `你是「Agent Chat Playground」里的助手，面向求职演示。
规则：
1. 需要准确时间时调用 get_current_time。
2. 需要计算时调用 calculator。
3. 用户问本项目、SSE、tool calling、技术栈、怎么学、学习规划、或上传文档里的内容时，先调用 search_notes，再只根据返回的 hits 回答。search_notes 的 query 可以是用户原句或 2～6 个关键词。
4. 使用 search_notes 后：在相关句子末尾标注引用，格式必须是方括号+数字，例如 [1] 或 [2]。数字必须来自「同一次」工具返回的 hits[].citation（本轮局部编号，1 表示本轮第一条命中）；不要用旧一次检索的编号；不要编造 hits 里没有的内容；未命中就明确说知识库没有。
5. 用简洁中文回答；调用其它工具后也要根据工具结果给出最终结论。
6. 用户要掷骰子、随机点数时调用 roll_dice。
7. search_notes 对同一条用户问题最多调用 1 次。工具一旦返回了 hits（哪怕只有 1 条），必须立刻给出最终中文回答并标注 [1][2]，禁止再调用任何工具。只有 hits 为空时，才允许换一个更短的关键词再搜一次。
8. Skill 是说明书，不是函数。已安装 Skill：
${skillsCatalogText()}
用户任务匹配某条 description 时，先 load_skill(name)，再按返回的 body 执行。同一 skill 每轮最多一次。若 history 里已经有该 skill 的 load_skill 结果，直接按 body 执行，不要再 load。问时间、算术、掷骰子不要 load_skill。
9. 用户要读/写/列出已选工作区里的文件时，调用 workspace_read / workspace_write / workspace_list。path 只用相对路径（如 README.md）。读项目说明、SSE、简历缺口仍优先 search_notes，不要用工作区代替知识库。
10. 用户问当前改了什么、未提交、diff 时，先 git_status，需要看具体行再 git_diff。不要 checkout / reset。
${mcpPromptBlock()}
`;
}

function mcpPromptBlock() {
  const tools = mcpToolDefinitions()
  if (tools.length === 0) return ''
  const names = tools.map((t) => t.function.name).join('、')
  const extra = mcpInstructions().slice(0, 600)
  return `11. 已连接 MCP 工具：${names}。用户问这些工具能查的业务数据时调用它们，不要用 search_notes 代替。${extra ? `服务端说明：${extra}` : ''}`
}

/** 向 SSE 管道推事件的函数类型（由 index.ts 注入） */
type Send = (event: SseEvent) => void;

/** Promise 版延时，mock 流式用 */
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function matchesInterviewSkill(text: string) {
  return /自我介绍|面试口径|按面试|短板|缺口|怎么讲|口述|简历怎么/.test(text);
}

/**
 * 运行时先把匹配到的 skill 注入 history，并推卡片。
 * 这才是「已经在连」：不是等模型想起 load_skill。
 */
async function preloadMatchedSkills(
  lastUser: string,
  history: ChatCompletionMessageParam[],
  send: Send,
) {
  if (!matchesInterviewSkill(lastUser)) return;
  const args = JSON.stringify({ name: 'job-interview' });
  const id = 'skill_job-interview';
  send({ type: 'tool_start', id, name: 'load_skill', arguments: args });
  try {
    const result = await executeTool('load_skill', args);
    send({ type: 'tool_result', id, name: 'load_skill', result });
    history.push({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id,
          type: 'function',
          function: { name: 'load_skill', arguments: args },
        },
      ],
    });
    history.push({ role: 'tool', tool_call_id: id, content: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send({ type: 'tool_error', id, name: 'load_skill', error: message });
  }
}

/**
 * Mock 模式：不调大模型，用正则猜意图，仍走「工具卡片 + 流式文字」
 * 方便没 Key 时也能演示完整 UI。
 */
async function streamMock(messages: ChatMessageInput[], send: Send) {
  send({ type: 'meta', mode: 'mock' });

  // 取最后一条用户话
  const last = messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
  const lower = last.toLowerCase();

  const wantsTime = /几点|时间|日期|now|time/.test(lower);
  const wantsCalc = /算|计算|\d+\s*[\+\-\*\/]/.test(lower);
  const wantsInterviewSkill = matchesInterviewSkill(last);
  const wantsSearch = /项目|sse|tool|agent|技术栈|简历|rag|知识库/.test(lower);
  const wantsWorkspace =
    /readme|\.md|工作区|读一下.*文件|打开.*文件|workspace_read/i.test(last) &&
    /读|看|打开|列出|list|readme/i.test(last);
  const wantsGit = /改了什么|当前改动|未提交|git status|git diff|有哪些改|看一下 diff/i.test(
    last,
  );

  /** 把整段回答拆成小块推 text_delta，模拟打字机 */
  const streamText = async (text: string) => {
    // 中文按 1~2 字切，其它字符整段切
    const parts = text.match(/[\u4e00-\u9fff]{1,2}|[^\u4e00-\u9fff]+/g) ?? [
      text,
    ];
    for (const part of parts) {
      send({ type: 'text_delta', delta: part });
      await sleep(18);
    }
  };

  // —— 时间 ——
  if (wantsTime) {
    const id = 'mock_time_1';
    const args = '{}';
    send({ type: 'tool_start', id, name: 'get_current_time', arguments: args });
    await sleep(200);
    const result = await executeTool('get_current_time', args);
    send({ type: 'tool_result', id, name: 'get_current_time', result });
    const now = (JSON.parse(result) as { now: string }).now;
    await streamText(`（mock）根据工具结果：当前时间为 ${now}。`);
    send({ type: 'done' });
    return;
  }

  // —— 计算 ——
  if (wantsCalc) {
    const match = last.match(/[\d.\s+\-*/()]+/);
    const expression = (match?.[0] ?? '1+1').trim();
    const id = 'mock_calc_1';
    const args = JSON.stringify({ expression });
    send({ type: 'tool_start', id, name: 'calculator', arguments: args });
    await sleep(200);
    try {
      const result = await executeTool('calculator', args);
      send({ type: 'tool_result', id, name: 'calculator', result });
      const value = (JSON.parse(result) as { result: string }).result;
      await streamText(`（mock）计算结果：${expression} = ${value}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send({ type: 'tool_error', id, name: 'calculator', error: message });
      await streamText(`（mock）计算失败：${message}`);
    }
    send({ type: 'done' });
    return;
  }

  if (wantsGit) {
    const statusId = 'mock_git_status'
    send({ type: 'tool_start', id: statusId, name: 'git_status', arguments: '{}' })
    await sleep(160)
    try {
      const statusRaw = await executeTool('git_status', '{}')
      send({ type: 'tool_result', id: statusId, name: 'git_status', result: statusRaw })
      const diffId = 'mock_git_diff'
      send({ type: 'tool_start', id: diffId, name: 'git_diff', arguments: '{}' })
      await sleep(160)
      const diffRaw = await executeTool('git_diff', '{}')
      send({ type: 'tool_result', id: diffId, name: 'git_diff', result: diffRaw })
      const status = JSON.parse(statusRaw) as { status: string }
      const diff = JSON.parse(diffRaw) as { diff: string }
      const lines = status.status.split('\n').filter(Boolean).slice(0, 12)
      await streamText(
        `（mock）git_status：\n${lines.join('\n')}\n\n（diff 已截取前几行）\n${diff.diff.slice(0, 400)}`,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      send({ type: 'tool_error', id: statusId, name: 'git_status', error: message })
      await streamText(`（mock）读取 git 失败：${message}`)
    }
    send({ type: 'done' })
    return
  }

  // —— 工作区读文件（先于知识库，避免「读 README」被搜笔记抢走）——
  if (wantsWorkspace) {
    const rel =
      last.match(/([\w./-]+\.(?:md|txt|ts|tsx|json))/)?.[1] ?? 'README.md'
    const id = 'mock_ws_1'
    const args = JSON.stringify({ path: rel })
    send({ type: 'tool_start', id, name: 'workspace_read', arguments: args })
    await sleep(200)
    try {
      const result = await executeTool('workspace_read', args)
      send({ type: 'tool_result', id, name: 'workspace_read', result })
      const parsed = JSON.parse(result) as { path: string; content: string }
      const preview = parsed.content.slice(0, 400)
      await streamText(
        `（mock）已读工作区 ${parsed.path}：\n${preview}${parsed.content.length > 400 ? '…' : ''}`,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      send({ type: 'tool_error', id, name: 'workspace_read', error: message })
      await streamText(`（mock）读取失败：${message}`)
    }
    send({ type: 'done' })
    return
  }

  // —— Skill：先加载说明书，再按正文去检索 ——
  if (wantsInterviewSkill) {
    const skillId = 'mock_skill_1';
    const skillArgs = JSON.stringify({ name: 'job-interview' });
    send({ type: 'tool_start', id: skillId, name: 'load_skill', arguments: skillArgs });
    await sleep(180);
    const skillResult = await executeTool('load_skill', skillArgs);
    send({ type: 'tool_result', id: skillId, name: 'load_skill', result: skillResult });

    const searchId = 'mock_search_1';
    const searchArgs = JSON.stringify({ query: last });
    send({ type: 'tool_start', id: searchId, name: 'search_notes', arguments: searchArgs });
    await sleep(200);
    const result = await executeTool('search_notes', searchArgs);
    send({ type: 'tool_result', id: searchId, name: 'search_notes', result });
    const parsed = JSON.parse(result) as {
      hits?: Array<{ citation?: number; title: string; snippet: string }>;
    };
    const hits = parsed.hits ?? [];
    const text =
      hits.length === 0
        ? '（mock）已加载 skill job-interview，但知识库未命中。换关键词再问，或看文档页是否已索引。'
        : `（mock）已加载 skill job-interview。按说明书只用知识库回答：\n${hits
            .map((h) => `- [${h.citation ?? '?'}] ${h.title}：${h.snippet}`)
            .join('\n')}`;
    await streamText(text);
    send({ type: 'done' });
    return;
  }

  // —— 简易知识库 ——
  if (wantsSearch) {
    const id = 'mock_search_1';
    const args = JSON.stringify({ query: last });
    send({ type: 'tool_start', id, name: 'search_notes', arguments: args });
    await sleep(200);
    const result = await executeTool('search_notes', args);
    send({ type: 'tool_result', id, name: 'search_notes', result });
    const parsed = JSON.parse(result) as {
      hits?: Array<{ id: string; title: string; snippet: string }>;
    };
    const hits = parsed.hits ?? [];
    const text =
      hits.length === 0
        ? '（mock）知识库未命中。你可以问：这个项目是做什么的？SSE 怎么实现？'
        : `（mock）根据知识库：\n${hits
            .map((h) => `- [${h.id}] ${h.title}：${h.snippet}`)
            .join('\n')}`;
    await streamText(text);
    send({ type: 'done' });
    return;
  }

  // 都不匹配：提示怎么用
  await streamText(
    '（mock 模式）当前未配置 API Key。你可以问：现在几点？帮我算 123*456；这个项目的技术栈是什么？\n到「配置」页填 API Key 后即可走真实模型。',
  );
  send({ type: 'done' });
}

/** 面板配置优先；mock 会压过 .env 里的 Key */
export function resolveLlmConfig() {
  return resolveLlmFromSettings();
}

/**
 * 流式 tool_calls 是拆成很多 delta 过来的：按 index 拼成完整 id/name/arguments
 * @param acc 累积 Map（key = tool_call 的 index）
 */
function collectToolCallDeltas(
  acc: Map<number, { id: string; name: string; arguments: string }>,
  toolCalls: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>,
) {
  for (const part of toolCalls) {
    const prev = acc.get(part.index) ?? { id: '', name: '', arguments: '' };
    if (part.id) prev.id = part.id;
    if (part.function?.name) prev.name += part.function.name;
    if (part.function?.arguments) prev.arguments += part.function.arguments;
    acc.set(part.index, prev);
  }
}

/**
 * Live 模式主循环：
 *   调模型(stream) → 有 tool_calls？
 *     有 → 执行工具 → 结果写回 history → 再调模型（最多 maxRounds 轮）
 *     无 → 结束
 */
async function runLive(
  client: OpenAI,
  model: string,
  messages: ChatMessageInput[],
  send: Send,
) {
  send({ type: 'meta', mode: 'live', model });

  // 对话上下文：system + 前端传来的 user/assistant
  const history: ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystemPrompt() },
    ...messages.map((m) => ({ role: m.role, content: m.content }) as const),
  ];

  const lastUser = messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
  await preloadMatchedSkills(lastUser, history, send);

  const tools = getToolDefinitions()
  const maxRounds = mcpToolDefinitions().length > 0 ? 6 : 4
  for (let round = 0; round < maxRounds; round += 1) {
    // 开启一轮流式补全，并声明可用工具
    const stream = await client.chat.completions.create({
      model,
      messages: history,
      tools,
      stream: true,
    });

    let assistantText = '';
    const toolAcc = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();
    let finishReason: string | null = null;
    // 消费流：文本立刻推前端；tool_calls 先攒着
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;
      finishReason = choice.finish_reason ?? finishReason;
      const delta = choice.delta;
      if (delta?.content) {
        assistantText += delta.content;
        send({ type: 'text_delta', delta: delta.content });
      }
      if (delta?.tool_calls) {
        collectToolCallDeltas(toolAcc, delta.tool_calls);
      }
    }
    // 把攒好的 toolAcc 转成 OpenAI 要求的 tool_calls 结构
    const toolCalls: ChatCompletionMessageToolCall[] = Array.from(
      toolAcc.entries(),
    )
      .sort((a, b) => a[0] - b[0])
      .map(([, t]) => ({
        id: t.id || `call_${t.name}_${Math.random().toString(36).slice(2, 8)}`,
        type: 'function' as const,
        function: { name: t.name, arguments: t.arguments || '{}' },
      }));

    // 没有工具调用 → 本轮就是最终回答
    if (toolCalls.length === 0) {
      send({ type: 'done' });
      return;
    }

    // 先把「助手决定调工具」这条消息写入 history
    history.push({
      role: 'assistant',
      content: assistantText || null,
      tool_calls: toolCalls,
    });
    // 逐个执行工具，结果以 role:tool 写回，并推 SSE 给前端卡片
    for (const call of toolCalls) {
      if (call.type !== 'function') continue
      const name = call.function.name;
      const args = call.function.arguments;
      send({ type: 'tool_start', id: call.id, name, arguments: args });
      try {
        const result = await executeTool(name, args);
        send({ type: 'tool_result', id: call.id, name, result });
        history.push({
          role: 'tool',
          tool_call_id: call.id,
          content: result,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send({ type: 'tool_error', id: call.id, name, error: message });
        history.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: message }),
        });
      }
    }

    // 理论上 toolCalls 非空时不会走进这里；保留作防御
    if (finishReason === 'stop' && toolCalls.length === 0) {
      send({ type: 'done' });
      return;
    }
    // for 循环继续 → 带着工具结果再问模型，拿最终自然语言回答
  }

  // 超过 maxRounds 还在调工具
  send({ type: 'text_delta', delta: '\n\n（已达工具调用轮次上限）' });
  send({ type: 'done' });
}

/**
 * 入口：有 Key 走 live，否则 mock
 * index.ts 的 /api/chat 只调用这一处
 */
export async function runAgentChat(options: {
  messages: ChatMessageInput[];
  send: Send;
}) {
  const { apiKey, baseURL, model } = resolveLlmConfig();

  if (!apiKey) {
    await streamMock(options.messages, options.send);
    return;
  }

  const client = new OpenAI({ apiKey, baseURL });
  try {
    await runLive(client, model, options.messages, options.send);
  } catch (err) {
    throw wrapLlmError(err, baseURL);
  }
}

/** SDK 的 "Connection error." 看不出是网关挂了还是工作区坏了 */
function wrapLlmError(err: unknown, baseURL?: string) {
  const raw = err instanceof Error ? err.message : String(err);
  if (
    raw === 'Connection error.' ||
    /fetch failed|ENOTFOUND|ECONNREFUSED|getaddrinfo/i.test(raw)
  ) {
    const where = baseURL ? `（${baseURL}）` : '';
    return new Error(
      `模型网关连不上${where}。本地后端是好的，不是工作区坏了。多半没连公司网/VPN。到「配置」页切到 MOCK 就能继续演示工具卡片。`,
    );
  }
  return err instanceof Error ? err : new Error(raw);
}
