/**
 * 消息列表：渲染用户/助手气泡，以及中间的工具卡片和引用来源
 */
import { useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AgentRole, ToolCallView, UiMessage } from '../types'
import {
  groupCitationsByDoc,
  parseCitationHitsFromTools,
  type CitationHit,
} from '../lib/citations'
import { formatScore, stepLabel } from '../lib/toolView'
import { CitationMarkdown } from './CitationMarkdown'
import { ChatImage } from './ChatImage'
import { ToolCard } from './ToolCard'
import './MessageList.css'

function roleLabel(role: AgentRole) {
  if (role === 'explore') return '探索'
  if (role === 'implement') return '改码'
  if (role === 'review') return '评审'
  if (role === 'pm') return '产品'
  if (role === 'dev') return '研发'
  if (role === 'qa') return '测试'
  return role
}

function groupSteps(tools: ToolCallView[]) {
  const groups: Array<{ step: number; tools: ToolCallView[] }> = []
  for (const tool of tools) {
    const step = tool.step ?? 1
    const last = groups[groups.length - 1]
    if (last && last.step === step) last.tools.push(tool)
    else groups.push({ step, tools: [tool] })
  }
  return groups
}

function StepBlocks({
  tools,
  cited,
  onApprove,
}: {
  tools: ToolCallView[]
  cited: Set<number> | null
  onApprove?: (id: string, decision: 'approve' | 'deny') => void
}) {
  const groups = groupSteps(tools)
  return (
    <>
      {groups.map((group) => (
        <div key={group.step} className="msg__step">
          <p className="msg__process-head">
            第 {group.step} 步 · {stepLabel(group.tools)}
          </p>
          {group.tools.map((tool) => (
            <ToolCard key={tool.id} tool={tool} cited={cited} onApprove={onApprove} />
          ))}
        </div>
      ))}
    </>
  )
}

function MessageProcess({
  tools,
  streaming,
  cited,
  onApprove,
}: {
  tools: ToolCallView[]
  streaming: boolean
  cited: Set<number> | null
  onApprove?: (id: string, decision: 'approve' | 'deny') => void
}) {
  if (!tools.length) return null
  const running =
    streaming || tools.some((t) => t.status === 'running' || t.status === 'awaiting_approval')
  if (running) {
    return (
      <div className="msg__process msg__process--on">
        <StepBlocks tools={tools} cited={cited} onApprove={onApprove} />
      </div>
    )
  }
  const steps = groupSteps(tools).length
  return (
    <details className="msg__process">
      <summary>
        {steps > 1 ? `${steps} 步` : '1 步'} · {tools.length} 个工具
      </summary>
      <StepBlocks tools={tools} cited={cited} onApprove={onApprove} />
    </details>
  )
}

function sourceHref(hit: CitationHit) {
  if (hit.docPath) return `#/documents?path=${encodeURIComponent(hit.docPath)}`
  if (hit.docId) return `#/vectors?doc=${encodeURIComponent(hit.docId)}`
  return null
}

function citationNumbers(content: string) {
  const set = new Set<number>()
  const re = /\[(\d+)\]/g
  let match: RegExpExecArray | null
  while ((match = re.exec(content))) set.add(Number(match[1]))
  return set
}

function formatMs(ms: number | undefined) {
  if (ms == null) return ''
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

function MessageTiming({ message }: { message: UiMessage }) {
  if (message.ttftMs == null && message.totalMs == null) return null
  return (
    <div className="msg__timing">
      {message.ttftMs != null && <span>首字 {formatMs(message.ttftMs)}</span>}
      {message.totalMs != null && <span>整轮 {formatMs(message.totalMs)}</span>}
    </div>
  )
}

function SourceStrip({
  tools,
  content,
  done,
}: {
  tools: ToolCallView[]
  content: string
  done: boolean
}) {
  const hits = useMemo(() => {
    return Array.from(parseCitationHitsFromTools(tools).values()).sort((a, b) => a.citation - b.citation)
  }, [tools])
  const cited = useMemo(() => citationNumbers(content), [content])
  const [openKey, setOpenKey] = useState<string | null>(null)
  if (hits.length === 0) return null
  const usedHits = done ? hits.filter((hit) => cited.has(hit.citation)) : hits
  const unusedHits = done ? hits.filter((hit) => !cited.has(hit.citation)) : []
  const usedDocs = groupCitationsByDoc(usedHits)
  const unusedDocs = groupCitationsByDoc(unusedHits)
  const openDoc =
    usedDocs.find((d) => d.key === openKey) ??
    unusedDocs.find((d) => d.key === openKey) ??
    null
  const href = openDoc?.hits[0] ? sourceHref(openDoc.hits[0]) : null

  const renderDocs = (docs: ReturnType<typeof groupCitationsByDoc>) => (
    <div className="sources__row">
      {docs.map((doc) => (
        <button
          key={doc.key}
          type="button"
          className={openKey === doc.key ? 'source source--on' : 'source'}
          onClick={() => setOpenKey(openKey === doc.key ? null : doc.key)}
        >
          <span className="source__n">{doc.hits.length}</span>
          <span className="source__name">{doc.docName}</span>
        </button>
      ))}
    </div>
  )

  return (
    <div className="sources">
      {usedDocs.length > 0 && (
        <>
          <div className="sources__label">引用来源 · {usedDocs.length} 篇</div>
          {renderDocs(usedDocs)}
        </>
      )}
      {unusedDocs.length > 0 && (
        <details className="sources__unused">
          <summary>检索到但回答没用 · {unusedDocs.length} 篇</summary>
          {renderDocs(unusedDocs)}
        </details>
      )}
      {openDoc && (
        <div className="sources__detail">
          {href ? <a href={href}>{openDoc.docName}</a> : <strong>{openDoc.docName}</strong>}
          {openDoc.hits.map((hit) => {
            const score = formatScore(hit.score)
            const rerank = formatScore(hit.rerank)
            const meta = [
              `[${hit.citation}]`,
              score ? `融合 ${score}` : '',
              rerank ? `重排 ${rerank}` : '',
            ]
              .filter(Boolean)
              .join(' · ')
            return (
              <div key={hit.citation} className="sources__seg">
                <div className="sources__seg-meta">{meta}</div>
                {hit.title !== openDoc.docName && <strong>{hit.title}</strong>}
                {hit.imageUrl && <ChatImage src={hit.imageUrl} alt={hit.title} />}
                {hit.snippet && <p>{hit.snippet}</p>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

type BodyRun =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tools'; tools: ToolCallView[] }
  | { kind: 'role'; role: AgentRole; phase: 'start' | 'done' }

function bodyRuns(message: UiMessage): BodyRun[] {
  if (!message.parts) {
    const runs: BodyRun[] = []
    if (message.tools.length) runs.push({ kind: 'tools', tools: message.tools })
    if (message.content) runs.push({ kind: 'text', text: message.content })
    return runs
  }
  const byId = new Map(message.tools.map((tool) => [tool.id, tool]))
  const runs: BodyRun[] = []
  for (const part of message.parts) {
    if (part.type === 'role') {
      runs.push({ kind: 'role', role: part.role, phase: part.phase })
      continue
    }
    if (part.type === 'tool') {
      const tool = byId.get(part.id)
      if (!tool) continue
      const last = runs[runs.length - 1]
      if (last?.kind === 'tools') last.tools.push(tool)
      else runs.push({ kind: 'tools', tools: [tool] })
      continue
    }
    runs.push(
      part.type === 'text'
        ? { kind: 'text', text: part.text }
        : { kind: 'reasoning', text: part.text },
    )
  }
  return runs
}

function AssistantBody({
  message,
  onApprove,
}: {
  message: UiMessage
  onApprove?: (id: string, decision: 'approve' | 'deny') => void
}) {
  const streaming = message.status === 'streaming'
  const cited = streaming ? null : citationNumbers(message.content)
  const runs = bodyRuns(message)
  const waiting =
    streaming &&
    runs.length === 0 &&
    message.tools.every((tool) => tool.status !== 'running' && tool.status !== 'awaiting_approval')
  return (
    <>
      {waiting && <div className="msg__content muted">思考中…</div>}
      {runs.map((run, index) => {
        const last = index === runs.length - 1
        if (run.kind === 'role') {
          if (run.phase === 'done') return null
          return (
            <div key={index} className="msg__role-bar">
              {roleLabel(run.role)}
            </div>
          )
        }
        if (run.kind === 'reasoning') {
          return streaming && last ? (
            <div key={index} className="msg__reason">
              <p className="msg__process-head">思考</p>
              <div>{run.text}</div>
            </div>
          ) : (
            <details key={index} className="msg__reason">
              <summary>思考</summary>
              <div>{run.text}</div>
            </details>
          )
        }
        if (run.kind === 'tools') {
          return (
            <MessageProcess
              key={index}
              tools={run.tools}
              streaming={streaming && last}
              cited={cited}
              onApprove={onApprove}
            />
          )
        }
        return (
          <div key={index} className="msg__content">
            <CitationMarkdown content={run.text} tools={message.tools} />
            {streaming && last && <span className="caret" />}
          </div>
        )
      })}
      <SourceStrip tools={message.tools} content={message.content} done={!streaming} />
      <MessageTiming message={message} />
    </>
  )
}

/** 接收整个 messages 数组，按条画文章气泡 */
export function MessageList({
  messages,
  onApprove,
}: {
  messages: UiMessage[]
  onApprove?: (id: string, decision: 'approve' | 'deny') => void
}) {
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

          {m.role === 'assistant' ? (
            <AssistantBody message={m} onApprove={onApprove} />
          ) : m.content ? (
            <div className="msg__content">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: ChatImage }}>
                {m.content}
              </ReactMarkdown>
            </div>
          ) : null}
        </article>
      ))}
    </div>
  )
}
