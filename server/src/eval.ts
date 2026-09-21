/**
 * RAG 评测：黄金问句 → Recall@K
 *
 *   npm run eval:rag              默认 280，对照 vector / hybrid / rerank
 *   npm run eval:rag -- --sweep   只扫切块（仍走 vector，和上一课同一张表）
 */
import dotenv from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadGoldCases, type GoldCase } from './eval-cases.js'
import { configureChunking, getChunkParams, loadCoreChunks } from './knowledge.js'
import { expandWithNeighbors, indexChunksInMemory, searchHybrid, searchRerank, searchVectors } from './retrieve.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')
dotenv.config({ path: path.join(ROOT, '.env'), override: true })

type GoldFile = {
  topK: number
  cases: GoldCase[]
}

type Hit = { docId: string; title: string; text: string; score: number }

function parseArgs(argv: string[]) {
  const sweep = argv.includes('--sweep')
  let maxChars = 280
  let overlap = 60
  let topK = 0
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--size' && argv[i + 1]) maxChars = Number(argv[++i])
    else if (argv[i] === '--overlap' && argv[i + 1]) overlap = Number(argv[++i])
    else if (argv[i] === '--topK' && argv[i + 1]) topK = Number(argv[++i])
  }
  return { sweep, maxChars, overlap, topK }
}

/**
 * 正确答案在 hits 里的排名(1-based);没命中返回 0。
 * Recall 只看「在不在 TopK」,rank 还能看出「排第几」——rerank 的价值全在这。
 */
function firstHitRank(c: GoldCase, hits: Hit[]): number {
  const needle = c.contains.toLowerCase()
  for (let i = 0; i < hits.length; i += 1) {
    const h = hits[i]
    if (h.docId !== c.docId) continue
    if (`${h.title}\n${h.text}`.toLowerCase().includes(needle)) return i + 1
  }
  return 0
}

async function scoreCases(
  label: string,
  gold: GoldFile,
  topK: number,
  hitsOf: (c: GoldCase) => Promise<Hit[]>,
) {
  let ok = 0
  let rrSum = 0 // reciprocal rank 累加,除以题数就是 MRR
  const misses: string[] = []
  for (const c of gold.cases) {
    const hits = await hitsOf(c)
    const rank = firstHitRank(c, hits)
    if (rank > 0) {
      ok += 1
      rrSum += 1 / rank // 命中第 1 名 → 1.0,第 2 名 → 0.5,第 3 名 → 0.33
      continue
    }
    const top = hits[0]
    misses.push(
      `  ✗ ${c.id} 期望 ${c.docId}∋${c.contains}；top1=${
        top ? `${top.docId}/${top.title} (${top.score})` : '空'
      }`,
    )
  }
  const recall = ok / gold.cases.length
  const mrr = rrSum / gold.cases.length
  console.log(
    `[eval] ${label} Recall@${topK} = ${ok}/${gold.cases.length} = ${(recall * 100).toFixed(0)}%  MRR@${topK} = ${mrr.toFixed(3)}`,
  )
  if (misses.length) console.log(misses.join('\n'))
  return { ok, total: gold.cases.length, recall, mrr }
}

async function embedConfig(maxChars: number, overlap: number) {
  configureChunking(maxChars, overlap)
  const chunks = loadCoreChunks()
  console.log(
    `\n[eval] 切块 size=${maxChars} overlap=${overlap} → ${chunks.length} chunks，开始编码…`,
  )
  return { chunks: chunks.length, items: await indexChunksInMemory(chunks) }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const gold = loadGoldCases() as GoldFile
  const topK = args.topK || gold.topK || 3

  console.log(
    `[eval] ${gold.cases.length} 条黄金问题  topK=${topK}  当前默认切块 ${JSON.stringify(getChunkParams())}`,
  )

  if (args.sweep) {
    console.log('[eval] --sweep 只测 vector（和上一课对照表同一口径）')
    const rows = []
    for (const cfg of [
      { maxChars: 200, overlap: 60 },
      { maxChars: 280, overlap: 60 },
      { maxChars: 300, overlap: 60 },
    ]) {
      const { chunks, items } = await embedConfig(cfg.maxChars, cfg.overlap)
      const scored = await scoreCases('vector', gold, topK, (c) =>
        searchVectors(c.query, items, topK),
      )
      rows.push({ ...cfg, chunks, ...scored })
    }
    console.log('\n[eval] 对照')
    const best = [...rows].sort((a, b) => b.recall - a.recall || a.chunks - b.chunks)[0]
    for (const r of rows) {
      const mark = r === best ? ' ← 命中率最高' : ''
      console.log(
        `  size=${r.maxChars} overlap=${r.overlap} chunks=${r.chunks}  Recall@${topK}=${(r.recall * 100).toFixed(0)}%${mark}`,
      )
    }
    return
  }

  console.log('[eval] 对照 vector → hybrid → rerank')
  const { items } = await embedConfig(args.maxChars, args.overlap)
  await scoreCases('vector', gold, topK, (c) => searchVectors(c.query, items, topK))
  await scoreCases('hybrid', gold, topK, (c) => searchHybrid(c.query, items, topK))
  await scoreCases('rerank', gold, topK, (c) => searchRerank(c.query, items, topK))

  const learn = gold.cases.find((c) => c.id === 'learn')
  if (learn) {
    const ranked = await searchRerank(learn.query, items, topK)
    const expanded = expandWithNeighbors(ranked, items)
    const top = expanded[0]
    const matched = top?.text.length ?? 0
    const ctx = top?.context?.length ?? matched
    console.log(
      `[eval] small-to-big 例 learn top1「${top?.title ?? ''}」命中块 ${matched} 字 → 含邻接 ${ctx} 字`,
    )
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
