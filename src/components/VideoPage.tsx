/**
 * 视频产线。剧本进，分镜和一条本地成片出。
 * 图生视频供应商还没接，画面是 ffmpeg 画出来的分镜板，任务表和幂等已经按长任务来做。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  fetchVideo,
  filmUrl,
  openVideoTask,
  previewStoryboard,
  retryVideoTask,
  type Shot,
  type VideoGuard,
  type VideoTask,
} from '../api/video'
import './VideoPage.css'

const SAMPLE = `夜市收摊。阿青把最后一笼包子端回店里。
她抬头，看见巷口站着一个没打伞的人。
「还热的。」她把包子递过去。
雨停了。两个人站在灯下，谁都没先走。`

const STAGES = ['分镜', '画面', '拼接', '成片'] as const

function stageIndex(task: VideoTask): number {
  if (task.stage === 'storyboard') return 0
  if (task.stage === 'keyframe') return 1
  if (task.stage === 'assemble') return 2
  return 3
}

function statusText(task: VideoTask): string {
  if (task.status === 'queued') return '排队'
  if (task.status === 'running') return '在做'
  if (task.status === 'succeeded') return '成片'
  return task.errorClass === 'terminal' ? '停了' : '失败'
}

function yuan(cents: number): string {
  return `${(cents / 100).toFixed(2)} 元`
}

export function VideoPage() {
  const [script, setScript] = useState(SAMPLE)
  const [shots, setShots] = useState<Shot[]>([])
  const [live, setLive] = useState(false)
  const [tasks, setTasks] = useState<VideoTask[]>([])
  const [guard, setGuard] = useState<VideoGuard | null>(null)
  const [activeId, setActiveId] = useState<string>('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<'board' | 'run' | ''>('')

  const load = useCallback(async () => {
    const data = await fetchVideo()
    setTasks(data.tasks)
    setGuard(data.guard)
    setActiveId((cur) => cur || data.tasks[0]?.id || '')
  }, [])

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [load])

  const active = tasks.find((t) => t.id === activeId) ?? null
  const pending = tasks.some((t) => t.status === 'queued' || t.status === 'running')

  useEffect(() => {
    if (!pending) return
    const timer = window.setInterval(() => {
      void load().catch(() => {})
    }, 1500)
    return () => window.clearInterval(timer)
  }, [pending, load])

  async function onBoard() {
    setBusy('board')
    setError('')
    try {
      const board = await previewStoryboard(script)
      setShots(board.shots)
      setLive(board.live)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy('')
    }
  }

  async function onRun() {
    setBusy('run')
    setError('')
    try {
      const opened = await openVideoTask(script)
      setShots(opened.task.shots)
      setLive(opened.task.live)
      setActiveId(opened.task.id)
      await load()
    } catch (err) {
      const message =
        err && typeof err === 'object' && 'response' in err
          ? String((err as { response?: { data?: { error?: string } } }).response?.data?.error || '')
          : ''
      setError(message || (err instanceof Error ? err.message : String(err)))
    } finally {
      setBusy('')
    }
  }

  async function onRetry(id: string) {
    setError('')
    try {
      const task = await retryVideoTask(id)
      setActiveId(task.id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const board = shots.length ? shots : active?.shots ?? []
  const seconds = board.reduce((sum, shot) => sum + shot.durationSec, 0)

  return (
    <section className="reel">
      <header className="reel__head">
        <div>
          <h1>视频产线</h1>
          <p>剧本拆成分镜，本机 ffmpeg 拼一条能播的成片。图生视频还没接。</p>
        </div>
        {guard && (
          <p className="reel__guard">
            同时 {guard.running}/{guard.maxConcurrent}
            <span>今日 {yuan(guard.spentCents)} / {yuan(guard.dailyCapCents)}</span>
          </p>
        )}
      </header>

      {error && <p className="reel__err">{error}</p>}

      <div className="reel__body">
        <form
          className="reel__script"
          onSubmit={(e) => {
            e.preventDefault()
            void onRun()
          }}
        >
          <label htmlFor="video-script">剧本</label>
          <textarea
            id="video-script"
            value={script}
            onChange={(e) => setScript(e.target.value)}
            rows={8}
          />
          <div className="reel__actions">
            <button type="button" className="reel__ghost" disabled={busy !== ''} onClick={() => void onBoard()}>
              {busy === 'board' ? '在拆…' : '只看分镜'}
            </button>
            <button type="submit" className="reel__go" disabled={busy !== ''}>
              {busy === 'run' ? '在开…' : '开一条'}
            </button>
          </div>
          <p className="reel__note">
            {board.length
              ? `${board.length} 镜 · ${seconds} 秒 · ${live || active?.live ? '模型拆的' : '按句切开的'}`
              : '同一段剧本再开会回到原来那条，不会再渲一遍。'}
          </p>
        </form>

        <div className="reel__board">
          {board.length === 0 ? (
            <p className="reel__empty">先写剧本，再拆分镜。右边会按镜号排开。</p>
          ) : (
            <ol className="reel__strip">
              {board.map((shot) => (
                <li key={shot.index}>
                  <span className="reel__sprocket" aria-hidden="true" />
                  <strong>
                    {String(shot.index).padStart(2, '0')} {shot.shotSize}
                  </strong>
                  <em>
                    {shot.durationSec}s · {shot.camera}
                  </em>
                  <p>{shot.description}</p>
                  {shot.dialogue ? <q>{shot.dialogue}</q> : null}
                </li>
              ))}
            </ol>
          )}

          {active && (
            <article className="reel__job">
              <header>
                <strong>{active.title}</strong>
                <span className={`reel__status reel__status--${active.status}`}>{statusText(active)}</span>
              </header>
              <ol className="reel__stages">
                {STAGES.map((name, i) => (
                  <li key={name} className={i <= stageIndex(active) ? 'is-on' : ''}>
                    {name}
                  </li>
                ))}
              </ol>
              {active.error ? <p className="reel__joberr">{active.error}</p> : null}
              {active.status === 'failed' && active.errorClass !== 'terminal' && (
                <button type="button" className="reel__ghost" onClick={() => void onRetry(active.id)}>
                  再跑一次
                </button>
              )}
              {active.status === 'succeeded' && active.outputUrl && (
                <video key={active.id} src={filmUrl(active)} controls />
              )}
            </article>
          )}
        </div>
      </div>

      {tasks.length > 0 && (
        <ul className="reel__list">
          {tasks.map((task) => (
            <li key={task.id}>
              <button
                type="button"
                className={task.id === activeId ? 'is-on' : ''}
                onClick={() => {
                  setActiveId(task.id)
                  setShots(task.shots)
                  setLive(task.live)
                }}
              >
                <span>{task.title}</span>
                <em>{statusText(task)}</em>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
