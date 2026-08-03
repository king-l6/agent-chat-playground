export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ChatMessageInput {
  role: 'user' | 'assistant'
  content: string
}

export interface ToolCallState {
  id: string
  name: string
  arguments: string
  status: 'running' | 'done' | 'error'
  result?: string
  error?: string
}

/** SSE event payloads sent to the frontend */
export type SseEvent =
  | { type: 'meta'; mode: 'live' | 'mock'; model?: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_start'; id: string; name: string; arguments: string }
  | { type: 'tool_result'; id: string; name: string; result: string }
  | { type: 'tool_error'; id: string; name: string; error: string }
  | { type: 'done' }
  | { type: 'error'; message: string }
