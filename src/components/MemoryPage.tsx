/**
 * 记忆页：把「跨不跨会话」这件事直接摊在界面上。
 *
 *   长期记忆 tab —— 落 server/data/memory/<id>.md，跨会话、跨刷新，可编辑可删可归档
 *   短期记忆 tab —— 会话内那层（滚动摘要 + 最近 K 轮原文 + 会话暂存板），P3 接上服务端会话后填充
 *
 * 页面里有两处是「解释给面试官听」的：
 *   1. 召回预览：输一句话，看它命中哪几条、cos 多少、跟基线比高多少。
 *      之所以要把 baseline 显示出来，是因为实测发现区分度主要来自 query 一侧
 *      （同一句话对所有条目的 cos 只差 ±0.05，不同话的基线能从 0.29 到 0.55）。
 *   2. 记忆日志：ADD/UPDATE/DELETE/NOOP 的决策记录，用来解释「全自动写」为什么可信。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  MEMORY_STATUS_LABEL,
  MEMORY_TYPE_LABEL,
  createMemory,
  deleteMemory,
  fetchMemories,
  fetchMemoryLog,
  fetchMemoryStats,
  previewRecall,
  setMemoryArchived,
  sweepMemories,
  updateMemory,
  type MemoryEntry,
  type MemoryLogRow,
  type MemoryStats,
  type MemoryType,
  type RecallPreview,
} from '../api/memory'
import './MemoryPage.css'

const TYPES: MemoryType[] = ['user', 'preference', 'project', 'reference']

type Tab = 'long' | 'short'

function fmt(ms: number | null): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 空表单 */
const BLANK = { description: '', text: '', type: 'user' as MemoryType, salience: 0.7 }

export function MemoryPage() {
  const [tab, setTab] = useState<Tab>('long')
  const [stats, setStats] = useState<MemoryStats | null>(null)
  const [items, setItems] = useState<MemoryEntry[]>([])
  const [log, setLog] = useState<MemoryLogRow[]>([])
  const [q, setQ] = useState('')
  const [typeFilter, setTypeFilter] = useState<MemoryType | 'all'>('all')
  const [statusFilter, setStatusFilter] = useState<'active' | 'archived' | 'all'>('all')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  /** 正在编辑的条目 id；'new' 表示新增表单 */
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [form, setForm] = useState(BLANK)

  // 召回预览
  const [probe, setProbe] = useState('')
  const [recall, setRecall] = useState<RecallPreview | null>(null)

  const load = useCallback(async () => {
    setError('')
    try {
      const [s, list, rows] = await Promise.all([
        fetchMemoryStats(),
        fetchMemories({ q, type: typeFilter, status: statusFilter, limit: 200 }),
        fetchMemoryLog(60),
      ])
      setStats(s)
      setItems(list.items)
      setLog(rows)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [q, typeFilter, statusFilter])

  useEffect(() => {
    void load()
  }, [load])

  async function run<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
    setBusy(true)
    setError('')
    try {
      return await fn()
    } catch (err) {
      setError(`${what}：${err instanceof Error ? err.message : String(err)}`)
      return null
    } finally {
      setBusy(false)
    }
  }

  async function submit() {
    if (!form.description.trim()) {
      setError('摘要不能为空——它决定了这条记忆能不能被召回（向量就是拿它算的）')
      return
    }
    const payload = {
      description: form.description.trim(),
      text: form.text.trim() || form.description.trim(),
      type: form.type,
      salience: form.salience,
    }
    const ok = await run(editing === 'new' ? '新增' : '保存', () =>
      editing === 'new' ? createMemory(payload) : updateMemory(editing as string, payload),
    )
    if (!ok) return
    setEditing(null)
    setForm(BLANK)
    await load()
  }

  async function remove(entry: MemoryEntry) {
    // 删除是不可逆的，归档不是——提示里说清区别
    if (!window.confirm(`删除「${entry.description}」？\n\n删除后向量一并清掉。只想让它不再被召回就打「归档」。`)) {
      return
    }
    if (await run('删除', () => deleteMemory(entry.id))) await load()
  }

  async function toggleArchive(entry: MemoryEntry) {
    const toArchive = entry.status !== 'archived'
    if (await run(toArchive ? '归档' : '恢复', () => setMemoryArchived(entry.id, toArchive))) await load()
  }

  async function doSweep() {
    const r = await run('衰减扫描', () => sweepMemories())
    if (r) {
      setError('')
      window.alert(`归档 ${r.expired.length} 条过期、${r.stale.length} 条久未召回（可随时恢复）`)
      await load()
    }
  }

  async function doProbe() {
    if (!probe.trim()) return
    const r = await run('召回预览', () => previewRecall(probe.trim()))
    if (r) setRecall(r)
  }

  const activeCount = useMemo(() => items.filter((e) => e.status === 'active').length, [items])

  return (
    <div className="mem">
      <div className="mem-bar">
        <div className="mem-bar__tabs">
          <button
            type="button"
            className={`mem-tab ${tab === 'long' ? 'mem-tab--on' : ''}`}
            onClick={() => setTab('long')}
          >
            长期记忆 <span className="mem-tab__n">{stats?.total ?? 0}</span>
          </button>
          <button
            type="button"
            className={`mem-tab ${tab === 'short' ? 'mem-tab--on' : ''}`}
            onClick={() => setTab('short')}
          >
            短期记忆
          </button>
        </div>
        <div className="mem-bar__meta">
          {stats && (
            <>
              <span className="mem-chip mem-chip--on">生效 {stats.active}</span>
              <span className="mem-chip">归档 {stats.archived}</span>
              <span className="mem-chip">
                有向量 {stats.embedded}/{stats.total}
              </span>
              <span className="mem-chip mem-chip--dim">{stats.model}</span>
            </>
          )}
          {tab === 'long' && (
            <>
              <button type="button" className="mem-btn" onClick={() => void doSweep()} disabled={busy}>
                衰减扫描
              </button>
              <button
                type="button"
                className="mem-btn mem-btn--primary"
                onClick={() => {
                  setEditing('new')
                  setForm(BLANK)
                }}
                disabled={busy}
              >
                手动记录
              </button>
            </>
          )}
        </div>
      </div>

      {error && <div className="error-banner mem-error">{error}</div>}

      {tab === 'short' ? (
        <div className="mem-body">
          <div className="mem-empty">
            <p>
              <strong>短期记忆 = 会话内那层。</strong>它跨刷新、但<strong>不跨会话</strong>：换个会话就看不见了。
            </p>
            <p>按设计由服务端持有，三块内容分开显示：</p>
            <ul className="mem-list">
              <li>滚动摘要 —— 老轮次折叠成的单段文本（带「覆盖到第几轮」，可审计）</li>
              <li>最近 K 轮原文 —— 不压缩，直接进上下文</li>
              <li>会话暂存板 —— 本会话内有用、但过不了长期记忆那三道闸的事实</li>
            </ul>
            <p className="mem-dim">
              会话落盘（server/data/sessions/&lt;id&gt;.json）和滚动摘要在下一阶段接上，现在 /api/sessions
              还不存在，所以这一页是空的。
            </p>
          </div>
        </div>
      ) : (
        <div className="mem-body">
          {/* —— 召回预览：回答「这句话会命中哪几条、为什么」—— */}
          <div className="mem-probe">
            <div className="mem-probe__head">
              <span className="mem-label">召回预览</span>
              <span className="mem-dim">
                每轮聊天前拿用户这句话去比一遍长期记忆，过线的注入 system（最多 {recall?.topK ?? 3} 条，cos ≥{' '}
                {recall?.minCosine ?? 0.45}）
              </span>
            </div>
            <div className="mem-probe__row">
              <input
                className="mem-input"
                placeholder="输入一句话，例如：我准备面试该从哪下手"
                value={probe}
                onChange={(e) => setProbe(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void doProbe()
                }}
              />
              <button type="button" className="mem-btn" onClick={() => void doProbe()} disabled={busy}>
                试
              </button>
            </div>
            {recall && (
              <div className="mem-probe__out">
                <div className="mem-probe__sum">
                  基线 cos {recall.baseline}（这句话对全部记忆的均值）· 被门槛挡掉 {recall.blocked} 条
                  {recall.baseline >= recall.minCosine && (
                    <span className="mem-warn">
                      {' '}
                      · 基线已经高过门槛了：这句话跟什么都像，命中不代表真相关
                    </span>
                  )}
                </div>
                {recall.hits.length === 0 ? (
                  <div className="mem-dim">库里还没有 active 记忆</div>
                ) : (
                  recall.hits.map((h) => (
                    <div key={h.id} className={`mem-hit ${h.pass ? 'mem-hit--on' : ''}`}>
                      <span className="mem-hit__cos">cos {h.cos.toFixed(4)}</span>
                      <span className="mem-hit__gap">
                        {h.gap >= 0 ? '+' : ''}
                        {h.gap.toFixed(4)} vs 基线
                      </span>
                      <span className={`mem-badge mem-badge--${h.type}`}>{MEMORY_TYPE_LABEL[h.type]}</span>
                      <span className="mem-hit__txt">{h.description}</span>
                      <span className={`mem-verdict ${h.pass ? 'mem-verdict--ok' : ''}`}>
                        {h.pass ? '注入' : '挡掉'}
                      </span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          {/* —— 新增 / 编辑表单 —— */}
          {editing && (
            <div className="mem-form">
              <div className="mem-form__row">
                <input
                  className="mem-input mem-input--wide"
                  placeholder="摘要（一行，召回靠它）"
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
                <select
                  className="mem-select"
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value as MemoryType })}
                >
                  {TYPES.map((t) => (
                    <option key={t} value={t}>
                      {MEMORY_TYPE_LABEL[t]}
                    </option>
                  ))}
                </select>
                <label className="mem-slider">
                  salience {form.salience.toFixed(2)}
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={form.salience}
                    onChange={(e) => setForm({ ...form, salience: Number(e.target.value) })}
                  />
                </label>
              </div>
              <textarea
                className="mem-textarea"
                rows={3}
                placeholder="正文：这条事实本身（一条只装一个事实，多了向量会被摊平）"
                value={form.text}
                onChange={(e) => setForm({ ...form, text: e.target.value })}
              />
              <div className="mem-form__foot">
                <button type="button" className="mem-btn mem-btn--primary" onClick={() => void submit()} disabled={busy}>
                  {editing === 'new' ? '保存' : '保存修改'}
                </button>
                <button
                  type="button"
                  className="mem-btn"
                  onClick={() => {
                    setEditing(null)
                    setForm(BLANK)
                  }}
                >
                  取消
                </button>
              </div>
            </div>
          )}

          {/* —— 筛选 + 列表 —— */}
          <div className="mem-toolbar">
            <input
              className="mem-input"
              placeholder="搜摘要 / 正文 / id"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <select
              className="mem-select"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as MemoryType | 'all')}
            >
              <option value="all">全部类型</option>
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {MEMORY_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
            <select
              className="mem-select"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as 'active' | 'archived' | 'all')}
            >
              <option value="all">全部状态</option>
              <option value="active">生效中</option>
              <option value="archived">已归档</option>
            </select>
            <span className="mem-dim">
              命中 {items.length} 条（生效 {activeCount}）
            </span>
            <button type="button" className="mem-btn" onClick={() => void load()} disabled={busy}>
              刷新
            </button>
          </div>

          {items.length === 0 ? (
            <div className="mem-empty">
              <p>还没有长期记忆。</p>
              <p>
                <strong>什么时候才会写进来：</strong>说出「跨会话仍然成立、下次还会用到」的事实（岗位、面试时间、
                技术栈偏好、项目背景），过三道闸（归属 → 耐久 → 显著度+去重）后自动落盘；说「记住……」则直接落盘，
                但仍要走去重。只在本次对话成立的事（「这个 bug 刚修完」）会留在短期层，不进这里。
              </p>
              <p className="mem-dim">
                自动抽取在下一阶段接上；现在可以用右上角「手动记录」先塞一条——召回、注入 system、按相关度排序
                这些能力现在就是通的。
              </p>
            </div>
          ) : (
            <div className="mem-cards">
              {items.map((e) => (
                <div key={e.id} className={`mem-card ${e.status !== 'active' ? 'mem-card--off' : ''}`}>
                  <div className="mem-card__head">
                    <span className={`mem-badge mem-badge--${e.type}`}>{MEMORY_TYPE_LABEL[e.type]}</span>
                    <span className="mem-card__desc">{e.description}</span>
                    <span className="mem-card__actions">
                      <button
                        type="button"
                        className="mem-btn mem-btn--xs"
                        onClick={() => {
                          setEditing(e.id)
                          setForm({
                            description: e.description,
                            text: e.text,
                            type: e.type,
                            salience: e.salience,
                          })
                        }}
                      >
                        编辑
                      </button>
                      <button type="button" className="mem-btn mem-btn--xs" onClick={() => void toggleArchive(e)}>
                        {e.status === 'archived' ? '恢复' : '归档'}
                      </button>
                      <button
                        type="button"
                        className="mem-btn mem-btn--xs mem-btn--danger"
                        onClick={() => void remove(e)}
                      >
                        删除
                      </button>
                    </span>
                  </div>
                  {e.text && e.text !== e.description && <p className="mem-card__text">{e.text}</p>}
                  <div className="mem-card__meta">
                    <span className="mem-mono">{e.id}</span>
                    <span>salience {e.salience}</span>
                    <span>召回 {e.accessCount} 次</span>
                    <span>最后访问 {fmt(e.lastAccess)}</span>
                    <span>建于 {fmt(e.createdAt)}</span>
                    {e.status !== 'active' && (
                      <span className="mem-badge mem-badge--off">{MEMORY_STATUS_LABEL[e.status]}</span>
                    )}
                    {e.expires && <span>到期 {fmt(e.expires)}</span>}
                  </div>
                  {(e.sourceQuote || e.sourceSession) && (
                    <div className="mem-card__src">
                      {e.sourceSession ? `来自会话 ${e.sourceSession}` : '手动记录'}
                      {e.sourceQuote ? `：「${e.sourceQuote}」` : ''}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* —— 记忆日志 —— */}
          <div className="mem-log">
            <div className="mem-label">记忆日志（写入决策，最近的在前）</div>
            {log.length === 0 ? (
              <div className="mem-dim">
                还没有记录。自动抽取接上后，每一次 ADD / UPDATE / DELETE / NOOP 都会带理由写在这里——
                「全自动写」敢开就是因为它可审计。
              </div>
            ) : (
              <div className="mem-log__rows">
                {log.map((row, i) => (
                  <div key={`${row.ts}-${i}`} className="mem-log__row">
                    <span className="mem-log__ts">{fmt(row.ts)}</span>
                    <span className={`mem-log__act mem-log__act--${row.action}`}>{row.action}</span>
                    <span className="mem-mono mem-log__id">{row.id}</span>
                    <span className="mem-log__reason">{row.reason}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
