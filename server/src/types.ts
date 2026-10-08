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
 * Agent 角色（role_start / role_done 的取值）。
 * Chat「代码团队」用 explore → implement → review → summary 四段（见 codeTeam.ts）；
 * pm / dev / qa 是交付泳道那一侧的（Delivery 自己另有 DeliveryRole）。
 */
export type AgentRole = 'pm' | 'dev' | 'review' | 'qa' | 'explore' | 'implement' | 'summary'

export interface ToolCallState {
  id: string
  name: string
  arguments: string
  status: 'running' | 'done' | 'error' | 'awaiting_approval' | 'awaiting_answer'
  result?: string
  error?: string
  /** ask_user 挂起时的问题与候选答案（前端渲染输入框用） */
  question?: string
  options?: string[]
}

/**
 * 通过 SSE 推给前端的事件载荷
 * index.ts 的 send() 会写成：data: ${JSON.stringify(event)}\n\n
 *
 * 字段口径必须和 src/types.ts 的 SseEvent 一致：前端 App.handleEvent 是按这里写的。
 */
export type SseEvent =
  /** 告知前端当前模式与模型名 */
  | { type: 'meta'; mode: 'live' | 'mock'; model?: string }
  /** 文本增量 */
  | { type: 'text_delta'; delta: string }
  /**
   * 多步 Agent 的一轮。后面紧跟的 tool_* 都属于这一步，
   * 直到下一个 step。前端按这个把工具卡片分成「第 N 步」。
   */
  | { type: 'step'; index: number }
  /** 模型的思考增量，不进最终回答 */
  | { type: 'reasoning_delta'; delta: string }
  /** 开始调工具 */
  | { type: 'tool_start'; id: string; name: string; arguments: string }
  /** 工具参数的增量快照，arguments 是截至目前拼出来的整段 */
  | { type: 'tool_args'; id: string; arguments: string }
  /** 工具成功返回 */
  | { type: 'tool_result'; id: string; name: string; result: string }
  /** 工具失败 */
  | { type: 'tool_error'; id: string; name: string; error: string }
  /**
   * 写入工作区前等人点批准，arguments 是完整参数，preview 是给卡片看的摘要。
   *
   * 没有 expiresInMs：批准不会过期（见 codeTeam.ts 的 waitForApproval，那里没有计时器），
   * 生产者也不发这个字段，留着只会让人以为存在超时自动拒绝。前端 src/types.ts 早已删掉。
   */
  | {
      type: 'tool_approval'
      id: string
      name: string
      arguments: string
      preview?: string
      path?: string
      before?: string
      after?: string
      risk?: 'low' | 'medium' | 'high'
      riskReason?: string
    }
  /**
   * 模型要用户拍板：卡片停在 awaiting_answer，等 POST /api/chat/answer。
   *
   * 这是 ask_user 工具的人机停点，和 tool_approval 是同一类「停下来等人」，
   * 区别是等的是**一段文字**而不是一个批准。同样没有超时字段：
   * 挂起能等多久就等多久（codeTeam.ts 的 waitForAnswer 里没有计时器）。
   */
  | { type: 'ask'; id: string; name?: string; question: string; options?: string[] }
  /** 本轮结束 */
  | { type: 'done' }
  /** 整轮异常 */
  | { type: 'error'; message: string }
  | { type: 'role_start'; role: AgentRole }
  | { type: 'role_done'; role: AgentRole }
  | { type: 'artifact'; name: string; payload: unknown }
  | { type: 'gate_blocked'; gate: string; message: string }
