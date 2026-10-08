/**
 * 设置页（Multica 风格）：左侧子导航，右侧切换面板。
 * 通用 / 环境变量 / 模型 / MCP。Key、Cookie 只写不回显；多用户靠档案 ID 隔离。
 */
import { useEffect, useState, type FormEvent } from 'react'
import {
  fetchEnv,
  fetchMcp,
  fetchSettings,
  importClaudeMcp,
  saveEnv,
  saveMcp,
  saveSettings,
  type McpPublic,
} from '../api/chat'
import { getUserId, getUserName, setUserId, setUserName } from '../lib/userProfile'
import './SettingsPage.css'

type EnvRow = { key: string; value: string; hasValue: boolean; show: boolean }
type SettingsTab = 'general' | 'env' | 'model' | 'mcp'

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'general', label: '通用' },
  { id: 'env', label: '环境变量' },
  { id: 'model', label: '模型' },
  { id: 'mcp', label: 'MCP' },
]

const CONTEXT_WINDOW_PRESETS = [
  { tokens: '8000', label: '早期档（8k/16k，放不下本项目 system prompt + 工具 schema）' },
  { tokens: '32000', label: '上一代主流档；留空时的兜底值' },
  { tokens: '64000', label: '上一代长档' },
  { tokens: '128000', label: '现在 API 最常见档' },
  { tokens: '200000', label: 'Claude 系列常见档' },
  { tokens: '1000000', label: '长上下文档（Gemini 1.5/2.x、GPT-4.1 一类）' },
  { tokens: '2000000', label: '当前公开上限档，也是本项目允许的上界' },
]

export function SettingsPage(props: {
  onSaved?: (next: { mode: 'mock' | 'live'; model: string; contextWindow: number }) => void
  onMcpSaved?: (next: McpPublic) => void
}) {
  const [tab, setTab] = useState<SettingsTab>('env')

  const [mode, setMode] = useState<'mock' | 'live'>('mock')
  const [apiKey, setApiKey] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [model, setModel] = useState('')
  const [contextWindow, setContextWindow] = useState('')
  const [windowTouched, setWindowTouched] = useState(false)
  const [hasKey, setHasKey] = useState(false)
  const [error, setError] = useState('')
  const [hint, setHint] = useState('')
  const [busy, setBusy] = useState(false)

  const [mcpEnabled, setMcpEnabled] = useState(false)
  const [mcpUrl, setMcpUrl] = useState('')
  const [mcpAuth, setMcpAuth] = useState('')
  const [mcp, setMcp] = useState<McpPublic | null>(null)
  const [mcpBusy, setMcpBusy] = useState(false)

  const [envRows, setEnvRows] = useState<EnvRow[]>([])
  const [envBusy, setEnvBusy] = useState(false)
  const [envUnlocked, setEnvUnlocked] = useState(false)
  const [profileId, setProfileId] = useState(getUserId)
  const [profileName, setProfileName] = useState(getUserName)

  useEffect(() => {
    fetchSettings()
      .then((data) => {
        setMode(data.mode)
        setBaseURL(data.baseURL)
        setModel(data.model)
        setHasKey(data.hasKey)
        setContextWindow(String(data.contextWindow))
        setWindowTouched(false)
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
    fetchMcp()
      .then((data) => {
        setMcp(data)
        setMcpEnabled(data.enabled)
        setMcpUrl(data.url)
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
    fetchEnv()
      .then((data) => {
        const rows = data.vars.map((v) => ({
          key: v.key,
          value: '',
          hasValue: v.hasValue,
          show: false,
        }))
        setEnvRows(
          rows.length
            ? rows
            : [
                { key: 'Cookie', value: '', hasValue: false, show: false },
                { key: 'ANTHROPIC_API_KEY', value: '', hasValue: false, show: false },
                { key: 'ANTHROPIC_BASE_URL', value: '', hasValue: false, show: false },
              ],
        )
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    setHint('')
    try {
      const saved = await saveSettings({
        mode,
        apiKey: apiKey.trim() || undefined,
        baseURL,
        model,
        ...(windowTouched
          ? { contextWindow: contextWindow.trim() ? Number(contextWindow) : 0 }
          : {}),
      })
      setApiKey('')
      setHasKey(saved.hasKey)
      setBaseURL(saved.baseURL)
      setModel(saved.model)
      setMode(saved.mode)
      setContextWindow(String(saved.contextWindow))
      setWindowTouched(false)
      setHint(saved.mode === 'mock' ? '已保存，当前是 MOCK。' : '已保存，当前走真实模型。')
      props.onSaved?.({
        mode: saved.mode,
        model: saved.model,
        contextWindow: saved.contextWindow,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function onSaveMcp(e: FormEvent) {
    e.preventDefault()
    setMcpBusy(true)
    setError('')
    setHint('')
    try {
      const saved = await saveMcp({
        enabled: mcpEnabled,
        url: mcpUrl,
        auth: mcpAuth.trim() || undefined,
      })
      setMcpAuth('')
      setMcp(saved)
      setMcpEnabled(saved.enabled)
      setMcpUrl(saved.url)
      setHint(
        saved.connected
          ? `MCP 已连接，${saved.tools.length} 个工具。`
          : saved.enabled
            ? `MCP 没连上：${saved.error ?? '未知错误'}`
            : '已关闭 MCP。',
      )
      props.onMcpSaved?.(saved)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setMcpBusy(false)
    }
  }

  async function onImportClaude() {
    setMcpBusy(true)
    setError('')
    setHint('')
    try {
      const saved = await importClaudeMcp()
      setMcp(saved)
      setMcpEnabled(saved.enabled)
      setMcpUrl(saved.url)
      setHint(
        saved.connected
          ? `已从 Claude 导入并连上，${saved.tools.length} 个工具。`
          : `已导入 URL，但没连上：${saved.error ?? '未知错误'}`,
      )
      props.onMcpSaved?.(saved)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setMcpBusy(false)
    }
  }

  async function onSaveEnv(e: FormEvent) {
    e.preventDefault()
    setEnvBusy(true)
    setError('')
    setHint('')
    try {
      const payload = envRows
        .filter((row) => row.key.trim())
        .map((row) => {
          const key = row.key.trim()
          const value = row.value
          if (value.trim()) return { key, value }
          if (row.hasValue) return { key, keep: true }
          return { key, value: '' }
        })
      const saved = await saveEnv(payload)
      setEnvRows(
        saved.vars.map((v) => ({
          key: v.key,
          value: '',
          hasValue: v.hasValue,
          show: false,
        })),
      )
      const mcpNow = await fetchMcp()
      setMcp(mcpNow)
      setHint(`环境变量已保存（${saved.vars.length} 项）。`)
      props.onMcpSaved?.(mcpNow)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setEnvBusy(false)
    }
  }

  async function onSaveGeneral(e: FormEvent) {
    e.preventDefault()
    setError('')
    setHint('')
    try {
      setUserName(profileName)
      if (profileId.trim() && profileId.trim().toLowerCase() !== getUserId()) {
        setUserId(profileId)
        setProfileId(getUserId())
      }
      setHint('档案已保存。切换档案 ID 后请重新打开各配置页拉取对应数据。')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const active = TABS.find((t) => t.id === tab) ?? TABS[0]
  const savedEnvCount = envRows.filter((r) => r.hasValue || r.key.trim()).length

  return (
    <div className="settings">
      <aside className="settings__nav" aria-label="设置分类">
        <div className="settings__nav-title">设置</div>
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={
              tab === item.id ? 'settings__nav-item settings__nav-item--on' : 'settings__nav-item'
            }
            onClick={() => {
              setTab(item.id)
              setError('')
              setHint('')
              if (item.id !== 'env') setEnvUnlocked(false)
            }}
          >
            {item.label}
          </button>
        ))}
      </aside>

      <section className="settings__panel" aria-label={active.label}>
        <div className="settings__sheet">
          {error && <div className="settings__banner settings__banner--err">{error}</div>}
          {hint && <div className="settings__banner settings__banner--ok">{hint}</div>}

          {tab === 'general' && (
            <form className="settings__body" onSubmit={(e) => void onSaveGeneral(e)}>
              <div>
                <h2 className="settings__title">通用</h2>
                <p className="settings__lead">
                  多用户各用一个档案 ID；Cookie / Key 按档案隔离存放在本机。
                </p>
              </div>
              <div className="settings__stack">
                <div className="settings__profile">
                  <label className="settings__field">
                    档案 ID
                    <input
                      type="text"
                      value={profileId}
                      onChange={(e) => setProfileId(e.target.value)}
                      placeholder="u_xxxx"
                      spellCheck={false}
                    />
                  </label>
                  <label className="settings__field">
                    显示名
                    <input
                      type="text"
                      value={profileName}
                      onChange={(e) => setProfileName(e.target.value)}
                      placeholder="例如：张三 / UAT"
                    />
                  </label>
                </div>
              </div>
              <button type="submit" className="settings__save">
                保存
              </button>
            </form>
          )}

          {tab === 'env' && (
            <form className="settings__body" onSubmit={(e) => void onSaveEnv(e)}>
              <div>
                <h2 className="settings__title">环境变量</h2>
                <p className="settings__lead">
                  在智能体进程与 MCP 请求时注入，例如 Cookie、ANTHROPIC_API_KEY。密文默认受保护，解锁后可编辑。
                </p>
              </div>

              {!envUnlocked ? (
                <div className="settings__locked">
                  <p>
                    {savedEnvCount > 0
                      ? `已配置 ${savedEnvCount} 项环境变量，当前为保护模式显示。解锁后可查看占位并编辑，每次编辑会写回本机档案。`
                      : '尚未配置环境变量。解锁后可添加 Cookie、API Key 等；密文不会回显到页面。'}
                  </p>
                  <button
                    type="button"
                    className="settings__secondary"
                    onClick={() => setEnvUnlocked(true)}
                  >
                    解锁并编辑
                  </button>
                </div>
              ) : (
                <>
                  <div className="settings__toolbar">
                    <button
                      type="button"
                      className="settings__secondary"
                      onClick={() =>
                        setEnvRows((rows) => [
                          ...rows,
                          { key: '', value: '', hasValue: false, show: false },
                        ])
                      }
                    >
                      + 添加
                    </button>
                  </div>
                  <div className="settings__stack">
                    <div className="settings__env">
                      {envRows.map((row, index) => (
                        <div className="settings__env-row" key={`env-${index}`}>
                          <input
                            className="settings__env-key"
                            type="text"
                            value={row.key}
                            spellCheck={false}
                            placeholder="KEY"
                            onChange={(e) =>
                              setEnvRows((rows) =>
                                rows.map((r, i) =>
                                  i === index ? { ...r, key: e.target.value } : r,
                                ),
                              )
                            }
                          />
                          <div className="settings__env-val">
                            <input
                              type={row.show ? 'text' : 'password'}
                              autoComplete="off"
                              value={row.value}
                              placeholder={row.hasValue ? '已保存，留空则保持' : 'value'}
                              onChange={(e) =>
                                setEnvRows((rows) =>
                                  rows.map((r, i) =>
                                    i === index ? { ...r, value: e.target.value } : r,
                                  ),
                                )
                              }
                            />
                            <button
                              type="button"
                              className="settings__icon-btn"
                              title={row.show ? '隐藏' : '显示'}
                              onClick={() =>
                                setEnvRows((rows) =>
                                  rows.map((r, i) =>
                                    i === index ? { ...r, show: !r.show } : r,
                                  ),
                                )
                              }
                            >
                              {row.show ? '隐' : '显'}
                            </button>
                            <button
                              type="button"
                              className="settings__icon-btn"
                              title="删除"
                              onClick={() =>
                                setEnvRows((rows) => rows.filter((_, i) => i !== index))
                              }
                            >
                              删
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                    <p className="settings__hint">
                      MCP 鉴权常用 <code>Cookie</code>；模型可用 <code>ANTHROPIC_API_KEY</code> /
                      <code>OPENAI_API_KEY</code>。
                    </p>
                  </div>
                  <div className="settings__row">
                    <button type="submit" className="settings__save" disabled={envBusy}>
                      {envBusy ? '保存中…' : '保存'}
                    </button>
                    <button
                      type="button"
                      className="settings__secondary"
                      onClick={() => setEnvUnlocked(false)}
                    >
                      重新锁定
                    </button>
                  </div>
                </>
              )}
            </form>
          )}

          {tab === 'model' && (
            <form className="settings__body" onSubmit={(e) => void onSubmit(e)}>
              <div>
                <h2 className="settings__title">模型</h2>
                <p className="settings__lead">
                  也可在「环境变量」里配 API Key / Base URL。面板值优先；Key 不回显。
                </p>
              </div>
              <div className="settings__stack">
                <fieldset className="settings__modes">
                  <legend>模式</legend>
                  <label
                    className={
                      mode === 'mock' ? 'settings__mode settings__mode--on' : 'settings__mode'
                    }
                  >
                    <input
                      type="radio"
                      name="llm-mode"
                      checked={mode === 'mock'}
                      onChange={() => setMode('mock')}
                    />
                    <span>
                      <strong>MOCK</strong>
                      <em>未配置 API Key，用规则演示工具卡片</em>
                    </span>
                  </label>
                  <label
                    className={
                      mode === 'live' ? 'settings__mode settings__mode--on' : 'settings__mode'
                    }
                  >
                    <input
                      type="radio"
                      name="llm-mode"
                      checked={mode === 'live'}
                      onChange={() => setMode('live')}
                    />
                    <span>
                      <strong>LIVE</strong>
                      <em>走 OpenAI 兼容网关</em>
                    </span>
                  </label>
                </fieldset>

                <label className="settings__field">
                  API Key
                  <input
                    type="password"
                    autoComplete="off"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={hasKey ? '已保存，留空则保持' : 'sk-… 或公司网关 Key'}
                  />
                </label>
                <label className="settings__field">
                  Base URL
                  <input
                    type="text"
                    value={baseURL}
                    onChange={(e) => setBaseURL(e.target.value)}
                    placeholder="https://api.openai.com/v1"
                  />
                </label>
                <label className="settings__field">
                  模型
                  <input
                    type="text"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="deepseek-v4-flash"
                  />
                </label>
                <label className="settings__field">
                  上下文窗口（token）
                  <input
                    type="text"
                    inputMode="numeric"
                    list="context-window-presets"
                    value={contextWindow}
                    onChange={(e) => {
                      setWindowTouched(true)
                      setContextWindow(e.target.value)
                    }}
                    placeholder="32000（常见 128000 / 200000）"
                  />
                </label>
                <datalist id="context-window-presets">
                  {CONTEXT_WINDOW_PRESETS.map((preset) => (
                    <option key={preset.tokens} value={preset.tokens}>
                      {preset.label}
                    </option>
                  ))}
                </datalist>
              </div>
              <button type="submit" className="settings__save" disabled={busy}>
                {busy ? '保存中…' : '保存'}
              </button>
            </form>
          )}

          {tab === 'mcp' && (
            <form className="settings__body" onSubmit={(e) => void onSaveMcp(e)}>
              <div>
                <h2 className="settings__title">MCP</h2>
                <p className="settings__lead">
                  HTTP MCP → function calling。鉴权优先在「环境变量」配 Cookie；交付页不调用 MCP。
                </p>
              </div>
              <div className="settings__stack">
                <label
                  className={mcpEnabled ? 'settings__mode settings__mode--on' : 'settings__mode'}
                >
                  <input
                    type="checkbox"
                    checked={mcpEnabled}
                    onChange={(e) => setMcpEnabled(e.target.checked)}
                  />
                  <span>
                    <strong>启用</strong>
                    <em>
                      {mcp?.connected
                        ? `已连接 ${mcp.tools.length} 个工具`
                        : mcp?.error
                          ? mcp.error
                          : '未连接'}
                    </em>
                  </span>
                </label>
                <label className="settings__field">
                  URL
                  <input
                    type="text"
                    value={mcpUrl}
                    onChange={(e) => setMcpUrl(e.target.value)}
                    placeholder="https://ai-fe.bilibili.co/mcp"
                  />
                </label>
                <label className="settings__field">
                  请求头（可选，临时覆盖）
                  <textarea
                    rows={3}
                    autoComplete="off"
                    value={mcpAuth}
                    onChange={(e) => setMcpAuth(e.target.value)}
                    placeholder={
                      mcp?.hasAuth
                        ? '已保存，留空则保持。或写：\nCookie: _AJSESSIONID=…'
                        : 'Cookie: _AJSESSIONID=…\n或 JSON：{"Cookie":"…"}'
                    }
                    spellCheck={false}
                  />
                </label>
                {mcp?.tools && mcp.tools.length > 0 ? (
                  <p className="settings__hint">工具：{mcp.tools.join('、')}</p>
                ) : null}
              </div>
              <div className="settings__row">
                <button type="submit" className="settings__save" disabled={mcpBusy}>
                  {mcpBusy ? '连接中…' : '保存并连接'}
                </button>
                <button
                  type="button"
                  className="settings__secondary"
                  disabled={mcpBusy}
                  onClick={() => void onImportClaude()}
                >
                  从 Claude 导入
                </button>
              </div>
            </form>
          )}
        </div>
      </section>
    </div>
  )
}
