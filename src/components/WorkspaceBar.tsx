/**
 * 工作区条：把「现在绑的是哪棵目录树」画出来。
 * 菜单里选完如果这里不更新，用户会以为没选上——A2 翻车就是这样。
 */
import { useEffect, useState } from 'react'
import { fetchWorkspace } from '../api/chat'

function folderName(root: string) {
  const parts = root.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || root
}

export function WorkspaceBar() {
  const isElectron = Boolean(window.desktop?.isElectron)
  const [root, setRoot] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    void fetchWorkspace()
      .then((next) => {
        if (!cancelled) setRoot(next)
      })
      .catch(() => {
        if (!cancelled) setRoot(null)
      })
    const off = window.desktop?.onWorkspaceChange((next) => {
      setRoot(next)
      setError('')
    })
    return () => {
      cancelled = true
      off?.()
    }
  }, [])

  async function onPick() {
    if (!window.desktop?.pickWorkspace) return
    setError('')
    try {
      const next = await window.desktop.pickWorkspace()
      if (next) setRoot(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

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
          <span className="wsbar__empty">
            {isElectron
              ? '还没选。菜单「文件 → 打开工作区」或点右边按钮。'
              : '网页模式不能选目录。用桌面壳打开后再选，Agent 才读得了本地文件。'}
          </span>
        )}
        {error ? <span className="wsbar__err">{error}</span> : null}
      </div>
      {isElectron ? (
        <button type="button" className="wsbar__btn" onClick={() => void onPick()}>
          {root ? '重选' : '选择工作区'}
        </button>
      ) : (
        <span className="wsbar__hint">仅桌面版</span>
      )}
    </div>
  )
}
