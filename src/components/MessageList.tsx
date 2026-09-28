/**
 * 消息列表：渲染用户/助手气泡，以及中间的工具卡片
 */
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ToolCallView, UiMessage } from '../types'
import { CitationMarkdown } from './CitationMarkdown'
import { ChatImage } from './ChatImage'
import { ToolCard } from './ToolCard'
import './MessageList.css'

function MessageProcess({ tools, streaming }: { tools: ToolCallView[]; streaming: boolean }) {
  if (!tools.length) return null
  const running = streaming || tools.some((t) => t.status === 'running')
  const cards = tools.map((tool) => <ToolCard key={tool.id} tool={tool} />)
  if (running) {
    return (
      <div className="msg__process msg__process--on">
        <p className="msg__process-head">正在执行</p>
        {cards}
      </div>
    )
  }
  return (
    <details className="msg__process">
      <summary>中间步骤 · {tools.length}</summary>
      {cards}
    </details>
  )
}

/** 接收整个 messages 数组，按条画文章气泡 */
export function MessageList({ messages }: { messages: UiMessage[] }) {
  // 还没聊过：显示空状态引导
  if (messages.length === 0) {
    return (
      <div className="empty">
        <h2>Agent Chat Playground</h2>
        <p>流式对话 + 工具卡片 + 已连接 Skill。无 API Key 也能用 mock 演示。</p>
        <ul>
          <li>现在几点了？（只调工具）</li>
          <li>这个项目的技术栈是什么？（只检索）</li>
          <li>请按面试口径介绍这个项目（先 load skill 再检索）</li>
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

          <MessageProcess tools={m.tools} streaming={m.status === 'streaming'} />

          {m.content ? (
            <div className="msg__content">
              {m.role === 'assistant' ? (
                /* 助手：解析 [1][2] 角标，数据来自同条消息里的 search_notes */
                <CitationMarkdown content={m.content} tools={m.tools} />
              ) : (
                /* 用户消息现在也能贴图（比如把一条图片地址丢进来） */
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: ChatImage }}>
                  {m.content}
                </ReactMarkdown>
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
