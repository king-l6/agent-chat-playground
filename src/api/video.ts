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
  placeId?: string
  outfitIds?: string[]
  propChanges?: Array<{ name: string; where: string }>
  stillUrl?: string
  refCount?: number
}

export type VideoTask = {
  id: string
  idempotencyKey: string
  script: string
  title: string
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  stage: 'storyboard' | 'keyframe' | 'assemble' | 'done'
  shots: Shot[]
  provider: 'gpt-image-2' | 'local-ffmpeg'
  imageCount?: number
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

export async function draftVideoScript(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  script: string,
): Promise<{ reply: string; script: string; live: boolean }> {
  const { data } = await axios.post(`${API_BASE}/api/video/draft`, { messages, script })
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

export async function deleteVideoTask(id: string): Promise<void> {
  await axios.delete(`${API_BASE}/api/video/tasks/${id}`)
}

export async function retryVideoTask(id: string): Promise<VideoTask> {
  const { data } = await axios.post(`${API_BASE}/api/video/tasks/${id}/retry`)
  return data.task
}

export function filmUrl(task: VideoTask): string {
  if (!task.outputUrl) return ''
  return `${API_BASE}${task.outputUrl}`
}

export function stillSrc(url: string): string {
  return url.startsWith('/api/') ? `${API_BASE}${url}` : url
}

export type PropSpot = { name: string; where: string }
export type BibleCharacter = { id: string; name: string; look: string; images?: string[]; voiceId?: string }
export type BibleOutfit = { id: string; characterId: string; name: string; look: string; images?: string[] }
export type BiblePlace = { id: string; name: string; look: string; props: PropSpot[]; images?: string[] }
export type BibleDay = { id: string; title: string; places: Record<string, PropSpot[]> }
export type SeriesBible = {
  characters: BibleCharacter[]
  outfits: BibleOutfit[]
  places: BiblePlace[]
  days: BibleDay[]
  activeDayId: string
}

export async function fetchBible(): Promise<SeriesBible> {
  const { data } = await axios.get(`${API_BASE}/api/video/bible`)
  return data
}

export async function saveBible(bible: SeriesBible): Promise<SeriesBible> {
  const { data } = await axios.put(`${API_BASE}/api/video/bible`, bible)
  return data
}

export function bibleImageSrc(name: string): string {
  return `${API_BASE}/api/video/bible/images/${name}`
}

export async function uploadBibleImage(file: File): Promise<string> {
  const body = new FormData()
  body.append('file', file)
  const { data } = await axios.post(`${API_BASE}/api/video/bible/images`, body)
  return data.image as string
}

export async function generateBibleImage(prompt: string, wide = false): Promise<string> {
  try {
    const { data } = await axios.post(`${API_BASE}/api/video/bible/images/generate`, {
      prompt,
      size: wide ? '1536x1024' : '1024x1024',
    })
    return data.image as string
  } catch (err) {
    if (axios.isAxiosError(err) && typeof err.response?.data?.error === 'string') throw new Error(err.response.data.error)
    throw err
  }
}

export async function usedShotKeys(
  images: string[],
  shots: Array<{ taskId: string; index: number }>,
): Promise<Array<{ key: string; image: string }>> {
  const { data } = await axios.post(`${API_BASE}/api/video/bible/images/used`, { images, shots })
  return Array.isArray(data.used) ? data.used : []
}

export async function adoptShotImage(taskId: string, index: number): Promise<string> {
  const { data } = await axios.post(`${API_BASE}/api/video/bible/images/from-shot`, { taskId, index })
  return data.image as string
}

export async function drawBibleImage(input: {
  kind: 'character' | 'outfit' | 'place'
  name: string
  look: string
  message?: string
  base?: string
  images: string[]
}): Promise<string> {
  try {
    const { data } = await axios.post(`${API_BASE}/api/video/bible/images/draw`, input, { timeout: 180_000 })
    return data.image as string
  } catch (err) {
    if (axios.isAxiosError(err) && typeof err.response?.data?.error === 'string') throw new Error(err.response.data.error)
    throw err
  }
}

export async function fetchBibleLibrary(): Promise<string[]> {
  const { data } = await axios.get(`${API_BASE}/api/video/bible/library`)
  return Array.isArray(data.images) ? data.images : []
}

export async function addBibleLibrary(image: string): Promise<string[]> {
  const { data } = await axios.post(`${API_BASE}/api/video/bible/library`, { image })
  return Array.isArray(data.images) ? data.images : []
}

export async function reviseBibleLook(input: {
  kind: 'character' | 'outfit' | 'place'
  name: string
  look: string
  images: string[]
  message?: string
}): Promise<string> {
  try {
    const { data } = await axios.post(`${API_BASE}/api/video/bible/look`, input)
    return data.look as string
  } catch (err) {
    if (axios.isAxiosError(err) && typeof err.response?.data?.error === 'string') throw new Error(err.response.data.error)
    throw err
  }
}

export type VoiceClip = { id: string; name: string }

export function voiceAudioUrl(id: string): string {
  return `${API_BASE}/api/video/voices/${id}/audio`
}

export async function fetchVoices(): Promise<VoiceClip[]> {
  const { data } = await axios.get(`${API_BASE}/api/video/voices`)
  return Array.isArray(data.voices) ? data.voices : []
}

export async function addVoiceClip(name: string, url: string): Promise<VoiceClip> {
  try {
    const { data } = await axios.post(`${API_BASE}/api/video/voices`, { name, url }, { timeout: 180_000 })
    return data
  } catch (err) {
    if (axios.isAxiosError(err) && typeof err.response?.data?.error === 'string') throw new Error(err.response.data.error)
    throw err
  }
}

export async function renameVoiceClip(id: string, name: string): Promise<VoiceClip[]> {
  try {
    const { data } = await axios.patch(`${API_BASE}/api/video/voices/${id}`, { name })
    return Array.isArray(data.voices) ? data.voices : []
  } catch (err) {
    if (axios.isAxiosError(err) && typeof err.response?.data?.error === 'string') throw new Error(err.response.data.error)
    throw err
  }
}

export async function deleteVoiceClip(id: string): Promise<VoiceClip[]> {
  const { data } = await axios.delete(`${API_BASE}/api/video/voices/${id}`)
  return Array.isArray(data.voices) ? data.voices : []
}
