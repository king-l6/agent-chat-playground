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
import { executeTool, toolDefinitions } from './tools.js';
import type { ChatMessageInput, SseEvent } from './types.js';

/** 系统提示：告诉模型何时调哪些工具 */
const SYSTEM_PROMPT = `你是「Agent Chat Playground」里的助手，面向求职演示。
规则：
1. 需要准确时间时调用 get_current_time。
2. 需要计算时调用 calculator。
3. 用户问本项目、SSE、tool calling、技术栈、简历作品相关问题时，先调用 search_notes 再基于结果回答，并在回答里引用片段。
4. 用简洁中文回答；调用工具后根据工具结果给出最终结论，不要编造工具没返回的内容。`;

/** 向 SSE 管道推事件的函数类型（由 index.ts 注入） */
type Send = (event: SseEvent) => void;

/** Promise 版延时，mock 流式用 */
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const wantsSearch = /项目|sse|tool|agent|技术栈|简历|rag|知识库/.test(lower);

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
    '（mock 模式）当前未配置 API Key。你可以问：现在几点？帮我算 123*456；这个项目的技术栈是什么？\n配置 `.env` 里的 ANTHROPIC_API_KEY（或 OPENAI_API_KEY）后即可走真实模型。',
  );
  send({ type: 'done' });
}

/**
 * 从环境变量解析 Key / BaseURL / Model
 * 支持 OPENAI_*，也兼容公司网关 ANTHROPIC_*（Base 会自动补 /v1）
 */
export function resolveLlmConfig() {
  const apiKey =
    process.env.OPENAI_API_KEY?.trim() ||
    process.env.ANTHROPIC_API_KEY?.trim() ||
    '';

  const openaiBase = process.env.OPENAI_BASE_URL?.trim();
  const anthropicBase = process.env.ANTHROPIC_BASE_URL?.trim()?.replace(
    /\/$/,
    '',
  );
  const baseURL =
    openaiBase || (anthropicBase ? `${anthropicBase}/v1` : undefined);

  const model =
    process.env.OPENAI_MODEL?.trim() ||
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL?.trim() ||
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL?.trim() ||
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL?.trim() ||
    'deepseek-v4-flash';

  return { apiKey, baseURL, model };
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
    { role: 'system', content: SYSTEM_PROMPT },
    ...messages.map((m) => ({ role: m.role, content: m.content }) as const),
  ];

  const maxRounds = 4;
  for (let round = 0; round < maxRounds; round += 1) {
    // 开启一轮流式补全，并声明可用工具
    const stream = await client.chat.completions.create({
      model,
      messages: history,
      tools: toolDefinitions,
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
    console.log('toolCalls', toolCalls);
    // 逐个执行工具，结果以 role:tool 写回，并推 SSE 给前端卡片
    for (const call of toolCalls) {
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
    console.log('999999');
    
    await streamMock(options.messages, options.send);
    return;
  }

  const client = new OpenAI({ apiKey, baseURL });
  await runLive(client, model, options.messages, options.send);
}
