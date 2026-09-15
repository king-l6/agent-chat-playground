/**
 * 工作区条：把「现在绑的是哪棵目录树」画出来。
 * 菜单里选完如果这里不更新，用户会以为没选上——A2 翻车就是这样。
 */
import { useEffect, useState } from 'react'
import {
  browseWorkspace,
  fetchWorkspaceInfo,
  notifyWorkspaceChanged,
  setWorkspace,
  type WorkspaceBrowse,
} from '../api/chat'

function folderName(root: string) {
  const parts = root.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || root
}

export function WorkspaceBar() {
  const isElectron = Boolean(window.desktop?.isElectron)
  const [root, setRoot] = useState<string | null>(null)
  const [here, setHere] = useState('')
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const [browse, setBrowse] = useState<WorkspaceBrowse | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void fetchWorkspaceInfo()
      .then((info) => {
        if (cancelled) return
        setRoot(info.root)
        setHere(info.here)
      })
      .catch(() => {
        if (!cancelled) setRoot(null)
      })
    const off = window.desktop?.onWorkspaceChange((next) => {
      setRoot(next)
      setError('')
    })
    const onCustom = (event: Event) => {
      const next = (event as CustomEvent<string | null>).detail
      setRoot(next ?? null)
      setError('')
    }
    window.addEventListener('workspace-changed', onCustom)
    return () => {
      cancelled = true
      off?.()
      window.removeEventListener('workspace-changed', onCustom)
    }
  }, [])

  async function bind(next: string) {
    const bound = await setWorkspace(next)
    setRoot(bound)
    setOpen(false)
    notifyWorkspaceChanged(bound)
  }

  async function onPick() {
    setError('')
    if (window.desktop?.pickWorkspace) {
      try {
        const next = await window.desktop.pickWorkspace()
        if (next) {
          setRoot(next)
          notifyWorkspaceChanged(next)
        }
        return
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        return
      }
    }
    setOpen(true)
    setBusy(true)
    try {
      setBrowse(await browseWorkspace(root || here || undefined))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function go(dir: string) {
    setBusy(true)
    setError('')
    try {
      setBrowse(await browseWorkspace(dir))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function onUseHere() {
    if (!here) return
    setError('')
    try {
      await bind(here)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function onUseCwd() {
    if (!browse) return
    setError('')
    try {
      await bind(browse.cwd)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const sameHere = Boolean(here && root && root === here)

  return (
    <div className={root ? 'wsbar wsbar--on' : 'wsbar'} role="status">
      <div className="wsbar__text">
        <span className="wsbar__label">工作区</span>
        {root ? (
          <span className="wsbar__path" title={root}>
            {folderName(root)}
            <span className="wsbar__full">{root}</span>
          </span>
        ) : (
          <span className="wsbar__empty">还没选。点右边选一个目录，研发和测试都对着它干活。</span>
        )}
        {error ? <span className="wsbar__err">{error}</span> : null}
      </div>
      <div className="wsbar__actions">
        {here && !sameHere ? (
          <button type="button" className="wsbar__btn" onClick={() => void onUseHere()}>
            用这个项目
          </button>
        ) : null}
        <button type="button" className="wsbar__btn" onClick={() => void onPick()}>
          {isElectron ? (root ? '重选' : '选择目录') : root ? '换一个' : '选择目录'}
        </button>
      </div>

      {open && (
        <div className="wspick" role="dialog" aria-label="选择目录">
          <div className="wspick__panel">
            <header className="wspick__head">
              <strong>选一个仓库目录</strong>
              <button type="button" className="wspick__x" onClick={() => setOpen(false)}>
                取消
              </button>
            </header>
            <p className="wspick__cwd" title={browse?.cwd}>
              {browse?.cwd || (busy ? '在读目录…' : '')}
            </p>
            <div className="wspick__jumps">
              {browse?.parent ? (
                <button type="button" onClick={() => void go(browse.parent!)} disabled={busy}>
                  上一级
                </button>
              ) : null}
              {browse?.home ? (
                <button type="button" onClick={() => void go(browse.home)} disabled={busy}>
                  家目录
                </button>
              ) : null}
              {browse?.here ? (
                <button type="button" onClick={() => void go(browse.here)} disabled={busy}>
                  这个项目
                </button>
              ) : null}
            </div>
            <ul className="wspick__list">
              {(browse?.entries ?? []).map((entry) => (
                <li key={entry.path}>
                  <button type="button" onClick={() => void go(entry.path)} disabled={busy}>
                    {entry.name}
                  </button>
                </li>
              ))}
            </ul>
            <button type="button" className="wspick__ok" onClick={() => void onUseCwd()} disabled={!browse || busy}>
              对准这一层
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
