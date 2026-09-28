/**
 * Chat「代码团队」：固定 explore → implement → review。
 * workspace_write 不直接落盘，发 tool_approval 挂起，等人 POST /api/chat/approve。
 * 挂起记录写到磁盘：热重载后仍能按原参数批准/拒绝。
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
import { getWorkspaceRoot, workspaceDigest } from './workspace.js'
import type { AgentRole, ChatMessageInput, SseEvent } from './types.js'

type Send = (event: SseEvent) => void
type Decision = 'approve' | 'deny'

type Pending = {
  resolve: (decision: Decision, keepStore?: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

type StoredPending = {
  id: string
  name: string
  arguments: string
  createdAt: number
  expiresAt: number
}

export type ApproveResult =
  | { ok: true; mode: 'live' }
  | { ok: true; mode: 'orphan'; decision: Decision; result?: string; error?: string }
  | { ok: false; error: string }

const APPROVAL_MS = 5 * 60 * 1000
const STORE = path.join(DATA_DIR, 'chat-approvals.json')
const pending = new Map<string, Pending>()

const EXPLORE_TOOLS = ['workspace_list', 'workspace_read', 'search_notes', 'git_status', 'git_diff']
const IMPLEMENT_TOOLS = ['workspace_list', 'workspace_read', 'workspace_write', 'git_status', 'git_diff']
const REVIEW_TOOLS = ['workspace_list', 'workspace_read', 'git_status', 'git_diff']

function readStore(): StoredPending[] {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE, 'utf8')) as unknown
    if (!Array.isArray(raw)) return []
    const now = Date.now()
    return raw.filter(
      (row): row is StoredPending =>
        !!row &&
        typeof row === 'object' &&
        typeof (row as StoredPending).id === 'string' &&
        typeof (row as StoredPending).name === 'string' &&
        typeof (row as StoredPending).arguments === 'string' &&
        typeof (row as StoredPending).expiresAt === 'number' &&
        (row as StoredPending).expiresAt > now,
    )
  } catch {
    return []
  }
}

function writeStore(rows: StoredPending[]) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(STORE, JSON.stringify(rows, null, 2))
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

/** 内存里有挂起 → 唤醒 SSE 循环；否则从磁盘捞出孤儿写入直接落盘/拒绝 */
export async function settleApproval(id: string, decision: Decision): Promise<ApproveResult> {
  const live = pending.get(id)
  if (live) {
    live.resolve(decision)
    return { ok: true, mode: 'live' }
  }

  const stored = takeStored(id)
  if (!stored) {
    return {
      ok: false,
      error: '没有这条待批准写入（可能已处理或超过 5 分钟）。请重新发一轮「代码团队」。',
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
  savePending({
    id,
    name,
    arguments: args,
    createdAt: Date.now(),
    expiresAt: Date.now() + APPROVAL_MS,
  })
  return new Promise((resolve) => {
    let settled = false
    const finish = (decision: Decision, keepStore = false) => {
      if (settled) return
      settled = true
      const item = pending.get(id)
      if (item) {
        clearTimeout(item.timer)
        pending.delete(id)
      }
      // 连接断开（含热重载）保留磁盘记录，批准接口还能按原参数落盘
      if (!keepStore) dropStored(id)
      signal.removeEventListener('abort', onAbort)
      resolve(decision)
    }
    const onAbort = () => finish('deny', true)
    const timer = setTimeout(() => finish('deny', false), APPROVAL_MS)
    pending.set(id, { resolve: finish, timer })
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

function rolePrompt(role: AgentRole, userTask: string): string {
  const digest = workspaceDigest()
  const ws = digest
    ? `已连接工作区「${digest.name}」：${digest.root}\n根目录：${digest.entries.join(' ')}`
    : ''
  if (role === 'explore') {
    return `你是代码团队的「探索」角色。只摸底，不改文件。
任务：${userTask}
${ws}
硬性规则：
1. 最多 1 次 workspace_list + 最多 2 次 workspace_read（或 1 次 git_status/git_diff）。不要再开一轮工具。
2. 拿到材料后立刻用中文给出摸底结论：相关文件、怎么改、风险。禁止再调工具。
3. 禁止 workspace_write。`
  }
  if (role === 'implement') {
    return `你是代码团队的「改码」角色。根据探索结论动手改仓库。
任务：${userTask}
${ws}
硬性规则：
1. 先最多读 2 个文件，再 workspace_write；写完立刻用中文简述改了哪些文件并结束，不要再读。
2. 每次 workspace_write 会等人批准，批准前不会落盘。path 只用相对路径。
3. 不要做代码评审，不要无意义地反复读目录。`
  }
  return `你是代码团队的「评审」角色。只读、不写。
任务：${userTask}
${ws}
硬性规则：
1. 优先 git_diff / git_status，最多再读 1 个文件。不要反复列目录。
2. 拿到 diff 后立刻用中文评审：做对了什么、必须修、风险。禁止再调工具。
3. 禁止 workspace_write。`
}

/** 每角色允许的「带工具」轮次；用尽后会再强制要一轮纯文本结论 */
function maxToolRounds(role: AgentRole) {
  if (role === 'implement') return 3
  if (role === 'explore') return 2
  return 2
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
  history.push({
    role: 'user',
    content:
      role === 'implement'
        ? '工具轮次已用完。不要再调用任何工具。根据已有结果用中文简述：改了什么 / 没改成什么 / 下一步建议。'
        : role === 'explore'
          ? '工具轮次已用完。不要再调用任何工具。根据已读内容立刻用中文给出摸底结论。'
          : '工具轮次已用完。不要再调用任何工具。根据已有 diff/文件立刻用中文给出评审结论。',
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
      const preview = writePreview(args)
      send({
        type: 'tool_approval',
        id: call.id,
        name,
        arguments: args,
        preview,
        expiresInMs: APPROVAL_MS,
      })
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
  const maxToolsPerRound = 3

  for (let round = 0; round < toolRounds; round += 1) {
    if (signal.aborted) break
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
      if (delta?.content) {
        assistantText += delta.content
        send({ type: 'text_delta', delta: delta.content })
      }
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

    lastText = assistantText
    const allCalls: ChatCompletionMessageToolCall[] = Array.from(toolAcc.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, t]) => ({
        id: t.id || `call_${t.name}_${Math.random().toString(36).slice(2, 8)}`,
        type: 'function' as const,
        function: { name: t.name, arguments: t.arguments || '{}' },
      }))

    if (allCalls.length === 0) {
      send({ type: 'role_done', role })
      return lastText
    }

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
  const preview = writePreview(args)
  send({
    type: 'tool_approval',
    id: writeId,
    name: 'workspace_write',
    arguments: args,
    preview,
    expiresInMs: APPROVAL_MS,
  })
  tracked.add(writeId)
  const decision = await waitForApproval(writeId, 'workspace_write', args, signal)
  tracked.delete(writeId)
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
  send({ type: 'done' })
}

export async function runCodeTeamChat(options: {
  messages: ChatMessageInput[]
  send: Send
  signal: AbortSignal
}) {
  const tracked = new Set<string>()
  const { send, messages, signal } = options
  try {
    if (!getWorkspaceRoot()) {
      send({ type: 'error', message: '代码团队需要先连接工作区。请在聊天底部选一个本地仓库。' })
      send({ type: 'done' })
      return
    }

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

    const stages: Array<{ role: AgentRole; tools: string[] }> = [
      { role: 'explore', tools: EXPLORE_TOOLS },
      { role: 'implement', tools: IMPLEMENT_TOOLS },
      { role: 'review', tools: REVIEW_TOOLS },
    ]
    const stepRef = { n: 0 }

    for (const stage of stages) {
      if (signal.aborted) break
      const history: ChatCompletionMessageParam[] = [
        { role: 'system', content: rolePrompt(stage.role, lastUser) },
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
