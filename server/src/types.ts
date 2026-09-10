/**
 * 后端共享类型（和前端 src/types.ts 的 SseEvent 保持一致）
 */

/** 模型对话里可能出现的角色（含 system / tool） */
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

/** 前端 POST /api/chat 时传入的消息条目（不含 system/tool） */
export interface ChatMessageInput {
  role: 'user' | 'assistant'
  content: string
}

/**
 * 服务端内部也可用来记工具状态（当前主流程更多靠 SSE 直接推前端）
 */
export interface ToolCallState {
  id: string
  name: string
  arguments: string
  status: 'running' | 'done' | 'error'
  result?: string
  error?: string
}

/**
 * 通过 SSE 推给前端的事件载荷
 * index.ts 的 send() 会写成：data: ${JSON.stringify(event)}\n\n
 */
export type SseEvent =
  /** 告知前端当前模式与模型名 */
  | { type: 'meta'; mode: 'live' | 'mock'; model?: string }
  /** 文本增量 */
  | { type: 'text_delta'; delta: string }
  /** 开始调工具 */
  | { type: 'tool_start'; id: string; name: string; arguments: string }
  /** 工具成功返回 */
  | { type: 'tool_result'; id: string; name: string; result: string }
  /** 工具失败 */
  | { type: 'tool_error'; id: string; name: string; error: string }
  /** 本轮结束 */
  | { type: 'done' }
  /** 整轮异常 */
  | { type: 'error'; message: string }
