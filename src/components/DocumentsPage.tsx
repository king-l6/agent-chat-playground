/**
 * 文档页：只管理原文（上传 / 列表 / 删除）
 * 切成了哪些向量 → 去「向量库」页，按文档分组看
 */
import { useCallback, useEffect, useState } from 'react'
import {
  deleteKnowledgeFile,
  fetchKnowledgeBoard,
  uploadKnowledge,
  type KnowledgeDoc,
} from '../api/chat'
import './KnowledgePage.css'

export function DocumentsPage() {
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
    <div className="kb">
      {error && <div className="error-banner">{error}</div>}
      {hint && <p className="kb__hint">{hint}</p>}

      <section className="kb-card">
        <header className="kb-card__head">
          <div>
            <h2>文档</h2>
            <p>原文文件。内置不能删。每次上传都是新文档（即使文件名相同）；要替换就先删旧的。</p>
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
                <td>{doc.source === 'upload' ? '上传' : '内置'}</td>
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
                  {doc.source === 'upload' && (
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
