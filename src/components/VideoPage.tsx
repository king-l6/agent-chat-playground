/**
 * 视频产线：上面是画布。一块画布一个场景，各自记剧本和对话。
 */
import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Card, ConfigProvider, Empty, Flex, Image, Input, Space, Splitter, Tabs, Tag, Timeline, Typography } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import {
  deleteVideoTask,
  draftVideoScript,
  fetchBible,
  fetchVideo,
  filmUrl,
  openVideoTask,
  previewStoryboard,
  retryVideoTask,
  stillSrc,
  type SeriesBible,
  type Shot,
  type VideoGuard,
  type VideoTask,
} from '../api/video'
import './VideoPage.css'
import { BibleDrawer } from './BibleDrawer'

const FLOW_KEY = 'reel-flow-width'
const SIDE_KEY = 'reel-side-width'
const SCRIPT_KEY = 'reel-script-size'
const BOARDS_KEY = 'reel-boards'
const FLOW_DEFAULT = 360
const FLOW_MIN = 240
const SIDE_DEFAULT = 320
const SIDE_MIN = 220
const FILM_MIN = 280
const SCRIPT_DEFAULT = 188
const SCRIPT_MIN = 132

type Talk = { role: 'user' | 'assistant'; content: string; script?: string }

type Board = {
  id: string
  title: string
  script: string
  talk: Talk[]
  ask: string
  taskId: string
  preview: Shot[] | null
  live: boolean
}

function boardId(): string {
  return `board_${Math.random().toString(16).slice(2, 10)}`
}

function blankBoard(): Board {
  return { id: boardId(), title: '新场景', script: '', talk: [], ask: '', taskId: '', preview: null, live: false }
}

function taskBoard(task: VideoTask): Board {
  return {
    id: boardId(),
    title: task.title,
    script: task.script,
    talk: [],
    ask: '',
    taskId: task.id,
    preview: null,
    live: task.live,
  }
}

function readBoards(): Board[] {
  try {
    const raw = JSON.parse(localStorage.getItem(BOARDS_KEY) || '[]') as unknown
    if (!Array.isArray(raw)) return []
    return raw.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const row = item as Partial<Board>
      if (typeof row.id !== 'string' || typeof row.script !== 'string') return []
      return [{
        id: row.id,
        title: typeof row.title === 'string' && row.title ? row.title : '新场景',
        script: row.script,
        talk: Array.isArray(row.talk) ? row.talk : [],
        ask: typeof row.ask === 'string' ? row.ask : '',
        taskId: typeof row.taskId === 'string' ? row.taskId : '',
        preview: null,
        live: false,
      }]
    })
  } catch {
    return []
  }
}

function mergeBoards(prev: Board[], tasks: VideoTask[]): Board[] {
  const ids = new Set(tasks.map((task) => task.id))
  const kept = prev.filter((board) => !board.taskId || ids.has(board.taskId))
  const known = new Set(kept.map((board) => board.taskId).filter(Boolean))
  const added = tasks.filter((task) => !known.has(task.id)).map(taskBoard)
  const next = [...added, ...kept]
  return next.length ? next : [blankBoard()]
}

function readSize(key: string, fallback: number, min: number): number {
  const raw = Number(localStorage.getItem(key))
  return Number.isFinite(raw) && raw >= min ? raw : fallback
}

function statusText(task: VideoTask): string {
  if (task.status === 'queued') return '排队'
  if (task.status === 'running') return '在做'
  if (task.status === 'succeeded') return '成片'
  return task.errorClass === 'terminal' ? '停了' : '失败'
}

type FlowKind = 'ok' | 'run' | 'wait' | 'err'

type FlowStep = {
  key: string
  kind: FlowKind
  title: string
  detail?: string
  stillUrl?: string
  retry?: boolean
}

function flowSteps(task: VideoTask | null, shots: Shot[], live: boolean): FlowStep[] {
  if (!task && shots.length === 0) return []
  const storyModel = live || task?.live ? 'deepseek-v4.1-flash' : '按句切开'
  const imageModel = task?.provider ?? 'gpt-image-2'
  const succeeded = task?.status === 'succeeded'
  const failed = task?.status === 'failed'
  const drawing = task?.status === 'running' && task.stage === 'keyframe'
  const assembling = task?.status === 'running' && task.stage === 'assemble'
  const doneImages = task?.imageCount ?? (succeeded ? shots.length : 0)
  const steps: FlowStep[] = [{ key: 'story', kind: 'ok', title: '分镜', detail: storyModel }]

  if (!task) {
    shots.forEach((shot) => {
      steps.push({
        key: `shot-${shot.index}`,
        kind: 'ok',
        title: `${String(shot.index).padStart(2, '0')} ${shot.shotSize}`,
        detail: `${shot.description}${shot.refCount === 0 ? '（没有参考图，脸按文字重画）' : ''}`,
      })
    })
    return steps
  }

  if (task.status === 'queued') {
    steps.push({ key: 'queue', kind: 'run', title: '排队', detail: '等上一条结束' })
    return steps
  }

  steps.push({
    key: 'image',
    kind: drawing && doneImages === 0 ? 'run' : 'ok',
    title: '图片模型',
    detail: imageModel,
  })

  const reveal = succeeded || failed || drawing ? shots.length : Math.min(shots.length, doneImages)
  shots.slice(0, reveal).forEach((shot) => {
    const ready = Boolean(shot.stillUrl) || succeeded
    const stuck = failed && task.stage === 'keyframe' && !shot.stillUrl
    steps.push({
      key: `shot-${shot.index}`,
      kind: ready ? 'ok' : stuck ? 'err' : drawing ? 'run' : 'wait',
      title: `${String(shot.index).padStart(2, '0')} ${shot.shotSize}`,
      detail: stuck ? task.error : `${shot.description}${shot.refCount === 0 ? '（没有参考图，脸按文字重画）' : ''}`,
      stillUrl: ready ? shot.stillUrl : undefined,
      retry: stuck,
    })
  })

  if (assembling || succeeded || (failed && task.stage !== 'keyframe' && task.stage !== 'storyboard')) {
    steps.push({
      key: 'cut',
      kind: succeeded ? 'ok' : failed ? 'err' : 'run',
      title: failed || assembling ? '静帧转成动作' : '拼接成片',
      detail: failed ? task.error : assembling ? '万相参考生视频，再贴配音' : '已贴配音',
      retry: failed,
    })
  }
  if (failed && !steps.some((step) => step.retry)) {
    steps.push({ key: 'fail', kind: 'err', title: '停了', detail: task.error, retry: true })
  }
  if (succeeded) steps.push({ key: 'done', kind: 'ok', title: '成片已好', detail: `${shots.length} 镜` })
  return steps
}

function yuan(cents: number): string {
  return `${(cents / 100).toFixed(2)} 元`
}

function apiError(err: unknown): string {
  if (err && typeof err === 'object' && 'response' in err) {
    const message = (err as { response?: { data?: { error?: string } } }).response?.data?.error
    if (message) return message
  }
  return err instanceof Error ? err.message : String(err)
}

export function VideoPage() {
  const [tasks, setTasks] = useState<VideoTask[]>([])
  const [guard, setGuard] = useState<VideoGuard | null>(null)
  const [boards, setBoards] = useState<Board[]>(readBoards)
  const [activeBoardId, setActiveBoardId] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<'board' | 'run' | 'talk' | ''>('')
  const [flowWidth, setFlowWidth] = useState(() => readSize(FLOW_KEY, FLOW_DEFAULT, FLOW_MIN))
  const [sideWidth, setSideWidth] = useState(() => readSize(SIDE_KEY, SIDE_DEFAULT, SIDE_MIN))
  const [scriptSize, setScriptSize] = useState(() => readSize(SCRIPT_KEY, SCRIPT_DEFAULT, SCRIPT_MIN))
  const [shownKeys, setShownKeys] = useState<string[]>([])
  const [bibleOpen, setBibleOpen] = useState(false)
  const [cast, setCast] = useState<SeriesBible | null>(null)

  const load = useCallback(async () => {
    const data = await fetchVideo()
    setTasks(data.tasks)
    setGuard(data.guard)
    setBoards((cur) => mergeBoards(cur, data.tasks))
  }, [])

  useEffect(() => {
    if (bibleOpen) return
    void fetchBible().then(setCast).catch(() => {})
  }, [bibleOpen])

  useEffect(() => {
    void load().catch((err) => setError(apiError(err)))
  }, [load])

  const activeBoard = boards.find((item) => item.id === activeBoardId) ?? boards[0] ?? null
  const active = tasks.find((task) => task.id === activeBoard?.taskId) ?? null
  const pending = tasks.some((task) => task.status === 'queued' || task.status === 'running')
  const script = activeBoard?.script ?? ''
  const talk = activeBoard?.talk ?? []
  const ask = activeBoard?.ask ?? ''

  useEffect(() => {
    if (!boards.length) return
    if (!boards.some((item) => item.id === activeBoardId)) setActiveBoardId(boards[0].id)
  }, [boards, activeBoardId])

  useEffect(() => {
    const saved = boards.map(({ id, title, script: text, talk: lines, ask: draft, taskId }) => ({
      id,
      title,
      script: text,
      talk: lines,
      ask: draft,
      taskId,
    }))
    localStorage.setItem(BOARDS_KEY, JSON.stringify(saved))
  }, [boards])

  function insertCast(name: string) {
    if (!activeBoard) return
    const text = script.trim()
    const next = text ? `${script.trimEnd()} ${name}` : name
    const title = next.trim().replace(/\s+/g, ' ').slice(0, 18) || '新场景'
    patchBoard(activeBoard.id, { script: next, title: activeBoard.taskId ? activeBoard.title : title })
  }

  function patchBoard(id: string, patch: Partial<Board>) {
    setBoards((cur) => cur.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }

  useEffect(() => {
    if (!pending) return
    const timer = window.setInterval(() => {
      void load().catch(() => {})
    }, 1500)
    return () => window.clearInterval(timer)
  }, [pending, load])

  function selectBoard(id: string) {
    setActiveBoardId(id)
    setError('')
  }

  function onNewBoard() {
    const next = blankBoard()
    setBoards((cur) => [next, ...cur])
    setActiveBoardId(next.id)
    setError('')
  }

  async function onCloseBoard(item: Board) {
    const task = tasks.find((row) => row.id === item.taskId)
    if (task && (task.status === 'running' || task.status === 'queued')) {
      setError('这条还在做，做完再关')
      return
    }
    setError('')
    try {
      if (item.taskId) await deleteVideoTask(item.taskId)
      setBoards((cur) => {
        const next = cur.filter((row) => row.id !== item.id)
        return next.length ? next : [blankBoard()]
      })
      if (item.taskId) await load()
    } catch (err) {
      setError(apiError(err))
    }
  }

  async function onBoard() {
    if (!activeBoard) return
    const id = activeBoard.id
    setBusy('board')
    setError('')
    try {
      const result = await previewStoryboard(script)
      patchBoard(id, { preview: result.shots, live: result.live })
    } catch (err) {
      setError(apiError(err))
    } finally {
      setBusy('')
    }
  }

  async function onRun(text?: string) {
    if (!activeBoard) return
    const id = activeBoard.id
    const body = (text ?? script).trim()
    setBusy('run')
    setError('')
    try {
      const opened = await openVideoTask(body)
      setBoards((cur) => {
        const owner = cur.find((item) => item.taskId === opened.task.id && item.id !== id)
        if (owner) return cur.filter((item) => item.id !== id)
        return cur.map((item) =>
          item.id === id
            ? { ...item, script: body, title: opened.task.title, taskId: opened.task.id, preview: null, live: opened.task.live }
            : item,
        )
      })
      if (boards.some((item) => item.taskId === opened.task.id && item.id !== id)) {
        const owner = boards.find((item) => item.taskId === opened.task.id)
        if (owner) setActiveBoardId(owner.id)
      }
      await load()
    } catch (err) {
      setError(apiError(err))
    } finally {
      setBusy('')
    }
  }

  async function onRetry(id: string) {
    setError('')
    try {
      await retryVideoTask(id)
      await load()
    } catch (err) {
      setError(apiError(err))
    }
  }

  async function onAsk() {
    if (!activeBoard) return
    const id = activeBoard.id
    const content = ask.trim()
    if (!content || busy === 'talk') return
    const next = [...talk, { role: 'user' as const, content }]
    patchBoard(id, { talk: next, ask: '' })
    setBusy('talk')
    setError('')
    try {
      const draft = await draftVideoScript(
        next.map((line) => ({ role: line.role, content: line.content })),
        script,
      )
      setBoards((cur) =>
        cur.map((item) => {
          if (item.id !== id) return item
          const title = draft.script.trim().replace(/\s+/g, ' ').slice(0, 18) || item.title
          return {
            ...item,
            script: draft.script || item.script,
            title: draft.script && !item.taskId ? title : item.title,
            talk: [...next, { role: 'assistant' as const, content: draft.reply, script: draft.script }],
          }
        }),
      )
    } catch (err) {
      setError(apiError(err))
    } finally {
      setBusy('')
    }
  }

  const shots = activeBoard?.preview ?? active?.shots ?? []
  const flow = flowSteps(activeBoard?.preview ? null : active, shots, Boolean(activeBoard?.live || active?.live))
  const visible = flow.filter((step) => shownKeys.includes(step.key))
  const seconds = shots.reduce((sum, shot) => sum + shot.durationSec, 0)
  const latestScript = [...talk].reverse().find((line) => line.script)?.script ?? ''
  const flowSig = flow.map((step) => step.key).join('|')

  useEffect(() => {
    setShownKeys([])
  }, [activeBoard?.id])

  useEffect(() => {
    const missing = flowSig.split('|').filter((key) => key && !shownKeys.includes(key))
    if (!missing.length) return
    const timer = window.setTimeout(() => {
      setShownKeys((cur) => (cur.includes(missing[0]) ? cur : [...cur, missing[0]]))
    }, 280)
    return () => window.clearTimeout(timer)
  }, [flowSig, shownKeys])

  return (
    <ConfigProvider locale={zhCN}>
      <section className="reel">
        <Flex justify="space-between" align="center">
          <Typography.Title level={5} style={{ margin: 0 }}>
            视频产线
          </Typography.Title>
          <Space>
            <Button onClick={() => setBibleOpen(true)}>设定</Button>
            {guard && (
              <Typography.Text type="secondary">
                同时 {guard.running}/{guard.maxConcurrent}
                <span style={{ marginLeft: 12 }}>
                  今日 {yuan(guard.spentCents)} / {yuan(guard.dailyCapCents)}
                </span>
              </Typography.Text>
            )}
          </Space>
        </Flex>

        <Tabs
          className="reel__tabs"
          type="editable-card"
          activeKey={activeBoard?.id}
          onChange={selectBoard}
          onEdit={(key, action) => {
            if (action === 'add') onNewBoard()
            if (action === 'remove' && typeof key === 'string') {
              const item = boards.find((row) => row.id === key)
              if (item) void onCloseBoard(item)
            }
          }}
          items={boards.map((item) => {
            const task = tasks.find((row) => row.id === item.taskId) ?? null
            const tone = task?.status ?? 'draft'
            return {
              key: item.id,
              label: (
                <Space size={6}>
                  <span>{item.title}</span>
                  <Tag color={tone === 'succeeded' ? 'success' : tone === 'failed' ? 'error' : tone === 'running' ? 'processing' : tone === 'queued' ? 'warning' : 'default'}>
                    {task ? statusText(task) : '草稿'}
                  </Tag>
                </Space>
              ),
            }
          })}
        />

        {error && <Alert type="error" showIcon title={error} />}

        <Splitter
          className="reel__split"
          onResizeEnd={(sizes) => {
            const flow = sizes[1]
            const side = sizes[2]
            if (typeof flow === 'number') {
              setFlowWidth(flow)
              localStorage.setItem(FLOW_KEY, String(Math.round(flow)))
            }
            if (typeof side === 'number') {
              setSideWidth(side)
              localStorage.setItem(SIDE_KEY, String(Math.round(side)))
            }
          }}
        >
          <Splitter.Panel min={FILM_MIN}>
              <Card title="成片" size="small" className="reel__pane">
                {active?.status === 'running' && active.stage === 'keyframe' ? (
                  <Typography.Text type="secondary">
                    同时出 3 张，已好 {active.imageCount ?? 0}/{active.shots.length}
                  </Typography.Text>
                ) : null}
                {active?.error ? <Alert type="error" showIcon title={active.error} /> : null}
                {active?.status === 'failed' && active.errorClass !== 'terminal' ? (
                  <Button onClick={() => void onRetry(active.id)}>再跑一次</Button>
                ) : null}
                {active?.status === 'succeeded' && active.outputUrl ? (
                  <video key={active.id} src={filmUrl(active)} controls className="reel__video" />
                ) : (
                  <Empty description={active ? '成片出来之后在这里播。' : '开一条之后，成片在这里播。'} />
                )}
                {(active?.script || script).trim() ? (
                  <Typography.Paragraph className="reel__prompt">{(active?.script || script).trim()}</Typography.Paragraph>
                ) : null}
              </Card>
          </Splitter.Panel>
          <Splitter.Panel size={flowWidth} min={FLOW_MIN} max={480}>
              <Card title="执行" size="small" className="reel__pane reel__flow">
                {flow.length === 0 ? (
                  <Empty description="开拍之后，步骤会一条一条出现。" />
                ) : (
                  <Timeline
                      items={visible.map((step) => ({
                        key: step.key,
                        color: step.kind === 'ok' ? 'green' : step.kind === 'err' ? 'red' : 'blue',
                        loading: step.kind === 'run',
                        content: (
                          <div className="reel__step">
                            <strong>{step.title}</strong>
                            {step.detail ? <Typography.Text type={step.kind === 'err' ? 'danger' : 'secondary'}>{step.detail}</Typography.Text> : null}
                            {step.retry && active ? (
                              <Button size="small" onClick={() => void onRetry(active.id)}>
                                重试这一步
                              </Button>
                            ) : null}
                            {step.stillUrl ? <Image className="reel__still" src={stillSrc(step.stillUrl)} alt={step.title} /> : null}
                          </div>
                        ),
                      }))}
                    />
                )}
              </Card>
          </Splitter.Panel>
          <Splitter.Panel size={sideWidth} min={SIDE_MIN} max="46%">
            <Splitter
              orientation="vertical"
              className="reel__split"
              onResizeEnd={(sizes) => {
                const next = sizes[1]
                if (typeof next === 'number') {
                  setScriptSize(next)
                  localStorage.setItem(SCRIPT_KEY, String(Math.round(next)))
                }
              }}
            >
              <Splitter.Panel min={120}>
              <Card title="对话写剧本" size="small" className="reel__pane">
                <Flex vertical gap={6} style={{ height: '100%' }}>
                  <div className="reel__log">
                    {talk.length === 0 && <Typography.Text type="secondary">说题材、人物、想要的结尾。写成之后可以插入下面的剧本。</Typography.Text>}
                    {talk.map((line, i) => (
                      <Typography.Paragraph key={i} className={line.role === 'user' ? 'reel__me' : undefined}>
                        {line.content}
                        {line.script ? <span className="reel__draft">{line.script}</span> : null}
                      </Typography.Paragraph>
                    ))}
                  </div>
                  <Space.Compact style={{ width: '100%' }}>
                    <Input
                      value={ask}
                      placeholder="想拍什么"
                      disabled={busy === 'talk'}
                      onChange={(e) => activeBoard && patchBoard(activeBoard.id, { ask: e.target.value })}
                      onPressEnter={() => void onAsk()}
                    />
                    <Button type="primary" disabled={busy === 'talk' || !ask.trim()} onClick={() => void onAsk()}>
                      {busy === 'talk' ? '在写…' : '发送'}
                    </Button>
                  </Space.Compact>
                  {latestScript && (
                    <>
                      <Typography.Paragraph type="secondary" ellipsis={{ rows: 3 }} style={{ marginBottom: 0 }}>
                        {latestScript}
                      </Typography.Paragraph>
                      <Space>
                        <Button
                          onClick={() =>
                            activeBoard &&
                            patchBoard(activeBoard.id, {
                              script: latestScript,
                              title: activeBoard.taskId ? activeBoard.title : latestScript.trim().replace(/\s+/g, ' ').slice(0, 18) || '新场景',
                            })
                          }
                        >
                          插入剧本
                        </Button>
                        <Button type="primary" disabled={busy !== ''} onClick={() => void onRun(latestScript)}>
                          插入并开拍
                        </Button>
                      </Space>
                    </>
                  )}
                </Flex>
              </Card>
              </Splitter.Panel>
              <Splitter.Panel size={scriptSize} min={SCRIPT_MIN} max="52%">
              <Card title="剧本" size="small" className="reel__pane">
                <Flex vertical gap={6}>
                  {cast && (cast.characters.some((item) => item.name.trim()) || cast.places.some((item) => item.name.trim())) ? (
                    <Space wrap size={4}>
                      {cast.characters.filter((item) => item.name.trim()).map((item) => (
                        <Button key={item.id} size="small" onClick={() => insertCast(item.name)}>
                          {item.name}
                        </Button>
                      ))}
                      {cast.places.filter((item) => item.name.trim()).map((item) => (
                        <Button key={item.id} size="small" onClick={() => insertCast(item.name)}>
                          {item.name}
                        </Button>
                      ))}
                    </Space>
                  ) : (
                    <Typography.Text type="secondary">设定里写好角色和场景并保存，名字会出现在这里。</Typography.Text>
                  )}
                  <Input.TextArea
                    value={script}
                    placeholder="点上面的名字写进剧本，或直接写。拆分镜时会套用设定里的外形和场景。"
                    autoSize={{ minRows: 3, maxRows: 6 }}
                    onChange={(e) => {
                      if (!activeBoard) return
                      const title = e.target.value.trim().replace(/\s+/g, ' ').slice(0, 18) || '新场景'
                      patchBoard(activeBoard.id, { script: e.target.value, title: activeBoard.taskId ? activeBoard.title : title })
                    }}
                  />
                  <Space>
                    <Button disabled={busy !== ''} onClick={() => void onBoard()}>
                      {busy === 'board' ? '在拆…' : '只看分镜'}
                    </Button>
                    <Button type="primary" disabled={busy !== ''} onClick={() => void onRun()}>
                      {busy === 'run' ? '在开…' : '开一条'}
                    </Button>
                  </Space>
                  <Typography.Text type="secondary">
                    {shots.length
                      ? `${shots.length} 镜 · ${seconds} 秒 · ${activeBoard?.live || active?.live ? '模型拆的' : '按句切开的'}`
                      : '同一段剧本再开会回到原来那条。'}
                  </Typography.Text>
                </Flex>
              </Card>
              </Splitter.Panel>
            </Splitter>
          </Splitter.Panel>
        </Splitter>
        <BibleDrawer open={bibleOpen} onClose={() => setBibleOpen(false)} />
      </section>
    </ConfigProvider>
  )
}
