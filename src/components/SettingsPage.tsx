/**
 * 模型配置：网页和桌面同一页。
 * Key 只写不回显；切 MOCK 即使 .env 有 Key 也不走网关。
 */
import { useEffect, useState, type FormEvent } from 'react'
import { fetchSettings, saveSettings } from '../api/chat'
import './KnowledgePage.css'
import './SettingsPage.css'

export function SettingsPage(props: {
  onSaved?: (next: { mode: 'mock' | 'live'; model: string }) => void
}) {
  const [mode, setMode] = useState<'mock' | 'live'>('mock')
  const [apiKey, setApiKey] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [model, setModel] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [error, setError] = useState('')
  const [hint, setHint] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetchSettings()
      .then((data) => {
        setMode(data.mode)
        setBaseURL(data.baseURL)
        setModel(data.model)
        setHasKey(data.hasKey)
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
    </div>
  )
}
