import type { ChatSession } from '../sessionStore'

function day(ts: number) {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function preview(session: ChatSession) {
  const last = [...session.messages].reverse().find((m) => m.content.trim())
  if (!last) return '还没有消息'
  return last.content.trim().replace(/\s+/g, ' ')
}

export function SessionList(props: {
  sessions: ChatSession[]
  activeId: string
  busyIds: ReadonlySet<string>
  onNew: () => void
  onSelect: (id: string) => void
  onDelete: (id: string) => void
}) {
  const ordered = [...props.sessions].sort((a, b) => b.updatedAt - a.updatedAt)

  return (
    <aside className="sessions">
      <button type="button" className="sessions__new" onClick={props.onNew}>
        开启新对话
      </button>
      <ul className="sessions__list">
        {ordered.map((session) => {
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
                    <time>{busy ? '生成中' : day(session.updatedAt)}</time>
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
    </aside>
  )
}
