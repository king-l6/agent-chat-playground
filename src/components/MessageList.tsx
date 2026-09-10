/**
 * 消息列表：渲染用户/助手气泡，以及中间的工具卡片
 */
import ReactMarkdown from 'react-markdown'
import type { UiMessage } from '../types'
import { CitationMarkdown } from './CitationMarkdown'
import { ToolCard } from './ToolCard'
import './MessageList.css'

/** 接收整个 messages 数组，按条画文章气泡 */
export function MessageList({ messages }: { messages: UiMessage[] }) {
  // 还没聊过：显示空状态引导
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
          {/* 角色标签 */}
          <div className="msg__role">{m.role === 'user' ? '你' : '助手'}</div>

          {/* 工具卡片画在正文前面，方便先看到「调了啥」再看回答 */}
          {m.tools.map((tool) => (
            <ToolCard key={tool.id} tool={tool} />
          ))}

          {m.content ? (
            <div className="msg__content">
              {m.role === 'assistant' ? (
                /* 助手：解析 [1][2] 角标，数据来自同条消息里的 search_notes */
                <CitationMarkdown content={m.content} tools={m.tools} />
              ) : (
                <ReactMarkdown>{m.content}</ReactMarkdown>
              )}
              {m.status === 'streaming' && <span className="caret" />}
            </div>
          ) : (
            // 还没文字、也没有正在跑的工具：显示「思考中」
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
