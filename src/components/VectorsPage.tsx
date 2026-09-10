/**
 * 向量库控制台：集合状态 + namespace 侧栏 + points 表
 * 对照 Pinecone / Qdrant 的 Browser，不是文档卡片
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  fetchKnowledgeBoard,
  type IndexRow,
  type KnowledgeDoc,
  type RagStatus,
} from '../api/chat'
import './VectorsPage.css'

function focusDocId(): string | null {
  const q = location.hash.split('?')[1]
  if (!q) return null
  return new URLSearchParams(q).get('doc')
}

function VectorStrip({ values }: { values: number[] }) {
  const amp = Math.max(...values.map((v) => Math.abs(v)), 0.04)
  return (
    <div className="vd-strip" title={values.map((v) => v.toFixed(3)).join('  ')}>
      {values.map((v, i) => {
        const t = v / amp
        const hue = t >= 0 ? 162 : 18
        const light = 42 + Math.abs(t) * 18
        const alpha = 0.35 + Math.abs(t) * 0.65
        return (
          <span
            key={i}
            style={{ background: `hsla(${hue} 72% ${light}% / ${alpha})` }}
          />
        )
      })}
    </div>
  )
}

function payloadPreview(row: IndexRow) {
  const text =
    row.tail != null ? `${row.head} … ${row.tail}` : row.head
  return { docId: row.docId, title: row.title, chars: row.chars, text }
}

export function VectorsPage() {
  const [rag, setRag] = useState<RagStatus | null>(null)
  const [documents, setDocuments] = useState<KnowledgeDoc[]>([])
  const [chunks, setChunks] = useState<IndexRow[]>([])
  const [indexMeta, setIndexMeta] = useState({ model: '', dim: 0 })
  const [error, setError] = useState('')
  const [ns, setNs] = useState<string | null>(focusDocId)
  const [filter, setFilter] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const data = await fetchKnowledgeBoard()
    setRag(data.rag)
    setDocuments(data.documents)
    setChunks(data.index.chunks)
    setIndexMeta({ model: data.index.model, dim: data.index.dim })
  }, [])

  useEffect(() => {
    reload().catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [reload])

  useEffect(() => {
    const onHash = () => setNs(focusDocId())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const namespaces = useMemo(() => {
    const byDoc = new Map<string, { label: string; source: string; count: number }>()
    for (const doc of documents) {
      byDoc.set(doc.docId, {
        label: doc.filename || doc.title || doc.docId,
        source: doc.source,
        count: 0,
      })
    }
    for (const row of chunks) {
      const prev = byDoc.get(row.docId)
      if (prev) prev.count += 1
      else {
        byDoc.set(row.docId, { label: row.docId, source: 'unknown', count: 1 })
      }
    }
    return Array.from(byDoc.entries()).map(([id, meta]) => ({ id, ...meta }))
  }, [documents, chunks])

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return chunks.filter((row) => {
      if (ns && row.docId !== ns) return false
      if (!q) return true
      return (
        row.id.toLowerCase().includes(q) ||
        row.docId.toLowerCase().includes(q) ||
        row.title.toLowerCase().includes(q) ||
        row.head.toLowerCase().includes(q) ||
        (row.tail ?? '').toLowerCase().includes(q)
      )
    })
  }, [chunks, ns, filter])

  const ready = (rag?.retrieval === 'hybrid' || rag?.retrieval === 'vector') && (rag.indexed ?? 0) > 0
  const dim = indexMeta.dim || rag?.dim || 0
  const model = indexMeta.model || rag?.embedding || '—'

  function selectNs(id: string | null) {
    setNs(id)
    setOpenId(null)
    const base = '#/vectors'
    location.hash = id ? `${base}?doc=${encodeURIComponent(id)}` : base
  }

  return (
    <div className="vd">
      <header className="vd-bar">
        <div className="vd-bar__id">
          <span className="vd-dot" />
          <div>
            <div className="vd-name">knowledge</div>
            <div className="vd-path">collection · local file index</div>
          </div>
        </div>
        <dl className="vd-stats">
          <div>
            <dt>Status</dt>
            <dd>
              <span className={ready ? 'vd-pill vd-pill--ok' : 'vd-pill vd-pill--warn'}>
                {ready ? 'READY' : rag?.embedError ? 'DEGRADED' : 'KEYWORD'}
              </span>
            </dd>
          </div>
          <div>
            <dt>Metric</dt>
            <dd>cosine</dd>
          </div>
          <div>
            <dt>Dimensions</dt>
            <dd>{dim || '—'}</dd>
          </div>
          <div>
            <dt>Vectors</dt>
            <dd>
              {chunks.length}
              <span className="vd-muted"> / {rag?.chunks ?? 0} chunks</span>
            </dd>
          </div>
          <div>
            <dt>Embedding</dt>
            <dd className="vd-mono">{model}</dd>
          </div>
        </dl>
      </header>

      <div className="vd-body">
        <aside className="vd-ns">
          <div className="vd-ns__label">Namespaces</div>
          <button
            type="button"
            className={!ns ? 'vd-ns__item vd-ns__item--on' : 'vd-ns__item'}
            onClick={() => selectNs(null)}
          >
            <span>all</span>
            <span className="vd-ns__count">{chunks.length}</span>
          </button>
          {namespaces.map((n) => (
            <button
              key={n.id}
              type="button"
              className={ns === n.id ? 'vd-ns__item vd-ns__item--on' : 'vd-ns__item'}
              onClick={() => selectNs(n.id)}
            >
              <span>
                <span className="vd-ns__id">{n.id}</span>
                <span className="vd-ns__file">{n.label}</span>
              </span>
              <span className="vd-ns__count">{n.count}</span>
            </button>
          ))}
        </aside>

        <section className="vd-main">
          {error && <div className="error-banner vd-error">{error}</div>}
          <div className="vd-toolbar">
            <input
              className="vd-filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by id, namespace, or payload…"
              spellCheck={false}
            />
            <span className="vd-toolbar__meta">
              {rows.length} points
              {ns ? ` · ns=${ns}` : ''}
            </span>
            <a className="vd-link" href="#/documents">
              Documents
            </a>
          </div>

          <div className="vd-table-wrap">
            <table className="vd-table">
              <thead>
                <tr>
                  <th className="vd-col-id">ID</th>
                  <th className="vd-col-ns">Namespace</th>
                  <th>Metadata</th>
                  <th className="vd-col-vec">Vector</th>
                  <th className="vd-col-n">Size</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="vd-empty">
                      {chunks.length === 0
                        ? '索引还是空的（模型未就绪或尚未编码）。'
                        : '当前 namespace / filter 没有点。'}
                    </td>
                  </tr>
                )}
                {rows.map((row) => {
                  const open = openId === row.id
                  const floats = row.vectorHead
                    .slice(0, 6)
                    .map((n) => n.toFixed(3))
                    .join(', ')
                  return (
                    <FragmentRow
                      key={row.id}
                      row={row}
                      open={open}
                      floats={floats}
                      onToggle={() => setOpenId(open ? null : row.id)}
                    />
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  )
}

function FragmentRow({
  row,
  open,
  floats,
  onToggle,
}: {
  row: IndexRow
  open: boolean
  floats: string
  onToggle: () => void
}) {
  const payload = payloadPreview(row)
  return (
    <>
      <tr className={open ? 'vd-row vd-row--open' : 'vd-row'} onClick={onToggle}>
        <td className="vd-mono vd-id">{row.id}</td>
        <td className="vd-mono vd-dim">{row.docId}</td>
        <td>
          <span className="vd-chip">{row.title}</span>
        </td>
        <td>
          <div className="vd-vec">
            <VectorStrip values={row.vectorHead} />
            <code>
              [{floats}, …] <span className="vd-muted">dim={row.dim}</span>
            </code>
          </div>
        </td>
        <td className="vd-num">{row.chars}</td>
      </tr>
      {open && (
        <tr className="vd-payload">
          <td colSpan={5}>
            <div className="vd-payload__grid">
              <div>
                <div className="vd-payload__k">payload</div>
                <pre>{JSON.stringify(payload, null, 2)}</pre>
              </div>
              <div>
                <div className="vd-payload__k">values[:{row.vectorHead.length}]</div>
                <pre>[{row.vectorHead.join(', ')}]</pre>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
