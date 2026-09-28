/**
 * 调度：提交后立刻返回任务 id，渲染在进程里接着跑。
 * 相同剧本返回已有任务。失败且可重试的，用 retry 再跑，不新开一条计费。
 */
import fs from 'node:fs'
import { referenceFilesForShot } from './bible.js'
import { assemble, shotPng } from './render.js'
import { buildStoryboard } from './storyboard.js'
import {
  assertGuard,
  createTask,
  findByKey,
  getTask,
  listTasks,
  patchTask,
  reclaimRunning,
  removeTask,
  scriptKey,
  taskDir,
  videoGuard,
} from './store.js'
import type { VideoTask } from './types.js'

const inflight = new Set<string>()

function fail(id: string, err: unknown, terminal: boolean): void {
  const message = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim()
  patchTask(id, {
    status: 'failed',
    error: message.slice(0, 500),
    errorClass: terminal || err instanceof Error && err.name === 'TerminalRenderError' ? 'terminal' : 'retryable',
    finishedAt: Date.now(),
  })
}

const AUTO_RETRY = 2

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function execute(id: string): Promise<void> {
  if (inflight.has(id)) return
  const task = getTask(id)
  if (!task || task.status === 'succeeded' || task.status === 'failed') return
  inflight.add(id)
  patchTask(id, { status: 'running', stage: 'keyframe', attempts: task.attempts + 1, error: undefined })
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await assemble(taskDir(id), task.shots, (done) => {
          patchTask(id, { imageCount: done, stage: done < task.shots.length ? 'keyframe' : 'assemble' })
        }, id)
        patchTask(id, {
          status: 'succeeded',
          stage: 'done',
          outputUrl: `/api/video/tasks/${id}/film`,
          finishedAt: Date.now(),
          error: undefined,
          errorClass: undefined,
        })
        return
      } catch (err) {
        const terminal = err instanceof Error && err.name === 'TerminalRenderError'
        if (terminal || attempt >= AUTO_RETRY) {
          fail(id, err, terminal)
          return
        }
        const message = err instanceof Error ? err.message : String(err)
        patchTask(id, { status: 'running', error: `失败了，正在重试 ${attempt + 1}/${AUTO_RETRY}：${message}`.slice(0, 500) })
        await wait(2000)
      }
    }
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
  const board = await buildStoryboard(text, true)
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

export function dropTask(id: string): void {
  if (!/^vid_[0-9a-f]{8}$/.test(id)) throw new Error('任务不存在')
  removeTask(id)
  fs.rmSync(taskDir(id), { recursive: true, force: true })
}

export function resumeVideoTasks(): void {
  for (const task of reclaimRunning()) kick(task.id)
}

function withStills(task: VideoTask): VideoTask {
  return {
    ...task,
    shots: task.shots.map((shot) =>
      stillPath(task.id, shot.index)
        ? { ...shot, stillUrl: `/api/video/tasks/${task.id}/shots/${shot.index}`, refCount: referenceFilesForShot(shot).length }
        : { ...shot, refCount: referenceFilesForShot(shot).length },
    ),
  }
}

export function publicVideo() {
  return { tasks: listTasks().map(withStills), guard: videoGuard() }
}

export function stillPath(id: string, index: number): string | null {
  if (!getTask(id) || !Number.isInteger(index) || index < 1) return null
  const png = shotPng(taskDir(id), index)
  const jpg = png.replace(/\.png$/, '.jpg')
  if (fs.existsSync(png)) return png
  if (fs.existsSync(jpg)) return jpg
  return null
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
