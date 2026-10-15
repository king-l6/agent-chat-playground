/**
 * 交付状态：一组需求（多条并行）+ 当前激活哪条，落一个 delivery.json。
 * 老的单条文件（顶层直接是 DeliveryRun）读进来自动包成一条，不迁移也不会丢。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../paths.js'
import type { DeliveryRun, DeliveryStore, RunSummary, Seat } from './types.js'

const FILE = path.join(DATA_DIR, 'delivery.json')

/** 同毫秒新建两条会撞号，加一段随机后缀错开 */
function newId() {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

export function emptyRun(input?: { workspaceRoot?: string }): DeliveryRun {
  const at = new Date().toISOString()
  return {
    id: newId(),
    workspaceRoot: input?.workspaceRoot,
    createdAt: at,
    updatedAt: at,
    seat: 'pm',
    phase: 'drafting',
    stale: false,
    dirtyWarning: false,
    prd: {
      title: '',
      oneLiner: '',
      body: '',
      acceptance: [],
      confirmed: false,
      version: 1,
    },
    questions: [],
    talk: [],
    lastErrors: [],
    gates: [],
  }
}

function isRun(value: unknown): value is DeliveryRun {
  const run = value as DeliveryRun | null
  return !!run && typeof run.id === 'string' && !!run.prd && Array.isArray(run.gates)
}

/** 把 JSON 里读出来的东西补齐可选字段，顺带兼容老的单条格式 */
function adopt(raw: unknown): DeliveryStore {
  if (raw && Array.isArray((raw as DeliveryStore).runs)) {
    const store = raw as DeliveryStore
    store.runs.forEach((run) => {
      if (!Array.isArray(run.talk)) run.talk = []
      if (!Array.isArray(run.lastErrors)) run.lastErrors = []
      if (!Array.isArray(run.gates)) run.gates = []
    })
    if (!store.runs.length) store.runs = [emptyRun()]
    if (!store.runs.some((run) => run.id === store.activeId)) {
      store.activeId = store.runs[0].id
    }
    return { version: 2, activeId: store.activeId, runs: store.runs }
  }
  // 旧文件：顶层就是一条 run
  if (isRun(raw)) {
    const run = raw
    if (!Array.isArray(run.talk)) run.talk = []
    if (!Array.isArray(run.lastErrors)) run.lastErrors = []
    return { version: 2, activeId: run.id, runs: [run] }
  }
  const seed = emptyRun()
  return { version: 2, activeId: seed.id, runs: [seed] }
}

let cached: DeliveryStore | null = null

function load(): DeliveryStore {
  if (cached) return cached
  try {
    cached = adopt(JSON.parse(fs.readFileSync(FILE, 'utf8')))
  } catch {
    const seed = emptyRun()
    cached = { version: 2, activeId: seed.id, runs: [seed] }
  }
  return cached
}

function persist() {
  const store = load()
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify(store, null, 2), 'utf8')
}

export function getActiveId(): string {
  return load().activeId
}

/** 取某条需求；不传 id 用当前激活的那条 */
export function requireRun(id?: string): DeliveryRun {
  const store = load()
  const want = id || store.activeId
  const run = store.runs.find((r) => r.id === want)
  if (run) return run
  // id 不存在（删掉了 / 前端拿着旧 id）→ 回落激活条，别抛异常把整页打挂
  const fallback = store.runs.find((r) => r.id === store.activeId) ?? store.runs[0]
  if (!fallback) {
    const seed = emptyRun()
    store.runs = [seed]
    store.activeId = seed.id
    persist()
    return seed
  }
  return fallback
}

export const getRun = requireRun

export function listRuns(): RunSummary[] {
  const store = load()
  return [...store.runs]
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
    .map((run) => ({
      id: run.id,
      title: run.prd.title,
      phase: run.phase,
      seat: run.seat,
      workspaceRoot: run.workspaceRoot,
      signed: run.phase === 'signed',
      updatedAt: run.updatedAt,
    }))
}

export function saveRun(run: DeliveryRun): DeliveryRun {
  const store = load()
  run.updatedAt = new Date().toISOString()
  const idx = store.runs.findIndex((r) => r.id === run.id)
  if (idx >= 0) store.runs[idx] = run
  else store.runs.push(run)
  persist()
  return run
}

/** 新开一条需求，并把它设为当前。未传则不带仓库，回落全局默认。 */
export function createRun(input?: { workspaceRoot?: string }): DeliveryRun {
  const store = load()
  const run = emptyRun(input)
  store.runs.push(run)
  store.activeId = run.id
  persist()
  return run
}

export function setActiveRun(id: string): DeliveryRun {
  const store = load()
  if (store.runs.some((r) => r.id === id)) {
    store.activeId = id
    persist()
  }
  return requireRun(id)
}

export function deleteRun(id: string): DeliveryRun {
  const store = load()
  store.runs = store.runs.filter((r) => r.id !== id)
  if (!store.runs.length) {
    const seed = emptyRun()
    store.runs = [seed]
    store.activeId = seed.id
  } else if (store.activeId === id) {
    store.activeId = store.runs[0].id
  }
  persist()
  return requireRun()
}

/** 绑仓库：这条需求以后对着哪个本地目录干活 */
export function bindRunWorkspace(id: string, absRoot: string | undefined): DeliveryRun {
  const run = requireRun(id)
  if (absRoot) run.workspaceRoot = absRoot
  else delete run.workspaceRoot
  return saveRun(run)
}

export function setSeat(seat: Seat, id?: string): DeliveryRun {
  const run = requireRun(id)
  run.seat = seat
  return saveRun(run)
}
