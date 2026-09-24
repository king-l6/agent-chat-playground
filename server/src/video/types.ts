/** 视频产线的分镜和任务。chat 是秒级同步，这里是分钟级异步。 */

export const SHOT_SIZES = ['远景', '全景', '中景', '近景', '特写'] as const
export type ShotSize = (typeof SHOT_SIZES)[number]

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

export type VideoStage = 'storyboard' | 'keyframe' | 'assemble' | 'done'
export type VideoStatus = 'queued' | 'running' | 'succeeded' | 'failed'

export type VideoTask = {
  id: string
  /** 剧本正文的哈希。相同正文再次提交返回同一条，避免重复跑 ffmpeg。 */
  idempotencyKey: string
  script: string
  title: string
  status: VideoStatus
  stage: VideoStage
  shots: Shot[]
  provider: 'local-ffmpeg'
  /** 分镜是否走了模型。没 Key 时是按句切开的本地版。 */
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
