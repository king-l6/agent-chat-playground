/**
 * 向量库控制台：集合状态 + namespace 侧栏 + points 表
 * 对照 Pinecone / Qdrant 的 Browser，不是文档卡片
 * 大索引只拉一页 points；侧栏按目录懒展开，避免一次挂 500+ 节点
 */
import { useCallback, useEffect, useState } from 'react'
import {
  fetchKnowledgeBoard,
  fetchKnowledgeChunks,
  fetchKnowledgeNamespacePath,
  fetchKnowledgeNamespaces,
  type IndexRow,
  type NamespaceChild,
  type RagStatus,
} from '../api/chat'
import './VectorsPage.css'

const PAGE_SIZE = 50

function focusDocId(): string | null {
  const q = location.hash.split('?')[1]
  if (!q) return null
  return new URLSearchParams(q).get('doc')
}

/** 一条 CSS 渐变代替几十个 span，少造 DOM */
function VectorStrip({ values }: { values: number[] }) {
  const amp = Math.max(...values.map((v) => Math.abs(v)), 0.04)
  const stops = values
    .map((v, i) => {
      const t = v / amp
      const hue = t >= 0 ? 162 : 18
      const light = 42 + Math.abs(t) * 18
      const alpha = 0.35 + Math.abs(t) * 0.65
      const pct = values.length <= 1 ? 0 : (i / (values.length - 1)) * 100
      return `hsla(${hue} 72% ${light}% / ${alpha}) ${pct.toFixed(1)}%`
    })
    .join(', ')
  return (
    <div
      className="vd-strip"
      title={values.map((v) => v.toFixed(3)).join('  ')}
      style={{ background: `linear-gradient(90deg, ${stops})` }}
    />
  )
}

function payloadPreview(row: IndexRow) {
  const text = row.tail != null ? `${row.head} … ${row.tail}` : row.head
  return { docId: row.docId, title: row.title, chars: row.chars, text }
}

function LazyNsTree({
  nodes,
  selected,
  open,
  loaded,
  loading,
  onToggle,
  onSelect,
}: {
  nodes: NamespaceChild[]
  selected: string | null
  open: Set<string>
  loaded: Map<string, NamespaceChild[]>
  loading: Set<string>
  onToggle: (path: string) => void
  onSelect: (id: string) => void
}) {
  return (
    <ul className="vd-tree">
      {nodes.map((node) => {
        if (node.kind === 'file') {
          return (
            <li key={node.id ?? node.path}>
              <button
                type="button"
                className={selected === node.id ? 'vd-ns__item vd-ns__item--on' : 'vd-ns__item'}
                onClick={() => node.id && onSelect(node.id)}
                title={node.path}
              >
                <span className="vd-ns__file">{node.name}</span>
                <span className="vd-ns__count">{node.count}</span>
              </button>
            </li>
          )
        }
        const expanded = open.has(node.path)
        const kids = loaded.get(node.path)
        const busy = loading.has(node.path)
        return (
          <li key={node.path}>
            <button type="button" className="vd-ns__dir" onClick={() => onToggle(node.path)}>
              <span className={expanded ? 'vd-ns__chev vd-ns__chev--open' : 'vd-ns__chev'} />
              <span className="vd-ns__dir-name">{node.name}</span>
              <span className="vd-ns__count">{node.count}</span>
            </button>
            {expanded ? (
              busy && !kids ? (
                <div className="vd-ns__loading">加载中…</div>
              ) : kids && kids.length > 0 ? (
                <LazyNsTree
                  nodes={kids}
                  selected={selected}
                  open={open}
                  loaded={loaded}
                  loading={loading}
                  onToggle={onToggle}
                  onSelect={onSelect}
                />
              ) : kids ? (
                <div className="vd-ns__loading">空目录</div>
              ) : null
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

export function VectorsPage() {
  const [rag, setRag] = useState<RagStatus | null>(null)
  const [chunks, setChunks] = useState<IndexRow[]>([])
  const [pageTotal, setPageTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loadingPage, setLoadingPage] = useState(false)
  const [indexMeta, setIndexMeta] = useState({ model: '', dim: 0 })
  const [error, setError] = useState('')
  const [ns, setNs] = useState<string | null>(focusDocId)
  const [filter, setFilter] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [openDirs, setOpenDirs] = useState<Set<string>>(() => new Set())
  const [loaded, setLoaded] = useState<Map<string, NamespaceChild[]>>(() => new Map())
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(() => new Set())

  const loadLevel = useCallback(async (path: string) => {
    setLoadingDirs((prev) => {
      const next = new Set(prev)
      next.add(path)
      return next
    })
    try {
      const data = await fetchKnowledgeNamespaces(path)
      setLoaded((prev) => {
        const next = new Map(prev)
        next.set(path, data.children)
        return next
      })
    } finally {
      setLoadingDirs((prev) => {
        const next = new Set(prev)
        next.delete(path)
        return next
      })
    }
  }, [])

  const reloadMeta = useCallback(async () => {
    const data = await fetchKnowledgeBoard({ lite: true })
    setRag(data.rag)
    setIndexMeta({ model: data.index.model, dim: data.index.dim })
  }, [])

  useEffect(() => {
    reloadMeta().catch((err) => setError(err instanceof Error ? err.message : String(err)))
    loadLevel('').catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [reloadMeta, loadLevel])

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(filter.trim()), 250)
    return () => window.clearTimeout(t)
  }, [filter])

  useEffect(() => {
    setOffset(0)
    setOpenId(null)
  }, [ns, debouncedQ])

  useEffect(() => {
    let cancelled = false
    setLoadingPage(true)
    fetchKnowledgeChunks({ doc: ns, q: debouncedQ, offset, limit: PAGE_SIZE })
      .then((page) => {
        if (cancelled) return
        setChunks(page.chunks)
        setPageTotal(page.total)
        setError('')
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoadingPage(false)
      })
    return () => {
      cancelled = true
    }
  }, [ns, debouncedQ, offset])

  useEffect(() => {
    const onHash = () => setNs(focusDocId())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  /** 深链 ?doc= 时解析路径并逐层展开 */
  useEffect(() => {
    if (!ns) return
    let cancelled = false
    ;(async () => {
      try {
        const parts = await fetchKnowledgeNamespacePath(ns)
        if (cancelled || !parts?.length) return
        const ancestorPaths: string[] = []
        for (let i = 0; i < parts.length - 1; i += 1) {
          ancestorPaths.push(parts.slice(0, i + 1).join('/'))
        }
        setOpenDirs((prev) => {
          const next = new Set(prev)
          for (const p of ancestorPaths) next.add(p)
          return next
        })
        for (const p of ['', ...ancestorPaths]) {
          if (cancelled) return
          await loadLevel(p)
        }
      } catch {
        /* 展开失败不挡表格 */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [ns, loadLevel])

  const ready = (rag?.retrieval === 'hybrid' || rag?.retrieval === 'vector') && (rag.indexed ?? 0) > 0
  const dim = indexMeta.dim || rag?.dim || 0
  const model = indexMeta.model || rag?.embedding || '—'
  const totalVectors = rag?.indexed ?? rag?.chunks ?? 0
  const pageFrom = pageTotal === 0 ? 0 : offset + 1
  const pageTo = Math.min(offset + chunks.length, pageTotal)
  const canPrev = offset > 0
  const canNext = offset + PAGE_SIZE < pageTotal
  const rootChildren = loaded.get('') ?? []

  function selectNs(id: string | null) {
    setNs(id)
    setOpenId(null)
    const base = '#/vectors'
    location.hash = id ? `${base}?doc=${encodeURIComponent(id)}` : base
  }

  function toggleDir(path: string) {
    setOpenDirs((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
        if (!loaded.has(path)) void loadLevel(path)
      }
      return next
    })
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
              {totalVectors}
              <span className="vd-muted"> / {rag?.chunks ?? 0} chunks</span>
            </dd>
          </div>
          <div>
            <dt>Images</dt>
            <dd>
              {rag?.images ?? 0}
              <span className="vd-muted"> · CLIP</span>
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
            <span className="vd-ns__count">{totalVectors}</span>
          </button>
          <LazyNsTree
            nodes={rootChildren}
            selected={ns}
            open={openDirs}
            loaded={loaded}
            loading={loadingDirs}
            onToggle={toggleDir}
            onSelect={selectNs}
          />
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
              {loadingPage ? '加载中…' : `${pageFrom}–${pageTo} / ${pageTotal} points`}
              {ns ? ` · ns=${ns}` : ''}
            </span>
            <div className="vd-pager">
              <button
                type="button"
                disabled={!canPrev || loadingPage}
                onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
              >
                上一页
              </button>
              <button
                type="button"
                disabled={!canNext || loadingPage}
                onClick={() => setOffset((o) => o + PAGE_SIZE)}
              >
                下一页
              </button>
            </div>
            <a className="vd-link" href="#/documents?tab=ingest">
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
                {chunks.length === 0 && (
                  <tr>
                    <td colSpan={5} className="vd-empty">
                      {loadingPage
                        ? '加载中…'
                        : totalVectors === 0
                          ? '索引还是空的（模型未就绪或尚未编码）。'
                          : '当前 namespace / filter 没有点。'}
                    </td>
                  </tr>
                )}
                {chunks.map((row) => {
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
