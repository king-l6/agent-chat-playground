/**
 * 给 Python 检索脚本批量编码 query。
 * stdin: JSON 字符串数组 → stdout: 向量数组
 * 走和线上同一套本地 BGE，保证向量空间一致。
 */
import { embedQuery } from '../server/src/embed.js'

const raw = await new Promise<string>((resolve, reject) => {
  const chunks: Buffer[] = []
  process.stdin.on('data', (c) => chunks.push(c as Buffer))
  process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  process.stdin.on('error', reject)
})

const queries = JSON.parse(raw) as unknown
if (!Array.isArray(queries) || queries.some((q) => typeof q !== 'string')) {
  throw new Error('stdin 必须是 JSON 字符串数组')
}

const vectors: number[][] = []
for (const q of queries) {
  vectors.push(await embedQuery(q))
}
process.stdout.write(JSON.stringify(vectors))
