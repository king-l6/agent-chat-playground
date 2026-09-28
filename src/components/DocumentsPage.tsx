/**
 * 文档页：浏览拷过来的 wiki Markdown；「入库」仍是原来的 RAG 上传。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  deleteKnowledgeFile,
  fetchKnowledgeBoard,
  fetchWikiDoc,
  fetchWikiIngestStatus,
  fetchWikiTree,
  ingestWikiBatch,
  ingestWikiOne,
  uploadKnowledge,
  type KnowledgeDoc,
  type WikiIngestStatus,
  type WikiNode,
} from '../api/chat'
import { normalizeWeworkMarkdown } from '../lib/weworkMarkdown'
import './KnowledgePage.css'
import './DocumentsPage.css'

function hashQuery(): URLSearchParams {
  const q = location.hash.split('?')[1] || ''
  return new URLSearchParams(q)
}

function currentTab(): 'wiki' | 'ingest' {
  return hashQuery().get('tab') === 'ingest' ? 'ingest' : 'wiki'
}

function currentWikiPath(): string {
  return hashQuery().get('path') || ''
}

function setDocHash(next: { tab?: 'wiki' | 'ingest'; path?: string }) {
  const params = new URLSearchParams()
  if (next.tab === 'ingest') params.set('tab', 'ingest')
  if (next.path) params.set('path', next.path)
  const qs = params.toString()
  location.hash = qs ? `#/documents?${qs}` : '#/documents'
}

function filterTree(nodes: WikiNode[], q: string): WikiNode[] {
  if (!q) return nodes
  const needle = q.toLowerCase()
  const keep: WikiNode[] = []
  for (const node of nodes) {
    if (node.type === 'file') {
      if (node.name.toLowerCase().includes(needle) || node.path.toLowerCase().includes(needle)) {
        keep.push(node)
      }
      continue
    }
    const children = filterTree(node.children ?? [], q)
    if (children.length > 0 || node.name.toLowerCase().includes(needle)) {
      keep.push({ ...node, children })
    }
  }
  return keep
}

function ancestorPaths(filePath: string): string[] {
  const parts = filePath.split('/')
  const out: string[] = []
  for (let i = 1; i < parts.length; i += 1) {
    out.push(parts.slice(0, i).join('/'))
  }
  return out
}

function Tree({
  nodes,
  selected,
  open,
  onToggle,
  onOpen,
}: {
  nodes: WikiNode[]
  selected: string
  open: Set<string>
  onToggle: (path: string) => void
  onOpen: (path: string) => void
}) {
  return (
    <ul className="wiki-tree">
      {nodes.map((node) => {
        if (node.type === 'file') {
          return (
            <li key={node.path}>
              <button
                type="button"
                className={selected === node.path ? 'wiki-tree__file wiki-tree__file--on' : 'wiki-tree__file'}
                onClick={() => onOpen(node.path)}
              >
                {node.name}
              </button>
            </li>
          )
        }
        const expanded = open.has(node.path)
        return (
          <li key={node.path}>
            <button
              type="button"
              className="wiki-tree__dir"
              onClick={() => onToggle(node.path)}
            >
              <span className={expanded ? 'wiki-tree__chev wiki-tree__chev--open' : 'wiki-tree__chev'} />
              {node.name}
            </button>
            {expanded && node.children && node.children.length > 0 ? (
              <Tree
                nodes={node.children}
                selected={selected}
                open={open}
                onToggle={onToggle}
                onOpen={onOpen}
              />
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

function WikiBrowser() {
  const [tree, setTree] = useState<WikiNode[]>([])
  const [count, setCount] = useState(0)
  const [exists, setExists] = useState(true)
  const [query, setQuery] = useState('')
  const [path, setPath] = useState(currentWikiPath)
  const [content, setContent] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [ingestBusy, setIngestBusy] = useState(false)
  const [ingestHint, setIngestHint] = useState('')
  const [job, setJob] = useState<WikiIngestStatus | null>(null)
  const [open, setOpen] = useState<Set<string>>(() => new Set(ancestorPaths(currentWikiPath())))

  useEffect(() => {
    fetchWikiTree()
      .then((data) => {
        setTree(data.tree)
        setCount(data.count)
        setExists(data.exists)
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
    fetchWikiIngestStatus()
      .then(setJob)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!job?.running) return
    const timer = window.setInterval(() => {
      fetchWikiIngestStatus()
        .then((next) => {
          setJob(next)
          if (!next.running) {
            setIngestHint(
              `批量完成：成功 ${next.ok}，失败 ${next.failed}（共 ${next.total}）`,
            )
          }
        })
        .catch(() => undefined)
    }, 1500)
    return () => window.clearInterval(timer)
  }, [job?.running])

  useEffect(() => {
    const onHash = () => setPath(currentWikiPath())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    if (!path) {
      setContent('')
      return
    }
    setBusy(true)
    setError('')
    fetchWikiDoc(path)
      .then((doc) => {
        setContent(doc.content)
        setOpen((prev) => {
          const next = new Set(prev)
          for (const p of ancestorPaths(path)) next.add(p)
          return next
        })
      })
      .catch((err) => {
        setContent('')
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setBusy(false))
  }, [path])

  const visible = useMemo(() => filterTree(tree, query.trim()), [tree, query])

  function toggle(dirPath: string) {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(dirPath)) next.delete(dirPath)
      else next.add(dirPath)
      return next
    })
  }

  async function onIngestOne() {
    if (!path || ingestBusy || job?.running) return
    setIngestBusy(true)
    setError('')
    setIngestHint('正在切块并编码这一篇…')
    try {
      const data = await ingestWikiOne(path)
      setIngestHint(`已入库：${data.chunks} 块 · 向量 ${data.rag.indexed}/${data.rag.chunks}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setIngestHint('')
    } finally {
      setIngestBusy(false)
    }
  }

  async function onIngestBatch(limit?: number) {
    if (ingestBusy || job?.running) return
    const label =
      limit != null
        ? `先入库 ${limit} 篇（本机 BGE 较慢，建议先小批量试）`
        : `入库全部 ${count} 篇？本机编码可能要很久，可先到向量库页看进度。`
    if (!confirm(label)) return
    setIngestBusy(true)
    setError('')
    setIngestHint('已启动批量入库…')
    try {
      const data = await ingestWikiBatch(limit ? { limit } : {})
      setJob(data.status)
      setIngestHint(`批量进行中 0/${data.status.total}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setIngestHint('')
    } finally {
      setIngestBusy(false)
    }
  }

  return (
    <div className="wiki">
      <aside className="wiki__nav">
        <input
          className="wiki__search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`搜索 ${count} 篇文档`}
        />
        {!exists ? (
          <p className="wiki__empty">还没有拷贝 wiki。把导出目录放到 server/data/wiki，或设置 PLAYGROUND_WIKI。</p>
        ) : visible.length === 0 ? (
          <p className="wiki__empty">没有匹配的文档。</p>
        ) : (
          <Tree
            nodes={visible}
            selected={path}
            open={query.trim() ? new Set(collectDirs(visible)) : open}
            onToggle={toggle}
            onOpen={(next) => setDocHash({ path: next })}
          />
        )}
      </aside>
      <article className="wiki__doc">
        {error && <div className="error-banner">{error}</div>}
        {(ingestHint || job?.running) && (
          <p className="wiki__ingest-hint">
            {job?.running
              ? `批量入库 ${job.done}/${job.total} · ${job.current || '…'}`
              : ingestHint}
          </p>
        )}
        {!path && !error ? (
          <div className="wiki__placeholder">
            <h2>文档</h2>
            <p>从左侧选一篇预览。要进对话检索，点「入库这篇」或下面批量入库（会切块 + 本地 BGE 编码）。</p>
            <div className="wiki__ingest-row">
              <button
                type="button"
                className="wiki__ingest"
                disabled={ingestBusy || Boolean(job?.running) || count === 0}
                onClick={() => void onIngestBatch(20)}
              >
                先入库 20 篇
              </button>
              <button
                type="button"
                className="wiki__ingest wiki__ingest--ghost"
                disabled={ingestBusy || Boolean(job?.running) || count === 0}
                onClick={() => void onIngestBatch()}
              >
                入库全部 {count} 篇
              </button>
            </div>
          </div>
        ) : null}
        {path ? (
          <>
            <header className="wiki__head">
              <p>{path.replace(/\.md$/i, '')}</p>
              <div className="wiki__ingest-row">
                <button
                  type="button"
                  className="wiki__ingest"
                  disabled={ingestBusy || Boolean(job?.running)}
                  onClick={() => void onIngestOne()}
                >
                  {ingestBusy ? '入库中…' : '入库这篇'}
                </button>
                <button
                  type="button"
                  className="wiki__ingest wiki__ingest--ghost"
                  disabled={ingestBusy || Boolean(job?.running)}
                  onClick={() => void onIngestBatch(20)}
                >
                  先入库 20 篇
                </button>
                <a className="wiki__ingest-link" href="#/vectors">
                  看向量库
                </a>
              </div>
            </header>
            {busy && !content ? <p className="wiki__empty">读取中…</p> : null}
            {content ? (
              <div className="wiki__md">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    img: ({ src, alt }) => (
                      <img src={src} alt={alt ?? ''} referrerPolicy="no-referrer" loading="lazy" />
                    ),
                  }}
                >
                  {normalizeWeworkMarkdown(content)}
                </ReactMarkdown>
              </div>
            ) : null}
          </>
        ) : null}
      </article>
    </div>
  )
}

function collectDirs(nodes: WikiNode[]): string[] {
  const out: string[] = []
  for (const node of nodes) {
    if (node.type === 'dir') {
      out.push(node.path)
      out.push(...collectDirs(node.children ?? []))
    }
  }
  return out
}

function IngestPanel() {
  const [documents, setDocuments] = useState<KnowledgeDoc[]>([])
  const [hint, setHint] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    const data = await fetchKnowledgeBoard()
    setDocuments(data.documents)
  }, [])

  useEffect(() => {
    reload().catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [reload])

  async function onUpload(file: File | undefined) {
    if (!file) return
    setBusy(true)
    setError('')
    setHint('正在切块并编码…')
    try {
      const data = await uploadKnowledge(file)
      setHint(`已入库 ${data.filename}`)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setHint('')
    } finally {
      setBusy(false)
    }
  }

  async function onDelete(docId: string, label: string) {
    if (!confirm(`删除 ${label} 并重建索引？`)) return
    setBusy(true)
    setError('')
    try {
      await deleteKnowledgeFile(docId)
      setHint(`已删除 ${label}`)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="kb wiki-ingest">
      {error && <div className="error-banner">{error}</div>}
      {hint && <p className="kb__hint">{hint}</p>}

      <section className="kb-card">
        <header className="kb-card__head">
          <div>
            <h2>RAG 入库</h2>
            <p>
              上传后会切块进向量库，对话里的 search_notes 能搜到。wiki 批量入库请回「文档」页点「入库这篇 /
              先入库 20 篇」。
            </p>
          </div>
          <label className={`upload ${busy ? 'upload--busy' : ''}`}>
            {busy ? '处理中…' : '上传 .md / .txt'}
            <input
              type="file"
              accept=".md,.txt,.markdown,text/plain,text/markdown"
              hidden
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                void onUpload(file)
              }}
            />
          </label>
        </header>
        <table className="kb-table">
          <thead>
            <tr>
              <th>来源</th>
              <th>文件名</th>
              <th>文档 id</th>
              <th>切块数</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {documents.map((doc) => (
              <tr key={doc.docId}>
                <td>
                  {doc.source === 'wiki' ? 'wiki' : doc.source === 'upload' ? '上传' : '内置'}
                </td>
                <td>
                  <strong>{doc.filename || doc.title}</strong>
                </td>
                <td>
                  <div className="kb-table__meta">{doc.docId}</div>
                </td>
                <td>{doc.chunkCount}</td>
                <td className="kb-table__actions">
                  <a className="kb-link" href={`#/vectors?doc=${encodeURIComponent(doc.docId)}`}>
                    查看 {doc.chunkCount} 条向量
                  </a>
                  {(doc.source === 'upload' || doc.source === 'wiki') && (
                    <button
                      type="button"
                      className="kb-del"
                      disabled={busy}
                      onClick={() => void onDelete(doc.docId, doc.filename || doc.title)}
                    >
                      删除
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}

export function DocumentsPage() {
  const [tab, setTab] = useState(currentTab)

  useEffect(() => {
    const onHash = () => setTab(currentTab())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  return (
    <div className="docs">
      <div className="docs__tabs">
        <button
          type="button"
          className={tab === 'wiki' ? 'docs__tab docs__tab--on' : 'docs__tab'}
          onClick={() => setDocHash({ tab: 'wiki', path: currentWikiPath() })}
        >
          文档
        </button>
        <button
          type="button"
          className={tab === 'ingest' ? 'docs__tab docs__tab--on' : 'docs__tab'}
          onClick={() => setDocHash({ tab: 'ingest' })}
        >
          RAG 入库
        </button>
      </div>
      {tab === 'ingest' ? <IngestPanel /> : <WikiBrowser />}
    </div>
  )
}
