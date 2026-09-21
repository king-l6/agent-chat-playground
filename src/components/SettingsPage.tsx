/**
 * 模型配置 + MCP：网页和桌面同一页。
 * Key / Cookie 只写不回显。
 */
import { useEffect, useState, type FormEvent } from 'react'
import {
  fetchMcp,
  fetchSettings,
  importClaudeMcp,
  saveMcp,
  saveSettings,
  type McpPublic,
} from '../api/chat'
import './KnowledgePage.css'
import './SettingsPage.css'

export function SettingsPage(props: {
  onSaved?: (next: { mode: 'mock' | 'live'; model: string }) => void
  onMcpSaved?: (next: McpPublic) => void
}) {
  const [mode, setMode] = useState<'mock' | 'live'>('mock')
  const [apiKey, setApiKey] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [model, setModel] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [error, setError] = useState('')
  const [hint, setHint] = useState('')
  const [busy, setBusy] = useState(false)

  const [mcpEnabled, setMcpEnabled] = useState(false)
  const [mcpUrl, setMcpUrl] = useState('')
  const [mcpAuth, setMcpAuth] = useState('')
  const [mcp, setMcp] = useState<McpPublic | null>(null)
  const [mcpBusy, setMcpBusy] = useState(false)

  useEffect(() => {
    fetchSettings()
      .then((data) => {
        setMode(data.mode)
        setBaseURL(data.baseURL)
        setModel(data.model)
        setHasKey(data.hasKey)
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
    fetchMcp()
      .then((data) => {
        setMcp(data)
        setMcpEnabled(data.enabled)
        setMcpUrl(data.url)
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
      })
      setApiKey('')
      setHasKey(saved.hasKey)
      setBaseURL(saved.baseURL)
      setModel(saved.model)
      setMode(saved.mode)
      setHint(saved.mode === 'mock' ? '已保存，当前是 MOCK。' : '已保存，当前走真实模型。')
      props.onSaved?.({ mode: saved.mode, model: saved.model })
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

  return (
    <div className="kb settings">
      {error && <div className="error-banner">{error}</div>}
      {hint && <p className="kb__hint">{hint}</p>}

      <form className="kb-card" onSubmit={(e) => void onSubmit(e)}>
        <header className="kb-card__head">
          <div>
            <h2>模型配置</h2>
            <p>网页和桌面共用。Key 存在本机数据目录，不会回显。打包应用写到系统 userData。</p>
          </div>
        </header>

        <div className="settings__body">
          <fieldset className="settings__modes">
            <legend>模式</legend>
            <label className={mode === 'mock' ? 'settings__mode settings__mode--on' : 'settings__mode'}>
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
            <label className={mode === 'live' ? 'settings__mode settings__mode--on' : 'settings__mode'}>
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

          <button type="submit" className="settings__save" disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </form>

      <form className="kb-card" onSubmit={(e) => void onSaveMcp(e)}>
        <header className="kb-card__head">
          <div>
            <h2>MCP</h2>
            <p>
              把 Claude Code 里的 HTTP MCP 接到对话循环：tools/list 转成 function
              calling。Cookie 只存在本机，不进仓库。交付页不会调用这些工具。
            </p>
          </div>
        </header>
        <div className="settings__body">
          <label className={mcpEnabled ? 'settings__mode settings__mode--on' : 'settings__mode'}>
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
            Cookie / Authorization
            <input
              type="password"
              autoComplete="off"
              value={mcpAuth}
              onChange={(e) => setMcpAuth(e.target.value)}
              placeholder={mcp?.hasAuth ? '已保存，留空则保持' : '_AJSESSIONID=… 或 Bearer …'}
            />
          </label>
          {mcp?.tools && mcp.tools.length > 0 ? (
            <p className="kb__hint">工具：{mcp.tools.join('、')}</p>
          ) : null}
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
        </div>
      </form>
    </div>
  )
}
