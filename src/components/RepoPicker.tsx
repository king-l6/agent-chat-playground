/**
 * 从「服务端预置的仓库列表」里选一个目录。服务器形态下代替系统目录选择器。
 *
 * 为什么不做成文件浏览器：工作区根会被 bind mount 进沙箱容器、也会被 workspace_read 读，
 * 让它变成「持令牌者能填/能点的任意路径」就等于绕开容器隔离。所以这里只有一个
 * 扁平列表，数据源是管理员在 PLAYGROUND_WORKSPACE_ALLOWLIST 里写下的目录，
 * 前端没有任何构造路径的自由。
 */
import { useEffect, useState } from 'react'
import { fetchAllowedWorkspaces, type AllowedRoot } from '../api/chat'
import './RepoPicker.css'

type Props = {
  open: boolean
  title?: string
  onClose: () => void
  onPick: (absPath: string) => void
}

type Row = { key: string; path: string; label: string; hint: string; indent: boolean }

/** 把「白名单根 + 它下面的仓库」摊平成一行行，根本身也算一个可选项（它自己可能就是仓库） */
function flatten(allowed: AllowedRoot[]): Row[] {
  const rows: Row[] = []
  for (const entry of allowed) {
    rows.push({
      key: `root:${entry.root}`,
      path: entry.root,
      label: entry.name,
      hint: entry.isRepo ? '这是仓库根' : '这个目录下面',
      indent: false,
    })
    for (const repo of entry.repos) {
      rows.push({
        key: `repo:${repo.path}`,
        path: repo.path,
        label: repo.name,
        hint: repo.path,
        indent: true,
      })
    }
  }
  return rows
}

export function RepoPicker({ open, title, onClose, onPick }: Props) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setRows(null)
    setError('')
    void fetchAllowedWorkspaces()
      .then((data) => {
        if (cancelled) return
        setRows(flatten(data.allowed))
        if (!data.allowlistEnabled) {
          setError('服务端没有配 PLAYGROUND_WORKSPACE_ALLOWLIST，没有可选的仓库。让管理员把仓库目录加进去。')
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [open])

  // Esc 关掉：弹窗没有系统级的行为，用户第一反应就是按 Esc
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="repopick" role="dialog" aria-modal="true" aria-label={title ?? '选择仓库'}>
      <div className="repopick__mask" onClick={onClose} />
      <div className="repopick__panel">
        <div className="repopick__head">
          <span className="repopick__title">{title ?? '选择仓库'}</span>
          <button type="button" className="repopick__x" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        {error ? <div className="repopick__err">{error}</div> : null}

        {rows === null && !error ? <div className="repopick__empty">读取中…</div> : null}

        {rows && rows.length > 0 ? (
          <ul className="repopick__list">
            {rows.map((row) => (
              <li key={row.key}>
                <button
                  type="button"
                  className={row.indent ? 'repopick__row repopick__row--sub' : 'repopick__row'}
                  onClick={() => {
                    onPick(row.path)
                    onClose()
                  }}
                >
                  <span className="repopick__name">{row.label}</span>
                  <span className="repopick__hint">{row.hint}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {rows && rows.length === 0 && !error ? (
          <div className="repopick__empty">白名单里的目录都读不出来，问问管理员。</div>
        ) : null}

        <div className="repopick__foot">
          列表来自服务端的 PLAYGROUND_WORKSPACE_ALLOWLIST。要加目录找管理员，页面这里改不了。
        </div>
      </div>
    </div>
  )
}
