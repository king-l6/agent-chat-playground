/**
 * SSE 客户端：向后端发消息，边收流边回调事件
 * App.tsx 点「发送」后主要走这里的 streamChat
 */

import axios from 'axios';
import type { SseEvent, UiMessage } from '../types';

/** 后端地址；.env 里 VITE_API_BASE，空则走当前域名（开发时配合代理） */
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';

/**
 * 发起一轮聊天：POST /api/chat，持续读取 SSE，每解析出一个事件就 onEvent
 * @param messages 发给后端的精简历史（只有 role + content）
 * @param signal   AbortController.signal，点「停止」时 abort 会中断请求
 * @param onEvent  每收到一个 SseEvent 回调一次（交给 App.handleEvent）
 */
export async function streamChat(options: {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  signal?: AbortSignal;
  onEvent: (event: SseEvent) => void;
}) {
  // 1) 用 axios 的 fetch adapter + stream，才能在浏览器里边收边解析 SSE
  let stream: ReadableStream<Uint8Array>;
  try {
    const res = await axios.post(
      `${API_BASE}/api/chat`,
      { messages: options.messages },
      {
        adapter: 'fetch',
        responseType: 'stream',
        headers: { 'Content-Type': 'application/json' },
        signal: options.signal,
      },
    );

    stream = res.data as ReadableStream<Uint8Array>;
  } catch (err) {
    // 统一成 AbortError，App 里按 name === 'AbortError' 处理「停止」
    if (axios.isCancel(err) || (err as Error).name === 'AbortError') {
      throw new DOMException('Aborted', 'AbortError');
    }
    if (axios.isAxiosError(err)) {
      const data = err.response?.data;
      let text = '';
      if (typeof data === 'string') {
        text = data;
      } else if (data instanceof ReadableStream) {
        text = await new Response(data).text().catch(() => '');
      }
      throw new Error(text || `请求失败 HTTP ${err.response?.status ?? ''}`);
    }
    throw err;
  }

  if (!stream) {
    throw new Error('请求失败：无响应体');
  }

  // 2) ReadableStream：一块一块读二进制，再用 TextDecoder 转成字符串
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = ''; // 跨 chunk 拼接：上次没收完的半截事件先留着

  while (true) {
    const { done, value } = await reader.read();
    if (done) break; // 流结束
    buffer += decoder.decode(value, { stream: true });
    // SSE 约定：事件之间用空行分隔（\n\n）
    const chunks = buffer.split('\n\n');
    // pop 出最后一段：可能还不完整，下次继续拼
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      // 一个事件里可能有多行，我们只要以 data: 开头的那行
      const line = chunk
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('data:'));
      if (!line) continue;
      // 去掉 "data:" 前缀，剩下就是 JSON 字符串
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        options.onEvent(JSON.parse(payload) as SseEvent);
      } catch {
        // 某包解析失败就跳过，避免整轮崩掉
      }
    }
  }
}

/**
 * 把 UI 消息列表收成后端接口需要的格式
 * （去掉空助手气泡等，只保留 role + content）
 */
export function toApiMessages(messages: UiMessage[]) {
  return messages
    .filter((m) => m.content.trim() || m.role === 'user')
    .map((m) => ({
      role: m.role,
      content: m.content,
    }));
}

/** 探测后端是否在线，以及当前是 live 还是 mock */
export type RagStatus = {
  chunks: number
  docs: number
  retrieval: string
  embedding: string
  indexed: number
  dim?: number
  embedError: string | null
  images?: number
  imageModel?: string
  imageDim?: number
}

export type KnowledgeDoc = {
  docId: string
  source: 'builtin' | 'upload' | 'wiki'
  filename?: string
  title: string
  chunkCount: number
  bytes?: number
}

export type IndexRow = {
  id: string
  docId: string
  title: string
  head: string
  tail: string | null
  chars: number
  dim: number
  vectorHead: number[]
}

export type SkillMeta = {
  name: string
  description: string
}

/** 当前 Agent 能碰的磁盘根目录；没选过是 null */
export async function fetchWorkspace() {
  const { data } = await axios.get<{ root: string | null; here?: string }>(`${API_BASE}/api/workspace`);
  return data.root;
}

export async function fetchWorkspaceInfo() {
  const { data } = await axios.get<{ root: string | null; here: string }>(`${API_BASE}/api/workspace`)
  return data
}

export type WorkspaceBrowse = {
  cwd: string
  parent: string | null
  home: string
  here: string
  entries: Array<{ name: string; path: string }>
}

export async function browseWorkspace(dir?: string) {
  try {
    const { data } = await axios.get<WorkspaceBrowse>(`${API_BASE}/api/workspace/browse`, {
      params: dir ? { dir } : undefined,
    })
    return data
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const msg = (err.response?.data as { error?: string } | undefined)?.error
      throw new Error(msg || err.message)
    }
    throw err
  }
}

export async function setWorkspace(root: string) {
  try {
    const { data } = await axios.post<{ ok: boolean; root: string }>(`${API_BASE}/api/workspace`, {
      root,
    })
    return data.root
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const msg = (err.response?.data as { error?: string } | undefined)?.error
      throw new Error(msg || err.message)
    }
    throw err
  }
}

export function notifyWorkspaceChanged(root: string | null) {
  window.dispatchEvent(new CustomEvent('workspace-changed', { detail: root }))
}

export type LlmSettingsPublic = {
  mode: 'mock' | 'live'
  hasKey: boolean
  baseURL: string
  model: string
}

export type McpPublic = {
  enabled: boolean
  connected: boolean
  url: string
  hasAuth: boolean
  tools: string[]
  error: string | null
}

export async function fetchSettings() {
  const { data } = await axios.get<LlmSettingsPublic>(`${API_BASE}/api/settings`)
  return data
}

export async function saveSettings(body: {
  mode: 'mock' | 'live'
  apiKey?: string
  baseURL?: string
  model?: string
}) {
  try {
    const { data } = await axios.put<LlmSettingsPublic>(`${API_BASE}/api/settings`, body)
    return data
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const msg = (err.response?.data as { error?: string } | undefined)?.error
      throw new Error(msg || err.message)
    }
    throw err
  }
}

export async function fetchMcp() {
  const { data } = await axios.get<McpPublic>(`${API_BASE}/api/mcp`)
  return data
}

export async function saveMcp(body: { enabled: boolean; url?: string; auth?: string }) {
  try {
    const { data } = await axios.put<McpPublic>(`${API_BASE}/api/mcp`, body)
    return data
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const msg = (err.response?.data as { error?: string } | undefined)?.error
      throw new Error(msg || err.message)
    }
    throw err
  }
}

export async function importClaudeMcp() {
  try {
    const { data } = await axios.post<McpPublic>(`${API_BASE}/api/mcp/import-claude`)
    return data
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const msg = (err.response?.data as { error?: string } | undefined)?.error
      throw new Error(msg || err.message)
    }
    throw err
  }
}

export async function fetchHealth() {
  const { data } = await axios.get<{
    ok: boolean
    mode: string
    model?: string
    rag?: RagStatus
    skills?: SkillMeta[]
    mcp?: McpPublic
  }>(`${API_BASE}/api/health`);
  return data;
}

export type WikiNode = {
  name: string
  path: string
  type: 'dir' | 'file'
  children?: WikiNode[]
}

export async function fetchWikiTree() {
  try {
    const { data } = await axios.get<{
      root: string
      exists: boolean
      count: number
      tree: WikiNode[]
    }>(`${API_BASE}/api/wiki/tree`)
    return data
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const msg = (err.response?.data as { error?: string } | undefined)?.error
      throw new Error(msg || err.message)
    }
    throw err
  }
}

export async function fetchWikiDoc(docPath: string) {
  try {
    const { data } = await axios.get<{
      path: string
      title: string
      content: string
      bytes: number
    }>(`${API_BASE}/api/wiki/doc`, { params: { path: docPath } })
    return data
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const msg = (err.response?.data as { error?: string } | undefined)?.error
      throw new Error(msg || err.message)
    }
    throw err
  }
}

export type WikiIngestStatus = {
  running: boolean
  done: number
  total: number
  current: string
  ok: number
  failed: number
  error: string | null
  finishedAt: string | null
}

export async function ingestWikiOne(docPath: string) {
  try {
    const { data } = await axios.post<{
      ok: boolean
      mode: 'one'
      docId: string
      chunks: number
      rag: RagStatus
    }>(`${API_BASE}/api/wiki/ingest`, { path: docPath })
    return data
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const msg = (err.response?.data as { error?: string } | undefined)?.error
      throw new Error(msg || err.message)
    }
    throw err
  }
}

export async function ingestWikiBatch(options: { prefix?: string; limit?: number } = {}) {
  try {
    const { data } = await axios.post<{
      ok: boolean
      mode: 'batch'
      status: WikiIngestStatus
    }>(`${API_BASE}/api/wiki/ingest`, { all: true, ...options })
    return data
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const msg = (err.response?.data as { error?: string } | undefined)?.error
      throw new Error(msg || err.message)
    }
    throw err
  }
}

export async function fetchWikiIngestStatus() {
  const { data } = await axios.get<WikiIngestStatus>(`${API_BASE}/api/wiki/ingest/status`)
  return data
}

export async function fetchKnowledgeBoard(options?: { lite?: boolean }) {
  const { data } = await axios.get<{
    rag: RagStatus
    documents: KnowledgeDoc[]
    index: { model: string; dim: number; chunks: IndexRow[] }
  }>(`${API_BASE}/api/knowledge`, {
    params: options?.lite ? { lite: 1 } : undefined,
  });
  return data;
}

/** 向量库 points 分页；doc 为空表示全库 */
export async function fetchKnowledgeChunks(params: {
  doc?: string | null
  q?: string
  offset?: number
  limit?: number
}) {
  const { data } = await axios.get<{
    total: number
    offset: number
    limit: number
    chunks: IndexRow[]
  }>(`${API_BASE}/api/knowledge/chunks`, {
    params: {
      doc: params.doc || undefined,
      q: params.q || undefined,
      offset: params.offset ?? 0,
      limit: params.limit ?? 50,
    },
  })
  return data
}

export type NamespaceChild = {
  kind: 'dir' | 'file'
  name: string
  path: string
  count: number
  id?: string
  source?: string
}

/** 向量库侧栏：按 path 拉一层子节点 */
export async function fetchKnowledgeNamespaces(path = '') {
  const { data } = await axios.get<{ path: string; children: NamespaceChild[] }>(
    `${API_BASE}/api/knowledge/namespaces`,
    { params: path ? { path } : {} },
  )
  return data
}

/** 深链选中文档时解析目录路径 */
export async function fetchKnowledgeNamespacePath(docId: string) {
  const { data } = await axios.get<{ resolve: string[] | null }>(
    `${API_BASE}/api/knowledge/namespaces`,
    { params: { doc: docId } },
  )
  return data.resolve
}

/** 上传知识库文档（multipart 字段名 file） */
export async function uploadKnowledge(file: File) {
  const body = new FormData();
  body.append('file', file);
  const { data } = await axios.post<{
    ok: boolean;
    filename: string;
    originalName?: string;
    docId: string;
    rag: RagStatus;
    error?: string;
  }>(`${API_BASE}/api/knowledge/upload`, body);
  return data;
}

export async function deleteKnowledgeFile(docId: string) {
  const { data } = await axios.delete<{
    ok: boolean
    rag: RagStatus
    documents: KnowledgeDoc[]
  }>(`${API_BASE}/api/knowledge/docs/${encodeURIComponent(docId)}`)
  return data
}

export async function runWorkflow(
  question: string,
  pipeline: Array<{ id: string; kind: 'search' | 'answer' | 'calc'; expression?: string }>,
) {
  const { data } = await axios.post<{
    steps: Array<{ id: string; output: string }>
    answer: string
  }>(`${API_BASE}/api/workflow/run`, { question, pipeline })
  return data
}
