/**
 * Chat「代码团队」：固定 explore → implement → review → summary。
 * workspace_write 不直接落盘，发 tool_approval 挂起，等人 POST /api/chat/approve。
 * 挂起记录写到磁盘：热重载后仍能按原参数批准/拒绝。
 *
 * 「全部批准」（accept all）：给这一轮 SSE 的 AbortSignal 打标记，
 * 之后同一轮里低/中风险的写入不再停下等人点，高风险（.env / 密钥 / CI 配置）仍逐条拦。
 *
 * 批准不会过期：这里没有超时计时器。人去泡杯咖啡回来，那条挂起还在，
 * 点批准就按原参数落盘。唯一会把挂起清掉的是：用户自己批准/拒绝、或者这一轮 SSE 断开
 * （断开时磁盘记录特意保留，页面回来还能走孤儿路径批准）。
 *
 * 最后一段是 summary：不带任何工具，只用前面三段落进 transcript 的结论写总结。
 * 之前这里跑完 explore/implement/review 就直接 done，用户体感是「改完没有总结」。
 *
 * 工具白名单是「按意图给」的：这条链路默认只给工作区 + git 工具，
 * 只有用户这句话本身像在问文档/知识库时才额外放开 search_notes（见 exploreToolsFor）。
 */
import fs from 'node:fs'
import path from 'node:path'
import OpenAI from 'openai'
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from 'openai/resources/chat/completions'
import { resolveLlmConfig } from './agent.js'
import { DATA_DIR } from './paths.js'
import { executeTool, getToolDefinitions } from './tools.js'
import { getWorkspaceRoot, workspaceDigest, workspaceRead } from './workspace.js'
import type { AgentRole, ChatMessageInput, SseEvent } from './types.js'

type Send = (event: SseEvent) => void
type Decision = 'approve' | 'deny'

type Pending = {
  resolve: (decision: Decision, keepStore?: boolean) => void
  /** 这条挂起属于哪一轮 SSE：用来把「全部批准」的作用域限定在同一轮 */
  signal: AbortSignal
}

type StoredPending = {
  id: string
  name: string
  arguments: string
  createdAt: number
}

export type ApproveResult =
  | { ok: true; mode: 'live' }
  | { ok: true; mode: 'orphan'; decision: Decision; result?: string; error?: string }
  | { ok: false; error: string }

/** settleApproval 的附加意图：all = 用户点了「全部批准」 */
export type ApproveOptions = { all?: boolean }

const STORE = path.join(DATA_DIR, 'chat-approvals.json')
const pending = new Map<string, Pending>()

/**
 * 已开启「全部批准」的轮次。用 AbortSignal 当键：
 * 一轮 SSE 结束/断开后这条 signal 不再被查询，天然失效，不需要手动清。
 */
const autoApproveSignals = new WeakSet<AbortSignal>()

/** 只读工作区 + git：改码链路三个角色都要有的底座 */
const WORKSPACE_READ_TOOLS = ['workspace_list', 'workspace_read', 'git_status', 'git_diff']
const IMPLEMENT_TOOLS = [...WORKSPACE_READ_TOOLS, 'workspace_write']
const REVIEW_TOOLS = [...WORKSPACE_READ_TOOLS]
/** 总结段一个工具都不给：素材是前三段自己的结论，不是再去读一遍盘 */
const SUMMARY_TOOLS: string[] = []

/**
 * 「要不要查知识库」的意图识别（纯正则、零延迟）。
 *
 * 代码团队的任务几乎总是「看这个仓库 / 改这段代码」，那要走工作区工具，不是知识库。
 * 之前 explore 的白名单里常备 search_notes，模型接到「看下这个仓库怎么改」会先去查文档
 * 再读源码——用户报的正是这个。现在只有这句话本身就在问文档/知识库时才把
 * search_notes 放进去（分流口径对齐 agent.ts 规则 3/9：知识库 ≠ 已连接的代码库）。
 *
 * 为什么不用模型判意图：这里要分开的只是「读工作区」和「读知识库」两组工具，
 * 正则足够；多一次模型往返只会让演示现场不可复现。
 *
 * 注意：这只决定「要不要查文档」，和「改完之后要不要总结」是两件事——
 * 总结是固定跑的 summary 段，不由这句话决定。
 */
const KNOWLEDGE_HINT = /知识库|文档|手册|wiki|周报|月报|纪要|简历|面经|学习路线|怎么学/i

function exploreToolsFor(userTask: string): string[] {
  return KNOWLEDGE_HINT.test(userTask)
    ? [...WORKSPACE_READ_TOOLS, 'search_notes']
    : WORKSPACE_READ_TOOLS
}

/** 这一轮是否已经开了「全部批准」，且该文件不是高风险 */
function canAutoApprove(signal: AbortSignal, rawArgs: string): boolean {
  if (!autoApproveSignals.has(signal)) return false
  return writeRisk(parseWriteArgs(rawArgs).path).risk !== 'high'
}

function readStore(): StoredPending[] {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE, 'utf8')) as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (row): row is StoredPending =>
        !!row &&
        typeof row === 'object' &&
        typeof (row as StoredPending).id === 'string' &&
        typeof (row as StoredPending).name === 'string' &&
        typeof (row as StoredPending).arguments === 'string',
    )
  } catch {
    return []
  }
}

/**
 * 落盘条数上限（200）。这只是防止文件无限增长，不是「放久了就作废」：
 * 记录不会因为时间流逝而失效，只会被批准/拒绝/新一轮覆盖式清理。
 */
const STORE_MAX = 200

function writeStore(rows: StoredPending[]) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const capped = rows.length > STORE_MAX ? rows.slice(rows.length - STORE_MAX) : rows
  fs.writeFileSync(STORE, JSON.stringify(capped, null, 2))
}

function savePending(row: StoredPending) {
  const rows = readStore().filter((r) => r.id !== row.id)
  rows.push(row)
  writeStore(rows)
}

function takeStored(id: string): StoredPending | null {
  const rows = readStore()
  const hit = rows.find((r) => r.id === id) ?? null
  if (hit) writeStore(rows.filter((r) => r.id !== id))
  return hit
}

function dropStored(id: string) {
  writeStore(readStore().filter((r) => r.id !== id))
}

/**
 * 内存里有挂起 → 唤醒 SSE 循环；否则从磁盘捞出孤儿写入直接落盘/拒绝。
 * options.all 由「全部批准」按钮传入：唤醒这一条的同时，把同轮后续写入也放行。
 */
export async function settleApproval(
  id: string,
  decision: Decision,
  options: ApproveOptions = {},
): Promise<ApproveResult> {
  const live = pending.get(id)
  if (live) {
    if (options.all && decision === 'approve') autoApproveSignals.add(live.signal)
    live.resolve(decision)
    return { ok: true, mode: 'live' }
  }

  const stored = takeStored(id)
  if (!stored) {
    return {
      ok: false,
      error: '没有这条待批准写入（可能已处理）。请重新发一轮「代码团队」。',
    }
  }

  if (decision === 'deny') {
    return { ok: true, mode: 'orphan', decision: 'deny', error: '用户拒绝写入，文件未改' }
  }

  try {
    const result = await executeTool(stored.name, stored.arguments)
    return { ok: true, mode: 'orphan', decision: 'approve', result }
  } catch (err) {
    return {
      ok: true,
      mode: 'orphan',
      decision: 'approve',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

function waitForApproval(
  id: string,
  name: string,
  args: string,
  signal: AbortSignal,
): Promise<Decision> {
  savePending({ id, name, arguments: args, createdAt: Date.now() })
  return new Promise((resolve) => {
    let settled = false
    const finish = (decision: Decision, keepStore = false) => {
      if (settled) return
      settled = true
      pending.delete(id)
      // 连接断开（含热重载）保留磁盘记录，批准接口还能按原参数落盘
      if (!keepStore) dropStored(id)
      signal.removeEventListener('abort', onAbort)
      resolve(decision)
    }
    const onAbort = () => finish('deny', true)
    /*
     * 这里故意不设超时：等人点批准可以等多久都行。
     * 唯一会自动结束的情况是这一轮 SSE 断开（onAbort），那种情况下
     * 模型侧已经没有继续的可能，只能如实告诉它「没写成」，但磁盘记录留着。
     */
    pending.set(id, { resolve: finish, signal })
    if (signal.aborted) {
      finish('deny', true)
      return
    }
    signal.addEventListener('abort', onAbort)
  })
}

function rejectApprovals(ids: Iterable<string>) {
  for (const id of ids) {
    const live = pending.get(id)
    // 只唤醒内存 Promise，保留磁盘——热重载后仍可孤儿批准
    if (live) live.resolve('deny', true)
  }
}

function toolsNamed(names: string[]): ChatCompletionTool[] {
  const allow = new Set(names)
  return getToolDefinitions().filter(
    (t) => t.type === 'function' && allow.has(t.function.name),
  )
}

function writePreview(rawArgs: string): string {
  try {
    const parsed = JSON.parse(rawArgs) as { path?: unknown; content?: unknown }
    const path = typeof parsed.path === 'string' ? parsed.path : '?'
    const content = typeof parsed.content === 'string' ? parsed.content : ''
    const clip = content.length > 400 ? `${content.slice(0, 400)}…` : content
    return `${path}\n${clip}`
  } catch {
    return rawArgs.slice(0, 400)
  }
}

function parseWriteArgs(rawArgs: string): { path: string; content: string } {
  try {
    const parsed = JSON.parse(rawArgs) as { path?: unknown; content?: unknown }
    return {
      path: typeof parsed.path === 'string' ? parsed.path : '',
      content: typeof parsed.content === 'string' ? parsed.content : '',
    }
  } catch {
    return { path: '', content: '' }
  }
}

function writeRisk(relPath: string): { risk: 'low' | 'medium' | 'high'; riskReason: string } {
  const p = relPath.replace(/\\/g, '/').toLowerCase()
  if (
    /(^|\/)\.env(\.|$)/.test(p) ||
    /(^|\/)credentials/.test(p) ||
    p.endsWith('.pem') ||
    p.includes('secret')
  ) {
    return { risk: 'high', riskReason: '敏感配置/密钥类文件' }
  }
  if (
    p.endsWith('package.json') ||
    p.endsWith('package-lock.json') ||
    p.endsWith('pnpm-lock.yaml') ||
    p.includes('dockerfile') ||
    p.endsWith('.yml') ||
    p.endsWith('.yaml') ||
    p.includes('.github/workflows')
  ) {
    return { risk: 'medium', riskReason: '依赖或 CI/部署相关' }
  }
  return { risk: 'low', riskReason: '普通源码写入' }
}

function readBefore(relPath: string): string {
  if (!relPath.trim()) return ''
  try {
    return workspaceRead(relPath)
  } catch {
    return ''
  }
}

function approvalPayload(id: string, name: string, args: string) {
  const { path: rel, content } = parseWriteArgs(args)
  const before = readBefore(rel)
  const risk = writeRisk(rel)
  return {
    type: 'tool_approval' as const,
    id,
    name,
    arguments: args,
    preview: writePreview(args),
    path: rel || undefined,
    before,
    after: content,
    risk: risk.risk,
    riskReason: risk.riskReason,
  }
}

function collectToolCallDeltas(
  acc: Map<number, { id: string; name: string; arguments: string }>,
  toolCalls: Array<{
    index: number
    id?: string
    function?: { name?: string; arguments?: string }
  }>,
) {
  for (const part of toolCalls) {
    const prev = acc.get(part.index) ?? { id: '', name: '', arguments: '' }
    if (part.id) prev.id = part.id
    if (part.function?.name) prev.name += part.function.name
    if (part.function?.arguments) prev.arguments += part.function.arguments
    acc.set(part.index, prev)
  }
}

function wrapLlmError(err: unknown, baseURL?: string) {
  const raw = err instanceof Error ? err.message : String(err)
  if (
    raw === 'Connection error.' ||
    /fetch failed|ENOTFOUND|ECONNREFUSED|getaddrinfo/i.test(raw)
  ) {
    const where = baseURL ? `（${baseURL}）` : ''
    return new Error(
      `模型网关连不上${where}。本地后端是好的，不是工作区坏了。多半没连公司网/VPN。到「配置」页切到 MOCK 就能继续演示。`,
    )
  }
  return err instanceof Error ? err : new Error(raw)
}

/** 防幻觉：没 tool 结果就不能说「已读/已写/已确认」 */
const EVIDENCE_RULES = `证据规则（违反=骗人，严禁）：
- 只能陈述本轮对话里 tool 实际返回的内容；没读过的文件禁止写「已读全文 / 确认存在 / 某行有缺陷」。
- 没有成功的 workspace_write 返回，禁止说「已更新 / 已写入 / 已改好」。
- 根目录摘要≠读过文件；不要靠猜写缺陷清单、排名、行号。
- 没核实就写「未读到 / 未核实」，不要编。`

function rolePrompt(role: AgentRole, userTask: string, tools: string[]): string {
  const digest = workspaceDigest()
  const ws = digest
    ? `已连接工作区「${digest.name}」：${digest.root}\n根目录（仅文件名，不算已读）：${digest.entries.join(' ')}`
    : '未连接工作区：先说明无法读盘，不要假装摸底。'
  const lang =
    '语言：最终回答用中文。内部思考 / reasoning 也必须用中文（能用中文就用中文，不要英文自言自语）。'
  const toolLine = tools.length
    ? `本角色本轮可用工具：${tools.join('、')}。不在这个列表里的工具调用会被服务端直接拒绝。`
    : '本角色本轮不调用任何工具：素材只有下面已经发生过的事情，直接写总结。'
  if (role === 'explore') {
    return `你是代码团队的「探索」角色。只摸底，不改文件。
任务：${userTask}
${ws}
${toolLine}
${lang}
${EVIDENCE_RULES}
硬性规则：
1. 先调工具再下结论。需要看多个文件时，同一轮并行发多个 workspace_read / list / git_*。
2. 问「仓库怎么组织 / 目录结构 / 导读」时：优先读 REPO_MAP.md（唯一官方导读）。不要另写平行导读。
3. 不查知识库：用户要改代码时，结论只能来自工作区文件与 git 工具返回，别拿 search_notes 顶替读源码。
   本轮工具列表里没有 search_notes，就说明这句话不是文档问题——直接读文件，不要绕道去查文档。
4. 材料够了就用中文短摸底；结论里点名的文件必须本轮读过。
5. 禁止 workspace_write。缺证据写「未核实」，不要编。`
  }
  if (role === 'implement') {
    return `你是代码团队的「改码」角色。根据探索结论动手改仓库。
任务：${userTask}
${ws}
${toolLine}
${lang}
${EVIDENCE_RULES}
硬性规则：
1. 读、写都可以同轮并行多个（多个 workspace_read / 多个 workspace_write）。
2. 每个 workspace_write 会分别等人批准，批准前不落盘；只说「申请写入了哪些 path」，除非 tool 返回成功否则别说已改好。path 用相对路径。
   用户点了「全部批准」之后，同一轮后续写入不再逐条停（高风险文件仍会拦），不要重复申请批准。
3. 更新导读只改 REPO_MAP.md。不要评审、不要空转列目录。
4. 不查知识库/文档：改哪几个文件就只读那几个文件，别去 search_notes 找「文档怎么说」。
5. 改完之后认真写「改了什么、验证到什么程度」，下一段（总结）会直接引用你的话；
   没写成 / 被拒绝的文件要如实说，别把「申请写入」讲成「已改好」。`
  }
  if (role === 'summary') {
    return `你是代码团队的「总结」角色。只做本轮总结：不调工具、不改文件、不重新摸底。
任务：${userTask}
${ws}
${toolLine}
${lang}
${EVIDENCE_RULES}
硬性规则：
1. 素材只有前面探索 / 改码 / 评审三段各自的结论（在下面对话里，以【explore】【implement】【review】开头）。
   本轮你没有任何工具，所以不许出现新的文件内容、行号、diff。
2. 用中文写，固定三块，每块 1~3 行，不要长篇：
   **这轮做了什么** —— 按角色一句话带过（谁摸底、谁改了什么、谁评审结论如何）。
   **动到的文件** —— 只写前面真正写入成功过的相对路径；一个都没成就写「本轮没有文件被写入」。
   **遗留 / 风险** —— 没做完的、被拒绝的、评审点出的必须修；没有就写「无」。
3. 前面角色没提过的一律不许补。缺证据写「未核实」，禁止编路径、编结论、编「已修复」。
4. 不要复述大段 diff 或代码，不要重复粘贴前面三段原文。`
  }
  return `你是代码团队的「评审」角色。只读、不写。
任务：${userTask}
${ws}
${toolLine}
${lang}
${EVIDENCE_RULES}
硬性规则：
1. 先 git_diff / git_status；要核对文件就同轮并行再读。
2. 用中文短评：做对了什么、必须修、风险。只评 tool 里出现过的改动。
3. 禁止 workspace_write。
4. 不查知识库/文档：评审依据只有本轮 git 与文件工具返回，不要引「文档里写的规范」。`
}

function toolEvidenceSummary(history: ChatCompletionMessageParam[]): string {
  const bits: string[] = []
  for (const m of history) {
    if (m.role !== 'tool') continue
    const raw = typeof m.content === 'string' ? m.content : ''
    if (!raw) continue
    bits.push(raw.length > 400 ? `${raw.slice(0, 400)}…` : raw)
  }
  if (!bits.length) {
    return '本轮没有任何工具返回。你只能回复：「未读取到文件/diff，无法下结论。」禁止编造路径、内容、缺陷。'
  }
  return `下面是本轮真实工具返回（结论只能基于这些，禁止补充未出现的事实）：\n${bits.join('\n---\n')}`
}

/** 防死循环上限（不是「每次只能动 N 个文件」）；业界产品同理只护跑飞 */
function maxToolRounds(role: AgentRole) {
  if (role === 'implement') return 12
  if (role === 'explore') return 8
  /* 总结段不给工具，给 1 只是让它进一次纯文本轮，别落到「轮次用完」那条兜底路径 */
  if (role === 'summary') return 1
  return 8
}

async function forceTextClose(
  client: OpenAI,
  model: string,
  role: AgentRole,
  history: ChatCompletionMessageParam[],
  send: Send,
  signal: AbortSignal,
) {
  if (signal.aborted) return ''
  const evidence = toolEvidenceSummary(history)
  history.push({
    role: 'user',
    content:
      (role === 'implement'
        ? '工具轮次已用完。不要再调用任何工具。只用下面证据用中文简述：申请写了什么 / 实际写成功了什么 / 下一步。'
        : role === 'explore'
          ? '工具轮次已用完。不要再调用任何工具。只用下面证据用中文给出短摸底；没读到的不要写。'
          : role === 'summary'
            ? '不要再调用任何工具。只用前面三段（探索 / 改码 / 评审）的结论写中文总结：这轮做了什么、动到的文件、遗留与风险。没出现过的事实不要写。'
            : '工具轮次已用完。不要再调用任何工具。只用下面证据用中文短评；没出现在证据里的改动不要评。') +
      `\n\n${evidence}\n\n${EVIDENCE_RULES}`,
  })
  const stream = await client.chat.completions.create({
    model,
    messages: history,
    stream: true,
  })
  let text = ''
  for await (const chunk of stream) {
    if (signal.aborted) break
    const delta = chunk.choices[0]?.delta
    const reasoning = (delta as { reasoning_content?: string } | undefined)?.reasoning_content
    if (reasoning) send({ type: 'reasoning_delta', delta: reasoning })
    if (delta?.content) {
      text += delta.content
      send({ type: 'text_delta', delta: delta.content })
    }
  }
  return text
}

async function runOneTool(
  call: ChatCompletionMessageToolCall,
  allowed: string[],
  lastUser: string,
  send: Send,
  signal: AbortSignal,
  tracked: Set<string>,
  announced: Set<string>,
): Promise<{ content: string; aborted: boolean }> {
  if (call.type !== 'function') {
    return { content: JSON.stringify({ error: 'unsupported tool call' }), aborted: false }
  }
  const name = call.function.name
  const args = call.function.arguments
  if (!announced.has(call.id)) {
    send({ type: 'tool_start', id: call.id, name, arguments: args })
  }
  if (!allowed.includes(name)) {
    const message = `当前角色不允许调用 ${name}`
    send({ type: 'tool_error', id: call.id, name, error: message })
    return { content: JSON.stringify({ error: message }), aborted: false }
  }
  try {
    if (name === 'workspace_write') {
      /*
       * 已点过「全部批准」（或发送时就带着开关）且不是高风险文件 → 不再挂起，
       * 卡片从 running 直接变 done。高风险（.env / 密钥 / CI）仍旧逐条等人点。
       */
      if (!canAutoApprove(signal, args)) {
        send(approvalPayload(call.id, name, args))
        tracked.add(call.id)
        const decision = await waitForApproval(call.id, name, args, signal)
        tracked.delete(call.id)
        if (decision !== 'approve') {
          const message = signal.aborted ? '已取消，未写入' : '用户拒绝写入，文件未改'
          send({ type: 'tool_error', id: call.id, name, error: message })
          return {
            content: JSON.stringify({ error: message, written: false }),
            aborted: signal.aborted,
          }
        }
      }
    }
    const result = await executeTool(name, args, { userQuery: lastUser })
    send({ type: 'tool_result', id: call.id, name, result })
    return { content: result, aborted: false }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    send({ type: 'tool_error', id: call.id, name, error: message })
    return { content: JSON.stringify({ error: message }), aborted: false }
  }
}

async function runRoleLive(
  client: OpenAI,
  model: string,
  role: AgentRole,
  allowed: string[],
  history: ChatCompletionMessageParam[],
  lastUser: string,
  send: Send,
  signal: AbortSignal,
  tracked: Set<string>,
  stepRef: { n: number },
) {
  send({ type: 'role_start', role })
  const tools = toolsNamed(allowed)
  const toolRounds = maxToolRounds(role)
  let lastText = ''
  const maxToolsPerRound = 32

  let usedTools = false

  for (let round = 0; round < toolRounds; round += 1) {
    if (signal.aborted) break
    // 探索/评审首轮：不传 tool_choice（公司 MaaS 拒 required → 400），改塞一条硬催
    const forceTool =
      tools.length > 0 && !usedTools && (role === 'explore' || role === 'review')
    if (forceTool && round === 0) {
      history.push({
        role: 'user',
        content:
          role === 'explore'
            ? '先调用工具再下结论。需要多个文件就同轮并行发出多个工具调用。'
            : '先调 git_diff 或 git_status；需要核对就同轮并行再读。',
      })
    }
    const stream = await client.chat.completions.create({
      model,
      messages: history,
      tools: tools.length ? tools : undefined,
      stream: true,
    })

    let assistantText = ''
    const toolAcc = new Map<number, { id: string; name: string; arguments: string }>()
    const announced = new Set<string>()
    let stepped = false

    for await (const chunk of stream) {
      if (signal.aborted) break
      const choice = chunk.choices[0]
      if (!choice) continue
      const delta = choice.delta
      const reasoning = (delta as { reasoning_content?: string } | undefined)?.reasoning_content
      if (reasoning) send({ type: 'reasoning_delta', delta: reasoning })
      // 先攒着：同轮若最终有 tool_calls，这段常是「还没读就编的结论」，不刷给用户
      if (delta?.content) assistantText += delta.content
      if (delta?.tool_calls) {
        collectToolCallDeltas(toolAcc, delta.tool_calls)
        if (!stepped) {
          stepRef.n += 1
          send({ type: 'step', index: stepRef.n })
          stepped = true
        }
        toolAcc.forEach((tool) => {
          if (!tool.id || !tool.name) return
          if (!announced.has(tool.id)) {
            announced.add(tool.id)
            send({
              type: 'tool_start',
              id: tool.id,
              name: tool.name,
              arguments: tool.arguments,
            })
          } else {
            send({ type: 'tool_args', id: tool.id, arguments: tool.arguments })
          }
        })
      }
    }

    const allCalls: ChatCompletionMessageToolCall[] = Array.from(toolAcc.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, t]) => ({
        id: t.id || `call_${t.name}_${Math.random().toString(36).slice(2, 8)}`,
        type: 'function' as const,
        function: { name: t.name, arguments: t.arguments || '{}' },
      }))

    // 纯文本轮才刷出来；带工具的轮把文字留给 history。
    // 首轮强制工具却空手：先别把胡话刷出去，交给 forceTextClose。
    if (allCalls.length === 0 && assistantText && !forceTool) {
      send({ type: 'text_delta', delta: assistantText })
    }
    lastText = assistantText

    if (allCalls.length === 0) {
      if (forceTool) {
        const closing = await forceTextClose(client, model, role, history, send, signal)
        send({ type: 'role_done', role })
        return closing || lastText
      }
      send({ type: 'role_done', role })
      return lastText
    }
    usedTools = true

    const runCalls = allCalls.slice(0, maxToolsPerRound)
    const skipped = allCalls.slice(maxToolsPerRound)
    history.push({
      role: 'assistant',
      content: assistantText || null,
      tool_calls: allCalls,
    })

    for (const call of runCalls) {
      const done = await runOneTool(call, allowed, lastUser, send, signal, tracked, announced)
      history.push({ role: 'tool', tool_call_id: call.id, content: done.content })
      if (done.aborted) {
        send({ type: 'role_done', role })
        return lastText
      }
    }
    for (const call of skipped) {
      if (call.type !== 'function') continue
      const message = '本轮工具过多，已跳过；请根据已有结果直接给中文结论，不要再调工具'
      send({ type: 'tool_error', id: call.id, name: call.function.name, error: message })
      history.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify({ error: message }),
      })
    }
  }

  // 模型一直调工具不收口：再要一轮纯文字，不要再甩「上限」糊弄用户
  const closing = await forceTextClose(client, model, role, history, send, signal)
  send({ type: 'role_done', role })
  return closing || lastText
}

async function streamText(send: Send, text: string) {
  const chunk = 12
  for (let i = 0; i < text.length; i += chunk) {
    send({ type: 'text_delta', delta: text.slice(i, i + chunk) })
  }
}

async function runMock(
  messages: ChatMessageInput[],
  send: Send,
  signal: AbortSignal,
  tracked: Set<string>,
) {
  send({ type: 'meta', mode: 'mock' })
  const lastUser = messages.filter((m) => m.role === 'user').at(-1)?.content ?? ''

  send({ type: 'role_start', role: 'explore' })
  send({ type: 'step', index: 1 })
  const listId = 'mock_list'
  send({ type: 'tool_start', id: listId, name: 'workspace_list', arguments: '{"path":"."}' })
  try {
    const listed = await executeTool('workspace_list', '{"path":"."}')
    send({ type: 'tool_result', id: listId, name: 'workspace_list', result: listed })
  } catch (err) {
    send({
      type: 'tool_error',
      id: listId,
      name: 'workspace_list',
      error: err instanceof Error ? err.message : String(err),
    })
  }
  await streamText(send, `摸底：用户要「${lastUser.slice(0, 80)}」。下面改码会写一份短说明，需你批准。`)
  send({ type: 'role_done', role: 'explore' })

  send({ type: 'role_start', role: 'implement' })
  send({ type: 'step', index: 2 })
  const writeId = 'mock_write'
  const args = JSON.stringify({
    path: 'AGENT_TEAM_NOTE.md',
    content: `# 代码团队备忘\n\n用户任务：${lastUser}\n\n（mock 演示写入，批准后才会落盘）\n`,
  })
  send({ type: 'tool_start', id: writeId, name: 'workspace_write', arguments: args })
  let decision: Decision = 'approve'
  // 已开「全部批准」时演示模式也不停：卡片直接 running → done
  if (!canAutoApprove(signal, args)) {
    send(approvalPayload(writeId, 'workspace_write', args))
    tracked.add(writeId)
    decision = await waitForApproval(writeId, 'workspace_write', args, signal)
    tracked.delete(writeId)
  }
  if (decision === 'approve') {
    const result = await executeTool('workspace_write', args)
    send({ type: 'tool_result', id: writeId, name: 'workspace_write', result })
    await streamText(send, '已按批准写入 AGENT_TEAM_NOTE.md。')
  } else {
    const message = signal.aborted ? '已取消，未写入' : '用户拒绝写入，文件未改'
    send({ type: 'tool_error', id: writeId, name: 'workspace_write', error: message })
    await streamText(send, message)
  }
  send({ type: 'role_done', role: 'implement' })

  send({ type: 'role_start', role: 'review' })
  await streamText(
    send,
    decision === 'approve'
      ? '评审：说明文件已写入工作区根目录。若这不是你要的改动，删掉 AGENT_TEAM_NOTE.md 即可。'
      : '评审：没有落盘，无需回滚。',
  )
  send({ type: 'role_done', role: 'review' })

  /*
   * mock 也走总结段：不然演示模式下「改完没总结」的现象照样复现，
   * 而 MOCK 正是没配 Key 时最常用的那条路径。
   */
  send({ type: 'role_start', role: 'summary' })
  await streamText(
    send,
    decision === 'approve'
      ? '**这轮做了什么**：探索列了根目录，改码申请写入一份备忘，评审确认落盘。\n**动到的文件**：AGENT_TEAM_NOTE.md（工作区根目录）。\n**遗留 / 风险**：这是 mock 演示写入的示例文件，不需要就删掉。'
      : '**这轮做了什么**：探索列了根目录，改码申请写入备忘，评审确认没有落盘。\n**动到的文件**：本轮没有文件被写入（写入被拒绝）。\n**遗留 / 风险**：无。',
  )
  send({ type: 'role_done', role: 'summary' })
  send({ type: 'done' })
}

export async function runCodeTeamChat(options: {
  messages: ChatMessageInput[]
  send: Send
  signal: AbortSignal
  /** 前端开关：本轮开始就让后续写入不再逐条挂起（高风险仍拦） */
  autoApprove?: boolean
}) {
  const tracked = new Set<string>()
  const { send, messages, signal, autoApprove } = options
  try {
    if (!getWorkspaceRoot()) {
      send({ type: 'error', message: '代码团队需要先连接工作区。请在聊天底部选一个本地仓库。' })
      send({ type: 'done' })
      return
    }

    if (autoApprove) autoApproveSignals.add(signal)

    const { apiKey, baseURL, model } = resolveLlmConfig()
    if (!apiKey) {
      await runMock(messages, send, signal, tracked)
      return
    }

    const lastUser = messages.filter((m) => m.role === 'user').at(-1)?.content ?? ''
    const client = new OpenAI({ apiKey, baseURL })
    send({ type: 'meta', mode: 'live', model })

    const transcript: ChatCompletionMessageParam[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }))

    /*
     * 工具按意图给：explore 默认只有工作区 + git，只有这句像在问文档/知识库时
     * 才加上 search_notes（见 exploreToolsFor）。implement 才有 workspace_write。
     * 最后固定再跑一段 summary（不给工具）：前三段的结论会被拼进它的 transcript，
     * 由它写「这轮做了什么 / 动到的文件 / 遗留与风险」——即用户看到的收尾总结。
     */
    const stages: Array<{ role: AgentRole; tools: string[] }> = [
      { role: 'explore', tools: exploreToolsFor(lastUser) },
      { role: 'implement', tools: IMPLEMENT_TOOLS },
      { role: 'review', tools: REVIEW_TOOLS },
      { role: 'summary', tools: SUMMARY_TOOLS },
    ]
    const stepRef = { n: 0 }

    for (const stage of stages) {
      if (signal.aborted) break
      const history: ChatCompletionMessageParam[] = [
        { role: 'system', content: rolePrompt(stage.role, lastUser, stage.tools) },
        ...transcript,
      ]
      const text = await runRoleLive(
        client,
        model,
        stage.role,
        stage.tools,
        history,
        lastUser,
        send,
        signal,
        tracked,
        stepRef,
      )
      if (text.trim()) {
        transcript.push({
          role: 'assistant',
          content: `【${stage.role}】\n${text.trim()}`,
        })
      }
    }

    send({ type: 'done' })
  } catch (err) {
    const { baseURL } = resolveLlmConfig()
    const wrapped = wrapLlmError(err, baseURL)
    send({ type: 'error', message: wrapped.message })
    send({ type: 'done' })
  } finally {
    rejectApprovals(tracked)
  }
}
