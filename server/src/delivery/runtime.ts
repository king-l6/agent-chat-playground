/**
 * 交付控制面：人点闸，Agent 只写黑板。不要把角色人设塞进 agent.ts。
 */
import fs from 'node:fs'
import type { SseEvent } from '../types.js'
import { gitDiff, gitStatus } from '../git.js'
import { currentUserId } from '../requestContext.js'
import { assertAllowedRoot, getWorkspaceRoot, withWorkspaceRoot } from '../workspace.js'
import { collectArtifacts, diffForFiles } from './artifacts.js'
import { runAllowedCommand } from './commands.js'
import { refinePrd } from './draft.js'
import { checkProjectHealth } from './health.js'
import { implementPrd } from './implement.js'
import { ensureProjectScaffold } from './scaffold.js'
import { assertRoleTool, assertWritablePath } from './roles.js'
import {
  bindRunWorkspace as storeBindWorkspace,
  createRun,
  deleteRun as storeDeleteRun,
  getActiveId,
  listRuns,
  requireRun,
  saveRun,
  setActiveRun,
  setSeat,
} from './store.js'
import {
  GateError,
  type DeliveryRun,
  type GateAction,
  type Prd,
  type Seat,
  type TalkTrace,
  type TalkTraceStep,
} from './types.js'

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

/**
 * 这条需求的仓库：绑过就用绑的，没绑回落全局默认（兼容老的单条 run 文件）。
 * 都没有才报错——研发和测试都在这个目录里干活。
 */
function requireWorkspace(run?: DeliveryRun) {
  const root = run?.workspaceRoot ?? getWorkspaceRoot()
  if (!root) {
    throw new GateError(
      'workspace',
      '还没选仓库。在这条需求上点「选仓库」，或菜单「文件 → 打开工作区」选一个目录，研发和测试都在那个目录里干活。',
    )
  }
  return root
}

/** 在需求绑定的仓库作用域里跑一段同步逻辑；没绑就照走全局默认 */
function inRunRoot<T>(run: DeliveryRun, fn: () => T): T {
  return run.workspaceRoot ? withWorkspaceRoot(run.workspaceRoot, fn) : fn()
}

/**
 * diff 展示顺序：源码在前，依赖清单（package.json / lock）垫后。
 * 模型为加依赖改的 package.json diff 又长又全是版本号，顶在最前面会盖住真正的业务改动。
 */
function orderForDiff(files: string[]): string[] {
  const rank = (p: string) => {
    if (/(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(p)) return 2
    if (/^(src|server\/src|electron)\//.test(p)) return 0
    return 1
  }
  return [...files].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

function workspaceSnapshot(run: DeliveryRun) {
  const root = run.workspaceRoot ?? getWorkspaceRoot()
  if (!root) return { root: null, status: '', diff: '' }
  try {
    return inRunRoot(run, () => ({ root, status: gitStatus().status, diff: gitDiff().diff }))
  } catch (err) {
    return {
      root,
      status: err instanceof Error ? err.message : String(err),
      diff: '',
    }
  }
}

export function currentRun(id?: string) {
  return requireRun(id)
}

export function publicDelivery(id?: string) {
  const run = requireRun(id)
  return { ...run, workspace: workspaceSnapshot(run) }
}

/**
 * 预览要的产物包：工程根下的文件 + 工程完整性结论。
 * 两者都在这条需求绑定的仓库作用域里算，前端一次请求就够。
 */
export function publicDeliveryArtifacts(id?: string) {
  const run = requireRun(id)
  requireWorkspace(run)
  const files = run.patch?.files ?? []
  return inRunRoot(run, () => ({
    ...collectArtifacts(files),
    health: checkProjectHealth(files),
  }))
}

/** 需求列表：摘要 + 当前激活哪条 */
export function publicRuns() {
  return { activeId: getActiveId(), runs: listRuns() }
}

export function startNewRun(input?: { workspaceRoot?: string }) {
  // 新开一条也带仓库时同样过白名单：不然「建的时候塞坏路径」和「事后改绑」是两个洞，
  // 只堵一个没有意义。
  const root = input?.workspaceRoot?.trim()
  if (!root) return createRun(input)
  const real = assertAllowedRoot(fs.realpathSync(root))
  if (!fs.statSync(real).isDirectory()) throw new Error('选的要是个目录')
  return createRun({ ...input, workspaceRoot: real })
}

export function activateRun(id: string) {
  return setActiveRun(id)
}

export function deleteDeliveryRun(id: string) {
  return storeDeleteRun(id)
}

/**
 * 绑仓库：校验目录真实存在**且在允许列表内**，再落盘。
 *
 * 白名单必须在写入这一层拦，不能只靠用的时候拦（withWorkspaceRoot / resolveUnderRoot）：
 * 只在用时拦，坏路径已经躺在 run 文件里了 —— 本轮会在最外层抛错、每个读接口都带着
 * 一段错误文本，看起来像「功能坏了」而不是「你选错了」。实测过：绑 /etc 会被存下来。
 */
export function bindRunWorkspace(id: string, absRoot: string | undefined) {
  const root = absRoot?.trim()
  if (root) {
    const real = assertAllowedRoot(fs.realpathSync(root))
    if (!fs.statSync(real).isDirectory()) throw new Error('选的要是个目录')
    return storeBindWorkspace(id, real)
  }
  return storeBindWorkspace(id, undefined)
}

export function changeSeat(seat: Seat, id?: string) {
  return setSeat(seat, id)
}

export function updatePrd(
  actor: Seat,
  patch: Partial<Pick<Prd, 'title' | 'oneLiner' | 'body' | 'acceptance'>>,
  id?: string,
) {
  const run = requireRun(id)
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
  id?: string,
) {
  const run = requireRun(id)
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


/*
 * 这里原来有个 deliveryExecuteTool(role, name, rawArgs)：一套「角色 → 允许的工具名」转发。
 * 全仓库 grep 无消费者（各 phase 执行体各自调自己的模块：implement.ts 调 implementPrd、
 * testing 段直接调 runAllowedCommand），留着是个坑 —— 它是唯一一处**不带 ctx**
 * 调 runAllowedCommand 的地方，容器标签、审计字段都会缺，谁哪天顺手接上去就会踩。
 * 删掉。assertRoleTool / assertWritablePath 仍然从下面 re-export，没有连带损失。
 */
function remember(run: DeliveryRun, user: string, assistant: string, trace?: TalkTrace) {
  run.talk.push({ role: 'user', content: user })
  run.talk.push({ role: 'assistant', content: assistant, ...(trace ? { trace } : {}) })
}

function tapTrace(send: Send) {
  const steps = new Map<string, TalkTraceStep>()
  let live = ''
  return {
    send(event: SseEvent) {
      if (event.type === 'tool_start') {
        steps.set(event.id, {
          id: event.id,
          name: event.name,
          arguments: event.arguments,
          status: 'running',
        })
      }
      if (event.type === 'tool_result') {
        const prev = steps.get(event.id)
        steps.set(event.id, {
          id: event.id,
          name: event.name,
          arguments: prev?.arguments ?? '',
          status: 'done',
          result: event.result,
        })
      }
      if (event.type === 'tool_error') {
        const prev = steps.get(event.id)
        steps.set(event.id, {
          id: event.id,
          name: event.name,
          arguments: prev?.arguments ?? '',
          status: 'error',
          error: event.error,
        })
      }
      if (event.type === 'text_delta' && event.delta && event.delta !== '…') {
        live = `${live}${event.delta}`.slice(-4000)
      }
      send(event)
    },
    snapshot(): TalkTrace | undefined {
      const list = Array.from(steps.values())
      if (list.length === 0 && !live) return undefined
      return { steps: list, live: live || undefined }
    },
  }
}

/** 同一时刻只让一条 turn 跑这条需求，防连点把 talk 交错写乱 */
const inFlight = new Set<string>()

export async function runDeliveryTurn(actor: Seat, message: string, send: Send, id?: string) {
  const run = requireRun(id)
  requireActor(run, actor, [actor])
  if (inFlight.has(run.id)) {
    send({ type: 'gate_blocked', gate: 'busy', message: '这条需求上一轮还在跑，等它完再发。' })
    send({ type: 'done' })
    return
  }
  inFlight.add(run.id)
  try {
    // 整个 phase 分派都在这条需求的仓库作用域里，实现/评审/测试各自命中对的 root
    await inRunRoot(run, () => runTurnBody(run, actor, message.trim(), send))
  } finally {
    inFlight.delete(run.id)
  }
}

async function runTurnBody(run: DeliveryRun, actor: Seat, text: string, send: Send) {
  if (run.phase === 'drafting') {
    requireActor(run, actor, ['pm'])
    send({ type: 'role_start', role: 'pm' })
    const refined = await refinePrd(run.prd, run.talk, text)
    send({ type: 'meta', mode: refined.live ? 'live' : 'mock' })
    run.prd = refined.prd
    remember(run, text, refined.reply)
    saveRun(run)
    send({ type: 'artifact', name: 'prd', payload: run.prd })
    send({ type: 'role_done', role: 'pm' })
    send({ type: 'text_delta', delta: refined.reply })
    send({ type: 'done' })
    return
  }

  if (run.phase === 'blocked_on_pm') {
    send({
      type: 'gate_blocked',
      gate: 'blocked_on_pm',
      message: '研发把问题打回来了，文档还冻着。要改需求先「撤回确认」；认可原文就「维持原文档再转研发」。',
    })
    send({ type: 'done' })
    return
  }

  if (run.phase === 'developing') {
    requireActor(run, actor, ['dev'])
    if (!run.prd.confirmed) throw new GateError('frozen', 'PRD 未确认，不能在仓库里改代码')
    if (run.stale) throw new GateError('stale', '这次已经撤回过，run 过期了。重新确认后再改仓库。')
    const root = requireWorkspace(run)
    send({ type: 'role_start', role: 'dev' })
    const tap = tapTrace(send)
    tap.send({ type: 'text_delta', delta: '开始按文档改仓库。\n' })
    const sink = {
      note: (line: string) => tap.send({ type: 'text_delta', delta: line }),
      start: (id: string, name: string, args: string) =>
        tap.send({ type: 'tool_start', id, name, arguments: args }),
      done: (id: string, name: string, result: string) =>
        tap.send({ type: 'tool_result', id, name, result }),
      fail: (id: string, name: string, error: string) =>
        tap.send({ type: 'tool_error', id, name, error }),
    }

    // 这批交付涉及的文件：模型写的 + 脚手架补的/校正的，一路累积到取快照
    const declared = new Set<string>(run.patch?.files ?? [])
    const backfilled = { written: [] as string[], missingBefore: [] as string[], corrected: [] as string[] }

    /**
     * 工程骨架兜底 + 实测完整性。必须在取快照**之前**跑：落盘的改动才会被 git status
     * 看到、进 files、进 diff、被评审看见。可能被判不合格而重跑一轮，所以要能重复调用。
     */
    const settle = () => {
      const one = ensureProjectScaffold([...declared], (rel) => {
        const id = `scaffold-${rel}`
        tap.send({
          type: 'tool_start',
          id,
          name: 'scaffold_write',
          arguments: JSON.stringify({ path: rel }),
        })
        tap.send({ type: 'tool_result', id, name: 'scaffold_write', result: `已写入 ${rel}` })
      })
      backfilled.written.push(...one.written)
      backfilled.missingBefore.push(...one.missingBefore)
      backfilled.corrected.push(...one.corrected)
      for (const rel of one.written) declared.add(rel)
      for (const note of one.notes) tap.send({ type: 'text_delta', delta: `\n${note}\n` })
      return checkProjectHealth([...declared])
    }

    let done = await implementPrd(run.prd, text, sink, {
      talk: run.talk,
      lastErrors: run.lastErrors ?? [],
    })
    for (const rel of done.files) declared.add(rel)
    let health = settle()

    /*
     * 实测不合格就自愈一轮。
     *
     * 原来这里只兜底、不复验：产物起不起得来要等人自己去点「运行结果」，再靠人催一句
     * 才有人管——本次故障就是这么来回三轮的，而每一轮模型都以为自己写完了。
     * 既然评审那条 mustFix 用的就是同一个 checkProjectHealth，那就在这一轮直接拿它的
     * 结论再修一次。**只加一轮**：修不动就交给评审拦住，不在这里打转
     *（每轮都是一次完整的 LLM 调用，16G 机器上也不便宜）。
     */
    if (!health.ok) {
      tap.send({
        type: 'text_delta',
        delta: `\n实测这份产物起不来，带着证据再修一轮：\n- ${health.evidence.join('\n- ')}\n`,
      })
      done = await implementPrd(
        run.prd,
        `${text}\n\n【必须优先修】上一轮产物实测起不来，逐条改掉：\n- ${health.evidence.join('\n- ')}`,
        sink,
        { talk: run.talk, lastErrors: health.evidence },
      )
      for (const rel of done.files) declared.add(rel)
      health = settle()
    }

    send({ type: 'meta', mode: done.live ? 'live' : 'mock' })
    const snap = workspaceSnapshot(run)
    const files = orderForDiff([...declared])
    // 已跟踪的走 git，未跟踪的合成——空目录新建项目时后者才是全部
    const diff = inRunRoot(run, () => diffForFiles(files, snap.status))
    // 还没修好的问题一并进 lastErrors：下一轮研发开口时就带着实测证据，不用人复述
    run.lastErrors = [...done.errors, ...(health.ok ? [] : health.evidence)]
    run.patch = {
      summary: text || `按 PRD 改 ${root}`,
      files,
      status: snap.status,
      diff: diff || snap.diff,
      ...(backfilled.written.length
        ? {
            scaffold: {
              written: [...new Set(backfilled.written)],
              missingBefore: [...new Set(backfilled.missingBefore)],
              corrected: [...new Set(backfilled.corrected)],
            },
          }
        : {}),
    }
    remember(run, text || '按右边文档改选中的仓库', done.reply, tap.snapshot())
    saveRun(run)
    send({ type: 'artifact', name: 'patch', payload: run.patch })
    send({ type: 'role_done', role: 'dev' })
    send({ type: 'text_delta', delta: run.talk[run.talk.length - 1]?.content ?? '' })
    send({ type: 'done' })
    return
  }

  if (run.phase === 'reviewing') {
    requireActor(run, actor, ['qa'])
    requireWorkspace(run)
    send({ type: 'meta', mode: 'mock' })
    send({ type: 'role_start', role: 'review' })
    const diff = gitDiff()
    const files = [
      ...new Set(
        (diff.diff.match(/^\+\+\+ b\/.+$/gm) ?? []).map((line) => line.replace('+++ b/', '').trim()),
      ),
    ]
    const path = run.patch?.files[0] || files[0] || '(未写文件)'
    const extra = files.filter((f) => f !== path)
    // 工程完整性：只报实测到的事实，条条能指回文件。mustFix 已有的闸门语义会拦住「放行去测试」。
    const health = checkProjectHealth(run.patch?.files ?? [])
    // 打回研发时让它带着实测证据走，而不是只丢一句「起不来」——复验用的就是这个结论
    if (!health.ok) run.lastErrors = health.evidence
    run.review = {
      comments: [
        ...(health.ok
          ? []
          : [
              {
                path: health.entry ?? path,
                risk: `工程完整性没过：这份产物起不来。${health.evidence.join('；')}`,
                mustFix: true,
              },
            ]),
        {
          path,
          risk:
            diff.diff && diff.diff !== '(与 HEAD 无差异)'
              ? extra.length
                ? `这轮交付改的是 ${run.patch?.files.join(', ') || path}。工作区里还有其它改动：${extra.slice(0, 6).join(', ')}${extra.length > 6 ? '…' : ''}。`
                : `对照工作区 diff：${path}。`
              : '工作区相对 HEAD 没有 diff。若文件已提交，先看 git status。',
          mustFix: false,
        },
      ],
    }
    remember(
      run,
      text || '对照仓库 diff 出评审',
      health.ok
        ? `意见指向 ${path}。人点放行或打回。`
        : `按实测：这份产物起不来（${health.evidence.join('；')}）。只能打回研发，或带风险放行并写理由。`,
    )
    saveRun(run)
    send({ type: 'artifact', name: 'review', payload: run.review })
    send({ type: 'role_done', role: 'review' })
    send({ type: 'text_delta', delta: run.talk[run.talk.length - 1]?.content ?? '' })
    send({ type: 'done' })
    return
  }

  if (run.phase === 'testing') {
    requireActor(run, actor, ['qa'])
    const cwd = requireWorkspace(run)
    send({ type: 'meta', mode: 'mock' })
    send({ type: 'role_start', role: 'qa' })
    const items = []
    const commandLogs = []
    for (const ac of run.prd.acceptance) {
      if (!ac.checkedByPm) continue
      if (ac.kind === 'auto' && ac.command) {
        const log = runAllowedCommand(ac.command, cwd, {
          runId: run.id,
          phase: 'testing',
          userId: currentUserId(),
        })
        commandLogs.push(log)
        // 报告里写清命令是在哪跑的：容器模式下这是「隔离生效」的凭据，
        // 比在文档里声称有用。启动失败（exitCode 1 且没输出）会带 launchError。
        const where = log.sandbox === 'docker' ? '沙箱容器' : '宿主机'
        items.push({
          acId: ac.id,
          result: log.exitCode === 0 ? 'pass' : 'fail',
          detail: `在${where}的 ${cwd} 跑 ${log.command}，exit=${log.exitCode}${log.launchError ? '（没能启动）' : ''}\n${log.excerpt}`,
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
    remember(
      run,
      text || '在选中的仓库跑验收',
      commandLogs.length
        ? `已在 ${cwd} 跑 ${commandLogs.map((l) => `${l.command}→${l.exitCode}`).join('，')}。看右边输出再签字。`
        : '没有已勾的自动验收。勾过的人工项需要你自己看。',
    )
    saveRun(run)
    send({ type: 'artifact', name: 'test_report', payload: run.test_report })
    send({ type: 'role_done', role: 'qa' })
    send({ type: 'text_delta', delta: run.talk[run.talk.length - 1]?.content ?? '' })
    send({ type: 'done' })
    return
  }

  send({
    type: 'gate_blocked',
    gate: run.phase,
    message: '这条已经签过字。要再来一回，点「新开一条需求」。',
  })
  send({ type: 'done' })
}

export { assertRoleTool, assertWritablePath }
