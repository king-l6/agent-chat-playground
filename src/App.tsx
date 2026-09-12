/**
 * 根组件：聊天页状态机
 * - 维护 messages / 输入框 / busy
 * - 调 streamChat，把 SSE 事件落到某一条助手消息上
 */
import { useEffect, useRef, useState } from 'react';
import { streamChat, toApiMessages, fetchHealth, type RagStatus, type SkillMeta } from './api/chat';
import type { SseEvent, UiMessage } from './types';
import { MessageList } from './components/MessageList';
import { DocumentsPage } from './components/DocumentsPage';
import { VectorsPage } from './components/VectorsPage';
import { CanvasPage } from './components/CanvasPage';
import './components/AppShell.css';

/** 生成前端本地唯一 id（消息 id、助手气泡 id） */
function uid() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function pageFromHash(): 'chat' | 'documents' | 'vectors' | 'canvas' {
  const path = location.hash.replace(/^#\/?/, '').split('?')[0]
  if (path.startsWith('canvas') || path.startsWith('workflow')) return 'canvas'
  if (path.startsWith('vectors')) return 'vectors'
  if (path.startsWith('documents') || path.startsWith('knowledge')) return 'documents'
  return 'chat'
}

export default function App() {
  /** 聊天记录 */
  const [messages, setMessages] = useState<UiMessage[]>([]);
  /** 输入框文案 */
  const [input, setInput] = useState('');
  /** 是否正在生成（禁用发送、显示停止） */
  const [busy, setBusy] = useState(false);
  /** 右上角徽章：live / mock / 未连接 */
  const [mode, setMode] = useState<'live' | 'mock' | 'unknown'>('unknown');
  const [model, setModel] = useState<string>('');
  const [rag, setRag] = useState<RagStatus | null>(null);
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [page, setPage] = useState<'chat' | 'documents' | 'vectors' | 'canvas'>(pageFromHash);
  /** 顶部/底部错误条 */
  const [error, setError] = useState<string>('');
  /** 当前请求的 AbortController，点停止时 abort */
  const abortRef = useRef<AbortController | null>(null);
  /** 锚点：消息变了滚到底部 */
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // 进页先 ping 一下健康检查
  useEffect(() => {
    fetchHealth()
      .then((data) => {
        setMode(data.mode === 'live' ? 'live' : 'mock');
        setModel(data.model || '');
        if (data.rag) setRag(data.rag);
        if (data.skills) setSkills(data.skills);
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
  function patchAssistant(
    assistantId: string,
    updater: (msg: UiMessage) => UiMessage,
  ) {
    setMessages((prev) =>
      prev.map((m) => (m.id === assistantId ? updater(m) : m)),
    );
  }

  /** 把单个 SSE 事件反映到 UI（核心状态机） */
  function handleEvent(assistantId: string, event: SseEvent) {
    if (event.type === 'meta') {
      setMode(event.mode);
      if (event.model) setModel(event.model);
      return;
    }
    if (event.type === 'text_delta') {
      // 追加一段文字，并标成 streaming
      patchAssistant(assistantId, (m) => ({
        ...m,
        content: m.content + event.delta,
        status: 'streaming',
      }));
      return;
    }
    if (event.type === 'tool_start') {
      // 插入/替换一张 running 卡片（同 id 先滤掉再加，避免重复）
      patchAssistant(assistantId, (m) => {
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
      patchAssistant(assistantId, (m) => {
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
      patchAssistant(assistantId, (m) => {
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
      patchAssistant(assistantId, (m) => ({ ...m, status: 'error' }));
      return;
    }
    if (event.type === 'done') {
      patchAssistant(assistantId, (m) => ({ ...m, status: 'done' }));
    }
  }

  /**
   * 发送一轮对话
   * @param text 可选：快捷提示按钮传入；不传则用输入框
   */
  async function onSend(text?: string) {
    const content = (text ?? input).trim();
    if (!content || busy) return;

    setError('');
    setInput('');

    // 先落盘用户消息 + 空的助手气泡（后面靠 SSE 往里填）
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

    const next = [...messages, userMsg, assistantMsg];
    setMessages(next);
    setBusy(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // 注意：发给后端的历史不含空助手气泡，只到 userMsg
      await streamChat({
        messages: toApiMessages([...messages, userMsg]),
        signal: controller.signal,
        onEvent: (event) => handleEvent(assistantId, event),
      });
      // 流正常结束但没收到 done 时，兜底标 done
      patchAssistant(assistantId, (m) =>
        m.status === 'streaming' ? { ...m, status: 'done' } : m,
      );
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        // 用户点了停止
        patchAssistant(assistantId, (m) => ({
          ...m,
          status: 'done',
          content: m.content || '（已停止）',
        }));
      } else {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        patchAssistant(assistantId, (m) => ({
          ...m,
          status: 'error',
          content: m.content || `出错了：${message}`,
        }));
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  /** 中断当前 SSE 请求 */
  function onStop() {
    abortRef.current?.abort();
  }

  return (
    <div className={page === 'chat' ? 'app' : 'app app--kb'}>
      <header className='topbar'>
        <div>
          <div className='brand'>Agent Chat Playground</div>
          <div className='sub'>SSE · Tool · Skill · RAG · 编排画布</div>
        </div>
        <div className="topbar__right">
          <nav className="nav">
            <a className={page === 'chat' ? 'nav__link nav__link--on' : 'nav__link'} href="#/">
              对话
            </a>
            <a
              className={page === 'documents' ? 'nav__link nav__link--on' : 'nav__link'}
              href="#/documents"
            >
              文档
            </a>
            <a
              className={page === 'vectors' ? 'nav__link nav__link--on' : 'nav__link'}
              href="#/vectors"
            >
              向量库
            </a>
            <a
              className={page === 'canvas' ? 'nav__link nav__link--on' : 'nav__link'}
              href="#/canvas"
            >
              编排
            </a>
          </nav>
          <div className={`badge badge--${mode}`}>
            {mode === 'live' && `LIVE${model ? ` · ${model}` : ''}`}
            {mode === 'mock' && 'MOCK（未配置 API Key）'}
            {mode === 'unknown' && '后端未连接'}
          </div>
        </div>
      </header>

      {page === 'documents' ? (
        <DocumentsPage />
      ) : page === 'vectors' ? (
        <VectorsPage />
      ) : page === 'canvas' ? (
        <CanvasPage />
      ) : (
        <>
      <main className='main'>
        {(rag || skills.length > 0) && (
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
          </p>
        )}
        <MessageList messages={messages} />
        {/* 滚动锚点 */}
        <div ref={bottomRef} />
      </main>

      <footer className='composer-wrap'>
        {error && <div className='error-banner'>{error}</div>}

        {/* 一键示例问题 */}
        <div className='hints'>
          {['现在几点了？', '帮我算 123*456', '这个项目技术栈是什么？', '请按面试口径介绍这个项目'].map(
            (q) => (
              <button
                key={q}
                type='button'
                className='hint'
                disabled={busy}
                onClick={() => onSend(q)}
              >
                {q}
              </button>
            ),
          )}
        </div>

        <form
          className='composer'
          onSubmit={(e) => {
            e.preventDefault();
            void onSend();
          }}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder='输入问题，Enter 发送，Shift+Enter 换行'
            rows={2}
            onKeyDown={(e) => {
              // Enter 发送；Shift+Enter 留给换行
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void onSend();
              }
            }}
          />
          {busy ? (
            <button type='button' className='btn btn--stop' onClick={onStop}>
              停止
            </button>
          ) : (
            <button type='submit' className='btn' disabled={!input.trim()}>
              发送
            </button>
          )}
        </form>
      </footer>
        </>
      )}
    </div>
  );
}
