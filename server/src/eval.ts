/**
 * RAG 评测：黄金问句 → Recall@K
 *
 *   npm run eval:rag              默认：全量索引 + 公司 wiki 黄金题
 *   npm run eval:rag -- --all     全量索引 + gold.json + 产品题 + 公司题
 *   npm run eval:rag -- --core    只切内置+手册（旧口径）
 *   npm run eval:rag -- --sweep   只扫切块（强制 --core）
 */
import dotenv from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadGoldCases, COMPANY_CASES, type GoldCase } from './eval-cases.js'
import { configureChunking, getChunkParams, loadCoreChunks } from './knowledge.js'
import {
  expandWithNeighbors,
  indexChunksInMemory,
  loadIndexedItems,
  searchHybrid,
  searchRerank,
  searchVectors,
} from './retrieve.js'

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
  const coreOnly = sweep || argv.includes('--core')
  /** 全量索引下默认只跑公司 wiki 题；--all 才加上 gold.json + 产品题 */
  const allSuites = argv.includes('--all')
  let maxChars = 280
  let overlap = 60
  let topK = 0
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--size' && argv[i + 1]) maxChars = Number(argv[++i])
    else if (argv[i] === '--overlap' && argv[i + 1]) overlap = Number(argv[++i])
    else if (argv[i] === '--topK' && argv[i + 1]) topK = Number(argv[++i])
  }
  return { sweep, coreOnly, allSuites, maxChars, overlap, topK }
}

function normalizeForMatch(s: string) {
  // wiki 里大量 auto\_refresh\_time；黄金题写 auto_refresh_time 应对齐
  return s.toLowerCase().replace(/\\_/g, '_').replace(/\\/g, '')
}

/**
 * 正确答案在 hits 里的排名(1-based);没命中返回 0。
 *
 * 公司 wiki 一篇很长、切成几十块：TopK 常命中「对的文档、错的块」，
 * 标答字眼在同文档另一块里。所以：
 *   1) 先看命中块本身含不含 contains
 *   2) 否则只要命中块的 docId 对，且该文档在索引里任意一块含 contains → 也算命中
 * （这是「找对文档」口径；比「找对 280 字碎片」更接近真实问答。）
 */
function firstHitRank(
  c: GoldCase,
  hits: Hit[],
  corpus?: Array<{ docId: string; title: string; text: string }>,
): number {
  const needle = normalizeForMatch(c.contains)
  const blob = (title: string, text: string) => normalizeForMatch(`${title}\n${text}`)
  const docHasNeedle = () =>
    !!corpus?.some((it) => it.docId === c.docId && blob(it.title, it.text).includes(needle))

  for (let i = 0; i < hits.length; i += 1) {
    const h = hits[i]
    if (h.docId !== c.docId) continue
    if (blob(h.title, h.text).includes(needle)) return i + 1
    if (docHasNeedle()) return i + 1
  }
  return 0
}

async function scoreCases(
  label: string,
  gold: GoldFile,
  topK: number,
  hitsOf: (c: GoldCase) => Promise<Hit[]>,
  corpus?: Array<{ docId: string; title: string; text: string }>,
) {
  let ok = 0
  let rrSum = 0
  const misses: string[] = []
  for (const c of gold.cases) {
    const hits = await hitsOf(c)
    const rank = firstHitRank(c, hits, corpus)
    if (rank > 0) {
      ok += 1
      rrSum += 1 / rank
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

async function loadItems(coreOnly: boolean, maxChars: number, overlap: number) {
  if (coreOnly) {
    configureChunking(maxChars, overlap)
    const chunks = loadCoreChunks()
    console.log(
      `\n[eval] --core 切块 size=${maxChars} overlap=${overlap} → ${chunks.length} chunks（不含公司 wiki）`,
    )
    return { chunks: chunks.length, items: await indexChunksInMemory(chunks), corpus: 'core' as const }
  }
  const items = await loadIndexedItems()
  const wikiDocs = new Set(items.filter((it) => it.docId.startsWith('w_')).map((it) => it.docId))
  console.log(
    `\n[eval] 磁盘全量索引 chunks=${items.length}  wiki文档≈${wikiDocs.size}（含你喂进来的公司文档）`,
  )
  return { chunks: items.length, items, corpus: 'index' as const }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const loaded = loadGoldCases() as GoldFile
  const cases =
    args.coreOnly || args.allSuites
      ? loaded.cases
      : COMPANY_CASES
  const gold: GoldFile = { topK: loaded.topK, cases }
  const topK = args.topK || gold.topK || 3

  console.log(
    `[eval] ${gold.cases.length} 条黄金问题  topK=${topK}  默认切块参数 ${JSON.stringify(getChunkParams())}`,
  )
  console.log(
    `[eval] 语料模式：${args.coreOnly ? 'core（内置+手册）' : 'index（全量，含公司 wiki）'}；题集：${
      args.coreOnly || args.allSuites ? 'gold.json+EXTRA' : 'COMPANY_CASES（公司 wiki）'
    }`,
  )

  if (args.sweep) {
    console.log('[eval] --sweep 只测 vector（强制 core，避免把线上索引切块参数打乱）')
    const rows = []
    for (const cfg of [
      { maxChars: 200, overlap: 60 },
      { maxChars: 280, overlap: 60 },
      { maxChars: 300, overlap: 60 },
    ]) {
      const { chunks, items } = await loadItems(true, cfg.maxChars, cfg.overlap)
      const scored = await scoreCases(
        'vector',
        gold,
        topK,
        (c) => searchVectors(c.query, items, topK),
        items,
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
  const { items } = await loadItems(args.coreOnly, args.maxChars, args.overlap)
  await scoreCases('vector', gold, topK, (c) => searchVectors(c.query, items, topK), items)
  await scoreCases('hybrid', gold, topK, (c) => searchHybrid(c.query, items, topK), items)
  await scoreCases('rerank', gold, topK, (c) => searchRerank(c.query, items, topK), items)

  const sample = gold.cases.find((c) => c.id.startsWith('wiki-')) ?? gold.cases[0]
  if (sample) {
    const ranked = await searchRerank(sample.query, items, topK)
    const expanded = expandWithNeighbors(ranked, items)
    const top = expanded[0]
    const matched = top?.text.length ?? 0
    const ctx = top?.context?.length ?? matched
    console.log(
      `[eval] small-to-big 例 ${sample.id} top1「${top?.title ?? ''}」命中块 ${matched} 字 → 含邻接 ${ctx} 字`,
    )
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
