/**
 * 调度：提交后立刻返回任务 id，渲染在进程里接着跑。
 * 相同剧本返回已有任务。失败且可重试的，用 retry 再跑，不新开一条计费。
 */
import fs from 'node:fs'
import { assemble } from './render.js'
import { buildStoryboard } from './storyboard.js'
import {
  assertGuard,
  createTask,
  findByKey,
  getTask,
  listTasks,
  patchTask,
  reclaimRunning,
  scriptKey,
  taskDir,
  videoGuard,
} from './store.js'
import type { VideoTask } from './types.js'

const inflight = new Set<string>()

function fail(id: string, err: unknown, terminal: boolean): void {
  const message = err instanceof Error ? err.message : String(err)
  patchTask(id, {
    status: 'failed',
    error: message.slice(0, 500),
    errorClass: terminal || err instanceof Error && err.name === 'TerminalRenderError' ? 'terminal' : 'retryable',
    finishedAt: Date.now(),
  })
}

async function execute(id: string): Promise<void> {
  if (inflight.has(id)) return
  const task = getTask(id)
  if (!task || task.status === 'succeeded' || task.status === 'failed') return
  inflight.add(id)
  patchTask(id, { status: 'running', stage: 'keyframe', attempts: task.attempts + 1, error: undefined })
  try {
    patchTask(id, { stage: 'assemble' })
    await assemble(taskDir(id), task.shots)
    patchTask(id, {
      status: 'succeeded',
      stage: 'done',
      outputUrl: `/api/video/tasks/${id}/film`,
      finishedAt: Date.now(),
      error: undefined,
      errorClass: undefined,
    })
  } catch (err) {
    fail(id, err, false)
  } finally {
    inflight.delete(id)
  }
}

export function kick(id: string): void {
  void execute(id)
}

export async function openTask(script: string): Promise<{ task: VideoTask; reused: boolean }> {
  const text = script.trim()
  if (text.length < 8) throw new Error('剧本至少写一句，8 个字以上')
  const key = scriptKey(text)
  const existing = findByKey(key)
  if (existing) return { task: existing, reused: true }
  assertGuard()
  const board = await buildStoryboard(text)
  const task = createTask({ script: text, shots: board.shots, live: board.live, reusedKey: key })
  kick(task.id)
  return { task, reused: false }
}

export function retryTask(id: string): VideoTask {
  const task = getTask(id)
  if (!task) throw new Error('任务不存在')
  if (task.status !== 'failed') return task
  if (task.errorClass === 'terminal') throw new Error(task.error || '这条不能重试')
  assertGuard()
  const next = patchTask(id, {
    status: 'queued',
    stage: 'keyframe',
    error: undefined,
    errorClass: undefined,
    finishedAt: undefined,
  })
  if (!next) throw new Error('任务不存在')
  kick(next.id)
  return next
}

export function resumeVideoTasks(): void {
  for (const task of reclaimRunning()) kick(task.id)
}

export function publicVideo() {
  return { tasks: listTasks(), guard: videoGuard() }
}

export function filmPath(id: string): string | null {
  const task = getTask(id)
  if (!task || task.status !== 'succeeded') return null
  const file = `${taskDir(id)}/film.mp4`
  return fs.existsSync(file) ? file : null
}

export function isGuardError(err: unknown): boolean {
  return err instanceof Error && err.name === 'GuardError'
}
