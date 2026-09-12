/**
 * 交付控制面：人点闸，Agent 只写黑板。不要把角色人设塞进 agent.ts。
 */
import { REPO_ROOT } from '../paths.js'
import type { SseEvent } from '../types.js'
import { gitDiff } from '../git.js'
import { executeTool } from '../tools.js'
import { getWorkspaceRoot, setWorkspaceRoot, workspaceRead, workspaceWrite } from '../workspace.js'
import { runAllowedCommand } from './commands.js'
import { assertRoleTool, assertWritablePath } from './roles.js'
import { getRun, saveRun, setSeat } from './store.js'
import {
  GateError,
  type Acceptance,
  type DeliveryRole,
  type DeliveryRun,
  type GateAction,
  type Prd,
  type Seat,
} from './types.js'

const EXTRA_PATH = 'server/src/eval-cases.ts'
const NEW_CASE_ID = 'vite-stack'

type Send = (event: SseEvent) => void

function now() {
  return new Date().toISOString()
}

function requireActor(run: DeliveryRun, actor: Seat, allowed: Seat[]) {
  if (run.seat !== actor) {
    throw new GateError('seat', `当前身份是 ${run.seat}，请求 actor=${actor}`)
  }
  if (!allowed.includes(actor)) {
    throw new GateError('seat', `${actor} 不能做这个操作`)
  }
}

function ensureRoot() {
  if (!getWorkspaceRoot()) setWorkspaceRoot(REPO_ROOT)
}

export function currentRun() {
  return getRun()
}

export function changeSeat(seat: Seat) {
  return setSeat(seat)
}

export function updatePrd(
  actor: Seat,
  patch: Partial<Pick<Prd, 'title' | 'oneLiner' | 'body' | 'acceptance'>>,
) {
  const run = getRun()
  requireActor(run, actor, ['pm'])
  if (run.prd.confirmed) throw new GateError('frozen', '文档已冻结。先撤回确认再改。')
  if (patch.title !== undefined) run.prd.title = patch.title
  if (patch.oneLiner !== undefined) run.prd.oneLiner = patch.oneLiner
  if (patch.body !== undefined) run.prd.body = patch.body
  if (patch.acceptance) run.prd.acceptance = patch.acceptance
  run.prd.version += 1
  return saveRun(run)
}

function record(run: DeliveryRun, action: GateAction, actor: Seat, reason?: string) {
  run.gates.push({ action, actor, at: now(), reason })
}

export function applyGate(
  actor: Seat,
  action: GateAction,
  extra?: { reason?: string; questions?: string[] },
) {
  const run = getRun()
  const reason = extra?.reason?.trim() || ''

  if (action === 'confirm') {
    requireActor(run, actor, ['pm'])
    if (run.phase !== 'drafting') throw new GateError('confirm', '只有起草中才能确认流转')
    if (!run.prd.acceptance.some((a) => a.checkedByPm)) {
      throw new GateError('confirm', '至少勾 1 条可判定验收才能确认流转')
    }
    run.prd.confirmed = true
    run.prd.confirmedAt = now()
    run.phase = 'developing'
    record(run, action, actor)
    return saveRun(run)
  }

  if (action === 'withdraw') {
    requireActor(run, actor, ['pm'])
    if (!run.prd.confirmed) throw new GateError('withdraw', '还没确认，不用撤回')
    run.prd.confirmed = false
    delete run.prd.confirmedAt
    if (run.patch?.files.length) {
      run.stale = true
      run.dirtyWarning = true
    }
    run.phase = 'drafting'
    record(run, action, actor)
    return saveRun(run)
  }

  if (action === 'bounce_pm') {
    requireActor(run, actor, ['dev'])
    if (run.phase !== 'developing') throw new GateError('bounce_pm', '只有研发中才能打回产品')
    const questions = (extra?.questions ?? []).map((q) => q.trim()).filter(Boolean)
    if (questions.length === 0) throw new GateError('bounce_pm', '打回产品必须写疑问')
    run.questions = questions
    run.phase = 'blocked_on_pm'
    record(run, action, actor)
    return saveRun(run)
  }

  if (action === 'keep_prd') {
    requireActor(run, actor, ['pm'])
    if (run.phase !== 'blocked_on_pm') throw new GateError('keep_prd', '只有被打回时才能维持原文档再转')
    if (!run.prd.confirmed) throw new GateError('keep_prd', '文档已解冻，先改完再确认')
    run.phase = 'developing'
    record(run, action, actor)
    return saveRun(run)
  }

  if (action === 'dev_done') {
    requireActor(run, actor, ['dev'])
    if (run.phase !== 'developing') throw new GateError('dev_done', '不在研发中')
    if (run.stale) throw new GateError('dev_done', '这次 run 已过期，重新确认后再交')
    run.phase = 'reviewing'
    record(run, action, actor)
    return saveRun(run)
  }

  if (action === 'review_bounce') {
    requireActor(run, actor, ['qa'])
    if (run.phase !== 'reviewing') throw new GateError('review', '不在评审中')
    run.phase = 'developing'
    record(run, action, actor)
    return saveRun(run)
  }

  if (action === 'review_pass' || action === 'review_risk') {
    requireActor(run, actor, ['qa'])
    if (run.phase !== 'reviewing') throw new GateError('review', '不在评审中')
    const mustFix = run.review?.comments.some((c) => c.mustFix)
    if (mustFix && action === 'review_pass') {
      throw new GateError('review', '有必须改的意见，只能带风险放行并写理由')
    }
    if (action === 'review_risk') {
      if (!reason) throw new GateError('review', '带风险放行必须写理由')
      if (run.review) run.review.riskReason = reason
    }
    run.phase = 'testing'
    record(run, action, actor, reason || undefined)
    return saveRun(run)
  }

  if (action === 'test_bounce') {
    requireActor(run, actor, ['qa'])
    if (run.phase !== 'testing') throw new GateError('test', '不在测试中')
    run.phase = 'developing'
    record(run, action, actor)
    return saveRun(run)
  }

  if (action === 'test_sign' || action === 'test_risk') {
    requireActor(run, actor, ['qa'])
    if (run.phase !== 'testing') throw new GateError('test', '不在测试中')
    const failed = run.test_report?.items.some((i) => i.result === 'fail')
    if (failed && action === 'test_sign') {
      throw new GateError('test', '有失败验收，只能带风险签字并写理由')
    }
    if (action === 'test_risk') {
      if (!reason) throw new GateError('test', '带风险签字必须写理由')
      if (run.test_report) run.test_report.riskReason = reason
    }
    const files = run.patch?.files ?? []
    run.release_notes = {
      files,
      text: `发布说明：${run.prd.title || '本轮交付'}\n改动文件：${files.join(', ') || '无'}`,
    }
    run.phase = 'signed'
    record(run, action, actor, reason || undefined)
    return saveRun(run)
  }

  throw new GateError('gate', `未知闸门 ${action}`)
}

function defaultAcceptance(): Acceptance[] {
  return [
    {
      id: 'ac-eval',
      text: 'npm run eval:rag 退出码 0，原有 8 题还在',
      kind: 'auto',
      command: 'eval:rag',
      checkedByPm: false,
    },
    {
      id: 'ac-see',
      text: '评测输出里能看到新增黄金问题',
      kind: 'manual',
      observable: '终端出现 9 条黄金问题，且 rerank 命中新增题',
      checkedByPm: false,
    },
  ]
}

function draftFrom(message: string, prev: Prd): Prd {
  const oneLiner = message.trim() || prev.oneLiner || '给 RAG 评测加一道题'
  const base = prev.acceptance.length ? prev.acceptance : defaultAcceptance()
  return {
    ...prev,
    oneLiner,
    title: prev.title || '给 RAG 评测加一道黄金问题',
    body:
      prev.body ||
      `一句话：${oneLiner}\n范围：只改 server/src/eval-cases.ts（或 eval.ts）。禁止改 agent.ts。\n做完后 npm run eval:rag 不能坏原有 8 题。`,
    acceptance: base,
    confirmed: false,
    version: prev.version + 1,
  }
}

function withNewCase(existing: string) {
  if (existing.includes(NEW_CASE_ID)) return existing
  const row = `  {
    id: '${NEW_CASE_ID}',
    query: 'agent-chat-playground 的技术栈是什么？',
    docId: 'project',
    contains: 'Vite',
  },`
  if (existing.includes('export const EXTRA_CASES: GoldCase[] = []')) {
    return existing.replace(
      'export const EXTRA_CASES: GoldCase[] = []',
      `export const EXTRA_CASES: GoldCase[] = [\n${row}\n]`,
    )
  }
  if (existing.includes('export const EXTRA_CASES: GoldCase[] = [')) {
    return existing.replace(
      'export const EXTRA_CASES: GoldCase[] = [',
      `export const EXTRA_CASES: GoldCase[] = [\n${row}`,
    )
  }
  throw new GateError('write', 'eval-cases.ts 找不到 EXTRA_CASES，拒绝盲写')
}

export function deliveryExecuteTool(role: DeliveryRole, name: string, rawArgs: string) {
  assertRoleTool(role, name)
  if (name === 'workspace_write') {
    const args = JSON.parse(rawArgs || '{}') as { path?: string }
    assertWritablePath(String(args.path ?? ''))
  }
  if (name === 'run_allowed_command') {
    const args = JSON.parse(rawArgs || '{}') as { command?: string }
    ensureRoot()
    return JSON.stringify(runAllowedCommand(String(args.command ?? ''), getWorkspaceRoot() || REPO_ROOT))
  }
  return executeTool(name, rawArgs)
}

function emitRole(send: Send, role: DeliveryRole, run: DeliveryRun, name: string) {
  send({ type: 'role_start', role })
  send({ type: 'artifact', name, payload: artifactPayload(name, run) })
  send({ type: 'role_done', role })
}

function artifactPayload(name: string, run: DeliveryRun) {
  if (name === 'prd') return run.prd
  if (name === 'patch') return run.patch
  if (name === 'review') return run.review
  if (name === 'test_report') return run.test_report
  if (name === 'release_notes') return run.release_notes
  return run
}

export async function runDeliveryTurn(actor: Seat, message: string, send: Send) {
  const run = getRun()
  requireActor(run, actor, [actor])
  send({ type: 'meta', mode: 'mock' })

  if (run.phase === 'drafting') {
    requireActor(run, actor, ['pm'])
    run.prd = draftFrom(message, run.prd)
    saveRun(run)
    emitRole(send, 'pm', run, 'prd')
    send({ type: 'text_delta', delta: '已起草 PRD。勾至少 1 条验收后点「确认流转」。' })
    send({ type: 'done' })
    return
  }

  if (run.phase === 'blocked_on_pm') {
    send({
      type: 'gate_blocked',
      gate: 'blocked_on_pm',
      message: '文档仍冻结。产品撤回改文档，或维持原文档再转研发。',
    })
    send({ type: 'done' })
    return
  }

  if (run.phase === 'developing') {
    requireActor(run, actor, ['dev'])
    if (!run.prd.confirmed) throw new GateError('frozen', 'PRD 未确认，不能进研发')
    if (run.stale) throw new GateError('stale', 'run 已过期，重新确认后再改代码')
    ensureRoot()
    send({ type: 'role_start', role: 'dev' })
    const before = workspaceRead(EXTRA_PATH)
    await deliveryExecuteTool(
      'dev',
      'workspace_write',
      JSON.stringify({ path: EXTRA_PATH, content: withNewCase(before) }),
    )
    run.patch = {
      summary: `追加黄金题 ${NEW_CASE_ID}`,
      files: [EXTRA_PATH],
    }
    saveRun(run)
    send({ type: 'artifact', name: 'patch', payload: run.patch })
    send({ type: 'role_done', role: 'dev' })
    send({ type: 'text_delta', delta: `已写入 ${EXTRA_PATH}。人点「开发完成」才进评审。` })
    send({ type: 'done' })
    return
  }

  if (run.phase === 'reviewing') {
    requireActor(run, actor, ['qa'])
    ensureRoot()
    send({ type: 'role_start', role: 'review' })
    let path = EXTRA_PATH
    let fromDiff = false
    try {
      const diff = gitDiff(EXTRA_PATH)
      const first = diff.diff.split('\n').find((line) => line.startsWith('+++ b/'))
      if (first) {
        path = first.replace('+++ b/', '').trim() || EXTRA_PATH
        fromDiff = true
      }
    } catch {
      /* mock 也必须带路径 */
    }
    run.review = {
      comments: [
        {
          path,
          risk: fromDiff
            ? '只加了一道题，确认没有改 agent.ts / 原 8 题。'
            : '工作区没有 diff，按约定路径评审（mock 也要有 path）。',
          mustFix: false,
        },
      ],
    }
    saveRun(run)
    send({ type: 'artifact', name: 'review', payload: run.review })
    send({ type: 'role_done', role: 'review' })
    send({ type: 'text_delta', delta: `评审意见指向 ${path}。人点放行或打回。` })
    send({ type: 'done' })
    return
  }

  if (run.phase === 'testing') {
    requireActor(run, actor, ['qa'])
    ensureRoot()
    send({ type: 'role_start', role: 'qa' })
    const cwd = getWorkspaceRoot() || REPO_ROOT
    const items = []
    const commandLogs = []
    for (const ac of run.prd.acceptance) {
      if (!ac.checkedByPm) continue
      if (ac.kind === 'auto' && ac.command) {
        const log = runAllowedCommand(ac.command, cwd)
        commandLogs.push(log)
        items.push({
          acId: ac.id,
          result: log.exitCode === 0 ? 'pass' : 'fail',
          detail: `exit=${log.exitCode}\n${log.excerpt}`,
        } as const)
      } else {
        items.push({
          acId: ac.id,
          result: 'needs_human',
          detail: ac.observable || ac.text,
        } as const)
      }
    }
    run.test_report = { items, commandLogs }
    saveRun(run)
    send({ type: 'artifact', name: 'test_report', payload: run.test_report })
    send({ type: 'role_done', role: 'qa' })
    send({ type: 'text_delta', delta: '测试对照已勾验收。人签字后才出发布说明。' })
    send({ type: 'done' })
    return
  }

  send({
    type: 'gate_blocked',
    gate: run.phase,
    message: '这条 run 已结束。要再来一回请新产品从一句话重新起草。',
  })
  send({ type: 'done' })
}

export { assertRoleTool, assertWritablePath }
