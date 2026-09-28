/**
 * 前端用到的类型定义（没有函数，只描述「数据结构长什么样」）
 * 后端 SSE 推过来的事件形状，和这里的 SseEvent 基本一致。
 */

/** 消息角色：用户 或 助手（系统提示在后端，前端列表里不展示 system） */
export type Role = 'user' | 'assistant'

/** 代码团队 / Delivery 流水线角色 */
export type AgentRole = 'pm' | 'dev' | 'review' | 'qa' | 'explore' | 'implement'

/**
 * 一条「工具调用」在 UI 上的展示数据
 * 问「现在几点」时会先出现一张 Tool 卡片，就用这个结构。
 */
export interface ToolCallView {
  /** 这次调用的唯一 id，用来匹配 start / result / error */
  id: string
  /** 工具名，如 get_current_time / calculator / search_notes */
  name: string
  /** 模型传给工具的参数（JSON 字符串） */
  arguments: string
  /** 卡片状态：调用中 → 成功 / 失败 */
  status: 'running' | 'done' | 'error' | 'awaiting_approval'
  /** 待批准写入时给卡片看的短预览 */
  preview?: string
  /** 批准截止时间戳（本地 Date.now） */
  expiresAt?: number
  /** 成功时工具返回的内容（通常是 JSON 字符串） */
  result?: string
  /** 失败时的错误信息 */
  error?: string
  /** 属于 Agent 的第几步；同一步里可以有多张卡片 */
  step?: number
  /** 从发出 tool_start 到结果回来的毫秒 */
  ms?: number
  /** 前端计时用，不展示 */
  startedAt?: number
}

/**
 * 一条助手消息里的零件，顺序就是 SSE 到达顺序。
 * 对应 AI SDK 的 UIMessage.parts：文字、思考、工具穿插，而不是先堆完工具再贴正文。
 */
export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool'; id: string }
  | { type: 'role'; role: AgentRole; phase: 'start' | 'done' }

/**
 * 聊天列表里的一条消息（用户气泡或助手气泡）
 * App.tsx 的 messages 状态就是 UiMessage[]
 */
export interface UiMessage {
  /** 前端本地生成的 id，用于更新某一条助手消息 */
  id: string
  /** 谁说的：user / assistant */
  role: Role
  /** 正文；流式时会不断追加 text_delta */
  content: string
  /** 这条助手消息过程中触发的工具调用列表（可能为空） */
  tools: ToolCallView[]
  /** 整条消息状态：流式中 / 完成 / 出错 */
  status: 'done' | 'streaming' | 'error'
  /** 当前 Agent 步号；tool_start 时抄到对应卡片上 */
  step?: number
  /** 有这个字段时按零件顺序渲染；旧会话没有，就退回「工具在上、正文在下」 */
  parts?: MessagePart[]
  /** 发出请求的本地时间戳，用来算 ttft / total */
  startedAt?: number
  /** 首个 text / tool / reasoning 到达的毫秒数，对应 assistant-ui MessageTiming.ttft */
  ttftMs?: number
  /** 整轮结束耗时 */
  totalMs?: number
}

/**
 * 后端通过 SSE 推给前端的事件（联合类型：每次只会出现其中一种）
 * chat.ts 解析 data: {...} 后，交给 App.handleEvent 处理。
 *
 * 典型顺序示例（问时间）：
 *   meta → tool_start → tool_result → text_delta* → done
 * 典型顺序示例（闲聊）：
 *   meta → text_delta* → done
 */
export type SseEvent =
  /** 会话元信息：当前是 live 还是 mock，以及模型名 */
  | { type: 'meta'; mode: 'live' | 'mock'; model?: string }
  /** 助手文本的一小段增量，前端拼到 content 上形成「打字机」效果 */
  | { type: 'text_delta'; delta: string }
  /** 多步 Agent 进入新的一轮，后面的工具卡片归到这一步 */
  | { type: 'step'; index: number }
  /** 模型思考过程的增量，对应 AI SDK 的 reasoning-delta，不写进最终回答 */
  | { type: 'reasoning_delta'; delta: string }
  /** 开始调用工具：前端插入一张 status=running 的卡片 */
  | { type: 'tool_start'; id: string; name: string; arguments: string }
  /** 工具参数还没写完，卡片上的 arguments 整段替换。对应 tool-input-delta */
  | { type: 'tool_args'; id: string; arguments: string }
  /** 工具执行成功：把对应卡片改成 done，并带上 result */
  | { type: 'tool_result'; id: string; name: string; result: string }
  /** 工具执行失败：把对应卡片改成 error */
  | { type: 'tool_error'; id: string; name: string; error: string }
  | {
      type: 'tool_approval'
      id: string
      name: string
      arguments: string
      preview?: string
      expiresInMs?: number
    }
  /** 本轮对话正常结束，前端可以重新允许发送 */
  | { type: 'done' }
  /** 整轮出错（网络/模型异常等），前端展示错误并可结束 busy */
  | { type: 'error'; message: string }
  | { type: 'role_start'; role: AgentRole }
  | { type: 'role_done'; role: AgentRole }
  | { type: 'artifact'; name: string; payload: unknown }
  | { type: 'gate_blocked'; gate: string; message: string }
