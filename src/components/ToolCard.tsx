/**
 * 单张 Tool Calling 卡片。
 * 先给能读的摘要（检索轨迹、算式、Skill 名），原始 JSON 收在折叠里。
 * 代码团队的 workspace_write 会停在 awaiting_approval，对齐 OpenHands 确认卡。
 */
import { useEffect, useState } from 'react'
import type { ToolCallView } from '../types'
import {
  formatScore,
  retrievalLabel,
  summarizeTool,
  type SearchHitView,
} from '../lib/toolView'
import './ToolCard.css'

function statusText(tool: ToolCallView, skill: boolean) {
  const time =
    tool.ms == null ? '' : tool.ms < 1000 ? ` · ${tool.ms} ms` : ` · ${(tool.ms / 1000).toFixed(1)} s`
  if (tool.status === 'running') return skill ? '加载中…' : '调用中…'
  if (tool.status === 'awaiting_approval') return '待批准'
  if (tool.status === 'done') return `${skill ? '已加载' : '完成'}${time}`
  return `失败${time}`
}

function SearchHits({ hits, cited }: { hits: SearchHitView[]; cited: Set<number> | null }) {
  return (
    <ol className="tool-hits">
      {hits.slice(0, 4).map((hit) => {
        const score = formatScore(hit.score)
        const rerank = formatScore(hit.rerank)
        const unused = cited != null && !cited.has(hit.citation)
        const meta = [
          score ? `融合 ${score}` : '',
          rerank ? `重排 ${rerank}` : '',
          unused ? '未写入回答' : '',
        ].filter(Boolean)
        return (
          <li key={hit.citation} className={unused ? 'tool-hits__unused' : undefined}>
            <span className="tool-hits__n">{hit.citation}</span>
            <span className="tool-hits__body">
              <span className="tool-hits__title">{hit.docName || hit.title}</span>
              {meta.length > 0 && <span className="tool-hits__meta">{meta.join(' · ')}</span>}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function Summary({ tool, cited }: { tool: ToolCallView; cited: Set<number> | null }) {
  const summary = summarizeTool(tool)
  if (summary.kind === 'search') {
    const drafting = tool.status === 'running' && !summary.query && tool.arguments.trim()
    return (
      <div className="tool-card__sum">
        <p className="tool-card__line">
          {summary.retrieval ? retrievalLabel(summary.retrieval) : '检索'}
          {summary.query ? ` · ${summary.query}` : ''}
        </p>
        {drafting && <p className="tool-card__line tool-card__line--sub">参数生成中 {tool.arguments}</p>}
        {summary.rewrite.length > 0 && (
          <p className="tool-card__line tool-card__line--sub">
            改写 {summary.rewrite.slice(0, 8).join(' ')}
          </p>
        )}
        {summary.hits.length > 0 ? (
          <SearchHits hits={summary.hits} cited={cited} />
        ) : (
          tool.status === 'done' && <p className="tool-card__line">{summary.empty}</p>
        )}
      </div>
    )
  }
  if (summary.kind === 'calc') {
    const value = summary.result ? ` = ${summary.result}` : ''
    return <p className="tool-card__line">{summary.expression}{value}</p>
  }
  if (summary.kind === 'skill') {
    return (
      <p className="tool-card__line">
        {summary.name}
        {summary.description ? ` · ${summary.description}` : ''}
      </p>
    )
  }
  if (!summary.line) return null
  return <p className="tool-card__line">{summary.line}</p>
}

function rawPayload(tool: ToolCallView) {
  const parts: string[] = []
  if (tool.arguments) parts.push(formatJson(tool.arguments))
  if (tool.result) parts.push(slimResult(tool.result))
  return parts.join('\n\n')
}

/** 模型用的 instruction / 长正文不进折叠，卡片上已经有命中列表 */
function slimResult(raw: string) {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return formatJson(raw)
    const next: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (key === 'instruction') continue
      if (key === 'hits' && Array.isArray(value)) {
        next.hits = value.map((hit) => {
          if (!hit || typeof hit !== 'object') return hit
          const copy = { ...(hit as Record<string, unknown>) }
          delete copy.text
          return copy
        })
        continue
      }
      next[key] = value
    }
    return JSON.stringify(next, null, 2)
  } catch {
    return raw
  }
}

function formatJson(raw: string) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

function formatRemain(ms: number) {
  if (ms <= 0) return '即将超时'
  const sec = Math.ceil(ms / 1000)
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return m > 0 ? `${m}:${String(s).padStart(2, '0')} 后自动拒绝` : `${s}s 后自动拒绝`
}

export function ToolCard({
  tool,
  cited = null,
  onApprove,
}: {
  tool: ToolCallView
  cited?: Set<number> | null
  onApprove?: (id: string, decision: 'approve' | 'deny') => void | Promise<void>
}) {
  const skill = tool.name === 'load_skill'
  const skillName = skill ? summarizeTool(tool) : null
  const title =
    skill && skillName?.kind === 'skill' && skillName.name
      ? `skill:${skillName.name}`
      : tool.name === 'workspace_write' && tool.status === 'awaiting_approval'
        ? '拟写入'
        : tool.name
  const raw = tool.status === 'done' ? rawPayload(tool) : formatJson(tool.arguments || '')
  const waiting = tool.status === 'awaiting_approval'
  const [busy, setBusy] = useState(false)
  const [remain, setRemain] = useState(() =>
    tool.expiresAt ? Math.max(0, tool.expiresAt - Date.now()) : null,
  )

  useEffect(() => {
    if (!waiting || tool.expiresAt == null) {
      setRemain(null)
      return
    }
    const tick = () => setRemain(Math.max(0, (tool.expiresAt ?? 0) - Date.now()))
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [waiting, tool.expiresAt])

  useEffect(() => {
    if (!waiting) setBusy(false)
  }, [waiting, tool.status])

  async function decide(decision: 'approve' | 'deny') {
    if (!onApprove || busy) return
    setBusy(true)
    try {
      await onApprove(tool.id, decision)
    } finally {
      // 成功会变成 running/done；失败 App 会回滚 awaiting，这里放开按钮
      setBusy(false)
    }
  }

  return (
    <div className={`tool-card tool-card--${tool.status}${skill ? ' tool-card--skill' : ''}`}>
      <div className="tool-card__head">
        <span className="tool-card__name">{title}</span>
        <span className="tool-card__status">{statusText(tool, skill)}</span>
      </div>
      <Summary tool={tool} cited={cited} />
      {waiting && tool.preview && (
        <pre className="tool-card__preview">
          <code>{tool.preview}</code>
        </pre>
      )}
      {waiting && remain != null && (
        <p className="tool-card__deadline">{formatRemain(remain)}</p>
      )}
      {waiting && onApprove && (
        <div className="tool-card__actions">
          <button
            type="button"
            className="tool-card__ok"
            disabled={busy}
            onClick={() => void decide('approve')}
          >
            {busy ? '提交中…' : '批准写入'}
          </button>
          <button
            type="button"
            className="tool-card__no"
            disabled={busy}
            onClick={() => void decide('deny')}
          >
            拒绝
          </button>
        </div>
      )}
      {tool.error && <div className="tool-card__error">{tool.error}</div>}
      {raw.trim() && !waiting && (
        <details className="tool-card__raw">
          <summary>参数与返回</summary>
          <pre className="tool-card__block">
            <code>{raw}</code>
          </pre>
        </details>
      )}
    </div>
  )
}
