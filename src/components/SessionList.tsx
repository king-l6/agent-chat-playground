import { useMemo, useState } from 'react'
import type { ChatSession } from '../sessionStore'
import './SessionList.css'

function day(ts: number) {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 列表的排序键 = 最后一次「用户提问」的时间。
 *
 * 不要换成 updatedAt：那个字段会被每个流式事件（text_delta / reasoning_delta / tool_*）刷新，
 * 多个会话同时生成时，谁的 token 后到谁就被顶到最前面，列表会上下反复换位。
 * 老数据没有 lastUserAt（内存里兜底），退回 updatedAt 至少保证顺序稳定。
 */
function sortKey(s: ChatSession) {
  return Number.isFinite(s.lastUserAt) ? s.lastUserAt : s.updatedAt
}

function preview(session: ChatSession) {
  const last = [...session.messages].reverse().find((m) => m.content.trim())
  if (!last) return '还没有消息'
  return last.content.trim().replace(/\s+/g, ' ')
}

/** 按「今天 / 昨天 / 近 7 天 / 更早」分组，对齐 DeepSeek 左侧列表的分段方式（同样只认提问时间） */
function bucketOf(ts: number) {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const dayMs = 24 * 60 * 60 * 1000
  if (ts >= startOfToday) return '今天'
  if (ts >= startOfToday - dayMs) return '昨天'
  if (ts >= startOfToday - 6 * dayMs) return '近 7 天'
  return '更早'
}

const ORDER = ['今天', '昨天', '近 7 天', '更早'] as const

export function SessionList(props: {
  sessions: ChatSession[]
  activeId: string
  busyIds: ReadonlySet<string>
  onNew: () => void
  onSelect: (id: string) => void
  onDelete: (id: string) => void
}) {
  const [query, setQuery] = useState('')

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const hit = q
      ? props.sessions.filter((s) => {
          if (s.title.toLowerCase().includes(q)) return true
          return s.messages.some((m) => m.content.toLowerCase().includes(q))
        })
      : props.sessions
    const ordered = [...hit].sort((a, b) => sortKey(b) - sortKey(a))
    return ORDER.map((label) => ({
      label,
      items: ordered.filter((s) => bucketOf(sortKey(s)) === label),
    })).filter((g) => g.items.length > 0)
  }, [props.sessions, query])

  return (
    <aside className="sessions">
      <button type="button" className="sessions__new" onClick={props.onNew}>
        开启新对话
      </button>
      <input
        className="sessions__search"
        type="search"
        value={query}
        placeholder="搜索对话"
        aria-label="搜索对话"
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="sessions__scroll">
        {groups.length === 0 && <p className="sessions__none">没有匹配的对话</p>}
        {groups.map((group) => (
          <div key={group.label} className="sessions__group">
            <p className="sessions__group-label">{group.label}</p>
            <ul className="sessions__list">
              {group.items.map((session) => {
                const on = session.id === props.activeId
                const busy = props.busyIds.has(session.id)
                return (
                  <li key={session.id}>
                    <button
                      type="button"
                      className={on ? 'sessions__item sessions__item--on' : 'sessions__item'}
                      onClick={() => props.onSelect(session.id)}
                    >
                      <span className="sessions__avatar" aria-hidden>
                        {(session.title || '新').slice(0, 1)}
                      </span>
                      <span className="sessions__meta">
                        <span className="sessions__row">
                          <strong>{session.title || '新对话'}</strong>
                          {/* 显示的也是提问日期，和排序键同一个字段，避免「排在这组但日期是那天」 */}
                          <time>{busy ? '生成中' : day(sortKey(session))}</time>
                        </span>
                        <span className="sessions__preview">{preview(session)}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="sessions__del"
                      title="删除会话"
                      aria-label={`删除 ${session.title || '新对话'}`}
                      onClick={() => props.onDelete(session.id)}
                    >
                      ×
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </div>
    </aside>
  )
}
