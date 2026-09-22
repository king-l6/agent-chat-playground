/**
 * 脚本只读加载索引：直接读 index.json，不建索引、不编码、不写盘。
 *
 * 为什么不走 retrieve()：那条路在内存为空时会触发 ensureIndex()，
 * 一旦版本对不上就要重编码上千块。脚本只想看「现在索引里能召回什么」，
 * 拿现成的向量就够了。
 */
import fs from 'node:fs'
import { INDEX_PATH, getDocMetaMap, listUploadRecords } from '../../src/knowledge.js'
import { decodeVector } from '../../src/vectorCodec.js'
import type { KnowledgeChunk } from '../../src/knowledge.js'

export type IndexedChunk = KnowledgeChunk & { embedding: number[] }

export function loadIndexItems(): IndexedChunk[] {
  const file = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')) as {
    items: Array<{
      id: string
      docId: string
      title: string
      text: string
      v?: string
      embedding?: number[]
    }>
  }
  return file.items.map((it) => ({
    id: it.id,
    docId: it.docId,
    title: it.title,
    text: it.text,
    embedding: it.v ? decodeVector(it.v) : it.embedding ?? [],
  }))
}

/** docId → 可读文档名，和线上同一张表（内置文档也覆盖） */
export function loadDocNames(): Map<string, string> {
  const meta = getDocMetaMap()
  return new Map(Array.from(meta.entries()).map(([id, m]) => [id, m.name]))
}

export function loadDocCount(): number {
  return listUploadRecords().length
}
