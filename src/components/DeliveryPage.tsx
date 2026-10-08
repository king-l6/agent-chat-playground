import { useCallback, useEffect, useRef, useState } from 'react'
import {
  activateDelivery,
  bindDeliveryWorkspace,
  createDelivery,
  deleteDelivery,
  fetchDelivery,
  fetchDeliveryRuns,
  postGate,
  savePrd,
  saveSeat,
  streamDeliveryTurn,
  type DeliveryRun,
  type Phase,
  type RunSummary,
  type Seat,
  type TalkTrace,
} from '../api/delivery'
import { pickWorkspaceNative } from '../api/chat'
import type { ToolCallView } from '../types'
import { UnifiedDiff } from './CodeDiff'
import DeliveryPreview from './DeliveryPreview'
import './DeliveryPage.css'

function stepTitle(name: string) {
  if (name === 'workspace_read') return '读文件'
  if (name === 'workspace_write') return '写文件'
  if (name === 'write_patch') return '模型出补丁'
  if (name === 'repair') return '对失败的再改'
  if (name === 'scaffold_write') return '补齐工程文件'
  return name
}

function folderName(root: string) {
  const parts = root.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || root
}

const PHASE_LABEL: Record<Phase, string> = {
  drafting: '起草中',
  developing: '研发中',
  blocked_on_pm: '等产品',
  reviewing: '评审中',
  testing: '测试中',
  signed: '已签字',
}

function nowCopy(run: DeliveryRun) {
  if (run.seat === 'pm' && run.phase === 'drafting') {
    return { title: '产品在写需求', body: '中间说话，右边出文档。勾过验收再交给研发。' }
  }
  if (run.seat === 'pm' && run.phase === 'blocked_on_pm') {
    return { title: '研发把问题打回来了', body: '右边这份还冻着。要改先撤回；认可原文就维持再转。' }
  }
  if (run.seat === 'pm') {
    return { title: '这份已经交给研发', body: '中间还能追问新功能；改右边这份，先撤回。' }
  }
  if (run.phase === 'developing') {
    return { title: '研发对着这条需求的仓库改', body: '中间继续说，右边看改动。步骤跑完会折起来。' }
  }
  if (run.phase === 'reviewing') {
    return { title: '对照改动做评审', body: '中间是对话，右边是这轮改动。放行后才测。' }
  }
  if (run.phase === 'testing') {
    return { title: '按已勾验收来测', body: '中间是对话，右边是跑出来的结果。' }
  }
  return { title: '测试已签字', body: '这条结束了，留在左边「已签字」里。要再来一回，开一条新需求。' }
}

function turnLabel(run: DeliveryRun) {
  if (run.seat === 'pm' && run.phase === 'drafting') {
    return run.prd.title ? '让 AI 再改一版' : '让 AI 起草'
  }
  if (run.seat === 'pm' && run.phase === 'blocked_on_pm') return '先撤回或维持原文'
  if (run.seat === 'pm') return '开新需求并起草'
  if (run.seat === 'dev' && run.phase === 'developing') {
    return run.lastErrors?.length ? '按这句再改' : '让 AI 改一版'
  }
  if (run.seat === 'qa' && run.phase === 'reviewing') return '对照改动出意见'
  if (run.seat === 'qa' && run.phase === 'testing') return '跑已勾的验收'
  return '现在不能让 AI 动手'
}

function placeholder(run: DeliveryRun) {
  if (run.seat === 'pm') return '说你想做的功能，或接着改'
  if (run.seat === 'dev') return '还要改就说，比如「先把页面和接口补上」'
  if (run.phase === 'reviewing') return '这轮改动你还想盯什么'
  if (run.phase === 'testing') return '还想跑哪条已勾验收'
  return '换一个身份，或先过闸'
}

/**
 * 不打字直接点按钮时，这句话会当成用户气泡发给后端。
 * 别再统一塞「按右边这份需求做」——点几次就复读几条，看着像空转；
 * 按身份/阶段说人话，研发那句顺带把模型往「一次做完整」推。
 */
function defaultTurnMessage(run: DeliveryRun) {
  if (run.seat === 'dev' && run.phase === 'developing') {
    return run.lastErrors?.length ? '把上一轮没写成的补上' : '按这份需求把功能一次实现完整'
  }
  if (run.seat === 'qa' && run.phase === 'reviewing') return '对照这轮改动出评审意见'
  if (run.seat === 'qa' && run.phase === 'testing') return '按已勾的验收在仓库里跑一遍'
  return ''
}

function workDiff(run: DeliveryRun) {
  if (run.patch?.diff && run.patch.diff !== '(与 HEAD 无差异)') return run.patch.diff
  if (run.workspace?.diff && run.workspace.diff !== '(与 HEAD 无差异)') return run.workspace.diff
  return ''
}

type TimelineRole = 'pm' | 'dev' | 'review' | 'qa'
type TimelineItem = { role: TimelineRole; status: 'pending' | 'active' | 'done' }

const TIMELINE_ROLES: TimelineRole[] = ['pm', 'dev', 'review', 'qa']

function roleName(role: TimelineRole) {
  if (role === 'pm') return '产品'
  if (role === 'dev') return '研发'
  if (role === 'review') return '评审(测)'
  return '测试签字'
}

function timelineFromPhase(phase: DeliveryRun['phase']): TimelineItem[] {
  const activeIndex =
    phase === 'drafting' || phase === 'blocked_on_pm'
      ? 0
      : phase === 'developing'
        ? 1
        : phase === 'reviewing'
          ? 2
          : phase === 'testing'
            ? 3
            : 4
  return TIMELINE_ROLES.map((role, i) => ({
    role,
    status: activeIndex >= 4 || i < activeIndex ? 'done' : i === activeIndex ? 'active' : 'pending',
  }))
}

function markRole(items: TimelineItem[], role: TimelineRole, status: 'active' | 'done'): TimelineItem[] {
  const idx = TIMELINE_ROLES.indexOf(role)
  return items.map((item, i) => {
    if (item.role === role) return { ...item, status }
    if (status === 'active' && i < idx) return { ...item, status: 'done' }
    return item
  })
}

function isTimelineRole(role: string): role is TimelineRole {
  return (TIMELINE_ROLES as string[]).includes(role)
}

function processLabel(steps: ToolCallView[], live?: string) {
  const reads = steps.filter((s) => s.name === 'workspace_read').length
  const writes = steps.filter((s) => s.name === 'workspace_write' && s.status === 'done').length
  const fails = steps.filter((s) => s.status === 'error').length
  const bits = []
  if (reads) bits.push(`读 ${reads}`)
  if (writes) bits.push(`写 ${writes}`)
  if (fails) bits.push(`失败 ${fails}`)
  if (!bits.length && live) bits.push('思考')
  return bits.length ? `中间步骤 · ${bits.join(' · ')}` : '中间步骤'
}

function ProcessFold({
  active,
  steps,
  live,
}: {
  active: boolean
  steps: ToolCallView[]
  live?: string
}) {
  if (!steps.length && !live) return null
  const body = (
    <>
      {steps.map((step) => (
        <div
          key={step.id}
          className={
            step.status === 'running'
              ? 'work__step work__step--run'
              : step.status === 'error'
                ? 'work__step work__step--err'
                : 'work__step'
          }
        >
          <strong>
            {step.status === 'running' ? '…' : step.status === 'error' ? '✗' : '✓'} {stepTitle(step.name)}
          </strong>
          <span>{step.result || step.error || step.arguments}</span>
        </div>
      ))}
      {live ? <pre className="desk__think">{live}</pre> : null}
    </>
  )
  if (active) {
    return (
      <div className="desk__process desk__process--on">
        <p className="desk__process-head">正在执行</p>
        {body}
      </div>
    )
  }
  return (
    <details className="desk__process">
      <summary>{processLabel(steps, live)}</summary>
      {body}
    </details>
  )
}

/** tsc / lint / eval 的原始输出：默认折起来，别整段倒在产物里挡住结论 */
function CommandLogs({ logs }: { logs: NonNullable<DeliveryRun['test_report']>['commandLogs'] }) {
  if (!logs.length) return null
  const failed = logs.filter((log) => log.exitCode !== 0).length
  return (
    <details className="cmds" open={failed > 0}>
      <summary>
        命令输出 · {logs.length} 条{failed ? ` · ${failed} 条失败` : ''}
      </summary>
      {logs.map((log) => (
        <div key={log.command} className={log.exitCode === 0 ? 'cmd' : 'cmd cmd--bad'}>
          <div className="cmd__head">
            <code>{log.command}</code>
            <span>{log.exitCode === 0 ? '通过' : `退出 ${log.exitCode}`}</span>
          </div>
          <pre className="cmd__out">{log.excerpt}</pre>
        </div>
      ))}
    </details>
  )
}

function toSteps(trace?: TalkTrace): ToolCallView[] {
  return (trace?.steps ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    arguments: s.arguments,
    status: s.status,
    result: s.result,
    error: s.error,
  }))
}

export function DeliveryPage() {
  const [run, setRun] = useState<DeliveryRun | null>(null)
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [reason, setReason] = useState('')
  const [questions, setQuestions] = useState('')
  const [prompt, setPrompt] = useState('')
  const [steps, setSteps] = useState<ToolCallView[]>([])
  const [live, setLive] = useState('')
  const [waitSec, setWaitSec] = useState(0)
  const [timeline, setTimeline] = useState<TimelineItem[] | null>(null)
  const [stickyDiff, setStickyDiff] = useState('')
  /** 每回合「产物写完了」加一，预览面板拿它当启动信号；0 = 还没跑过，不显示 */
  const [previewKey, setPreviewKey] = useState(0)
  const [gateNote, setGateNote] = useState<{ gate: string; message: string } | null>(null)
  const threadRef = useRef<HTMLDivElement | null>(null)
  const liveBuf = useRef('')
  const livePaint = useRef(0)

  const reload = useCallback(async () => {
    const [next, list] = await Promise.all([fetchDelivery(), fetchDeliveryRuns()])
    setRun(next)
    setRuns(list.runs)
    const diff = workDiff(next)
    if (diff) setStickyDiff(diff)
    return next
  }, [])

  useEffect(() => {
    reload().catch((err) => setError(err instanceof Error ? err.message : String(err)))
    const off = window.desktop?.onWorkspaceChange(() => {
      void reload()
    })
    const onCustom = () => {
      void reload()
    }
    window.addEventListener('workspace-changed', onCustom)
    return () => {
      off?.()
      window.removeEventListener('workspace-changed', onCustom)
    }
  }, [reload])

  useEffect(() => {
    const el = threadRef.current
    if (!el) return
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight
    if (gap < 100) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [run?.talk?.length, busy, steps.length])

  useEffect(() => {
    if (!busy) {
      setWaitSec(0)
      return
    }
    const timer = window.setInterval(() => setWaitSec((n) => n + 1), 1000)
    return () => window.clearInterval(timer)
  }, [busy])

  /** 切需求：清掉上一条的临时态（步骤/差异/提示），再拉新的一条 */
  function resetEphemeral() {
    setPrompt('')
    setSteps([])
    setLive('')
    setStickyDiff('')
    setPreviewKey(0)
    setGateNote(null)
    setTimeline(null)
    setError('')
    setReason('')
    setQuestions('')
  }

  async function onSwitch(id: string) {
    if (!run || id === run.id || busy) return
    resetEphemeral()
    try {
      setRun(await activateDelivery(id))
      setRuns((await fetchDeliveryRuns()).runs)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function onNewRun() {
    if (busy) return
    resetEphemeral()
    try {
      const fresh = await createDelivery()
      setRun(fresh)
      setRuns((await fetchDeliveryRuns()).runs)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function onDeleteRun(id: string, title: string) {
    if (busy) return
    if (!window.confirm(`删掉「${title || '未命名需求'}」？这条的文档、对话、产物都会没。`)) return
    resetEphemeral()
    try {
      setRun(await deleteDelivery(id))
      setRuns((await fetchDeliveryRuns()).runs)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function onPickRepo() {
    if (!run) return
    setError('')
    try {
      // 统一走服务端弹的系统选择器：桌面壳那个 pickWorkspace 会顺手改全局工作区，
      // 用它给单条需求绑仓库会把全局也带跑偏。
      const dir = await pickWorkspaceNative('给这条需求选一个仓库')
      if (dir) setRun(await bindDeliveryWorkspace(run.id, dir))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function followGlobal() {
    if (!run) return
    setError('')
    try {
      setRun(await bindDeliveryWorkspace(run.id, undefined))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function onSeat(seat: Seat) {
    if (!run) return
    setError('')
    try {
      setRun(await saveSeat(seat, run.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function onGate(action: string, extra?: { reason?: string; questions?: string[] }) {
    if (!run) return
    setError('')
    try {
      setRun(await postGate(run.seat, action, { ...extra, id: run.id }))
      setRuns((await fetchDeliveryRuns()).runs)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function persistChecks(acceptance: DeliveryRun['prd']['acceptance']) {
    if (!run) return
    setRun(await savePrd(run.seat, { acceptance }, run.id))
  }

  async function onTurn() {
    if (!run) return
    if (run.seat === 'pm' && !prompt.trim()) {
      setError('先写你想做什么。')
      return
    }
    if (run.seat === 'pm' && run.phase === 'blocked_on_pm') {
      setError('要改这份先「撤回确认」；要另写一个功能点，左边「新开一条需求」。')
      return
    }
    const needsRepo =
      (run.seat === 'dev' && run.phase === 'developing') ||
      (run.seat === 'qa' && (run.phase === 'reviewing' || run.phase === 'testing'))
    if (needsRepo && !run.workspace?.root) {
      setError('先给这条需求绑一个仓库，再让 AI 动手。')
      return
    }
    const message = prompt.trim() || (run.seat === 'pm' ? '' : defaultTurnMessage(run))
    if (!message) {
      setError('先写你想做什么。')
      return
    }
    setBusy(true)
    setError('')
    setGateNote(null)
    setPrompt('')
    setWaitSec(0)
    setTimeline(timelineFromPhase(run.phase))
    liveBuf.current = ''
    if (livePaint.current) cancelAnimationFrame(livePaint.current)
    livePaint.current = 0
    setSteps([
      {
        id: 'local-wait',
        name: 'write_patch',
        arguments: '请求已发出，等网关首包…',
        status: 'running',
      },
    ])
    setLive('请求已发出，模型出字后这里会隔一会儿刷新一次。')
    let actor = run.seat
    let base = run
    // 产品在一条已经流转过的需求上再动手 = 另起一条，不再覆盖原来那条
    if (run.seat === 'pm' && run.phase !== 'drafting') {
      try {
        base = await createDelivery()
        actor = 'pm'
        setRuns((await fetchDeliveryRuns()).runs)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setBusy(false)
        setSteps([])
        setLive('')
        setTimeline(null)
        return
      }
    }
    setRun({
      ...base,
      talk: [...(base.talk ?? []), { role: 'user', content: message }],
    })
    try {
      await streamDeliveryTurn({
        actor,
        message,
        id: base.id,
        onEvent: (event) => {
          if (event.type === 'text_delta') {
            if (!event.delta || event.delta === '…') return
            liveBuf.current = `${liveBuf.current}${event.delta}`.slice(-4000)
            if (livePaint.current) return
            livePaint.current = requestAnimationFrame(() => {
              livePaint.current = 0
              setLive(liveBuf.current)
            })
          }
          if (event.type === 'tool_start') {
            setSteps((prev) => [
              ...prev.filter((s) => s.id !== event.id),
              {
                id: event.id,
                name: event.name,
                arguments: event.arguments,
                status: 'running',
              },
            ])
          }
          if (event.type === 'tool_result') {
            setSteps((prev) =>
              prev.map((s) =>
                s.id === event.id ? { ...s, status: 'done', result: event.result } : s,
              ),
            )
          }
          if (event.type === 'tool_error') {
            setSteps((prev) =>
              prev.map((s) =>
                s.id === event.id ? { ...s, status: 'error', error: event.error } : s,
              ),
            )
          }
          if (event.type === 'role_start' && isTimelineRole(event.role)) {
            const role = event.role
            setTimeline((prev) => markRole(prev ?? timelineFromPhase(base.phase), role, 'active'))
          }
          if (event.type === 'role_done' && isTimelineRole(event.role)) {
            const role = event.role
            setTimeline((prev) => markRole(prev ?? timelineFromPhase(base.phase), role, 'done'))
          }
          if (event.type === 'artifact') {
            setRun((prev) => {
              if (!prev) return prev
              if (event.name === 'prd') return { ...prev, prd: event.payload as DeliveryRun['prd'] }
              if (event.name === 'patch') return { ...prev, patch: event.payload as DeliveryRun['patch'] }
              if (event.name === 'review') return { ...prev, review: event.payload as DeliveryRun['review'] }
              if (event.name === 'test_report') {
                return { ...prev, test_report: event.payload as DeliveryRun['test_report'] }
              }
              return prev
            })
            if (event.name === 'patch') {
              const patch = event.payload as DeliveryRun['patch']
              if (patch?.diff && patch.diff !== '(与 HEAD 无差异)') setStickyDiff(patch.diff)
              // 一回合恰好一次：挂在 artifact 上而不是 workspace_write（那是一次写一次，会连开十几次）
              setPreviewKey((k) => k + 1)
            }
          }
          if (event.type === 'tool_result' && event.name === 'workspace_write') {
            void fetchDelivery(base.id).then((next) => {
              setRun(next)
              const diff = workDiff(next)
              if (diff) setStickyDiff(diff)
            })
          }
          if (event.type === 'gate_blocked') setGateNote({ gate: event.gate, message: event.message })
          if (event.type === 'error') setError(event.message)
        },
      })
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      await reload()
    } finally {
      setBusy(false)
      setSteps([])
      setLive('')
      setTimeline(null)
    }
  }

  if (!run) {
    return (
      <div className="desk">
        {error && <div className="desk__err">{error}</div>}
        <p className="desk__muted">在打开工作台…</p>
      </div>
    )
  }

  const status = nowCopy(run)
  const frozen = run.prd.confirmed
  const pm = run.seat === 'pm'
  const dev = run.seat === 'dev'
  const qa = run.seat === 'qa'
  const canTalk =
    turnLabel(run) !== '现在不能让 AI 动手' && turnLabel(run) !== '先撤回或维持原文'
  const root = run.workspace?.root
  const boundRoot = run.workspaceRoot || ''
  const talk = run.talk ?? []
  const checked = run.prd.acceptance.some((a) => a.checkedByPm)
  const needsRepo =
    (dev && run.phase === 'developing') ||
    (qa && (run.phase === 'reviewing' || run.phase === 'testing'))
  const diff = stickyDiff || workDiff(run)
  const shownTimeline = timeline ?? timelineFromPhase(run.phase)

  // 提示合并到一个槽位，并按原文去重——同一句「已过期」以前会显示两遍
  const notices: Array<{ tone: 'gate' | 'err' | 'warn'; text: string }> = []
  if (gateNote) notices.push({ tone: 'gate', text: gateNote.message })
  if (error) notices.push({ tone: 'err', text: error })
  const staleCovered = Boolean(gateNote?.message.includes('过期') || gateNote?.message.includes('撤回'))
  if (run.stale && !staleCovered) {
    notices.push({ tone: 'warn', text: '这次撤回过，这条 run 已过期。重新确认后研发才能再改仓库。' })
  }
  if (needsRepo && !boundRoot && !root) {
    notices.push({ tone: 'warn', text: '这条需求还没绑仓库。点右上「选仓库」再让 AI 动手。' })
  }
  const shownNotices = notices.filter(
    (n, i) => notices.findIndex((m) => m.text === n.text) === i,
  )

  const composer = (
    <form
      className="desk__composer"
      onSubmit={(e) => {
        e.preventDefault()
        void onTurn()
      }}
    >
      <textarea
        rows={3}
        value={prompt}
        placeholder={placeholder(run)}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void onTurn()
          }
        }}
      />
      <button type="submit" disabled={busy || !canTalk || (needsRepo && !root)}>
        {busy ? `执行中 ${waitSec}s` : turnLabel(run)}
      </button>
    </form>
  )

  /**
   * 预览的启动信号。
   * `previewKey` 只在本轮 SSE 收到 patch 时递增——它管「同一回合里再跑一次增量同步」。
   * 但刷新页面、或切走再切回来时，patch 早就落盘了、SSE 不会重放，
   * 光看 previewKey 会让预览永远不出现（产物明明在磁盘上）。所以「已经有产物」也算一次启动。
   * 0 = 确实还没有任何产物，面板不显示。
   */
  const previewTrigger = Math.max(previewKey, run.patch?.files.length ? 1 : 0)

  const documentPane = (
    <section className="sheet" aria-label="结果">
      <header>
        <h2>{run.prd.title || '还没有产物'}</h2>
        <p>{frozen ? '已交给研发，正文不能改。要改先撤回。' : '右边是文档和改动，左边继续说。'}</p>
      </header>
      {/* 研发写完文件就自动跑起来。key 用 run.id：换一条需求就换一个容器视图 */}
      {previewTrigger > 0 ? (
        <DeliveryPreview key={run.id} runId={run.id} trigger={previewTrigger} />
      ) : null}
      {run.prd.body ? (
        <pre className="sheet__body">{run.prd.body}</pre>
      ) : (
        <p className="desk__muted">先在中间说你要做什么。</p>
      )}
      {run.prd.acceptance.length > 0 && (
        <fieldset className="sheet__acs">
          <legend>{pm ? '验收 · 至少勾一条才能交给研发' : '验收'}</legend>
          {run.prd.acceptance.map((ac, idx) => (
            <label key={ac.id}>
              <input
                type="checkbox"
                disabled={!pm || frozen}
                checked={ac.checkedByPm}
                onChange={(e) => {
                  const acceptance = run.prd.acceptance.map((item, i) =>
                    i === idx ? { ...item, checkedByPm: e.target.checked } : item,
                  )
                  setRun({ ...run, prd: { ...run.prd, acceptance } })
                  void persistChecks(acceptance)
                }}
              />
              <span>{ac.text}</span>
            </label>
          ))}
        </fieldset>
      )}
      {run.questions.length > 0 && (
        <div className="sheet__q">
          <strong>研发问了</strong>
          <ul>
            {run.questions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </div>
      )}
      {dev && run.lastErrors && run.lastErrors.length > 0 && (
        <div className="work__fails">
          <strong>还没写成 · {run.lastErrors.length}</strong>
          <ul>
            {run.lastErrors.map((err) => (
              <li key={err}>{err}</li>
            ))}
          </ul>
        </div>
      )}
      {diff ? (
        <div className="desk__diff-panel">
          <div className="desk__diff-head">
            文件变更
            {diff.length > 8000 ? <span> · 预览截断</span> : null}
            {run.patch?.scaffold?.written.length ? (
              <span title={run.patch.scaffold.written.join('\n')}>
                {' '}
                · 补齐了 {run.patch.scaffold.written.map((f) => f.split(/[\\/]/).pop()).join('、')}
              </span>
            ) : null}
          </div>
          <UnifiedDiff text={diff.slice(0, 8000)} height={360} />
        </div>
      ) : null}
      {run.review?.comments.map((c) => (
        <p key={c.path}>
          {c.mustFix ? <strong>【必须改】</strong> : null}
          {c.path}：{c.risk}
        </p>
      ))}
      <CommandLogs logs={run.test_report?.commandLogs ?? []} />
      {run.release_notes ? <pre>{run.release_notes.text}</pre> : null}
      <div className="sheet__gates">
        {pm && run.phase === 'drafting' && (
          <button type="button" disabled={!checked} onClick={() => void onGate('confirm')}>
            交给研发
          </button>
        )}
        {pm && frozen && (
          <button type="button" className="sheet__ghost" onClick={() => void onGate('withdraw')}>
            撤回确认
          </button>
        )}
        {pm && run.phase === 'blocked_on_pm' && (
          <button type="button" onClick={() => void onGate('keep_prd')}>
            维持原文档再转
          </button>
        )}
        {dev && run.phase === 'developing' && (
          <>
            <button type="button" onClick={() => void onGate('dev_done')}>
              开发完成
            </button>
            <button
              type="button"
              className="sheet__ghost"
              onClick={() => void onGate('bounce_pm', { questions: questions.split('\n') })}
            >
              打回产品
            </button>
            <textarea
              rows={2}
              placeholder="打回时写下哪里做不了"
              value={questions}
              onChange={(e) => setQuestions(e.target.value)}
            />
          </>
        )}
        {qa && run.phase === 'reviewing' && (
          <>
            <button type="button" onClick={() => void onGate('review_pass')}>
              放行去测试
            </button>
            <button type="button" className="sheet__ghost" onClick={() => void onGate('review_bounce')}>
              打回研发
            </button>
            <button type="button" className="sheet__ghost" onClick={() => void onGate('review_risk', { reason })}>
              带风险放行
            </button>
          </>
        )}
        {qa && run.phase === 'testing' && (
          <>
            <button type="button" onClick={() => void onGate('test_sign')}>
              测试签字
            </button>
            <button type="button" className="sheet__ghost" onClick={() => void onGate('test_bounce')}>
              打回研发
            </button>
            <button type="button" className="sheet__ghost" onClick={() => void onGate('test_risk', { reason })}>
              带风险签字
            </button>
          </>
        )}
        {qa && (run.phase === 'reviewing' || run.phase === 'testing') && (
          <input placeholder="带风险必须写理由" value={reason} onChange={(e) => setReason(e.target.value)} />
        )}
      </div>
    </section>
  )

  const talkPane = (
    <section className="desk__talk" aria-label="任务对话">
      <div className="desk__thread" ref={threadRef}>
        {talk.length === 0 && (
          <p className="desk__empty">
            {pm
              ? '写下你要做的功能。点「让 AI 起草」，右边会变成文档。'
              : '中间跟 AI 说话，右边看文档和改动。'}
          </p>
        )}
        {talk.map((turn, i) => (
          <article key={`${turn.role}-${i}`} className={`desk__bubble desk__bubble--${turn.role}`}>
            <span>{turn.role === 'user' ? '你' : 'AI'}</span>
            {turn.role === 'assistant' && turn.trace && (
              <ProcessFold active={false} steps={toSteps(turn.trace)} live={turn.trace.live} />
            )}
            <p>{turn.content}</p>
          </article>
        ))}
        {busy && <ProcessFold active steps={steps} live={live} />}
      </div>
      {composer}
    </section>
  )

  return (
    <div className="desk">
      <header className="rail">
        <div className="rail__top">
          <div className="rail__brand">
            <h1>交付工作台</h1>
            <span>一条需求一条线，各自绑仓库；AI 写产物，闸门由你把</span>
          </div>
          <div className="rail__seats" role="tablist" aria-label="当前身份">
            {(['pm', 'dev', 'qa'] as const).map((seat) => (
              <button
                key={seat}
                type="button"
                role="tab"
                aria-selected={run.seat === seat}
                className={run.seat === seat ? 'rail__seat rail__seat--on' : 'rail__seat'}
                onClick={() => void onSeat(seat)}
              >
                {seat === 'pm' ? '产品' : seat === 'dev' ? '研发' : '测试'}
              </button>
            ))}
          </div>
        </div>
        <ol className="rail__track" aria-label="交付进度">
          {shownTimeline.map((item, i) => (
            <li key={item.role} className={`rail__stage rail__stage--${item.status}`}>
              <span className="rail__dot">{item.status === 'done' ? '✓' : i + 1}</span>
              <span className="rail__stage-name">{roleName(item.role)}</span>
            </li>
          ))}
        </ol>
        <div className="rail__foot">
          <div className="rail__now">
            <strong>{status.title}</strong>
            <span>{status.body}</span>
          </div>
          <div className="repo">
            <span className="repo__label">仓库</span>
            <button
              type="button"
              className={boundRoot ? 'repo__btn repo__btn--own' : 'repo__btn'}
              title={boundRoot || root || ''}
              onClick={() => void onPickRepo()}
            >
              {boundRoot
                ? folderName(boundRoot)
                : root
                  ? `跟随全局 · ${folderName(root)}`
                  : '未选 · 点这里选'}
            </button>
            {boundRoot ? (
              <button type="button" className="repo__clear" onClick={() => void followGlobal()}>
                跟随全局
              </button>
            ) : null}
          </div>
        </div>
      </header>

      {shownNotices.map((notice) => (
        <div
          key={notice.text}
          className={
            notice.tone === 'gate' ? 'desk__gate' : notice.tone === 'err' ? 'desk__err' : 'desk__warn'
          }
        >
          {notice.text}
        </div>
      ))}

      <div className="desk__cols">
        <aside className="demand-pane">
          <DemandList
            runs={runs}
            activeId={run.id}
            busy={busy}
            onNew={() => void onNewRun()}
            onSwitch={(id) => void onSwitch(id)}
            onDelete={(id, title) => void onDeleteRun(id, title)}
          />
        </aside>
        {talkPane}
        {documentPane}
      </div>
    </div>
  )
}

function DemandList({
  runs,
  activeId,
  busy,
  onNew,
  onSwitch,
  onDelete,
}: {
  runs: RunSummary[]
  activeId: string
  busy: boolean
  onNew: () => void
  onSwitch: (id: string) => void
  onDelete: (id: string, title: string) => void
}) {
  const active = runs.filter((r) => !r.signed)
  const archived = runs.filter((r) => r.signed)
  return (
    <>
      <div className="demand-pane__head">
        <span>需求</span>
        <button type="button" className="demand-pane__new" disabled={busy} onClick={onNew}>
          新开
        </button>
      </div>
      <div className="demand-pane__scroll">
        <p className="demand-group">进行中 · {active.length}</p>
        {active.length === 0 && <p className="demand-pane__empty">没有进行中的。点「新开」起一条。</p>}
        {active.map((item) => (
          <DemandRow
            key={item.id}
            item={item}
            on={item.id === activeId}
            busy={busy}
            onSwitch={onSwitch}
            onDelete={onDelete}
          />
        ))}
        {archived.length > 0 && (
          <>
            <p className="demand-group">已签字 · {archived.length}</p>
            {archived.map((item) => (
              <DemandRow
                key={item.id}
                item={item}
                on={item.id === activeId}
                busy={busy}
                onSwitch={onSwitch}
                onDelete={onDelete}
              />
            ))}
          </>
        )}
      </div>
    </>
  )
}

function DemandRow({
  item,
  on,
  busy,
  onSwitch,
  onDelete,
}: {
  item: RunSummary
  on: boolean
  busy: boolean
  onSwitch: (id: string) => void
  onDelete: (id: string, title: string) => void
}) {
  const title = item.title || '未命名需求'
  return (
    <div className={on ? 'demand demand--on' : 'demand'}>
      <button
        type="button"
        className="demand__pick"
        disabled={busy}
        aria-current={on}
        onClick={() => onSwitch(item.id)}
      >
        <span className="demand__title">{title}</span>
        <span className="demand__meta">
          <span className={`demand__phase demand__phase--${item.phase}`}>{PHASE_LABEL[item.phase]}</span>
          {item.workspaceRoot ? (
            <span className="demand__repo">{folderName(item.workspaceRoot)}</span>
          ) : null}
        </span>
      </button>
      <button
        type="button"
        className="demand__del"
        disabled={busy}
        aria-label={`删掉 ${title}`}
        title="删掉这条"
        onClick={() => onDelete(item.id, title)}
      >
        ×
      </button>
    </div>
  )
}
