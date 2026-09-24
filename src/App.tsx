/**
 * 根组件：左侧 AgentOS 导航 + 各页内容
 * 聊天页按会话存 messages，SSE 写回对应会话，互不覆盖
 */
import { useEffect, useRef, useState } from 'react';
import { streamChat, toApiMessages, fetchHealth, type RagStatus, type SkillMeta, type McpPublic } from './api/chat';
import type { SseEvent, UiMessage } from './types';
import { MessageList } from './components/MessageList';
import { DocumentsPage } from './components/DocumentsPage';
import { MemoryPage } from './components/MemoryPage';
import { VectorsPage } from './components/VectorsPage';
import { CanvasPage } from './components/CanvasPage';
import { WorkspaceBar } from './components/WorkspaceBar';
import { SettingsPage } from './components/SettingsPage';
import { DeliveryPage } from './components/DeliveryPage';
import { VideoPage } from './components/VideoPage';
import { AppSidebar } from './components/AppSidebar';
import { SessionList } from './components/SessionList';
import {
  blankSession,
  loadSessions,
  saveSessions,
  sessionTitle,
  uid,
  type ChatSession,
} from './sessionStore';
import './components/AppShell.css';

/** 输入框自动长高的上限（px）。和 AppShell.css 里 .composer textarea 的 max-height 必须一致 */
const COMPOSER_MAX_HEIGHT = 180

function pageFromHash(): 'chat' | 'documents' | 'memory' | 'vectors' | 'canvas' | 'settings' | 'delivery' | 'video' {
  const path = location.hash.replace(/^#\/?/, '').split('?')[0]
  if (path.startsWith('canvas') || path.startsWith('workflow')) return 'canvas'
  if (path.startsWith('memory')) return 'memory'
  if (path.startsWith('vectors')) return 'vectors'
  if (path.startsWith('documents') || path.startsWith('knowledge')) return 'documents'
  if (path.startsWith('settings') || path.startsWith('config')) return 'settings'
  if (path.startsWith('delivery')) return 'delivery'
  if (path.startsWith('video')) return 'video'
  return 'chat'
}

export default function App() {
  const [boot] = useState(loadSessions);
  const [sessions, setSessions] = useState<ChatSession[]>(() => boot.sessions);
  const [activeId, setActiveId] = useState(() => boot.activeId);
  /** 各会话自己的草稿，切换时不丢 */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** 正在生成的会话 id；别的会话仍可发送 */
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  /** 右上角徽章：live / mock / 未连接 */
  const [mode, setMode] = useState<'live' | 'mock' | 'unknown'>('unknown');
  const [model, setModel] = useState<string>('');
  const [rag, setRag] = useState<RagStatus | null>(null);
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [mcp, setMcp] = useState<McpPublic | null>(null);
  const [page, setPage] = useState<
    'chat' | 'documents' | 'memory' | 'vectors' | 'canvas' | 'settings' | 'delivery' | 'video'
  >(pageFromHash);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('agentos.rail') === '1');
  /** 顶部/底部错误条 */
  const [error, setError] = useState<string>('');
  /** 每个会话一份 AbortController，停止只打断当前这条 */
  const abortMap = useRef(new Map<string, AbortController>());
  /** 锚点：当前会话有新消息就滚到底部 */
  const bottomRef = useRef<HTMLDivElement | null>(null);
  /** 输入框本体：自动长高要直接改它的 style.height */
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const active = sessions.find((s) => s.id === activeId) ?? sessions[0];
  const messages = active?.messages ?? [];
  const input = active ? (drafts[active.id] ?? '') : '';
  const activeBusy = active ? busyIds.has(active.id) : false;

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    localStorage.setItem('agentos.rail', collapsed ? '1' : '0')
  }, [collapsed])

  useEffect(() => {
    if (!sessions.some((s) => s.id === activeId) && sessions[0]) {
      setActiveId(sessions[0].id)
    }
  }, [sessions, activeId])

  const snap = useRef({ activeId, sessions })
  snap.current = { activeId, sessions }

  useEffect(() => {
    const flush = () => saveSessions(snap.current.activeId, snap.current.sessions)
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      saveSessions(snap.current.activeId, snap.current.sessions)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [activeId, sessions])

  /*
   * 输入框跟着内容长高：先归零再读 scrollHeight（不归零的话只能长不能缩，
   * 发完消息清空后输入框会一直停在高位）。超过上限就交给 CSS 的 max-height 滚动。
   * 依赖里带上 active.id：切会话时草稿换了，高度也得跟着换。
   */
  useEffect(() => {
    const el = composerRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`
  }, [input, active?.id])

  // 进页先 ping 一下健康检查
  useEffect(() => {
    fetchHealth()
      .then((data) => {
        setMode(data.mode === 'live' ? 'live' : 'mock');
        setModel(data.model || '');
        if (data.rag) setRag(data.rag);
        if (data.skills) setSkills(data.skills);
        if (data.mcp) setMcp(data.mcp);
      })
      .catch(() => setMode('unknown'));
  }, []);

  // 有新消息就平滑滚到底
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  /**
   * 只更新指定 id 的那条助手消息（不可变更新）
   * updater 收到旧消息，返回新消息对象
   */
  function setInput(value: string) {
    if (!active) return
    const id = active.id
    setDrafts((prev) => ({ ...prev, [id]: value }))
  }

  function patchAssistant(
    sessionId: string,
    assistantId: string,
    updater: (msg: UiMessage) => UiMessage,
  ) {
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId
          ? {
              ...s,
              updatedAt: Date.now(),
              messages: s.messages.map((m) => (m.id === assistantId ? updater(m) : m)),
            }
          : s,
      ),
    )
  }

  /** 把单个 SSE 事件写回发起它的那条会话 */
  function handleEvent(sessionId: string, assistantId: string, event: SseEvent) {
    if (event.type === 'meta') {
      setMode(event.mode);
      if (event.model) setModel(event.model);
      return;
    }
    if (event.type === 'text_delta') {
      // 追加一段文字，并标成 streaming
      patchAssistant(sessionId, assistantId, (m) => ({
        ...m,
        content: m.content + event.delta,
        status: 'streaming',
      }));
      return;
    }
    if (event.type === 'tool_start') {
      // 插入/替换一张 running 卡片（同 id 先滤掉再加，避免重复）
      patchAssistant(sessionId, assistantId, (m) => {
        return {
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
        };
      });
      return;
    }
    if (event.type === 'tool_result') {
      // 对应卡片改为完成，写入 result
      patchAssistant(sessionId, assistantId, (m) => {
        return {
          ...m,
          tools: m.tools.map((t) =>
            t.id === event.id
              ? { ...t, status: 'done', result: event.result }
              : t,
          ),
        };
      });
      return;
    }
    if (event.type === 'tool_error') {
      patchAssistant(sessionId, assistantId, (m) => {
        return {
          ...m,
          tools: m.tools.map((t) =>
            t.id === event.id
              ? { ...t, status: 'error', error: event.error }
              : t,
          ),
        };
      });
      return;
    }
    if (event.type === 'error') {
      setError(event.message);
      patchAssistant(sessionId, assistantId, (m) => ({ ...m, status: 'error' }));
      return;
    }
    if (event.type === 'done') {
      patchAssistant(sessionId, assistantId, (m) => ({ ...m, status: 'done' }));
    }
  }

  /**
   * 发送一轮对话
   * @param text 可选：快捷提示按钮传入；不传则用输入框
   */
  function markBusy(sessionId: string, on: boolean) {
    setBusyIds((prev) => {
      const next = new Set(prev)
      if (on) next.add(sessionId)
      else next.delete(sessionId)
      return next
    })
  }

  function openSession() {
    const empty = sessions.find((s) => s.messages.length === 0 && !busyIds.has(s.id))
    if (empty) {
      setActiveId(empty.id)
      saveSessions(empty.id, sessions)
      setError('')
      return
    }
    const created = blankSession()
    const next = [created, ...sessions]
    setSessions(next)
    setActiveId(created.id)
    saveSessions(created.id, next)
    setError('')
  }

  function removeSession(id: string) {
    abortMap.current.get(id)?.abort()
    abortMap.current.delete(id)
    markBusy(id, false)
    const rest = sessions.filter((s) => s.id !== id)
    const next = rest.length > 0 ? rest : [blankSession()]
    const nextActive = activeId === id ? next[0].id : activeId
    setSessions(next)
    setActiveId(nextActive)
    saveSessions(nextActive, next)
  }

  async function onSend(text?: string) {
    const sessionId = active?.id
    if (!sessionId) return
    const content = (text ?? input).trim();
    if (!content || busyIds.has(sessionId)) return;

    setError('');
    setDrafts((prev) => ({ ...prev, [sessionId]: '' }));

    const prior = messages
    const userMsg: UiMessage = {
      id: uid(),
      role: 'user',
      content,
      tools: [],
      status: 'done',
    };
    const assistantId = uid();
    const assistantMsg: UiMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      tools: [],
      status: 'streaming',
    };

    setSessions((prev) => {
      const next = prev.map((s) => {
        if (s.id !== sessionId) return s
        const nextMessages = [...s.messages, userMsg, assistantMsg]
        return {
          ...s,
          title: sessionTitle(nextMessages),
          updatedAt: Date.now(),
          messages: nextMessages,
        }
      })
      saveSessions(sessionId, next)
      return next
    })
    markBusy(sessionId, true);

    const controller = new AbortController();
    abortMap.current.set(sessionId, controller);

    try {
      await streamChat({
        messages: toApiMessages([...prior, userMsg]),
        signal: controller.signal,
        onEvent: (event) => handleEvent(sessionId, assistantId, event),
      });
      patchAssistant(sessionId, assistantId, (m) =>
        m.status === 'streaming' ? { ...m, status: 'done' } : m,
      );
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        patchAssistant(sessionId, assistantId, (m) => ({
          ...m,
          status: 'done',
          content: m.content || '（已停止）',
        }));
      } else {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        patchAssistant(sessionId, assistantId, (m) => ({
          ...m,
          status: 'error',
          content: m.content || `出错了：${message}`,
        }));
      }
    } finally {
      markBusy(sessionId, false);
      abortMap.current.delete(sessionId);
    }
  }

  function onStop() {
    if (active) abortMap.current.get(active.id)?.abort();
  }

  const talk = (
    <div className="app__talk">
      <main className="main">
        {(rag || skills.length > 0 || mcp?.connected || mcp?.error) && (
          <p className="rag-hint">
            {rag && (
              <a href="#/vectors">
                检索 {rag.retrieval} · {rag.indexed}/{rag.chunks} 已编码 · {rag.docs} 篇
              </a>
            )}
            {rag?.embedError ? ` · embed失败将走关键词` : ''}
            {skills.length > 0
              ? `${rag ? ' · ' : ''}已连接 skill：${skills.map((s) => s.name).join(', ')}`
              : ''}
            {mcp?.connected
              ? `${rag || skills.length > 0 ? ' · ' : ''}MCP ${mcp.tools.length} 个工具`
              : mcp?.enabled && mcp.error
                ? `${rag || skills.length > 0 ? ' · ' : ''}MCP 未连上`
                : ''}
          </p>
        )}
        <MessageList messages={messages} />
        <div ref={bottomRef} />
      </main>

      <footer className="composer-wrap">
        {error && <div className="error-banner">{error}</div>}
        {page === 'chat' && (
          <div className="hints">
            {['现在几点了？', '帮我算 123*456', '读一下 README.md', '当前改了什么？', '这个项目技术栈是什么？'].map(
              (q) => (
                <button
                  key={q}
                  type="button"
                  className="hint"
                  disabled={activeBusy}
                  onClick={() => onSend(q)}
                >
                  {q}
                </button>
              ),
            )}
          </div>
        )}
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault()
            void onSend()
          }}
        >
          <textarea
            ref={composerRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="输入问题，Enter 发送，Shift+Enter 换行"
            rows={2}
            onKeyDown={(e) => {
              /*
               * 输入法组词中（拼音还没上屏）时，Enter 是「选词」不是「发送」。
               * 不判 isComposing 的话，敲拼音按 Enter 会把半截字母当问题发出去。
               * keyCode 229 是部分输入法/旧浏览器只给 keyCode 的老路径，一起挡掉。
               */
              if (e.nativeEvent.isComposing || e.keyCode === 229) return
              if (e.key !== 'Enter') return
              if (e.shiftKey) {
                // 显式插换行：不依赖默认行为——输入法活跃时默认的换行会被吃掉
                e.preventDefault()
                const el = e.currentTarget
                const start = el.selectionStart ?? el.value.length
                const end = el.selectionEnd ?? start
                setInput(`${el.value.slice(0, start)}\n${el.value.slice(end)}`)
                // 受控组件：等 React 把新 value 写进 DOM 再挪光标，否则设了也被覆盖
                requestAnimationFrame(() => {
                  el.selectionStart = start + 1
                  el.selectionEnd = start + 1
                })
                return
              }
              e.preventDefault()
              void onSend()
            }}
          />
          {activeBusy ? (
            <button type="button" className="btn btn--stop" onClick={onStop}>
              停止
            </button>
          ) : (
            <button type="submit" className="btn" disabled={!input.trim()}>
              发送
            </button>
          )}
        </form>
        <WorkspaceBar />
      </footer>
    </div>
  )

  return (
    <div className={collapsed ? 'app app--rail' : 'app'}>
      <AppSidebar
        page={page}
        collapsed={collapsed}
        mode={mode}
        model={model}
        onToggle={() => setCollapsed((v) => !v)}
      />
      <div className="app__body">
        {page === 'chat' && (
          <div className="app__chat">
            <SessionList
              sessions={sessions}
              activeId={active?.id ?? ''}
              busyIds={busyIds}
              onNew={openSession}
              onSelect={(id) => {
                setActiveId(id)
                saveSessions(id, sessions)
                setError('')
              }}
              onDelete={removeSession}
            />
            {talk}
          </div>
        )}
        {page === 'documents' && <DocumentsPage />}
        {page === 'memory' && <MemoryPage />}
        {page === 'vectors' && <VectorsPage />}
        {page === 'canvas' && <CanvasPage />}
        {page === 'delivery' && <DeliveryPage />}
        {page === 'video' && <VideoPage />}
        {page === 'settings' && (
          <SettingsPage
            onSaved={(next) => {
              setMode(next.mode)
              setModel(next.model)
            }}
            onMcpSaved={(next) => setMcp(next)}
          />
        )}
      </div>
    </div>
  )
}
