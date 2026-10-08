/**
 * 会话上下文用量估算（纯前端、零依赖）。
 *
 * 口径（本轮修正）：这个数字要能跟「后端真正收到的 history」对得上，
 * 所以只数 role + content，并且与 server/src/index.ts 的 /api/chat 保持一致：
 *   1) 不算工具卡片的 arguments / result —— api/chat.ts 的 toApiMessages 只发
 *      { role, content }，tools 整块被丢掉；后端每轮拿「system + 这份 history」
 *      重建上下文，工具返回只在本轮 maxRounds 循环内有效，跨轮不保留。
 *   2) 不算正在流式的那条 —— App.onSend 发出去的是
 *      messages.filter((m) => m.status !== 'streaming')。
 *   3) 单条正文按 OUTGOING_CONTENT_LIMIT 截断（后端 slice 同样长度）。
 *
 * 仍是**下限**：后端每轮还会额外带 system prompt（规则 1–10 全文 + skill 目录 +
 * 工作区块 + MCP 块 + 长期记忆块）、工具 JSON schema（10 个 function）、以及
 * preloadMatchedSkills 注入的 skill 正文。这些量前端拿不到，所以真实占用一定比
 * 这个数高。界面上必须如实标「下限」，不要当成精确计数。
 *
 * 为什么不引 tokenizer：模型名在「配置」页是自由文本（占位符 deepseek-v4-flash），
 * 没有可靠的「模型名 → 分词器」映射；为了一个用量提示去装 tiktoken / gpt-tokenizer 不划算。
 * 这里按「中日韩字符 1 字 ≈ 1 token、其它 4 字符 ≈ 1 token」粗估，
 * 误差通常在 ±20% 量级，够用来提示「快满了」。
 *
 * 它是**估算**：不是计费依据，也不要据此做「删哪条历史」的决策——
 * 后端目前没有「按上下文裁剪 history」的策略：agent.ts 的 runLive 里的 maxRounds、
 * codeTeam.ts 的 maxToolRounds 都是**工具调用轮次**上限，不是上下文裁剪。
 * 这个数字的唯一用途是给用户一个「快满了，可以开新会话」的提示。
 */

/**
 * 上下文窗口的**兜底**值（token）。
 *
 * 真实值由后端给：/api/health 的 contextWindow 字段，
 * 来源与优先级见 server/src/settings.ts 的 resolveContextWindow()
 * （llm.json 的 contextWindow → 环境变量 CONTEXT_WINDOW_TOKENS / OPENAI_CONTEXT_WINDOW → 同值兜底）。
 *
 * 这个 32000 **不对应任何具体模型**，只是后端的保守缺省值。别拿它当「模型窗口就是 32k」的证据，
 * 也只在「health 还没回来 / 请求失败」时用它，别在 App 里另写一个数。
 */
export const CONTEXT_WINDOW_TOKENS = 32_000

/**
 * 给「模型输出 + 工具轮」预留的 token，作为预警线与分母的减项。
 *
 * 预警线不再拍一个「80%」：上下文窗口是输入和输出**共用**的，history + system prompt +
 * 工具 schema 占掉一部分之后，还得留出模型写本轮回答、以及 agent 循环里再来几轮工具的余量。
 * 两项都是量级估计（前端拿不到网关真实的 max_tokens，也拿不到服务端的工具轮上限）：
 *   - 8k：单轮输出。本项目没有显式传 max_tokens，取网关默认值的常见量级；
 *   - 4k：工具轮。server/src/agent.ts 的 runLive 最多 4 轮（有 MCP 时 6），
 *     每轮都要把工具返回再塞回去，留一份对应的余量。
 * 想更保守就调大这个数；它仍是估算，但至少是可解释的加总，而不是没有依据的百分比。
 */
export const CONTEXT_RESERVE_TOKENS = 12_000

/**
 * 旧口径的固定比例预警线。**已不用**，保留只为不让未迁移的引用直接断。
 * 替换理由：分母越大，固定比例留出的绝对余量越多——8k 窗口下 20% 是 1.6k、
 * 200k 窗口下是 40k，差了 25 倍，无法回答「为什么现在该开新会话」。
 * 新代码请用 contextWarnOf()。
 *
 * @deprecated 用 contextWarnOf(used, window)
 */
export const CONTEXT_WARN_RATIO = 0.8

/**
 * 单条消息正文发给后端时的截断上限（字符）。
 * 必须与 server/src/index.ts 里 /api/chat 的 `content.slice(0, 8000)` 一致：
 * 那边截断、这边不截断的话，分子会凭空多算一截（贴大 diff 的会话尤其明显）。
 */
export const OUTGOING_CONTENT_LIMIT = 8000

/**
 * 中日韩字符 + 全角标点判定。
 * 用 charCode 而不是正则：流式时这个函数每帧都会跑一遍全部消息，
 * 正则逐字符 test 在长会话里会有可感开销。
 */
function isCjkCode(code: number) {
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0x3000 && code <= 0x303f)
  )
}

export function estimateTokens(text: string) {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (let i = 0; i < text.length; i += 1) {
    if (isCjkCode(text.charCodeAt(i))) cjk += 1
    else other += 1
  }
  return Math.round(cjk + other / 4)
}

/**
 * 旧口径：正文 + 工具卡片的参数/返回。
 *
 * 注意它**高估**：tools 不会随 history 发回后端（见 api/chat.ts 的 toApiMessages），
 * 所以这部分是「前端看得见、后端收不到」的虚构占用。
 * App 的用量环已经改用 estimateOutgoingTokens，这里只为兼容未迁移的调用方保留。
 */
export type CountableMessage = {
  content: string
  tools?: Array<{ arguments?: string; result?: string }>
}

export function estimateMessageTokens(message: CountableMessage) {
  let total = estimateTokens(message.content)
  for (const tool of message.tools ?? []) {
    total += estimateTokens(tool.arguments ?? '')
    total += estimateTokens(tool.result ?? '')
  }
  return total
}

export function estimateMessagesTokens(messages: CountableMessage[]) {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
}

/** 与 src/api/chat.ts 的 toApiMessages 输出同形：后端 history 里只有角色和正文 */
export type OutgoingMessage = {
  role: 'user' | 'assistant'
  content: string
}

/**
 * 估算「真正发给后端的那份 history」占多少 token。
 *
 * 调用方先把消息列表收成 toApiMessages 的形状（顺带就是 App.onSend 发出去的那份），
 * 这里只按与后端一致的截断规则数正文。
 */
export function estimateOutgoingTokens(messages: OutgoingMessage[]) {
  return messages.reduce(
    (sum, message) => sum + estimateTokens(message.content.slice(0, OUTGOING_CONTENT_LIMIT)),
    0,
  )
}

/** 3.4k / 12k 这种短形式 */
export function formatTokens(n: number) {
  if (n < 1000) return String(n)
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
}

/**
 * 可用预算 = 窗口 - 预留（见 CONTEXT_RESERVE_TOKENS）。
 * 窗口 ≤ 预留（填了个很小的数，或 window 非法）时返回 0，表示「已经没有余量」。
 */
export function contextBudgetOf(window: number) {
  if (!Number.isFinite(window) || window <= 0) return 0
  return Math.max(0, window - CONTEXT_RESERVE_TOKENS)
}

/**
 * 是否提示「快满了」：已用 ≥ 可用预算。
 *
 * 判定基准是「窗口 - 预留」这个绝对量，不是窗口的固定百分比（旧 CONTEXT_WARN_RATIO 的问题
 * 见上面那段注释）。窗口 ≤ 预留时预算为 0，只要用过东西就该提示，所以返回 used > 0。
 */
export function contextWarnOf(used: number, window: number) {
  const budget = contextBudgetOf(window)
  if (budget <= 0) return used > 0
  return used >= budget
}

/**
 * 已用 / 整个窗口的占比，收在 [0, 1]。
 *
 * 注意它给的是**相对真实窗口**的相对量（环形进度条画的是这个），
 * 跟「什么时候该警告」是两件事——警告走 contextWarnOf，基准是窗口减预留。
 * 单独抽出来是为了两件事：window 传 0 / 负数 / NaN 时不会算出 Infinity，
 * 以及环形进度条的 dashoffset 需要一个不会越界的数（溢出的百分比会让环画反）。
 */
export function contextRatioOf(used: number, window: number) {
  if (!Number.isFinite(window) || window <= 0) return 0
  const ratio = used / window
  if (!Number.isFinite(ratio)) return 0
  return Math.min(1, Math.max(0, ratio))
}
