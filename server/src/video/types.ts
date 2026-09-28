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
  /** 这一镜用的场景。空表示没对上设定里的地点。 */
  placeId?: string
  /** 这一镜要穿上的衣橱编号。同一角色的衬衫、袜子、鞋都列在这里。 */
  outfitIds?: string[]
  /** 这一镜改动的物件。where 为空表示拿走。 */
  propChanges?: Array<{ name: string; where: string }>
  /** 首帧已经落盘时，接口补上的地址。不写入任务文件。 */
  stillUrl?: string
  /** 这一镜能用上的参考图张数。没有则出图时脸会按文字重画。 */
  refCount?: number
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
  provider: 'gpt-image-2' | 'local-ffmpeg'
  /** 已经出图的镜数。一张大约要一分钟。 */
  imageCount?: number
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
