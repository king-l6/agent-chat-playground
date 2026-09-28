/**
 * 单张 Tool Calling 卡片。
 * 先给能读的摘要（检索轨迹、算式、Skill 名），原始 JSON 收在折叠里。
 * 代码团队的 workspace_write 会停在 awaiting_approval，对齐 OpenHands 确认卡。
 *
 * 三个刻意为之的点：
 * 1. 没有「倒计时 / 自动拒绝」。后端把人点批准当成可以无限等的事
 *    （server/src/codeTeam.ts 的 waitForApproval 里根本没有计时器，注释也写明
 *    「批准不会过期」）；唯一会结束挂起的是用户自己点、或这一轮 SSE 断开。
 *    界面以前显示「5:00 后自动拒绝」，那是旧超时逻辑的残留，已经删掉。
 * 2. 「批准全部」= 本轮后续的低 / 中风险写入不再逐条停下来问（后端 canAutoApprove）。
 * 3. 高风险文件（.env / 密钥 / CI 配置）不给「批准全部」这个按钮：
 *    writeRisk() 把它们判成 high，后端也会单独拦，这里就不要给一刀切的入口。
 */
import { useEffect, useState } from 'react'
import type { ToolCallView, ToolApproveHandler } from '../types'
import {
  formatScore,
  retrievalLabel,
  summarizeTool,
  type SearchHitView,
} from '../lib/toolView'
import { SideBySideDiff } from './CodeDiff'
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

export function ToolCard({
  tool,
  cited = null,
  onApprove,
}: {
  tool: ToolCallView
  cited?: Set<number> | null
  onApprove?: ToolApproveHandler
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

  useEffect(() => {
    if (!waiting) setBusy(false)
  }, [waiting, tool.status])

  /** all = 点的是「批准全部」：本轮后续低/中风险写入一起放行 */
  async function decide(decision: 'approve' | 'deny', all = false) {
    if (!onApprove || busy) return
    setBusy(true)
    try {
      await onApprove(tool.id, decision, all ? { all: true } : undefined)
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
      {waiting && tool.risk && (
        <p className={`tool-card__risk tool-card__risk--${tool.risk}`}>
          风险 {tool.risk === 'high' ? '高' : tool.risk === 'medium' ? '中' : '低'}
          {tool.riskReason ? ` · ${tool.riskReason}` : ''}
        </p>
      )}
      {waiting && (tool.after != null || tool.before != null) ? (
        <SideBySideDiff
          path={tool.path}
          before={tool.before ?? ''}
          after={tool.after ?? ''}
          height={260}
        />
      ) : waiting && tool.preview ? (
        <pre className="tool-card__preview">
          <code>{tool.preview}</code>
        </pre>
      ) : null}
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
          {tool.risk !== 'high' && (
            <button
              type="button"
              className="tool-card__all"
              disabled={busy}
              title="本轮之后低 / 中风险的写入不再逐条询问；高风险文件仍会单独停下来问你"
              onClick={() => void decide('approve', true)}
            >
              批准全部
            </button>
          )}
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
      {waiting && tool.risk === 'high' && (
        <p className="tool-card__note">
          高风险文件（.env / 密钥 / CI 配置）不支持「批准全部」，请单独确认这一条。
        </p>
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
