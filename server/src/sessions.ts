/**
 * 会话存储：一个会话一个 JSON 文件，落在**归属人**自己的目录下。
 *
 *    server/data/users/<ownerId>/sessions/<sessionId>.json
 *
 * 为什么按归属人分目录：项目已是软多用户（前端 X-Playground-User → requestContext.currentUserId()），
 * LLM Key / MCP 早就按用户隔离。会话跟着同一套走，分享链接形如 #/c/<ownerId>/<sessionId>，
 * 别人打开时读的是归属人的文件（且要求 visibility === 'shared'，见 index.ts 的路由）。
 *
 * 落盘走 jsonStore 的 readJsonFile / writeJsonAtomic（tmp+rename 原子写），
 * 不自己裸 writeFileSync——写到一半崩掉会留下半截 JSON，下次整个文件读不出来。
 */
import fs from 'node:fs'
import path from 'node:path'
import { readJsonFile, writeJsonAtomic } from './jsonStore.js'
import { DATA_DIR } from './paths.js'

/**
 * ownerId / sessionId 共用的合法形态。和 requestContext.parseUserId 的口径一致：
 * 只用小写字母、数字、_、-，2～64 位。
 * 这里必须校验：id 会直接拼进文件路径，不校验就是路径穿越（`../../`）。
 */
const ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/

export function isValidId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id)
}

export type SessionVisibility = 'private' | 'shared'

export type StoredSession = {
  id: string
  /** 归属人。目录已经按 ownerId 分了，冗余存一份便于校验和界面展示 */
  ownerId: string
  title: string
  /** 最后一次「用户提问」时间；列表排序 / 分组只看它（口径同前端 sessionStore） */
  lastUserAt: number
  /** 最后一次活动时间（含流式 token），只用于展示 */
  updatedAt: number
  /** private = 只有本人能读；shared = 有链接的人都能只读打开 */
  visibility: SessionVisibility
  /** UiMessage[]，后端不解释结构，原样存取 */
  messages: unknown[]
}

function userSessionsDir(ownerId: string): string {
  const dir = path.join(DATA_DIR, 'users', ownerId, 'sessions')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function sessionFile(ownerId: string, id: string): string {
  return path.join(userSessionsDir(ownerId), `${id}.json`)
}

/** 把磁盘上读出来的东西收成 StoredSession；缺字段 / 类型不对就用兜底值，尽量不丢整条 */
function revive(raw: unknown, ownerId: string, fallbackId: string): StoredSession | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Partial<StoredSession>
  if (!Array.isArray(row.messages)) return null
  const updatedAt = typeof row.updatedAt === 'number' ? row.updatedAt : Date.now()
  return {
    id: isValidId(row.id) ? row.id : fallbackId,
    ownerId,
    title: typeof row.title === 'string' && row.title ? row.title : '新对话',
    lastUserAt: typeof row.lastUserAt === 'number' ? row.lastUserAt : updatedAt,
    updatedAt,
    visibility: row.visibility === 'shared' ? 'shared' : 'private',
    messages: row.messages,
  }
}

/** 某归属人的全部会话。坏文件 / 非 json 后缀直接跳过，不让一条脏数据毁掉整个列表 */
export function listSessions(ownerId: string): StoredSession[] {
  if (!isValidId(ownerId)) return []
  const dir = userSessionsDir(ownerId)
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out: StoredSession[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -'.json'.length)
    if (!isValidId(id)) continue
    const session = revive(readJsonFile<unknown>(path.join(dir, name)), ownerId, id)
    if (session) out.push(session)
  }
  // 按用户提问时间倒序，和前端列表一致；让前端拿到就是排好的
  return out.sort((a, b) => b.lastUserAt - a.lastUserAt)
}

export function getSession(ownerId: string, id: string): StoredSession | null {
  if (!isValidId(ownerId) || !isValidId(id)) return null
  return revive(readJsonFile<unknown>(sessionFile(ownerId, id)), ownerId, id)
}

/** 落盘一条会话。ownerId 由调用方给定（永远是当前用户，不接受代写别人的） */
export function upsertSession(session: StoredSession): StoredSession {
  if (!isValidId(session.ownerId) || !isValidId(session.id)) {
    throw new Error('会话 id 或归属人 id 不合法')
  }
  const clean: StoredSession = {
    id: session.id,
    ownerId: session.ownerId,
    title: session.title || '新对话',
    lastUserAt: Number.isFinite(session.lastUserAt) ? session.lastUserAt : Date.now(),
    updatedAt: Number.isFinite(session.updatedAt) ? session.updatedAt : Date.now(),
    visibility: session.visibility === 'shared' ? 'shared' : 'private',
    messages: Array.isArray(session.messages) ? session.messages : [],
  }
  writeJsonAtomic(sessionFile(clean.ownerId, clean.id), clean)
  return clean
}

/** 删除。返回是否真的删掉了（幂等：不存在也算成功，不抛错） */
export function deleteSession(ownerId: string, id: string): boolean {
  if (!isValidId(ownerId) || !isValidId(id)) return false
  try {
    fs.unlinkSync(sessionFile(ownerId, id))
    return true
  } catch {
    return false
  }
}
