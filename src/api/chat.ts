import type { SseEvent, UiMessage } from '../types'

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? ''

export async function streamChat(options: {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  signal?: AbortSignal
  onEvent: (event: SseEvent) => void
}) {
  const res = await fetch(`${API_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: options.messages }),
    signal: options.signal,
  })

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `请求失败 HTTP ${res.status}`)
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
      const payload = line.slice(5).trim()
      if (!payload) continue
      try {
        options.onEvent(JSON.parse(payload) as SseEvent)
      } catch {
        // ignore malformed chunk
      }
    }
  }
}

export function toApiMessages(messages: UiMessage[]) {
  return messages
    .filter((m) => m.content.trim() || m.role === 'user')
    .map((m) => ({
      role: m.role,
      content: m.content,
    }))
}

export async function fetchHealth() {
  const res = await fetch(`${API_BASE}/api/health`)
  if (!res.ok) throw new Error(`health ${res.status}`)
  return res.json() as Promise<{ ok: boolean; mode: string; model?: string }>
}
