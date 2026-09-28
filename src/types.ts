/**
 * 前端用到的类型定义（没有函数，只描述「数据结构长什么样」）。
 * 后端 SSE 推过来的事件形状，和这里的 SseEvent 基本一致。
 */

/** 消息角色：用户 或 助手（系统提示在后端，前端列表里不展示 system） */
export type Role = 'user' | 'assistant'

/**
 * 代码团队 / 交付泳道角色。
 * 代码团队四段：explore（探索）→ implement（改码）→ review（评审）→ summary（总结）；
 * pm / dev / qa 属交付泳道（Delivery 另有自己的 DeliveryRole）。
 */
export type AgentRole = 'pm' | 'dev' | 'review' | 'qa' | 'explore' | 'implement' | 'summary'

/**
 * 一条「工具调用」在 UI 上的展示数据
 * 问「现在几点」时会先出现一张 Tool 卡片，就用这个结构。
 */
export interface ToolCallView {
  /** 这次调用的唯一 id，用来匹配 start / result / error */
  id: string
  /** 工具名，如 get_current_time / calculator / search_notes / ask_user */
  name: string
  /** 模型传给工具的参数（JSON 字符串） */
  arguments: string
  /** 卡片状态：调用中 → 成功 / 失败 / 等人批准 / 等人回答 */
  status: 'running' | 'done' | 'error' | 'awaiting_approval' | 'awaiting_answer'
  /** 待批准写入时给卡片看的短预览 */
  preview?: string
  path?: string
  before?: string
  after?: string
  risk?: 'low' | 'medium' | 'high'
  riskReason?: string
  /**
   * ask_user 挂起时要问的问题与候选答案（卡片渲染成输入框 / 快捷选项）。
   * 只在这个工具上有值；用户提交后答案会作为 tool_result 回到模型。
   */
  question?: string
  options?: string[]
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
 * 批准 / 拒绝一条挂起的 workspace_write 的回调。
 * options.all = 用户点了「全部批准」：本轮后续低/中风险写入不再逐条询问
 *（.env、密钥、CI 配置这类高风险文件后端仍会单独拦一次）。
 */
export type ToolApproveHandler = (
  id: string,
  decision: 'approve' | 'deny',
  options?: { all?: boolean },
) => void | Promise<void>

/**
 * 回答一条挂起的 ask_user 的回调（用户按下「回答」或点了某个候选选项）。
 * 后端把它作为该工具的 result 回填给模型，那一轮的 Agent 循环继续往下走。
 */
export type ToolAnswerHandler = (id: string, answer: string) => void | Promise<void>

/** 一条助手消息里的零件，顺序就是 SSE 到达顺序。 */
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
 * 典型顺序示例（代码团队）：
 *   meta → role_start(explore) … role_done(explore) → role_start(implement) …
 *   → role_start(review) … → role_start(summary) … → done
 * 典型顺序示例（要人拍板）：
 *   已有卡片… → tool_start(ask_user) → ask（挂起）→ POST /api/chat/answer
 *   → tool_result(ask_user) → 继续…
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
  /**
   * 有写入需要人批准：卡片停在 awaiting_approval，等 POST /api/chat/approve。
   * 这里没有「过期时间」字段：后端等人点可以等多久都行（见 server/src/codeTeam.ts）。
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
   * 这是「需要我拍板」真正停下来问你的那条通道（工具名 ask_user）。
   */
  | { type: 'ask'; id: string; name?: string; question: string; options?: string[] }
  /** 本轮对话正常结束，前端可以重新允许发送 */
  | { type: 'done' }
  /** 整轮出错（网络/模型异常等），前端展示错误并可结束 busy */
  | { type: 'error'; message: string }
  | { type: 'role_start'; role: AgentRole }
  | { type: 'role_done'; role: AgentRole }
  | { type: 'artifact'; name: string; payload: unknown }
  | { type: 'gate_blocked'; gate: string; message: string }
