/**
 * 画布只存拓扑：节点位置、连线、问题。不存上一轮运行结果。
 */
import type { Edge, Node } from '@xyflow/react'

export const CANVAS_STORAGE_KEY = 'acp.canvas.v1'
export const DEFAULT_QUESTION = '每天优先学的第一项是流式还是画布？'

const KINDS = new Set(['ask', 'search', 'answer', 'calc', 'route'])

type Kind = 'ask' | 'search' | 'answer' | 'calc' | 'route'

export type CanvasNodeData = {
  kind: Kind
  title: string
  hint: string
  status: 'idle' | 'running' | 'done' | 'error' | 'skip'
  output: string
  expression?: string
}

export type SavedCanvas = {
  v: 1
  question: string
  nodes: Array<{
    id: string
    position: { x: number; y: number }
    data: { kind: Kind; title: string; hint: string; expression?: string }
  }>
  edges: Array<{
    id: string
    source: string
    target: string
    sourceHandle?: string | null
    targetHandle?: string | null
  }>
}

function stripNode(n: Node<CanvasNodeData>) {
  return {
    id: n.id,
    position: { x: n.position.x, y: n.position.y },
    data: {
      kind: n.data.kind,
      title: n.data.title,
      hint: n.data.hint,
      ...(n.data.expression ? { expression: n.data.expression } : {}),
    },
  }
}

function stripEdge(e: Edge) {
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
    ...(e.targetHandle ? { targetHandle: e.targetHandle } : {}),
  }
}

function parseNode(raw: unknown): Node<CanvasNodeData> | null {
  if (!raw || typeof raw !== 'object') return null
  const n = raw as {
    id?: unknown
    position?: { x?: unknown; y?: unknown }
    data?: { kind?: unknown; title?: unknown; hint?: unknown; expression?: unknown }
  }
  if (typeof n.id !== 'string' || !n.id) return null
  if (typeof n.position?.x !== 'number' || typeof n.position?.y !== 'number') return null
  if (!n.data || !KINDS.has(String(n.data.kind))) return null
  if (typeof n.data.title !== 'string') return null
  return {
    id: n.id,
    type: 'step',
    position: { x: n.position.x, y: n.position.y },
    data: {
      kind: n.data.kind as Kind,
      title: n.data.title,
      hint: typeof n.data.hint === 'string' ? n.data.hint : '',
      status: 'idle',
      output: '',
      ...(typeof n.data.expression === 'string' ? { expression: n.data.expression } : {}),
    },
  }
}

function parseEdge(raw: unknown): Edge | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as {
    id?: unknown
    source?: unknown
    target?: unknown
    sourceHandle?: unknown
    targetHandle?: unknown
  }
  if (typeof e.id !== 'string' || typeof e.source !== 'string' || typeof e.target !== 'string') return null
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    animated: true,
    ...(typeof e.sourceHandle === 'string' ? { sourceHandle: e.sourceHandle } : {}),
    ...(typeof e.targetHandle === 'string' ? { targetHandle: e.targetHandle } : {}),
  }
}

export function loadCanvas(): {
  question: string
  nodes: Node<CanvasNodeData>[]
  edges: Edge[]
} | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(CANVAS_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { v?: unknown; question?: unknown; nodes?: unknown; edges?: unknown }
    if (parsed.v !== 1 || typeof parsed.question !== 'string') return null
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null
    const nodes = parsed.nodes.map(parseNode).filter((n): n is Node<CanvasNodeData> => n != null)
    const edges = parsed.edges.map(parseEdge).filter((e): e is Edge => e != null)
    if (!nodes.some((n) => n.id === 'ask' && n.data.kind === 'ask')) return null
    if (nodes.length === 0) return null
    return { question: parsed.question.slice(0, 2000), nodes, edges }
  } catch {
    return null
  }
}

export function saveCanvas(
  question: string,
  nodes: Node<CanvasNodeData>[],
  edges: Edge[],
) {
  if (typeof localStorage === 'undefined') return
  const payload: SavedCanvas = {
    v: 1,
    question,
    nodes: nodes.map(stripNode),
    edges: edges.map(stripEdge),
  }
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(payload))
}
