/**
 * 长期记忆的存储内核：一条记忆 = server/data/memory/<id>.md。
 *
 * 为什么是 markdown 文件而不是向量库/DB：
 *   1. 人可读可编辑 —— 记忆是要被人审的，出了问题改一个字符串就行（这是「可审计」的前提）
 *   2. 量级只有几十~几百条，文件足够，不值得引一个库
 *   3. 召回直接复用已经热着的 BGE 单例（embed.ts），零额外加载成本
 *
 * 正文和向量分开存：正文给人看（.md），向量给检索用（memory-index.json）。
 * 向量只按内容哈希增量更新——改一条记忆不会重算别的条目的向量。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { MEMORY_DIR, MEMORY_INDEX_PATH, MEMORY_LOG_PATH } from '../paths.js'
import { appendJsonl, readJsonFile, readJsonl, writeJsonAtomic } from '../jsonStore.js'
import { EMBEDDING_MODEL, embedDocuments } from '../embed.js'
import { VECTOR_ENCODING, decodeVector, encodeVector } from '../vectorCodec.js'

export type MemoryType = 'user' | 'preference' | 'project' | 'reference'
export type MemoryStatus = 'active' | 'archived' | 'superseded'

/** 页面上按这几个类型分组展示；顺序也是展示顺序 */
export const MEMORY_TYPES: MemoryType[] = ['user', 'preference', 'project', 'reference']

export const MEMORY_TYPE_LABEL: Record<MemoryType, string> = {
  user: '关于用户',
  preference: '偏好',
  project: '项目事实',
  reference: '参考资料',
}

export type MemoryEntry = {
  /** 文件名（不含 .md），也是唯一键 */
  id: string
  /** 一行摘要，召回时模型先看这个判断要不要用 */
  description: string
  type: MemoryType
  /** 0~1，影响召回排序，也是「值不值得进长期」的闸门 */
  salience: number
  createdAt: number
  updatedAt: number
  sourceSession: string | null
  /** 原话引用，页面上显示「这条是从哪句话来的」 */
  sourceQuote: string | null
  /** 被这条取代的旧 id */
  supersedes: string | null
  /** 到期时间戳，过了就归档（可为空 = 永不过期） */
  expires: number | null
  accessCount: number
  lastAccess: number | null
  status: MemoryStatus
  /** 正文：那条事实本身 */
  text: string
}

/** 落盘形态的向量表：按内容哈希判断要不要重算 */
type MemoryVectorRow = { id: string; hash: string; dim: number; v: string }
type MemoryIndexFile = {
  model: string
  vectorEncoding?: string
  items: MemoryVectorRow[]
}

export type MemoryAction = 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP' | 'ARCHIVE' | 'RESTORE' | 'MANUAL'

export type MemoryLogRow = {
  ts: number
  action: MemoryAction
  id: string
  reason: string
  session?: string | null
  candidate?: string
}

/* ===================== frontmatter ===================== */

/**
 * 宽松的 frontmatter 解析：只认顶层 `key: value` 单行标量。
 *
 * 不复用 skills.ts 的 parseFrontmatter —— 那个把字段名硬编码成 name/description 两个，
 * 而且对 name 加了 slug 校验，记忆条目的 created/salience 这类字段它撑不住。
 * 也不引 YAML 库：这个项目的风格是手写可读，而且我们只需要单行标量这一种形态。
 */
export function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
  const text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  if (!text.startsWith('---\n')) return { fields: {}, body: text.trim() }
  const end = text.indexOf('\n---', 3)
  if (end < 0) return { fields: {}, body: text.trim() }

  const fields: Record<string, string> = {}
  for (const line of text.slice(4, end).split('\n')) {
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/)
    if (!m) continue
    let value = m[2].trim()
    // 去一层引号（写的时候对含冒号的值会加引号）
    const quoted = value.match(/^"(.*)"$/) ?? value.match(/^'(.*)'$/)
    if (quoted) value = quoted[1]
    fields[m[1]] = value
  }
  // 跳过结束那行的换行
  const bodyStart = text.indexOf('\n', end + 1)
  return { fields, body: bodyStart < 0 ? '' : text.slice(bodyStart + 1).trim() }
}

/** 值里带冒号/井号/首尾空格就加引号，否则原样写，保持文件好读 */
function quoteIfNeeded(value: string): string {
  if (value === '') return ''
  if (/^[\s]|[\s]$|:\s|#|^["']/.test(value)) return JSON.stringify(value)
  return value
}

export function serializeEntry(entry: MemoryEntry): string {
  const iso = (ms: number | null) => (ms === null ? '' : new Date(ms).toISOString())
  const lines = [
    '---',
    `name: ${entry.id}`,
    `description: ${quoteIfNeeded(entry.description)}`,
    `type: ${entry.type}`,
    `salience: ${entry.salience}`,
    `created: ${iso(entry.createdAt)}`,
    `updated: ${iso(entry.updatedAt)}`,
    `source_session: ${entry.sourceSession ?? ''}`,
    `source_quote: ${quoteIfNeeded(entry.sourceQuote ?? '')}`,
    `supersedes: ${entry.supersedes ?? ''}`,
    `expires: ${iso(entry.expires)}`,
    `access_count: ${entry.accessCount}`,
    `last_access: ${iso(entry.lastAccess)}`,
    `status: ${entry.status}`,
    '---',
    '',
    entry.text,
    '',
  ]
  return lines.join('\n')
}

/* ===================== 内存单例 ===================== */

let entries: MemoryEntry[] | null = null
let vectors: Map<string, { hash: string; embedding: number[] }> | null = null

/**
 * 文件名 slug。**保留中文**——只留 ASCII 的话「用户 11 月要面 Go 后端岗」会变成
 * `11-go`，既看不出是什么也容易互撞，而「人可读可编辑」正是记忆落成 markdown 的理由
 * （项目里本来就有「求职补充手册.md」这种中文文件名）。
 * 顺带把 `/` `.` 这些路径字符都并成 `-`，保证 id 不可能跳出 MEMORY_DIR。
 */
function slugify(input: string): string {
  const kept = input
    .toLowerCase()
    .replace(/[^\u4e00-\u9fff\u3040-\u30ffa-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (kept.length >= 2) return kept.slice(0, 40).replace(/-+$/, '')
  // 全是标点/emoji：退化成语义哈希，稳定且不会互相撞
  return `m-${createHash('sha1').update(input).digest('hex').slice(0, 10)}`
}

function parseDate(value: string | undefined): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function toEntry(id: string, raw: string): MemoryEntry {
  const { fields, body } = parseFrontmatter(raw)
  const type = (fields.type ?? 'reference') as MemoryType
  const status = (fields.status ?? 'active') as MemoryStatus
  const created = parseDate(fields.created) ?? Date.now()
  return {
    id,
    description: fields.description ?? '',
    type: MEMORY_TYPES.includes(type) ? type : 'reference',
    // salience 夹到 0~1，手写文件里写错也不至于把排序搞坏
    salience: Math.min(1, Math.max(0, parseNumber(fields.salience, 0.5))),
    createdAt: created,
    updatedAt: parseDate(fields.updated) ?? created,
    sourceSession: fields.source_session || null,
    sourceQuote: fields.source_quote || null,
    supersedes: fields.supersedes || null,
    expires: parseDate(fields.expires),
    accessCount: parseNumber(fields.access_count, 0),
    lastAccess: parseDate(fields.last_access),
    status: ['active', 'archived', 'superseded'].includes(status) ? status : 'active',
    text: body,
  }
}

function readEntriesFromDisk(): MemoryEntry[] {
  try {
    if (!fs.existsSync(MEMORY_DIR)) return []
    const out: MemoryEntry[] = []
    for (const name of fs.readdirSync(MEMORY_DIR)) {
      if (!name.endsWith('.md')) continue
      const id = name.slice(0, -3)
      try {
        out.push(toEntry(id, fs.readFileSync(path.join(MEMORY_DIR, name), 'utf8')))
      } catch (err) {
        // 单条坏了不该让整库读不出来（和「坏会话返 404 不静默重置」一个道理）
        console.warn(`[memory] 跳过读不出来的条目 ${name}:`, err instanceof Error ? err.message : err)
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}

function readVectorsFromDisk(): Map<string, { hash: string; embedding: number[] }> {
  const map = new Map<string, { hash: string; embedding: number[] }>()
  const file = readJsonFile<MemoryIndexFile>(MEMORY_INDEX_PATH)
  if (!file || file.model !== EMBEDDING_MODEL || !Array.isArray(file.items)) return map
  for (const row of file.items) {
    map.set(row.id, { hash: row.hash, embedding: decodeVector(row.v) })
  }
  return map
}

export function ensureMemoriesLoaded(): MemoryEntry[] {
  if (entries === null) entries = readEntriesFromDisk()
  return entries
}

function ensureVectorsLoaded(): Map<string, { hash: string; embedding: number[] }> {
  if (vectors === null) vectors = readVectorsFromDisk()
  return vectors
}

function persistVectors(): void {
  const map = ensureVectorsLoaded()
  const body: MemoryIndexFile = {
    model: EMBEDDING_MODEL,
    vectorEncoding: VECTOR_ENCODING,
    items: Array.from(map.entries()).map(([id, row]) => ({
      id,
      hash: row.hash,
      dim: row.embedding.length,
      v: encodeVector(row.embedding),
    })),
  }
  writeJsonAtomic(MEMORY_INDEX_PATH, body)
}

function persistEntry(entry: MemoryEntry): void {
  fs.mkdirSync(MEMORY_DIR, { recursive: true })
  const file = path.join(MEMORY_DIR, `${entry.id}.md`)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, serializeEntry(entry))
  fs.renameSync(tmp, file)
}

/** 向量的内容指纹：description + 正文一起变才算变，避免改个 salience 就重算 */
function contentHash(entry: MemoryEntry): string {
  return createHash('sha1').update(`${entry.description}\n${entry.text}`).digest('hex')
}

/* ===================== 日志 ===================== */

export function logMemoryAction(row: Omit<MemoryLogRow, 'ts'>): MemoryLogRow {
  const full: MemoryLogRow = { ts: Date.now(), ...row }
  try {
    appendJsonl(MEMORY_LOG_PATH, full)
  } catch (err) {
    // 日志写不进去不该影响记忆本身
    console.warn('[memory] 日志写入失败:', err instanceof Error ? err.message : err)
  }
  return full
}

export function readMemoryLog(limit = 200): MemoryLogRow[] {
  return readJsonl<MemoryLogRow>(MEMORY_LOG_PATH, limit).reverse()
}

/* ===================== CRUD ===================== */

export function listMemories(opts: {
  q?: string
  type?: MemoryType | 'all'
  status?: MemoryStatus | 'all'
  offset?: number
  limit?: number
} = {}): { total: number; offset: number; limit: number; items: MemoryEntry[] } {
  const offset = Math.max(0, opts.offset ?? 0)
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50))
  const q = (opts.q ?? '').trim().toLowerCase()
  const type = opts.type && opts.type !== 'all' ? opts.type : null
  const status = opts.status && opts.status !== 'all' ? opts.status : null

  const filtered = ensureMemoriesLoaded().filter((e) => {
    if (type && e.type !== type) return false
    if (status && e.status !== status) return false
    if (q && !`${e.id} ${e.description} ${e.text}`.toLowerCase().includes(q)) return false
    return true
  })
  return { total: filtered.length, offset, limit, items: filtered.slice(offset, offset + limit) }
}

export function getMemory(id: string): MemoryEntry | null {
  return ensureMemoriesLoaded().find((e) => e.id === id) ?? null
}

/** 召回用：只取 active 且没过期的 */
export function activeMemories(): MemoryEntry[] {
  const now = Date.now()
  return ensureMemoriesLoaded().filter(
    (e) => e.status === 'active' && (e.expires === null || e.expires > now),
  )
}

export type MemoryInput = {
  /** 不传则从 description 生成 */
  id?: string
  description: string
  text: string
  type?: MemoryType
  salience?: number
  sourceSession?: string | null
  sourceQuote?: string | null
  supersedes?: string | null
  expires?: number | null
  status?: MemoryStatus
}

/**
 * 新建或覆盖一条记忆。
 * @param existingId 传了就是更新这一条（id 不变，created 保留）；不传则按 description 生成 id
 */
export async function saveMemory(input: MemoryInput): Promise<MemoryEntry> {
  const list = ensureMemoriesLoaded()
  const now = Date.now()
  let id = input.id ?? slugify(input.description)
  // 生成出来的 id 撞了（两条记忆描述很像）就加短哈希后缀，别互相覆盖
  if (!input.id && list.some((e) => e.id === id)) {
    id = `${id}-${createHash('sha1').update(`${input.description}${now}`).digest('hex').slice(0, 4)}`
  }

  const prev = list.find((e) => e.id === id) ?? null
  const entry: MemoryEntry = {
    id,
    description: input.description.trim(),
    type: input.type ?? prev?.type ?? 'reference',
    salience: Math.min(1, Math.max(0, input.salience ?? prev?.salience ?? 0.6)),
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
    sourceSession: input.sourceSession ?? prev?.sourceSession ?? null,
    sourceQuote: input.sourceQuote ?? prev?.sourceQuote ?? null,
    supersedes: input.supersedes ?? prev?.supersedes ?? null,
    expires: input.expires !== undefined ? input.expires : prev?.expires ?? null,
    accessCount: prev?.accessCount ?? 0,
    lastAccess: prev?.lastAccess ?? null,
    status: input.status ?? prev?.status ?? 'active',
    text: input.text.trim(),
  }

  persistEntry(entry)
  if (entries) {
    const i = entries.findIndex((e) => e.id === id)
    if (i >= 0) entries[i] = entry
    else entries.unshift(entry)
    entries.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  await syncVector(entry)
  return entry
}

/** 内容变了才重算向量；embedder 不可用就跳过（正文照常落盘，召回退化为关键词） */
async function syncVector(entry: MemoryEntry): Promise<void> {
  const map = ensureVectorsLoaded()
  const hash = contentHash(entry)
  if (map.get(entry.id)?.hash === hash) return
  try {
    const [embedding] = await embedDocuments([`${entry.description}\n${entry.text}`])
    if (!embedding?.length) return
    map.set(entry.id, { hash, embedding })
    persistVectors()
  } catch (err) {
    console.warn('[memory] 向量化失败，这条走关键词召回:', err instanceof Error ? err.message : err)
  }
}

export function deleteMemory(id: string): boolean {
  const list = ensureMemoriesLoaded()
  const i = list.findIndex((e) => e.id === id)
  if (i < 0) return false
  list.splice(i, 1)
  try {
    fs.unlinkSync(path.join(MEMORY_DIR, `${id}.md`))
  } catch {
    // 文件已经不在就当删掉了
  }
  const map = ensureVectorsLoaded()
  if (map.delete(id)) persistVectors()
  return true
}

export function setMemoryStatus(id: string, status: MemoryStatus): MemoryEntry | null {
  const entry = ensureMemoriesLoaded().find((e) => e.id === id)
  if (!entry) return null
  entry.status = status
  entry.updatedAt = Date.now()
  persistEntry(entry)
  return entry
}

/** 召回命中时记一笔：access_count / last_access 是衰减归档的依据 */
export function touchMemories(ids: string[]): void {
  if (ids.length === 0) return
  const now = Date.now()
  for (const id of ids) {
    const entry = ensureMemoriesLoaded().find((e) => e.id === id)
    if (!entry) continue
    entry.accessCount += 1
    entry.lastAccess = now
    persistEntry(entry)
  }
}

export function getMemoryVectors(): Map<string, { hash: string; embedding: number[] }> {
  return ensureVectorsLoaded()
}

/* ===================== 归档（遗忘） ===================== */

/** 多久没被召回就归档 */
export const MEMORY_ARCHIVE_DAYS = 60

/**
 * 扫一遍：过期的、或者从没被召回且很久没更新的，归档。
 * 归档不是删除——页面上还能看到、能恢复，只是不再参与召回。
 */
export function sweepMemories(now = Date.now()): { expired: string[]; stale: string[] } {
  const expired: string[] = []
  const stale: string[] = []
  const cutoff = now - MEMORY_ARCHIVE_DAYS * 24 * 3600 * 1000
  for (const entry of ensureMemoriesLoaded()) {
    if (entry.status !== 'active') continue
    if (entry.expires !== null && entry.expires <= now) {
      expired.push(entry.id)
      continue
    }
    const lastTouched = entry.lastAccess ?? entry.createdAt
    if (entry.accessCount === 0 && lastTouched < cutoff) stale.push(entry.id)
  }
  for (const id of [...expired, ...stale]) setMemoryStatus(id, 'archived')
  return { expired, stale }
}

/* ===================== 统计（页面头部） ===================== */

export function memoryStats() {
  const all = ensureMemoriesLoaded()
  const active = all.filter((e) => e.status === 'active')
  const byType: Record<string, number> = {}
  for (const type of MEMORY_TYPES) byType[type] = 0
  for (const e of active) byType[e.type] += 1
  const top = [...all]
    .filter((e) => e.accessCount > 0)
    .sort((a, b) => b.accessCount - a.accessCount)
    .slice(0, 5)
    .map((e) => ({ id: e.id, description: e.description, accessCount: e.accessCount }))
  return {
    total: all.length,
    active: active.length,
    archived: all.filter((e) => e.status === 'archived').length,
    superseded: all.filter((e) => e.status === 'superseded').length,
    byType,
    topAccessed: top,
    /** 向量可用条数：少于 active 说明有些条目在走关键词兜底 */
    embedded: ensureVectorsLoaded().size,
    model: EMBEDDING_MODEL,
  }
}

/** 只给断言脚本用：把内存单例清掉，强制下次从磁盘重读 */
export function resetMemoryCache(): void {
  entries = null
  vectors = null
}
