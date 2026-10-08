/**
 * 产物预览：把研发这轮写出来的东西挂进浏览器里的沙箱，当场跑起来。
 *
 * 定位是**旁挂**：它自己 catch 全部异常，不向上抛、不参与任何 disabled 计算。
 * 预览起不来只是一个红块，PRD / diff / 闸门按钮全部照常——网络不通是外因，
 * 不能让它挡住交付流程。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WebContainer } from '@webcontainer/api'
import { fetchDeliveryArtifacts, type ArtifactBundle } from '../api/delivery'
import { ReadonlyFile } from './CodeDiff'
import {
  bootContainer,
  classifyBootError,
  installDeps,
  isIsolated,
  mountTree,
  runDev,
  syncTree,
  type DevHandle,
  type PreviewError,
  type PreviewPhase,
} from '../lib/webcontainer'
import './DeliveryPreview.css'

const PHASE_TEXT: Record<PreviewPhase, string> = {
  idle: '待启动',
  fetching: '取产物…',
  booting: '启动沙箱…',
  installing: '装依赖中…',
  starting: '等 dev server…',
  running: '运行中',
  error: '起不来',
}

/** 改了这些就得重启 dev server；只改源码交给 HMR */
const RESTART_FILES = ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'index.html']
const LOG_KEEP = 20_000

/** 列表里工程文件和入口排前面，源码次之，其余垫后 */
function rank(path: string) {
  if (/^(package\.json|index\.html|vite\.config\.|tsconfig)/.test(path)) return 0
  if (path.startsWith('src/')) return 1
  return 2
}

export default function DeliveryPreview({ runId, trigger }: { runId: string; trigger: number }) {
  const [phase, setPhase] = useState<PreviewPhase>('idle')
  const [url, setUrl] = useState('')
  const [logs, setLogs] = useState('')
  const [error, setError] = useState<PreviewError | null>(null)
  const [bundle, setBundle] = useState<ArtifactBundle | null>(null)
  const [picked, setPicked] = useState('')
  const [tab, setTab] = useState<'run' | 'code'>('run')
  const [open, setOpen] = useState(true)
  /** 手动重试计数。只有环境类失败（网络等）值得重试，它进 effect 依赖触发整条流程重跑 */
  const [attempt, setAttempt] = useState(0)

  const wcRef = useRef<WebContainer | null>(null)
  const mountedRef = useRef(false)
  const syncedRef = useRef<Map<string, string>>(new Map())
  const devRef = useRef<DevHandle | null>(null)
  const logBuf = useRef('')
  const logPaint = useRef(0)
  const logPane = useRef<HTMLPreElement | null>(null)

  // 日志一次一个 chunk，直接 setState 会把主线程打满；攒到一帧再画
  const append = useCallback((chunk: string) => {
    logBuf.current = `${logBuf.current}${chunk}`.slice(-LOG_KEEP)
    if (logPaint.current) return
    logPaint.current = requestAnimationFrame(() => {
      logPaint.current = 0
      setLogs(logBuf.current)
    })
  }, [])

  useEffect(() => {
    const pane = logPane.current
    if (pane) pane.scrollTop = pane.scrollHeight
  }, [logs, open])

  useEffect(() => {
    if (!trigger) return
    let cancelled = false
    const fail = (err: unknown) => {
      if (cancelled) return
      setError(classifyBootError(err))
      setPhase('error')
    }

    void (async () => {
      try {
        setError(null)
        setPhase('fetching')
        const next = await fetchDeliveryArtifacts(runId)
        if (cancelled) return
        setBundle(next)
        setPicked((prev) => prev || next.health.entry || next.files[0]?.path || '')

        /*
         * 没有 package.json 就地拦住，**连沙箱都不起**：npm 在沙箱里只会报
         * `Could not read package.json: ENOENT`，白跑一趟网络、还给不出有用的结论。
         * 这是产物缺件，不是环境问题，所以把完整性证据直接摆上来，别让用户猜。
         */
        if (!next.files.some((f) => f.path === 'package.json')) {
          setPhase('error')
          setError({
            kind: 'incomplete',
            message: '产物里没有 package.json，装不了依赖、也起不了 dev server。',
            detail: `${next.health.evidence.join('；')}\n\n这是生成侧少写了工程文件，不是网络问题。让研发把它补齐（评审里那条「必须改」就是这件事）再回来看。`,
          })
          return
        }

        const prevSynced = syncedRef.current
        const contentOf = (path: string) => next.files.find((f) => f.path === path)?.content ?? ''
        const first = !mountedRef.current

        setPhase('booting')
        const wc = await bootContainer()
        wcRef.current = wc
        if (cancelled) return

        if (first) {
          await mountTree(wc, next)
          syncedRef.current = new Map(next.files.map((f) => [f.path, f.content]))
          mountedRef.current = true
        } else {
          const synced = await syncTree(wc, next, prevSynced)
          syncedRef.current = synced.next
          if (synced.changed.length || synced.removed.length) {
            append(`\n已同步 ${synced.changed.length} 个改动${synced.removed.length ? `、删掉 ${synced.removed.length} 个` : ''}，等 HMR 生效。\n`)
          }
        }
        if (cancelled) return

        const needInstall = first || prevSynced.get('package.json') !== contentOf('package.json')
        const needRestart = first || RESTART_FILES.some((f) => prevSynced.get(f) !== contentOf(f))

        if (needInstall) {
          setPhase('installing')
          append(`\n$ npm install\n`)
          await installDeps(wc, append)
          if (cancelled) return
        }
        if (needRestart || !devRef.current) {
          devRef.current?.dispose()
          devRef.current = null
          setPhase('starting')
          append(`\n$ npm run dev\n`)
          const handle = await runDev(wc, append)
          if (cancelled) {
            handle.dispose()
            return
          }
          devRef.current = handle
          setUrl(handle.url)
        }
        setPhase('running')
      } catch (err) {
        fail(err)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [trigger, runId, attempt, append])

  const files = useMemo(() => {
    if (!bundle) return []
    return [...bundle.files].sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path))
  }, [bundle])
  const current = files.find((f) => f.path === picked)

  if (!trigger) return null

  return (
    <section className="preview" aria-label="产物预览">
      <header className="preview__head">
        <button type="button" className="preview__fold" onClick={() => setOpen((v) => !v)}>
          {open ? '收起' : '展开'}
        </button>
        <strong>生成的产物</strong>
        <span className={`preview__phase preview__phase--${phase}`}>{PHASE_TEXT[phase]}</span>
        {bundle ? (
          <span className="preview__meta">
            {bundle.root === '.' ? '仓库根' : bundle.root}/ · {bundle.files.length} 个文件
          </span>
        ) : null}
        <span className="preview__spacer" />
        <div className="preview__tabs">
          <button
            type="button"
            className={tab === 'run' ? 'is-on' : ''}
            onClick={() => setTab('run')}
          >
            运行结果
          </button>
          <button
            type="button"
            className={tab === 'code' ? 'is-on' : ''}
            onClick={() => setTab('code')}
          >
            看代码
          </button>
        </div>
      </header>

      {open ? (
        <div className="preview__body">
          {!isIsolated() ? (
            <p className="preview__note preview__note--warn">
              当前页面没开跨源隔离，沙箱起不来。用 <code>npm run dev</code> 打开
              127.0.0.1:5176 就能用（安装包走 file://，拿不到响应头）。
            </p>
          ) : null}
          {/* incomplete 那条错误里已经把完整性证据带上了，别再说一遍 */}
          {bundle?.health && !bundle.health.ok && error?.kind !== 'incomplete' ? (
            <p className="preview__note preview__note--warn">
              工程完整性没过：{bundle.health.evidence.join('；')}
            </p>
          ) : null}
          {bundle?.warnings.map((w) => (
            <p className="preview__note" key={w}>
              {w}
            </p>
          ))}
          {error ? (
            <div className="preview__note preview__note--error">
              <strong>{error.message}</strong>
              {error.detail ? <pre>{error.detail}</pre> : null}
              {/* 产物缺件和沙箱起不来，重试都是白试；只有环境类失败值得再按一次 */}
              {error.kind !== 'incomplete' && error.kind !== 'isolation' ? (
                <button type="button" onClick={() => setAttempt((n) => n + 1)}>
                  重试
                </button>
              ) : null}
            </div>
          ) : null}

          {tab === 'run' ? (
            <>
              {url ? (
                <iframe className="preview__frame" src={url} title="产物预览" />
              ) : (
                <div className="preview__blank">
                  {error
                    ? error.kind === 'incomplete'
                      ? '没东西可跑：先让研发把工程文件补齐。'
                      : '预览没起来，看下面的日志。'
                    : PHASE_TEXT[phase]}
                </div>
              )}
              <details className="preview__logs" open={phase === 'error' || phase === 'installing'}>
                <summary>安装 / 启动日志</summary>
                <pre ref={logPane}>{logs || '（还没输出）'}</pre>
              </details>
            </>
          ) : (
            <div className="preview__code">
              <ul className="preview__files">
                {files.map((f) => (
                  <li key={f.path}>
                    <button
                      type="button"
                      className={f.path === picked ? 'is-on' : ''}
                      onClick={() => setPicked(f.path)}
                      title={f.path}
                    >
                      {f.path}
                    </button>
                  </li>
                ))}
              </ul>
              {current ? (
                <ReadonlyFile
                  path={current.path}
                  value={current.binary ? `（二进制文件 ${current.size} 字节，不预览）` : current.content}
                  height={430}
                />
              ) : (
                <p className="preview__blank">左边点一个文件。</p>
              )}
            </div>
          )}
        </div>
      ) : null}
    </section>
  )
}
