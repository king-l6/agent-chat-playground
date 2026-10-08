/**
 * 工作区条：把「现在绑的是哪棵目录树」画出来。
 * 菜单里选完如果这里不更新，用户会以为没选上——A2 翻车就是这样。
 *
 * 选目录一律走系统弹窗：桌面壳用 Electron 的 dialog（挂在窗口上），
 * 浏览器里让服务端调 macOS 原生选择器。两边都是同一个系统弹窗，没有自制文件浏览器。
 */
import { useEffect, useState } from 'react'
import {
  fetchWorkspaceInfo,
  notifyWorkspaceChanged,
  pickWorkspaceNative,
  setWorkspace,
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
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
      return
    }
    // 浏览器：服务端代弹系统目录选择器
    setBusy(true)
    try {
      const dir = await pickWorkspaceNative('选择工作区')
      if (dir) await bind(dir)
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
        <button type="button" className="wsbar__btn" disabled={busy} onClick={() => void onPick()}>
          {busy ? '选目录中…' : isElectron ? (root ? '重选' : '选择目录') : root ? '换一个' : '选择目录'}
        </button>
      </div>
    </div>
  )
}
