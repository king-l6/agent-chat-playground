import axios from 'axios'
import type { SseEvent } from '../types'

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? ''

export type Seat = 'pm' | 'dev' | 'qa'
export type Phase =
  | 'drafting'
  | 'developing'
  | 'blocked_on_pm'
  | 'reviewing'
  | 'testing'
  | 'signed'

export type Acceptance = {
  id: string
  text: string
  kind: 'auto' | 'manual'
  command?: string
  observable?: string
  checkedByPm: boolean
}

export type TalkTraceStep = {
  id: string
  name: string
  arguments: string
  status: 'running' | 'done' | 'error'
  result?: string
  error?: string
}

export type TalkTrace = { steps: TalkTraceStep[]; live?: string }

export type TalkTurn = { role: 'user' | 'assistant'; content: string; trace?: TalkTrace }

export type DeliveryRun = {
  id: string
  workspaceRoot?: string
  createdAt?: string
  updatedAt?: string
  seat: Seat
  phase: Phase
  stale: boolean
  dirtyWarning: boolean
  prd: {
    title: string
    oneLiner: string
    body: string
    acceptance: Acceptance[]
    confirmed: boolean
    confirmedAt?: string
    version: number
  }
  patch?: {
    summary: string
    files: string[]
    status?: string
    diff?: string
    scaffold?: { written: string[]; missingBefore: string[] }
  }
  review?: { comments: Array<{ path: string; risk: string; mustFix: boolean }>; riskReason?: string }
  test_report?: {
    items: Array<{ acId: string; result: string; detail: string }>
    commandLogs: Array<{ command: string; exitCode: number; excerpt: string }>
    riskReason?: string
  }
  release_notes?: { text: string; files: string[] }
  questions: string[]
  talk: TalkTurn[]
  lastErrors?: string[]
  workspace?: { root: string | null; status: string; diff: string }
  gates: Array<{ action: string; actor: Seat; at: string; reason?: string }>
}

/** 需求列表用的摘要，不带 talk/patch */
export type RunSummary = {
  id: string
  title: string
  phase: Phase
  seat: Seat
  workspaceRoot?: string
  signed: boolean
  updatedAt?: string
}

export type RunList = { activeId: string; runs: RunSummary[] }

function apiError(err: unknown) {
  if (axios.isAxiosError(err)) {
    const msg = (err.response?.data as { error?: string } | undefined)?.error
    return new Error(msg || err.message)
  }
  return err instanceof Error ? err : new Error(String(err))
}

export async function fetchDelivery(id?: string) {
  const { data } = await axios.get<DeliveryRun>(`${API_BASE}/api/delivery`, { params: { id } })
  return data
}

/** 预览要挂进沙箱的文件。path 相对产物根，binary 为 true 时 content 是 base64 */
export type ArtifactNode = { path: string; size: number; binary: boolean; content: string }
export type ArtifactBundle = {
  root: string
  files: ArtifactNode[]
  skipped: Array<{ path: string; reason: 'over-file-cap' | 'over-total-cap' | 'unreadable' }>
  truncated: boolean
  warnings: string[]
  health: { ok: boolean; missing: string[]; entry: string | null; evidence: string[] }
}

export async function fetchDeliveryArtifacts(id?: string) {
  const { data } = await axios.get<ArtifactBundle>(`${API_BASE}/api/delivery/artifacts`, {
    params: { id },
  })
  return data
}

export async function fetchDeliveryRuns() {
  const { data } = await axios.get<RunList>(`${API_BASE}/api/delivery/runs`)
  return data
}

/** 新开一条需求；不传 workspaceRoot 就用全局默认仓库 */
export async function createDelivery(workspaceRoot?: string) {
  try {
    const { data } = await axios.post<DeliveryRun>(`${API_BASE}/api/delivery/runs`, {
      workspaceRoot,
    })
    return data
  } catch (err) {
    throw apiError(err)
  }
}

export async function activateDelivery(id: string) {
  const { data } = await axios.post<DeliveryRun>(`${API_BASE}/api/delivery/runs/activate`, { id })
  return data
}

export async function deleteDelivery(id: string) {
  const { data } = await axios.post<DeliveryRun>(`${API_BASE}/api/delivery/runs/delete`, { id })
  return data
}

/** 把这条需求绑到某个本地仓库 */
export async function bindDeliveryWorkspace(id: string, root: string | undefined) {
  try {
    const { data } = await axios.put<DeliveryRun>(`${API_BASE}/api/delivery/runs/workspace`, {
      id,
      root,
    })
    return data
  } catch (err) {
    throw apiError(err)
  }
}

export async function saveSeat(seat: Seat, id?: string) {
  const { data } = await axios.put<DeliveryRun>(`${API_BASE}/api/delivery/seat`, { seat, id })
  return data
}

export async function savePrd(
  actor: Seat,
  patch: Partial<Pick<DeliveryRun['prd'], 'title' | 'oneLiner' | 'body' | 'acceptance'>>,
  id?: string,
) {
  try {
    const { data } = await axios.put<DeliveryRun>(`${API_BASE}/api/delivery/prd`, {
      actor,
      id,
      ...patch,
    })
    return data
  } catch (err) {
    throw apiError(err)
  }
}

export async function postGate(
  actor: Seat,
  action: string,
  extra?: { reason?: string; questions?: string[]; id?: string },
) {
  try {
    const { data } = await axios.post<DeliveryRun>(`${API_BASE}/api/delivery/gate`, {
      actor,
      action,
      ...extra,
    })
    return data
  } catch (err) {
    throw apiError(err)
  }
}

/** 新开一条需求（不再覆盖当前那条） */
export async function resetDelivery() {
  const { data } = await axios.post<DeliveryRun>(`${API_BASE}/api/delivery/reset`)
  return data
}

export async function streamDeliveryTurn(options: {
  actor: Seat
  message: string
  id?: string
  onEvent: (event: SseEvent) => void
}) {
  const res = await fetch(`${API_BASE}/api/delivery/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ actor: options.actor, message: options.message, id: options.id }),
  })
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `研发回合失败 HTTP ${res.status}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const chunks = buffer.split('\n\n')
    buffer = chunks.pop() ?? ''
    for (const chunk of chunks) {
      const line = chunk
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('data:'))
      if (!line) continue
      try {
        options.onEvent(JSON.parse(line.slice(5).trim()) as SseEvent)
      } catch {
        /* skip */
      }
    }
  }
}
