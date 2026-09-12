import { useCallback, useEffect, useState } from 'react'
import {
  fetchDelivery,
  postGate,
  savePrd,
  saveSeat,
  streamDeliveryTurn,
  type DeliveryRun,
  type Seat,
} from '../api/delivery'
import './KnowledgePage.css'
import './DeliveryPage.css'

const LANES: Array<{ id: DeliveryRun['phase']; label: string }> = [
  { id: 'drafting', label: '产品' },
  { id: 'developing', label: '研发' },
  { id: 'blocked_on_pm', label: '打回产品' },
  { id: 'reviewing', label: '评审' },
  { id: 'testing', label: '测试' },
  { id: 'signed', label: '签字' },
]

export function DeliveryPage() {
  const [run, setRun] = useState<DeliveryRun | null>(null)
  const [error, setError] = useState('')
  const [log, setLog] = useState('')
  const [busy, setBusy] = useState(false)
  const [reason, setReason] = useState('')
  const [questions, setQuestions] = useState('')
  const [prompt, setPrompt] = useState('给 RAG 评测加一道题')

  const reload = useCallback(async () => {
    setRun(await fetchDelivery())
  }, [])

  useEffect(() => {
    reload().catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [reload])

  async function onSeat(seat: Seat) {
    setError('')
    setRun(await saveSeat(seat))
  }

  async function persistPrd(next: DeliveryRun['prd']) {
    if (!run) return
    setRun(await savePrd(run.seat, next))
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

  async function onTurn() {
    if (!run) return
    setBusy(true)
    setError('')
    setLog('')
    try {
      await streamDeliveryTurn({
        actor: run.seat,
        message: prompt,
        onEvent: (event) => {
          if (event.type === 'text_delta') setLog((prev) => prev + event.delta)
          if (event.type === 'gate_blocked') setError(event.message)
          if (event.type === 'error') setError(event.message)
        },
      })
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!run) {
    return (
      <div className="kb">
        {error && <div className="error-banner">{error}</div>}
        <p className="kb__hint">加载交付黑板…</p>
      </div>
    )
  }

  const frozen = run.prd.confirmed
  const pm = run.seat === 'pm'
  const dev = run.seat === 'dev'
  const qa = run.seat === 'qa'
  const canEdit = pm && !frozen

  return (
    <div className="kb delivery">
      {error && <div className="error-banner">{error}</div>}
      {run.stale && (
        <p className="kb__hint">这次 run 已过期。磁盘文件还在，不会自动 checkout。再确认后才能进研发。</p>
      )}
      {run.dirtyWarning && <p className="kb__hint">工作区可能是脏的，开工前自己看一眼 git status。</p>}

      <div className="seatbar">
        {(['pm', 'dev', 'qa'] as const).map((seat) => (
          <button
            key={seat}
            type="button"
            className={run.seat === seat ? 'seatbar__btn seatbar__btn--on' : 'seatbar__btn'}
            onClick={() => void onSeat(seat)}
          >
            {seat === 'pm' ? '产品' : seat === 'dev' ? '研发' : '测试'}
          </button>
        ))}
      </div>

      <ol className="lane">
        {LANES.map((lane) => (
          <li key={lane.id} className={run.phase === lane.id ? 'lane__item lane__item--on' : 'lane__item'}>
            {lane.label}
          </li>
        ))}
      </ol>

      <div className="delivery__grid">
        <section className="kb-card">
          <header className="kb-card__head">
            <div>
              <h2>需求</h2>
              <p>{frozen ? '已确认，正文只读。撤回后才能改。' : '未确认，只改文档。'}</p>
            </div>
          </header>
          <div className="delivery__fields">
            <label>
              标题
              <input
                value={run.prd.title}
                disabled={!canEdit}
                onChange={(e) => setRun({ ...run, prd: { ...run.prd, title: e.target.value } })}
                onBlur={(e) => void persistPrd({ ...run.prd, title: e.target.value })}
              />
            </label>
            <label>
              正文
              <textarea
                rows={6}
                value={run.prd.body}
                disabled={!canEdit}
                onChange={(e) => setRun({ ...run, prd: { ...run.prd, body: e.target.value } })}
                onBlur={(e) => void persistPrd({ ...run.prd, body: e.target.value })}
              />
            </label>
            <fieldset>
              <legend>验收（至少勾 1 条才能确认）</legend>
              {run.prd.acceptance.map((ac, idx) => (
                <label key={ac.id} className="delivery__ac">
                  <input
                    type="checkbox"
                    disabled={!canEdit}
                    checked={ac.checkedByPm}
                    onChange={(e) => {
                      const acceptance = run.prd.acceptance.map((item, i) =>
                        i === idx ? { ...item, checkedByPm: e.target.checked } : item,
                      )
                      const next = { ...run.prd, acceptance }
                      setRun({ ...run, prd: next })
                      void persistPrd(next)
                    }}
                  />
                  <span>
                    {ac.text}
                    {ac.command ? ` · ${ac.command}` : ''}
                    {ac.observable ? ` · ${ac.observable}` : ''}
                  </span>
                </label>
              ))}
            </fieldset>
            {run.questions.length > 0 && (
              <div className="delivery__q">
                <strong>研发疑问</strong>
                <ul>
                  {run.questions.map((q) => (
                    <li key={q}>{q}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>

        <section className="kb-card">
          <header className="kb-card__head">
            <div>
              <h2>产物</h2>
              <p>Agent 只写这些。过闸是人点的。</p>
            </div>
          </header>
          <div className="delivery__arts">
            {run.patch && <p>补丁：{run.patch.files.join(', ')}</p>}
            {run.review?.comments.map((c) => (
              <p key={c.path}>
                评审{' '}
                <button type="button" className="delivery__path" onClick={() => void navigator.clipboard.writeText(c.path)}>
                  {c.path}
                </button>
                ：{c.risk}
                {c.mustFix ? '（必须改）' : ''}
              </p>
            ))}
            {run.test_report?.items.map((item) => (
              <p key={item.acId}>
                测试 {item.acId}：{item.result}
                <pre>{item.detail.slice(0, 400)}</pre>
              </p>
            ))}
            {run.release_notes && <pre>{run.release_notes.text}</pre>}
            {log && <p className="kb__hint">{log}</p>}
          </div>
        </section>
      </div>

      <section className="kb-card delivery__actions">
        <div className="delivery__btns">
          {pm && run.phase === 'drafting' && (
            <button type="button" onClick={() => void onGate('confirm')}>
              确认流转
            </button>
          )}
          {pm && frozen && (
            <button type="button" onClick={() => void onGate('withdraw')}>
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
                onClick={() => void onGate('bounce_pm', { questions: questions.split('\n') })}
              >
                打回产品
              </button>
            </>
          )}
          {qa && run.phase === 'reviewing' && (
            <>
              <button type="button" onClick={() => void onGate('review_bounce')}>
                打回研发
              </button>
              <button type="button" onClick={() => void onGate('review_pass')}>
                放行
              </button>
              <button type="button" onClick={() => void onGate('review_risk', { reason })}>
                带风险放行
              </button>
            </>
          )}
          {qa && run.phase === 'testing' && (
            <>
              <button type="button" onClick={() => void onGate('test_bounce')}>
                打回研发
              </button>
              <button type="button" onClick={() => void onGate('test_sign')}>
                测试签字
              </button>
              <button type="button" onClick={() => void onGate('test_risk', { reason })}>
                带风险签字
              </button>
            </>
          )}
        </div>
        {dev && run.phase === 'developing' && (
          <textarea
            rows={2}
            placeholder="打回产品时写下疑问"
            value={questions}
            onChange={(e) => setQuestions(e.target.value)}
          />
        )}
        {qa && (run.phase === 'reviewing' || run.phase === 'testing') && (
          <input
            placeholder="带风险放行/签字必须写理由"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        )}
        <div className="delivery__turn">
          <input value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <button type="button" disabled={busy} onClick={() => void onTurn()}>
            {busy ? '出产物中…' : '让当前身份出产物'}
          </button>
        </div>
      </section>
    </div>
  )
}
