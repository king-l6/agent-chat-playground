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

export type DeliveryRun = {
  id: string
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
  patch?: { summary: string; files: string[] }
  review?: { comments: Array<{ path: string; risk: string; mustFix: boolean }>; riskReason?: string }
  test_report?: {
    items: Array<{ acId: string; result: string; detail: string }>
    commandLogs: Array<{ command: string; exitCode: number; excerpt: string }>
    riskReason?: string
  }
  release_notes?: { text: string; files: string[] }
  questions: string[]
  gates: Array<{ action: string; actor: Seat; at: string; reason?: string }>
}

function apiError(err: unknown) {
  if (axios.isAxiosError(err)) {
    const msg = (err.response?.data as { error?: string } | undefined)?.error
    return new Error(msg || err.message)
  }
  return err instanceof Error ? err : new Error(String(err))
}

export async function fetchDelivery() {
  const { data } = await axios.get<DeliveryRun>(`${API_BASE}/api/delivery`)
  return data
}

export async function saveSeat(seat: Seat) {
  const { data } = await axios.put<DeliveryRun>(`${API_BASE}/api/delivery/seat`, { seat })
  return data
}

export async function savePrd(
  actor: Seat,
  patch: Partial<Pick<DeliveryRun['prd'], 'title' | 'oneLiner' | 'body' | 'acceptance'>>,
) {
  try {
    const { data } = await axios.put<DeliveryRun>(`${API_BASE}/api/delivery/prd`, { actor, ...patch })
    return data
  } catch (err) {
    throw apiError(err)
  }
}

export async function postGate(
  actor: Seat,
  action: string,
  extra?: { reason?: string; questions?: string[] },
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

export async function streamDeliveryTurn(options: {
  actor: Seat
  message: string
  onEvent: (event: SseEvent) => void
}) {
  const res = await axios.post(
    `${API_BASE}/api/delivery/turn`,
    { actor: options.actor, message: options.message },
    { adapter: 'fetch', responseType: 'stream', headers: { 'Content-Type': 'application/json' } },
  )
  const stream = res.data as ReadableStream<Uint8Array>
  const reader = stream.getReader()
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
