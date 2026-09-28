import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchDelivery,
  postGate,
  resetDelivery,
  savePrd,
  saveSeat,
  streamDeliveryTurn,
  type DeliveryRun,
  type Seat,
  type TalkTrace,
} from '../api/delivery'
import type { ToolCallView } from '../types'
import './DeliveryPage.css'

function stepTitle(name: string) {
  if (name === 'workspace_read') return '读文件'
  if (name === 'workspace_write') return '写文件'
  if (name === 'write_patch') return '模型出补丁'
  if (name === 'repair') return '对失败的再改'
  return name
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
    return { title: '研发对着选中的仓库改', body: '中间继续说，右边看改动。步骤跑完会折起来。' }
  }
  if (run.phase === 'reviewing') {
    return { title: '对照改动做评审', body: '中间是对话，右边是这轮改动。放行后才测。' }
  }
  if (run.phase === 'testing') {
    return { title: '按已勾验收来测', body: '中间是对话，右边是跑出来的结果。' }
  }
  return { title: '测试已签字', body: '这条结束了。要再来一回，开一条新需求。' }
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

function workDiff(run: DeliveryRun) {
  if (run.patch?.diff && run.patch.diff !== '(与 HEAD 无差异)') return run.patch.diff
  if (run.workspace?.diff && run.workspace.diff !== '(与 HEAD 无差异)') return run.workspace.diff
  return ''
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
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [reason, setReason] = useState('')
  const [questions, setQuestions] = useState('')
  const [prompt, setPrompt] = useState('')
  const [steps, setSteps] = useState<ToolCallView[]>([])
  const [live, setLive] = useState('')
  const [waitSec, setWaitSec] = useState(0)
  const threadRef = useRef<HTMLDivElement | null>(null)
  const liveBuf = useRef('')
  const livePaint = useRef(0)

  const reload = useCallback(async () => {
    setRun(await fetchDelivery())
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
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'smooth' })
  }, [run?.talk?.length, busy, steps.length])

  useEffect(() => {
    if (!busy) {
      setWaitSec(0)
      return
    }
    const timer = window.setInterval(() => setWaitSec((n) => n + 1), 1000)
    return () => window.clearInterval(timer)
  }, [busy])

  async function onSeat(seat: Seat) {
    setError('')
    try {
      setRun(await saveSeat(seat))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function onGate(action: string, extra?: { reason?: string; questions?: string[] }) {
    if (!run) return
    setError('')
    try {
      setRun(await postGate(run.seat, action, extra))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function onReset() {
    setError('')
    setPrompt('')
    setRun(await resetDelivery())
  }

  async function persistChecks(acceptance: DeliveryRun['prd']['acceptance']) {
    if (!run) return
    setRun(await savePrd(run.seat, { acceptance }))
  }

  async function onTurn() {
    if (!run) return
    if (run.seat === 'pm' && !prompt.trim()) {
      setError('先写你想做什么。')
      return
    }
    if (run.seat === 'pm' && run.phase === 'blocked_on_pm') {
      setError('要改这份先「撤回确认」；要另写一个功能点「新开一条需求」。')
      return
    }
    const needsRepo =
      (run.seat === 'dev' && run.phase === 'developing') ||
      (run.seat === 'qa' && (run.phase === 'reviewing' || run.phase === 'testing'))
    if (needsRepo && !run.workspace?.root) {
      setError('先在上面工作区条选一个目录。')
      return
    }
    const message = prompt.trim() || (run.seat === 'pm' ? '' : '按右边这份需求做')
    if (!message) {
      setError('先写你想做什么。')
      return
    }
    setBusy(true)
    setError('')
    setPrompt('')
    setWaitSec(0)
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
    if (run.seat === 'pm' && run.phase !== 'drafting') {
      base = await resetDelivery()
      actor = 'pm'
    }
    setRun({
      ...base,
      talk: [...(base.talk ?? []), { role: 'user', content: message }],
    })
    try {
      await streamDeliveryTurn({
        actor,
        message,
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
          if (event.type === 'artifact' && event.name === 'patch') {
            setRun((prev) =>
              prev ? { ...prev, patch: event.payload as DeliveryRun['patch'] } : prev,
            )
          }
          if (event.type === 'gate_blocked') setError(event.message)
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
  const talk = run.talk ?? []
  const checked = run.prd.acceptance.some((a) => a.checkedByPm)
  const needsRepo =
    (dev && run.phase === 'developing') ||
    (qa && (run.phase === 'reviewing' || run.phase === 'testing'))
  const diff = workDiff(run)

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

  const documentPane = (
    <section className="sheet" aria-label="结果">
      <header>
        <h2>{run.prd.title || '还没有产物'}</h2>
        <p>{frozen ? '已交给研发，正文不能改。要改先撤回。' : '右边是文档和改动，左边继续说。'}</p>
      </header>
      {run.prd.body ? <pre className="sheet__body">{run.prd.body}</pre> : <p className="desk__muted">先在中间说你要做什么。</p>}
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
          <strong>还没写成</strong>
          {run.lastErrors.map((err) => (
            <p key={err}>{err}</p>
          ))}
        </div>
      )}
      {diff ? (
        <details className="desk__process">
          <summary>文件变更</summary>
          <pre>{diff.slice(0, 2500)}</pre>
        </details>
      ) : null}
      {run.review?.comments.map((c) => (
        <p key={c.path}>
          {c.path}：{c.risk}
        </p>
      ))}
      {run.test_report?.commandLogs.map((log) => (
        <pre key={log.command}>
          {log.command}  退出 {log.exitCode}
          {'\n'}
          {log.excerpt}
        </pre>
      ))}
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
        {pm && (
          <button type="button" className="sheet__ghost" onClick={() => void onReset()}>
            新开一条需求
          </button>
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
      <div className="desk__head">
        <div className="desk__seats" role="tablist" aria-label="当前身份">
          {(['pm', 'dev', 'qa'] as const).map((seat) => (
            <button
              key={seat}
              type="button"
              role="tab"
              aria-selected={run.seat === seat}
              className={run.seat === seat ? 'desk__seat desk__seat--on' : 'desk__seat'}
              onClick={() => void onSeat(seat)}
            >
              {seat === 'pm' ? '我是产品' : seat === 'dev' ? '我是研发' : '我是测试'}
            </button>
          ))}
        </div>
        <div className="desk__now">
          <strong>{status.title}</strong>
          <p>{status.body}</p>
        </div>
      </div>

      {error && <div className="desk__err">{error}</div>}
      {run.stale && pm && <div className="desk__warn">这次撤回过。重新确认后，研发才能再改。</div>}
      {needsRepo && !root && <div className="desk__warn">先在上面选一个目录，再让 AI 改仓库。</div>}

      <div className="desk__split">
        {talkPane}
        {documentPane}
      </div>
    </div>
  )
}
