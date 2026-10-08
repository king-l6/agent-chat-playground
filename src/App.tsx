import { useEffect, useMemo, useRef, useState } from 'react';
import { streamChat, toApiMessages, fetchHealth, postChatApprove, type RagStatus, type SkillMeta, type McpPublic } from './api/chat';
import type { SseEvent, UiMessage, MessagePart, ToolCallView } from './types';
import {
  CONTEXT_WINDOW_TOKENS,
  contextRatioOf,
  contextWarnOf,
  estimateOutgoingTokens,
  formatTokens,
} from './lib/contextUsage';
import { MessageList } from './components/MessageList';
import { ChatOutline } from './components/ChatOutline';
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
  hydrate,
  loadCached,
  reconcile,
  saveCached,
  sessionTitle,
  toPayload,
  uid,
  type ChatSession,
} from './sessionStore';
import {
  deleteRemoteSession,
  fetchSharedSession,
  listSessions,
  saveSession,
  sessionErrorText,
} from './api/sessions';
import { getUserId } from './lib/userProfile';
import './components/AppShell.css';

/** 输入框自动长高的上限（px）。和 AppShell.css 里 .composer textarea 的 max-height 必须一致 */
const COMPOSER_MAX_HEIGHT = 180

/**
 * 用量环的几何：viewBox 是 0 0 24 24、圆心 (12,12)。
 * 这里的半径必须和 AppShell.css 的 .ctx__ring 尺寸、SVG 里的 r 一致。
 */
const RING_RADIUS = 9
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

/** 文字和思考会粘到上一个同类零件上；工具另起一块 */
function withTtft(m: UiMessage): UiMessage {
  if (m.ttftMs != null || m.startedAt == null) return m
  return { ...m, ttftMs: Date.now() - m.startedAt }
}

function appendPart(parts: MessagePart[] | undefined, incoming: MessagePart): MessagePart[] {
  const next = [...(parts ?? [])]
  const last = next[next.length - 1]
  if (
    last &&
    incoming.type !== 'tool' &&
    incoming.type !== 'role' &&
    last.type === incoming.type
  ) {
    next[next.length - 1] = { type: last.type, text: last.text + incoming.text }
    return next
  }
  next.push(incoming)
  return next
}

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

/**
 * 从 hash 解出「要打开哪个会话」。
 * 形如 #/c/<ownerId>/<sessionId>；也容忍只有 #/c/<sessionId>（没带归属人的老链接，owner 视为自己）。
 * 用 /i 且统一转小写：id 生成时本就是小写，手输链接大小写混了也不至于打不开。
 */
function sessionRouteFromHash(): { ownerId: string; id: string } | null {
  const path = location.hash.replace(/^#\/?/, '').split('?')[0]
  const m = /^c\/([a-z0-9][a-z0-9_-]*)(?:\/([a-z0-9][a-z0-9_-]*))?$/i.exec(path)
  if (!m) return null
  return m[2]
    ? { ownerId: m[1].toLowerCase(), id: m[2].toLowerCase() }
    : { ownerId: getUserId(), id: m[1].toLowerCase() }
}

export default function App() {
  /** 当前用户 id（= 会话归属人）。启动读一次就够，改它本来就要刷新页面 */
  const me = useMemo(() => getUserId(), []);
  /** 首帧先拿 localStorage 缓存渲染（秒开），服务端结果回来后覆盖，见下面 loadFromServer 的 effect */
  const [boot] = useState(loadCached);
  const [sessions, setSessions] = useState<ChatSession[]>(() => boot.sessions);
  const [activeId, setActiveId] = useState(() => boot.activeId);
  /** 各会话自己的草稿，切换时不丢 */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** 正在生成的会话 id（有至少一条流在跑）；用来在列表里标「生成中」 */
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
  const [codeTeam, setCodeTeam] = useState(() => localStorage.getItem('agentos.codeTeam') === '1');
  /**
   * 正在看的**别人**分享的会话。null = 看的是自己的会话。
   * 只读态：输入框禁用、进不了 onSend，顶栏挂一条只读横幅。
   *
   * 别人的会话单独存这一份、**不并进 sessions**：sessions 的语义是「我自己的会话」，
   * 并进去的话持久化 effect 会把它 PUT 成我的副本、删会话时还会连带删掉别人的。
   */
  const [viewerOwner, setViewerOwner] = useState<string | null>(null);
  const [sharedSession, setSharedSession] = useState<ChatSession | null>(null);
  /** 一次性提示（链接已复制 / 打开失败），几秒后自动消失 */
  const [toast, setToast] = useState('');
  /**
   * 上下文窗口（token）＝用量环的分母。
   * 真值从 /api/health 的 contextWindow 来（后端 settings.resolveContextWindow 算好的）；
   * CONTEXT_WINDOW_TOKENS 只在 health 还没回来 / 请求失败时兜底，别在这里另写一个数。
   *
   * 更新时机只有两处：①挂载时 fetchHealth 一次；②「配置」页保存后由 onSaved 带回来。
   * 少了第②处的话，改完上下文窗口不刷新整页，分母一直是旧值（那正是环看起来算错的原因之一）。
   */
  const [windowTokens, setWindowTokens] = useState<number>(CONTEXT_WINDOW_TOKENS);
  /**
   * 每个会话可以有**多条**流同时在跑：生成中继续发 = 插话，新的一轮直接发出去，
   * 不等前一轮结束（两条 SSE 各写各的助手气泡，patchAssistant 按 assistantId 定位，不会串）。
   * 外层 key 是会话 id，内层 key 是这一轮 assistantId。
   */
  const runMap = useRef(new Map<string, Map<string, AbortController>>());
  /** 已经收到 done 的轮次（按 assistantId 记）；收尾 Network Error 时靠它决定是否吞掉 */
  const doneRuns = useRef(new Set<string>());
  /** 锚点：当前会话有新消息就滚到底部 */
  const bottomRef = useRef<HTMLDivElement | null>(null);
  /** 消息区滚动容器：生成时用户往上翻就不强行拽回底部；也是右侧目录（ChatOutline）的定位基准 */
  const mainRef = useRef<HTMLElement | null>(null);
  const stickBottom = useRef(true);
  /** 输入框本体：自动长高要直接改它的 style.height */
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  /** 「我的」当前会话。草稿、发送、busyIds 都认它 */
  const active = sessions.find((s) => s.id === activeId) ?? sessions[0];
  /** 只读态：正在看别人分享的会话 */
  const readonly = viewerOwner != null;
  /** 实际渲染出来的会话：只读态是别人那条，否则是自己的当前会话 */
  const viewing = readonly ? sharedSession : active;
  const messages = viewing?.messages ?? [];
  const input = active ? (drafts[active.id] ?? '') : '';
  const activeBusy = active ? busyIds.has(active.id) : false;
  /**
   * 上下文用量估算（见 lib/contextUsage.ts，按字符粗估，不是精确 token）。
   *
   * 口径必须与 onSend 真正发出去的那份 history 一致，否则环上的数字和模型看到的是两个集合：
   *   1) toApiMessages 只留 role + content —— 工具卡片的 arguments / result 不会发回后端
   *      （后端只在本轮的 maxRounds 循环里用一次，跨轮不保留）；
   *   2) 排除正在流式的那条 —— onSend 里的 prior 就是这么过滤的；
   *   3) 单条按 OUTGOING_CONTENT_LIMIT 截断，与后端 /api/chat 的 8000 字符一致。
   *
   * 它仍然是**下限**：system prompt、工具 schema、skill 正文前端拿不到，真实占用会更高。
   */
  const contextUsed = useMemo(
    () => estimateOutgoingTokens(toApiMessages(messages.filter((m) => m.status !== 'streaming'))),
    [messages],
  );
  /** 比例收在 [0,1] 再给环形用：溢出会让 dashoffset 算出负数、环画反 */
  const contextRatio = contextRatioOf(contextUsed, windowTokens);
  /**
   * 预警线**不是**固定的 0.8 百分比，而是「窗口 − 预留」（见 lib/contextUsage.ts 的
   * CONTEXT_RESERVE_TOKENS）：
   *   - 窗口是输入和输出**共用**的，history 占掉一部分后还得留出模型写本轮回答、
   *     以及 agent 工具轮再跑几圈的余量；
   *   - 固定比例给不出这个余量：8k 窗口下 80% 只留 1.6k，200k 窗口下留 40k，
   *     差 25 倍，没法回答「为什么现在该开新会话」。
   * 旧的 CONTEXT_WARN_RATIO 已标 @deprecated，别再用。
   */
  const contextWarn = contextWarnOf(contextUsed, windowTokens);

  /** 每渲染同步一次快照。effect 里读 snap.current 就不会踩到闭包里的旧值 */
  const snap = useRef({ activeId, sessions })
  snap.current = { activeId, sessions }
  /**
   * 已经推给服务端的会话（按 id 存**对象引用**）。
   * 会话是整条不可变更新的：某条没动过时引用不变，据此跳过重复 PUT——
   * 不然每来一个 token 都会把所有会话重推一遍。
   */
  const pushedRef = useRef(new Map<string, ChatSession>())

  /** 落盘一条到服务端。失败不打扰界面：localStorage 缓存里还在，下次启动合并时会补推 */
  function persistOne(s: ChatSession) {
    return saveSession(toPayload(s)).catch((err) => {
      console.warn('[sessions] 保存失败：%s', sessionErrorText(err, '保存失败'))
    })
  }

  /**
   * 拉自己的会话列表，和本地缓存合并。
   * 合并是**并集**且同 id 取 updatedAt 新的那条：localStorage 是写后缓存，
   * 关页/崩溃前来不及 PUT 的改动只存在本地，无脑用服务端就把它丢了；
   * 本地较新的那几条这一步会补推上去。
   */
  async function refreshOwnSessions() {
    let merged: ChatSession[]
    try {
      const remote = (await listSessions()).map(hydrate)
      const result = reconcile(snap.current.sessions, remote)
      merged = result.merged
      // 先登记再推，避免推完之后下面的防抖 effect 又推一遍
      for (const s of merged) pushedRef.current.set(s.id, s)
      for (const s of result.push) void persistOne(s)
    } catch {
      // 服务端不可达：保留缓存内容，不弹错——离线也要能用
      return
    }
    setSessions(merged.length > 0 ? merged : [blankSession()])
  }

  /**
   * 打开别人分享的会话（只读）。
   * 对方没分享（403）/ 不存在（404）时给提示并退回自己的会话，别把用户卡在空页面上。
   */
  async function openShared(ownerId: string, id: string) {
    try {
      setSharedSession(hydrate(await fetchSharedSession(ownerId, id)))
      setViewerOwner(ownerId)
      setError('')
    } catch (err) {
      setViewerOwner(null)
      setSharedSession(null)
      setError(sessionErrorText(err, '打开分享的会话失败'))
      writeHash(snap.current.activeId)
    }
  }

  /** 把地址栏写成「我在看的会话」。已经是就不写，免得白白触发一次 hashchange */
  function writeHash(id: string) {
    if (!id) return
    const next = `#/c/${me}/${id}`
    if (location.hash === next) return
    location.hash = next
  }

  /*
   * hash → state。
   * 除了切页面，还要处理 #/c/<owner>/<id>：是自己的会话就切过去（本地没有就补拉一次），
   * 是别人的就拉下来进只读态。挂载时手动调一次——直接打开分享链接不会触发 hashchange。
   */
  useEffect(() => {
    const applyHash = () => {
      setPage(pageFromHash())
      const route = sessionRouteFromHash()
      if (!route) return
      if (route.ownerId !== me) {
        void openShared(route.ownerId, route.id)
        return
      }
      setViewerOwner(null)
      setSharedSession(null)
      setActiveId(route.id)
      if (!snap.current.sessions.some((s) => s.id === route.id)) {
        void refreshOwnSessions() // 换浏览器/清缓存后只留了链接：从服务端补回来
      }
    }
    window.addEventListener('hashchange', applyHash)
    applyHash()
    return () => window.removeEventListener('hashchange', applyHash)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* 首帧渲染完再拉服务端，和缓存合并。缓存让首屏不空，服务端保证跨浏览器一致 */
  useEffect(() => {
    void refreshOwnSessions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* state → hash：在会话页时地址栏始终指向当前会话，方便刷新 / 收藏 / 复制 */
  useEffect(() => {
    if (page !== 'chat' || readonly) return
    writeHash(active?.id ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, readonly, active?.id])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 3200)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    localStorage.setItem('agentos.rail', collapsed ? '1' : '0')
  }, [collapsed])

  useEffect(() => {
    localStorage.setItem('agentos.codeTeam', codeTeam ? '1' : '0')
  }, [codeTeam])

  useEffect(() => {
    if (!sessions.some((s) => s.id === activeId) && sessions[0]) {
      setActiveId(sessions[0].id)
    }
  }, [sessions, activeId])

  useEffect(() => {
    const flush = () => {
      saveCached(snap.current.activeId, snap.current.sessions)
      // 尽力补推一把。没推完也不要紧：下次启动 refreshOwnSessions 的合并会兜住
      for (const s of snap.current.sessions) {
        if (pushedRef.current.get(s.id) !== s) void persistOne(s)
      }
    }
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /*
   * 防抖持久化：本地缓存立刻写（便宜、不会失败），服务端 PUT 等 300ms 静默——
   * 流式时每个 token 都会改 sessions，不防抖就是每个 token 一次网络写。
   * 连续吐字超过 300ms 的话这一轮要等停下来才落盘，收尾靠 pagehide / 下次启动合并兜底。
   */
  useEffect(() => {
    saveCached(snap.current.activeId, snap.current.sessions)
    const timer = window.setTimeout(() => {
      const current = snap.current.sessions
      const pushed = pushedRef.current
      const seen = new Set<string>()
      for (const s of current) {
        seen.add(s.id)
        if (pushed.get(s.id) === s) continue // 引用没变 = 这条没动过
        pushed.set(s.id, s)
        void persistOne(s)
      }
      // 本地删掉的，服务端跟着删
      for (const id of [...pushed.keys()]) {
        if (seen.has(id)) continue
        pushed.delete(id)
        void deleteRemoteSession(id).catch(() => {})
      }
    }, 300)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        // 真实分母：后端按「面板 → 环境变量 → 兜底」算好的窗口大小
        if (data.contextWindow) setWindowTokens(data.contextWindow);
      })
      .catch(() => setMode('unknown'));
  }, []);

  /*
   * 贴底时才跟着新内容滚；用户往上翻就停住。
   * 用瞬时定位（不给 behavior: 'smooth'）：流式时每个 delta 都会跑一次这个 effect，
   * 平滑动画会被下一个 delta 反复打断，观感和性能都更差。
   */
  useEffect(() => {
    if (!stickBottom.current) return
    bottomRef.current?.scrollIntoView()
  }, [messages]);

  function onMainScroll() {
    const el = mainRef.current
    if (!el) return
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight
    stickBottom.current = gap < 80
  }

  function setInput(value: string) {
    if (!active) return
    const id = active.id
    setDrafts((prev) => ({ ...prev, [id]: value }))
  }

  /**
   * 流式事件写回助手消息。
   *
   * 这里只推 `updatedAt`（「最近活动」，含每个 token），**绝不能碰 `lastUserAt`**：
   * 那是左侧历史列表的排序 / 分组键，只有用户提问才该推进。一旦在这里顺手刷它，
   * 多个会话同时生成时谁刚吐字谁就窜到列表最前面，列表上下反复换位。
   */
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
      patchAssistant(sessionId, assistantId, (m) => {
        const base = withTtft(m)
        return {
          ...base,
          content: base.content + event.delta,
          parts: appendPart(base.parts, { type: 'text', text: event.delta }),
          status: 'streaming',
        }
      });
      return;
    }
    if (event.type === 'reasoning_delta') {
      patchAssistant(sessionId, assistantId, (m) => {
        const base = withTtft(m)
        return {
          ...base,
          parts: appendPart(base.parts, { type: 'reasoning', text: event.delta }),
          status: 'streaming',
        }
      })
      return
    }
    if (event.type === 'step') {
      patchAssistant(sessionId, assistantId, (m) => ({ ...m, step: event.index }))
      return
    }
    if (event.type === 'tool_start') {
      patchAssistant(sessionId, assistantId, (m) => {
        const base = withTtft(m)
        const parts = base.parts ?? []
        const known = parts.some((part) => part.type === 'tool' && part.id === event.id)
        return {
          ...base,
          parts: known ? parts : [...parts, { type: 'tool' as const, id: event.id }],
          tools: [
            ...base.tools.filter((t) => t.id !== event.id),
            {
              id: event.id,
              name: event.name,
              arguments: event.arguments,
              status: 'running' as const,
              step: base.step ?? 1,
              startedAt: Date.now(),
            },
          ],
        };
      });
      return;
    }
    if (event.type === 'tool_args') {
      patchAssistant(sessionId, assistantId, (m) => ({
        ...m,
        tools: m.tools.map((t) =>
          t.id === event.id && t.status === 'running' ? { ...t, arguments: event.arguments } : t,
        ),
      }))
      return
    }
    if (event.type === 'tool_result') {
      // 对应卡片改为完成，写入 result
      patchAssistant(sessionId, assistantId, (m) => {
        return {
          ...m,
          tools: m.tools.map((t) =>
            t.id === event.id
              ? {
                  ...t,
                  status: 'done',
                  result: event.result,
                  ms: t.startedAt ? Date.now() - t.startedAt : t.ms,
                  startedAt: undefined,
                }
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
              ? {
                  ...t,
                  status: 'error',
                  error: event.error,
                  ms: t.startedAt ? Date.now() - t.startedAt : t.ms,
                  startedAt: undefined,
                }
              : t,
          ),
        };
      });
      return;
    }
    if (event.type === 'tool_approval') {
      patchAssistant(sessionId, assistantId, (m) => {
        const base = withTtft(m)
        const parts = base.parts ?? []
        const known = parts.some((part) => part.type === 'tool' && part.id === event.id)
        const nextTool = {
          id: event.id,
          name: event.name,
          arguments: event.arguments,
          status: 'awaiting_approval' as const,
          preview: event.preview,
          path: event.path,
          before: event.before,
          after: event.after,
          risk: event.risk,
          riskReason: event.riskReason,
          step: base.step ?? 1,
          startedAt: Date.now(),
        }
        return {
          ...base,
          parts: known ? parts : [...parts, { type: 'tool' as const, id: event.id }],
          tools: [...base.tools.filter((t) => t.id !== event.id), nextTool],
        }
      })
      return
    }
    if (event.type === 'role_start' || event.type === 'role_done') {
      patchAssistant(sessionId, assistantId, (m) => ({
        ...m,
        parts: [...(m.parts ?? []), { type: 'role' as const, role: event.role, phase: event.type === 'role_start' ? 'start' as const : 'done' as const }],
      }))
      return
    }
    if (event.type === 'error') {
      setError(event.message);
      patchAssistant(sessionId, assistantId, (m) => ({ ...m, status: 'error' }));
      return;
    }
    if (event.type === 'done') {
      doneRuns.current.add(assistantId);
      patchAssistant(sessionId, assistantId, (m) => ({
        ...m,
        status: 'done',
        totalMs: m.startedAt ? Date.now() - m.startedAt : m.totalMs,
        startedAt: undefined,
      }));
    }
  }

  /**
   * 开一条流：登记进 runMap，顺便把会话标成「生成中」。
   * 支持同会话多条并存——这是「生成中继续发」的基础。
   */
  function addRun(sessionId: string, runId: string, controller: AbortController) {
    const runs = runMap.current.get(sessionId) ?? new Map<string, AbortController>()
    runs.set(runId, controller)
    runMap.current.set(sessionId, runs)
    setBusyIds((prev) => {
      if (prev.has(sessionId)) return prev
      const next = new Set(prev)
      next.add(sessionId)
      return next
    })
  }

  /** 收掉一条流：该会话再没有别的流时才算「不忙」 */
  function endRun(sessionId: string, runId: string) {
    /*
     * 这条流彻底结束了，顺手清掉它的「已 done」标记。
     * done 判断只在同一轮的收尾（catch 里的 softNet 分支）用到，而那段逻辑在 finally 之前，
     * 所以这里删不会漏掉判断；不删的话这个 Set 在长会话里只增不减。
     */
    doneRuns.current.delete(runId)
    const runs = runMap.current.get(sessionId)
    if (runs) {
      runs.delete(runId)
      if (runs.size > 0) return
      runMap.current.delete(sessionId)
    }
    setBusyIds((prev) => {
      if (!prev.has(sessionId)) return prev
      const next = new Set(prev)
      next.delete(sessionId)
      return next
    })
  }

  /** 停掉某个会话的所有流（删除会话时用） */
  function abortSession(sessionId: string) {
    const runs = runMap.current.get(sessionId)
    if (!runs) return
    runMap.current.delete(sessionId)
    for (const [runId, controller] of runs) {
      doneRuns.current.delete(runId)
      controller.abort()
    }
    setBusyIds((prev) => {
      if (!prev.has(sessionId)) return prev
      const next = new Set(prev)
      next.delete(sessionId)
      return next
    })
  }

  function openSession() {
    // 从「别人分享的只读会话」回来：不退出只读的话，新建/切换都打不开自己的会话
    setViewerOwner(null)
    setSharedSession(null)
    const empty = sessions.find((s) => s.messages.length === 0 && !busyIds.has(s.id))
    if (empty) {
      setActiveId(empty.id)
      setError('')
      return
    }
    const created = blankSession()
    const next = [created, ...sessions]
    setSessions(next)
    setActiveId(created.id)
    setError('')
  }

  function removeSession(id: string) {
    abortSession(id)
    if (activeId === id) {
      setViewerOwner(null)
      setSharedSession(null)
    }
    const rest = sessions.filter((s) => s.id !== id)
    const next = rest.length > 0 ? rest : [blankSession()]
    const nextActive = activeId === id ? next[0].id : activeId
    setSessions(next)
    setActiveId(nextActive)
  }

  /**
   * 分享一条会话。
   *
   * 先把可见性置成 shared —— 私密会话别人打开是 403，链接发出去也是打不开的。
   * 再把链接写进剪贴板；clipboard API 在非安全上下文 / 权限被拒时会失败，退回 prompt 展示。
   */
  async function onShare(id: string) {
    const target = sessions.find((s) => s.id === id)
    if (!target) return
    if (target.visibility !== 'shared') {
      const next: ChatSession = { ...target, visibility: 'shared' }
      setSessions((prev) => prev.map((s) => (s.id === id ? next : s)))
      try {
        pushedRef.current.set(id, next) // 这条算已推过，免得防抖 effect 再推一次
        await saveSession(toPayload(next))
      } catch (err) {
        setError(sessionErrorText(err, '设为可分享失败'))
        return
      }
    }
    // 用 href 而不是拼 origin：Electron 里页面是 file:// 加载的，origin 是字符串 'null'
    const url = `${location.href.split('#')[0]}#/c/${me}/${id}`
    try {
      await navigator.clipboard.writeText(url)
      setToast('链接已复制（已设为可分享）')
    } catch {
      window.prompt('复制这条链接分享给别人：', url)
    }
  }

  /**
   * 发送一轮对话。
   *
   * 生成中也能发（不用等上一条做完）：这里**不再**因为 busy 就 return。
   * 发给后端的 history 只带「已完成的消息」——正在流式的那条会被过滤掉，
   * 于是新一轮的输入恰好是「历史 + 我刚发的新消息」，不会被自己的半截回答干扰。
   *
   * 注意这份 prior 也正是用量环分子的口径（见上面 contextUsed 的注释）：
   * 两处必须用同一个过滤条件，改一处要同步另一处。
   *
   * @param text 可选：快捷提示按钮传入；不传则用输入框
   */
  async function onSend(text?: string) {
    // 只读态（在看别人分享的会话）不该发问。输入框已经禁用，这里再兜一道
    if (readonly) return
    const sessionId = active?.id
    if (!sessionId) return
    const content = (text ?? input).trim();
    if (!content) return;

    setError('');
    setDrafts((prev) => ({ ...prev, [sessionId]: '' }));
    stickBottom.current = true;

    // 流式中的回答不算「历史」：它还没说完，带上会让模型看着半截话继续编
    const prior = messages.filter((m) => m.status !== 'streaming')
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
      parts: [],
      status: 'streaming',
      startedAt: Date.now(),
    };

    setSessions((prev) => {
      const next = prev.map((s) => {
        if (s.id !== sessionId) return s
        const nextMessages = [...s.messages, userMsg, assistantMsg]
        return {
          ...s,
          title: sessionTitle(nextMessages),
          /*
           * 这里是**唯一**推进 lastUserAt 的地方：用户提问 = 列表排序 / 分组 / 显示日期的时间。
           * 分桶/排序只认固定历史（这次提问），所以之后不管流式吐多少 token，
           * 这个会话在列表里的位置和它所在的分组都不会再动。
           *
           * updatedAt 仍照常刷新（活动时间，别的地方要看「最近动过」）；
           * 两者分工别调换，详见 REPO_MAP.md 第 3.2 节。
           */
          lastUserAt: Date.now(),
          updatedAt: Date.now(),
          messages: nextMessages,
        }
      })
      return next
    })

    const controller = new AbortController();
    addRun(sessionId, assistantId, controller);

    try {
      await streamChat({
        messages: toApiMessages([...prior, userMsg]),
        mode: codeTeam ? 'code_team' : 'default',
        signal: controller.signal,
        // 后端只用它打链路日志（[chat][<sid>]），不参与对话逻辑
        sessionId,
        onEvent: (event) => handleEvent(sessionId, assistantId, event),
      });
      patchAssistant(sessionId, assistantId, (m) =>
        m.status === 'streaming'
          ? {
              ...m,
              status: 'done',
              totalMs: m.startedAt ? Date.now() - m.startedAt : m.totalMs,
              startedAt: undefined,
            }
          : m,
      );
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        patchAssistant(sessionId, assistantId, (m) => ({
          ...m,
          status: 'done',
          content: m.content || '（已停止）',
          totalMs: m.startedAt ? Date.now() - m.startedAt : m.totalMs,
          startedAt: undefined,
        }));
      } else {
        const message = err instanceof Error ? err.message : String(err);
        const softNet =
          /network error|连接中断|可以忽略|failed to fetch|err_network/i.test(message);
        // 长 SSE 收尾：这一轮已经 done 的话，axios/代理抛的 Network Error 直接吞掉
        if (doneRuns.current.has(assistantId) && softNet) {
          /* no-op */
        } else if (softNet) {
          const cur = snap.current.sessions
            .find((s) => s.id === sessionId)
            ?.messages.find((m) => m.id === assistantId);
          const hasWork = !!(cur?.content || cur?.tools.length);
          patchAssistant(sessionId, assistantId, (m) => ({
            ...m,
            status: hasWork || m.status === 'done' ? 'done' : 'error',
            content: hasWork || m.content ? m.content : `出错了：${message}`,
            totalMs: m.startedAt ? Date.now() - m.startedAt : m.totalMs,
            startedAt: undefined,
          }));
          if (!hasWork) setError(message);
        } else {
          setError(message);
          patchAssistant(sessionId, assistantId, (m) => ({
            ...m,
            status: 'error',
            content: m.content || `出错了：${message}`,
            totalMs: m.startedAt ? Date.now() - m.startedAt : m.totalMs,
            startedAt: undefined,
          }));
        }
      }
    } finally {
      endRun(sessionId, assistantId);
    }
  }

  /** 停止：打断**最新**那条流（生成中还能继续发，所以一个会话可能同时有多条） */
  function onStop() {
    if (!active) return
    const runs = runMap.current.get(active.id)
    if (!runs || runs.size === 0) return
    const last = Array.from(runs.entries()).pop()
    last?.[1].abort()
  }

  /**
   * 批准 / 拒绝一条挂起的写入。
   * options.all = 用户点了「批准全部」：后端给这一轮打标记，本轮后续的低 / 中风险写入
   * 不再逐条挂起等人点；高风险（.env / 密钥 / CI 配置）仍逐条拦。
   */
  async function onApproveTool(
    id: string,
    decision: 'approve' | 'deny',
    options?: { all?: boolean },
  ) {
    const snapshot = new Map<string, ToolCallView['status']>()
    setSessions((prev) =>
      prev.map((s) => ({
        ...s,
        messages: s.messages.map((m) => ({
          ...m,
          tools: m.tools.map((t) => {
            if (t.id !== id || t.status !== 'awaiting_approval') return t
            snapshot.set(t.id, t.status)
            return { ...t, status: 'running' as const }
          }),
        })),
      })),
    )
    try {
      const settled = await postChatApprove(id, decision, options)
      // 热重载后 SSE 已断：接口直接落盘，用返回结果更新卡片
      if (settled.mode === 'orphan') {
        setSessions((prev) =>
          prev.map((s) => ({
            ...s,
            messages: s.messages.map((m) => ({
              ...m,
              tools: m.tools.map((t) => {
                if (t.id !== id) return t
                if (settled.decision === 'approve' && settled.result) {
                  return {
                    ...t,
                    status: 'done' as const,
                    result: settled.result,
                    ms: t.startedAt ? Date.now() - t.startedAt : t.ms,
                    startedAt: undefined,
                  }
                }
                return {
                  ...t,
                  status: 'error' as const,
                  error: settled.error || (settled.decision === 'deny' ? '用户拒绝写入，文件未改' : '写入失败'),
                  startedAt: undefined,
                }
              }),
            })),
          })),
        )
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setSessions((prev) =>
        prev.map((s) => ({
          ...s,
          messages: s.messages.map((m) => ({
            ...m,
            tools: m.tools.map((t) => {
              if (t.id !== id) return t
              if (/没有这条待批准|已处理/.test(message)) {
                return {
                  ...t,
                  status: 'error' as const,
                  error: message,
                  startedAt: undefined,
                }
              }
              return snapshot.has(t.id) ? { ...t, status: 'awaiting_approval' as const } : t
            }),
          })),
        })),
      )
    }
  }

  const talk = (
    <div className="app__talk">
      <main className="main" ref={mainRef} onScroll={onMainScroll}>
        {/*
         * 会话头：显示当前会话 id（和后端 [chat][<sid>] 日志、URL 里的 id 是同一个值），
         * 归属人这一侧还给一颗「复制链接」。短 id 只取前 8 位，够对上日志又不占地方。
         */}
        {viewing && (
          <div className="chat-head">
            <span className="chat-head__id" title={`完整会话 id：${viewing.id}`}>
              会话 #{viewing.id.slice(0, 8)}
            </span>
            {readonly ? (
              <span className="chat-head__ro">只读 · 来自 {viewerOwner} 的分享</span>
            ) : (
              <button
                type="button"
                className="chat-head__share"
                onClick={() => void onShare(viewing.id)}
                title="复制分享链接（会把这条会话设为可分享）"
              >
                {viewing.visibility === 'shared' ? '已分享 · 复制链接' : '复制链接'}
              </button>
            )}
          </div>
        )}
        {toast && <div className="chat-toast">{toast}</div>}
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
        <MessageList messages={messages} onApprove={onApproveTool} codeTeam={codeTeam} />
        <div ref={bottomRef} />
      </main>

      <footer className="composer-wrap">
        {error && <div className="error-banner">{error}</div>}
        {readonly && (
          <div className="readonly-note">
            这是 <strong>{viewerOwner}</strong> 分享的会话，只能查看。要自己提问请开一个新会话。
          </div>
        )}
        {page === 'chat' && !readonly && (
          <div className="hints">
            <label className={codeTeam ? 'team-switch team-switch--on' : 'team-switch'}>
              <input
                type="checkbox"
                checked={codeTeam}
                onChange={(e) => setCodeTeam(e.target.checked)}
              />
              代码团队
            </label>
            {(codeTeam
              ? ['看一下这个仓库怎么组织的', '给 README 加一句项目说明', '当前改了什么？']
              : ['现在几点了？', '帮我算 123*456', '读一下 README.md', '当前改了什么？', '这个项目技术栈是什么？']
            ).map((q) => (
                <button
                  key={q}
                  type="button"
                  className="hint"
                  /* 生成中不再禁用：这时发出去就是「插话」，新的一轮直接开跑 */
                  onClick={() => onSend(q)}
                >
                  {q}
                </button>
              ))}
          </div>
        )}
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void onSend();
          }}
        >
          <textarea
            ref={composerRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={readonly}
            placeholder={
              readonly
                ? `只读：这是 ${viewerOwner} 分享的会话`
                : activeBusy
                  ? '继续输入可以直接发出去（插话），不用等这一轮结束'
                  : '输入问题，Enter 发送，Shift+Enter 换行'
            }
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
          {/*
           * 生成中「发送」和「停止」并存：原来 busy 时整颗发送键被换成停止键，
           * 于是没法插话。现在发送始终在，旁边多一颗停止（生成中才出现）。
           * 外观对齐 Cursor：圆钮 + 上箭头 / 方块停止。
           */}
          <div className="composer__actions">
            {activeBusy && (
              <button
                type="button"
                className="composer__icon-btn composer__icon-btn--stop"
                onClick={onStop}
                title="只打断最新那一条；此前已经开出去的几轮会各自跑完"
                aria-label="停止"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                  <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />
                </svg>
              </button>
            )}
            <button
              type="submit"
              className="composer__icon-btn composer__icon-btn--send"
              disabled={!input.trim()}
              aria-label="发送"
              title="发送"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path
                  d="M12 19V5M6 11l6-6 6 6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.25"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
          {/*
           * 框里的第二行：左边用量环、右边工作区条。
           * 它们在 <form className="composer"> 内部，和输入区共用同一个圆角外框
           * （AppShell.css 把白底/边框/圆角从 textarea 提到了 .composer，这一行是 grid-area: foot）。
           * 注意 WorkspaceBar 里只有 div 和 type="button"，没有 form/input，放进来不会形成嵌套表单。
           */}
          <div className="composer-foot">
            {messages.length > 0 && (
              <div
                className={contextWarn ? 'ctx ctx--warn' : 'ctx'}
                title="与发给后端的 history 同口径：只数角色和正文、单条按 8000 字符截断，不含系统提示词、工具 schema 与 skill 正文，所以是下限；预警线按「窗口 − 预留」判，不是固定百分比"
              >
                <svg className="ctx__ring" viewBox="0 0 24 24" aria-hidden="true">
                  <circle className="ctx__ring-track" cx="12" cy="12" r={RING_RADIUS} />
                  {/*
                   * 从 12 点方向开始画（SVG 的 0° 在 3 点方向），顺时针走。
                   * dasharray 放整圈周长、dashoffset 按比例往后收，就是进度环。
                   */}
                  <circle
                    className="ctx__ring-fill"
                    cx="12"
                    cy="12"
                    r={RING_RADIUS}
                    transform="rotate(-90 12 12)"
                    strokeDasharray={RING_CIRCUMFERENCE}
                    strokeDashoffset={RING_CIRCUMFERENCE * (1 - contextRatio)}
                  />
                </svg>
                <span className="ctx__text">
                  {formatTokens(contextUsed)} / {formatTokens(windowTokens)}
                  <span className="ctx__mode">下限</span>
                </span>
                {contextWarn && <span className="ctx__hint">接近上限，建议开新会话</span>}
              </div>
            )}
            <WorkspaceBar />
          </div>
        </form>
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
                // 从只读态切回自己的会话：清掉别人那条，否则视图还停在分享的会话上
                setViewerOwner(null)
                setSharedSession(null)
                setActiveId(id)
                setError('')
              }}
              onDelete={removeSession}
              onShare={(id) => void onShare(id)}
            />
            {talk}
            {/*
             * 会话内提问目录：点一下直接跳到那条提问（瞬时定位，无过场动画）。
             * onJump 先关掉「自动贴底」——否则这一轮还在流式时，下一个 delta 会
             * 立刻把视图拽回底部，看起来像「点了没反应」。
             */}
            <ChatOutline
              messages={messages}
              containerRef={mainRef}
              onJump={() => {
                stickBottom.current = false
              }}
            />
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
              /*
               * 配置页保存后的窗口大小要立刻生效。
               * 挂载时那次 fetchHealth 的依赖是 []，而 App 是根组件、切 hash 不会重新挂载，
               * 所以不在这里更新的话：改完上下文窗口回对话页，分母一直是旧值（只有整页刷新才对）。
               */
              setWindowTokens(next.contextWindow)
            }}
            onMcpSaved={(next) => setMcp(next)}
          />
        )}
      </div>
    </div>
  )
}
