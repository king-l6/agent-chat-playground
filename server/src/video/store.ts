/**
 * 视频任务表。落在 server/data/video/tasks.json。
 * 幂等键是剧本哈希；并发和每日花费是护栏，超了直接拒绝，不排队硬跑。
 */
import crypto from 'node:crypto'
import path from 'node:path'
import { readJsonFile, writeJsonAtomic } from '../jsonStore.js'
import { DATA_DIR } from '../paths.js'
import type { Shot, VideoGuard, VideoTask } from './types.js'

export const VIDEO_DIR = path.join(DATA_DIR, 'video')
const TASKS_FILE = path.join(VIDEO_DIR, 'tasks.json')

/** 本地 ffmpeg 不花钱，护栏先按 0 记。接上按秒计费的供应商后，这里才会计入。 */
export const DAILY_CAP_CENTS = 2_000
export const MAX_CONCURRENT = 1

type Disk = {
  tasks: VideoTask[]
  spent: { date: string; cents: number }
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function blank(): Disk {
  return { tasks: [], spent: { date: today(), cents: 0 } }
}

function load(): Disk {
  const disk = readJsonFile<Disk>(TASKS_FILE) ?? blank()
  if (!Array.isArray(disk.tasks)) return blank()
  if (disk.spent?.date !== today()) disk.spent = { date: today(), cents: 0 }
  return disk
}

function save(disk: Disk): void {
  writeJsonAtomic(TASKS_FILE, disk)
}

export function scriptKey(script: string): string {
  return crypto.createHash('sha256').update(script.trim()).digest('hex').slice(0, 16)
}

export function taskDir(id: string): string {
  return path.join(VIDEO_DIR, id)
}

export function listTasks(): VideoTask[] {
  return load().tasks.slice().sort((a, b) => b.createdAt - a.createdAt)
}

export function getTask(id: string): VideoTask | null {
  return load().tasks.find((t) => t.id === id) ?? null
}

export function findByKey(key: string): VideoTask | null {
  return (
    load().tasks.find((t) => t.idempotencyKey === key && t.status !== 'failed') ?? null
  )
}

export function videoGuard(): VideoGuard {
  const disk = load()
  return {
    maxConcurrent: MAX_CONCURRENT,
    running: disk.tasks.filter((t) => t.status === 'running' || t.status === 'queued').length,
    dailyCapCents: DAILY_CAP_CENTS,
    spentCents: disk.spent.cents,
    date: disk.spent.date,
  }
}

export class GuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GuardError'
  }
}

export function assertGuard(): void {
  const guard = videoGuard()
  if (guard.running >= guard.maxConcurrent) {
    throw new GuardError(`同时只能跑 ${guard.maxConcurrent} 条，等这条结束再开`)
  }
  if (guard.spentCents >= guard.dailyCapCents) {
    throw new GuardError(`今日花费已到上限 ${guard.dailyCapCents / 100} 元`)
  }
}

export function createTask(input: {
  script: string
  shots: Shot[]
  live: boolean
  reusedKey: string
}): VideoTask {
  const disk = load()
  const now = Date.now()
  const task: VideoTask = {
    id: `vid_${crypto.randomBytes(4).toString('hex')}`,
    idempotencyKey: input.reusedKey,
    script: input.script.trim(),
    title: input.script.trim().replace(/\s+/g, ' ').slice(0, 18) || '未命名',
    status: 'queued',
    stage: 'storyboard',
    shots: input.shots,
    provider: 'local-ffmpeg',
    live: input.live,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    costCents: 0,
  }
  disk.tasks.unshift(task)
  save(disk)
  return task
}

export function patchTask(id: string, patch: Partial<VideoTask>): VideoTask | null {
  const disk = load()
  const idx = disk.tasks.findIndex((t) => t.id === id)
  if (idx < 0) return null
  const next = { ...disk.tasks[idx], ...patch, updatedAt: Date.now() }
  disk.tasks[idx] = next
  if (typeof patch.costCents === 'number' && patch.costCents > 0) {
    disk.spent.cents += patch.costCents
  }
  save(disk)
  return next
}

/** 进程重启时，卡在 running 的任务改回 queued，交给调度再跑。 */
export function reclaimRunning(): VideoTask[] {
  const disk = load()
  const stuck = disk.tasks.filter((t) => t.status === 'running')
  if (!stuck.length) return []
  const now = Date.now()
  for (const task of stuck) {
    task.status = 'queued'
    task.updatedAt = now
    task.error = undefined
    task.errorClass = undefined
  }
  save(disk)
  return stuck
}
