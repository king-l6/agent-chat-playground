export type Role = 'user' | 'assistant'

export interface ToolCallView {
  id: string
  name: string
  arguments: string
  status: 'running' | 'done' | 'error'
  result?: string
  error?: string
}

export interface UiMessage {
  id: string
  role: Role
  content: string
  tools: ToolCallView[]
  status: 'done' | 'streaming' | 'error'
}

export type SseEvent =
  | { type: 'meta'; mode: 'live' | 'mock'; model?: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_start'; id: string; name: string; arguments: string }
  | { type: 'tool_result'; id: string; name: string; result: string }
  | { type: 'tool_error'; id: string; name: string; error: string }
  | { type: 'done' }
  | { type: 'error'; message: string }
