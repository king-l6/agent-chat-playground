import ReactMarkdown from 'react-markdown'
import type { UiMessage } from '../types'
import { ToolCard } from './ToolCard'
import './MessageList.css'

export function MessageList({ messages }: { messages: UiMessage[] }) {
  if (messages.length === 0) {
    return (
      <div className="empty">
        <h2>Agent Chat Playground</h2>
        <p>流式对话 + Tool Calling 卡片。无 API Key 也能用 mock 模式演示。</p>
        <ul>
          <li>现在几点了？</li>
          <li>帮我算 123 * 456</li>
          <li>这个项目的技术栈是什么？</li>
        </ul>
      </div>
    )
  }

  return (
    <div className="message-list">
      {messages.map((m) => (
        <article key={m.id} className={`msg msg--${m.role}`}>
          <div className="msg__role">{m.role === 'user' ? '你' : '助手'}</div>
          {m.tools.map((tool) => (
            <ToolCard key={tool.id} tool={tool} />
          ))}
          {m.content ? (
            <div className="msg__content">
              <ReactMarkdown>{m.content}</ReactMarkdown>
              {m.status === 'streaming' && <span className="caret" />}
            </div>
          ) : (
            m.status === 'streaming' &&
            m.tools.every((t) => t.status !== 'running') && (
              <div className="msg__content muted">思考中…</div>
            )
          )}
        </article>
      ))}
    </div>
  )
}
