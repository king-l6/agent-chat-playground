import axios from 'axios'

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? ''

export type MeetingRoom = {
  roomId: number
  roomName: string
  capacity: number
  location: string
  resources: string
  needApprove: boolean
  reservableStart: string
  reservableEnd: string
  notReserve: boolean
  notReserveReason: string
  busy: string
  who: Record<string, string>
}

export type MeetingScan = {
  date: string
  total: number
  userId: number | null
  userName: string
  rooms: MeetingRoom[]
}

function errorText(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { error?: unknown; message?: unknown } | undefined
    if (typeof data?.error === 'string' && data.error) return data.error
    if (typeof data?.message === 'string' && data.message) return data.message
  }
  if (err instanceof Error && err.message) return err.message
  return fallback
}

export async function scanMeeting(cookie: string, date: string): Promise<MeetingScan> {
  try {
    const { data } = await axios.post<MeetingScan>(`${API_BASE}/api/meeting/scan`, { cookie, date })
    return data
  } catch (err) {
    throw new Error(errorText(err, '查询会议室失败'))
  }
}

export async function bookMeeting(input: {
  cookie: string
  roomId: number
  start: string
  end: string
  subject: string
  reminderTime: number
}): Promise<{ ok: true; message: string; userName: string }> {
  try {
    const { data } = await axios.post<{ ok: true; message: string; userName: string }>(
      `${API_BASE}/api/meeting/book`,
      input,
    )
    return data
  } catch (err) {
    throw new Error(errorText(err, '预定失败'))
  }
}
