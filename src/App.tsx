import { useEffect, useRef, useState } from 'react'
import { streamChat, toApiMessages, fetchHealth } from './api/chat'
import type { SseEvent, UiMessage } from './types'
import { MessageList } from './components/MessageList'
import './components/AppShell.css'

function uid() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export default function App() {
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<'live' | 'mock' | 'unknown'>('unknown')
  const [model, setModel] = useState<string>('')
  const [error, setError] = useState<string>('')
  const abortRef = useRef<AbortController | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    fetchHealth()
      .then((data) => {
        setMode(data.mode === 'live' ? 'live' : 'mock')
        setModel(data.model || '')
      })
      .catch(() => setMode('unknown'))
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  function patchAssistant(
    assistantId: string,
    updater: (msg: UiMessage) => UiMessage,
  ) {
    setMessages((prev) =>
      prev.map((m) => (m.id === assistantId ? updater(m) : m)),
    )
  }

  function handleEvent(assistantId: string, event: SseEvent) {
    if (event.type === 'meta') {
      setMode(event.mode)
      if (event.model) setModel(event.model)
      return
    }
    if (event.type === 'text_delta') {
      patchAssistant(assistantId, (m) => ({
        ...m,
        content: m.content + event.delta,
        status: 'streaming',
      }))
      return
    }
    if (event.type === 'tool_start') {
      patchAssistant(assistantId, (m) => ({
        ...m,
        tools: [
          ...m.tools.filter((t) => t.id !== event.id),
          {
            id: event.id,
            name: event.name,
            arguments: event.arguments,
            status: 'running',
          },
        ],
      }))
      return
    }
    if (event.type === 'tool_result') {
      patchAssistant(assistantId, (m) => ({
        ...m,
        tools: m.tools.map((t) =>
          t.id === event.id
            ? { ...t, status: 'done', result: event.result }
            : t,
        ),
      }))
      return
    }
    if (event.type === 'tool_error') {
      patchAssistant(assistantId, (m) => ({
        ...m,
        tools: m.tools.map((t) =>
          t.id === event.id
            ? { ...t, status: 'error', error: event.error }
            : t,
        ),
      }))
      return
    }
    if (event.type === 'error') {
      setError(event.message)
      patchAssistant(assistantId, (m) => ({ ...m, status: 'error' }))
      return
    }
    if (event.type === 'done') {
      patchAssistant(assistantId, (m) => ({ ...m, status: 'done' }))
    }
  }

  async function onSend(text?: string) {
    const content = (text ?? input).trim()
    if (!content || busy) return

    setError('')
    setInput('')
    const userMsg: UiMessage = {
      id: uid(),
      role: 'user',
      content,
      tools: [],
      status: 'done',
    }
    const assistantId = uid()
    const assistantMsg: UiMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      tools: [],
      status: 'streaming',
    }

    const next = [...messages, userMsg, assistantMsg]
    setMessages(next)
    setBusy(true)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      await streamChat({
        messages: toApiMessages([...messages, userMsg]),
        signal: controller.signal,
        onEvent: (event) => handleEvent(assistantId, event),
      })
      patchAssistant(assistantId, (m) =>
        m.status === 'streaming' ? { ...m, status: 'done' } : m,
      )
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        patchAssistant(assistantId, (m) => ({
          ...m,
          status: 'done',
          content: m.content || '（已停止）',
        }))
      } else {
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        patchAssistant(assistantId, (m) => ({
          ...m,
          status: 'error',
          content: m.content || `出错了：${message}`,
        }))
      }
    } finally {
      setBusy(false)
      abortRef.current = null
    }
  }

  function onStop() {
    abortRef.current?.abort()
  }

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <div className="brand">Agent Chat Playground</div>
          <div className="sub">SSE 流式 · Tool Calling 卡片 · 简易检索</div>
        </div>
        <div className={`badge badge--${mode}`}>
          {mode === 'live' && `LIVE${model ? ` · ${model}` : ''}`}
          {mode === 'mock' && 'MOCK（未配置 API Key）'}
          {mode === 'unknown' && '后端未连接'}
        </div>
      </header>

      <main className="main">
        <MessageList messages={messages} />
        <div ref={bottomRef} />
      </main>

      <footer className="composer-wrap">
        {error && <div className="error-banner">{error}</div>}
        <div className="hints">
          {['现在几点了？', '帮我算 123*456', '这个项目技术栈是什么？'].map(
            (q) => (
              <button
                key={q}
                type="button"
                className="hint"
                disabled={busy}
                onClick={() => onSend(q)}
              >
                {q}
              </button>
            ),
          )}
        </div>
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault()
            void onSend()
          }}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="输入问题，Enter 发送，Shift+Enter 换行"
            rows={2}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void onSend()
              }
            }}
          />
          {busy ? (
            <button type="button" className="btn btn--stop" onClick={onStop}>
              停止
            </button>
          ) : (
            <button type="submit" className="btn" disabled={!input.trim()}>
              发送
            </button>
          )}
        </form>
      </footer>
    </div>
  )
}
