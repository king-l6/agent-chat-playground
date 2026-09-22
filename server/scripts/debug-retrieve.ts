/**
 * 只看召回：不建索引、不写盘，直接读 index.json 跑一遍完整组装链路。
 *
 *   npx tsx server/scripts/debug-retrieve.ts "查一下平台工程最近的周报"
 *
 * 第 4 个参数是**用户原话**，用来复现真实链路里那个坑：
 * 送进检索的 query 是模型自己组的，会把「最近」这类词丢掉。
 *
 *   npx tsx server/scripts/debug-retrieve.ts "平台工程周报 讲了什么" 3 "平台工程周报讲了什么"
 *
 * 打印每条命中的「来源文档 / 块标题 / 分数 / 正文开头」，
 * 用来判断答错是召回错，还是召回对了但模型看不出是哪一篇。
 */
import { rewriteQuery, searchChunks } from '../src/knowledge.js'
import { HYBRID_CANDIDATES, assembleHits, recencyIntent, searchRerank } from '../src/retrieve.js'
import { loadIndexItems } from './lib/load-index.js'

async function main() {
  const query = process.argv[2] ?? '查一下平台工程最近的周报'
  const topK = Number(process.argv[3] ?? 3)
  const userQuery = process.argv[4]

  const items = loadIndexItems()
  console.log(`query     = ${query}`)
  if (userQuery) console.log(`用户原话  = ${userQuery}`)
  console.log(`时间意图  = ${recencyIntent(query, userQuery)}`)
  console.log(`索引 ${items.length} 块`)
  console.log(`rewriteQuery →`, JSON.stringify(rewriteQuery(query)))
  const kw = searchChunks(rewriteQuery(query).rewritten, 8, items, 4)
  console.log(`关键词那一路命中 ${kw.length} 条（0 = 这一问只有向量在起作用）`)
  console.log('')

  const fused = await searchRerank(query, items, HYBRID_CANDIDATES(topK))
  const hits = await assembleHits(fused, topK, items, query, userQuery)
  hits.forEach((h) => {
    console.log(
      `[${h.citation}] via=${h.via} score=${h.score}${h.rerank !== undefined ? ` rerank=${h.rerank}` : ''}`,
    )
    console.log(`    来源: ${h.docName ?? '(未知)'}${h.docTime ? `  [${new Date(h.docTime).toISOString().slice(0, 10)}]` : ''}`)
    console.log(`    块标题: ${h.title}`)
    console.log(`    正文: ${h.text.replace(/\n/g, ' ').slice(0, 140)}`)
    console.log('')
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
