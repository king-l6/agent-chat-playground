import axios from 'axios'

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? ''

export type ShotSize = '远景' | '全景' | '中景' | '近景' | '特写'

export type Shot = {
  index: number
  shotSize: ShotSize
  durationSec: number
  characters: string[]
  dialogue: string
  description: string
  firstFramePrompt: string
  camera: string
}

export type VideoTask = {
  id: string
  idempotencyKey: string
  script: string
  title: string
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  stage: 'storyboard' | 'keyframe' | 'assemble' | 'done'
  shots: Shot[]
  provider: 'local-ffmpeg'
  live: boolean
  error?: string
  errorClass?: 'retryable' | 'terminal'
  attempts: number
  createdAt: number
  updatedAt: number
  finishedAt?: number
  costCents: number
  outputUrl?: string
}

export type VideoGuard = {
  maxConcurrent: number
  running: number
  dailyCapCents: number
  spentCents: number
  date: string
}

export async function fetchVideo(): Promise<{ tasks: VideoTask[]; guard: VideoGuard }> {
  const { data } = await axios.get(`${API_BASE}/api/video`)
  return data
}

export async function previewStoryboard(script: string): Promise<{ shots: Shot[]; live: boolean }> {
  const { data } = await axios.post(`${API_BASE}/api/video/storyboard`, { script })
  return data
}

export async function openVideoTask(script: string): Promise<{ task: VideoTask; reused: boolean }> {
  const { data } = await axios.post(`${API_BASE}/api/video/tasks`, { script })
  return data
}

export async function retryVideoTask(id: string): Promise<VideoTask> {
  const { data } = await axios.post(`${API_BASE}/api/video/tasks/${id}/retry`)
  return data.task
}

export function filmUrl(task: VideoTask): string {
  if (!task.outputUrl) return ''
  return `${API_BASE}${task.outputUrl}`
}
