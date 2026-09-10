/**
 * 带引用角标的 Markdown 渲染
 * - 从 search_notes 工具结果建 citation → 原文 映射
 * - 正文里的 [1][2] 渲染为可点击角标，点开看 title / id / snippet
 */
import { useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { ToolCallView } from '../types'
import {
  injectCitationAnchors,
  parseCitationHref,
  parseCitationHitsFromTools,
  type CitationHit,
} from '../lib/citations'
import './CitationMarkdown.css'

/** 单个角标；instanceKey 来自 href，重渲染后不变 */
function CitationLink({
  n,
  instanceKey,
  hit,
  openKey,
  setOpenKey,
}: {
  n: number
  instanceKey: string
  hit?: CitationHit
  openKey: string | null
  setOpenKey: (key: string | null) => void
}) {
  const open = openKey === instanceKey

  return (
    <span className="cite-wrap">
      <button
        type="button"
        className={`cite-badge ${hit ? 'cite-badge--ok' : 'cite-badge--miss'}`}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOpenKey(open ? null : instanceKey)
        }}
        title={hit ? `${hit.title} (${hit.id})` : `引用 [${n}] 未找到`}
      >
        [{n}]
      </button>
      {open && hit && (
        <span className="cite-popover" role="tooltip">
          <strong>{hit.title}</strong>
          <span className="cite-popover__meta">{hit.id}</span>
          <div className="cite-popover__snippet">{hit.snippet}</div>
        </span>
      )}
      {open && !hit && (
        <span className="cite-popover cite-popover--miss">
          引用 [{n}] 未在本轮 search_notes 结果中找到
        </span>
      )}
    </span>
  )
}

export function CitationMarkdown({
  content,
  tools,
}: {
  content: string
  tools: ToolCallView[]
}) {
  const cites = useMemo(() => parseCitationHitsFromTools(tools), [tools])
  const processed = useMemo(() => injectCitationAnchors(content), [content])
  const [openKey, setOpenKey] = useState<string | null>(null)

  const components = useMemo(
    () => ({
      a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
        if (href?.startsWith('#citation-')) {
          const parsed = parseCitationHref(href)
          if (!parsed) return <>{children}</>
          return (
            <CitationLink
              n={parsed.n}
              instanceKey={parsed.instanceKey}
              hit={cites.get(parsed.n)}
              openKey={openKey}
              setOpenKey={setOpenKey}
            />
          )
        }
        return (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        )
      },
    }),
    [cites, openKey],
  )

  return (
    <ReactMarkdown components={components}>{processed}</ReactMarkdown>
  )
}
