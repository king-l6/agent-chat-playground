/**
 * 线上口径评测：和对话页同一条 retrieve()，不是 eval:rag 里的裸 searchRerank。
 *
 *   npm run eval:online
 *
 * 为什么要单独一条：
 *   eval:rag 100% ≠ 页面好用。那边用黄金问句直接打 searchRerank(TopK=块)；
 *   页面是 模型组 query → retrieve(按「篇」聚合) → 模型写答案/引用。
 *   本脚本测中间那层「用户原话丢进 retrieve」的命中率，最接近你手测手感。
 */
import dotenv from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMPANY_CASES, type GoldCase } from './eval-cases.js'
import { retrieve } from './retrieve.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')
dotenv.config({ path: path.join(ROOT, '.env'), override: true })

function normalize(s: string) {
  return s.toLowerCase().replace(/\\_/g, '_').replace(/\\/g, '')
}

function hitDoc(c: GoldCase, hits: Array<{ docId: string; title: string; text: string; context?: string }>) {
  const needle = normalize(c.contains)
  for (let i = 0; i < hits.length; i += 1) {
    const h = hits[i]
    if (h.docId !== c.docId) continue
    const blob = normalize(`${h.title}\n${h.text}\n${h.context ?? ''}`)
    if (blob.includes(needle)) return i + 1
    // 同文档即算召回对（标答可能在邻接块 / 同篇其它块）
    return i + 1
  }
  return 0
}

async function main() {
  const topK = 3
  console.log(
    `[eval:online] ${COMPANY_CASES.length} 道公司题 · 走 retrieve()（与 search_notes 同链路）· topK=${topK} 篇`,
  )
  console.log('[eval:online] 口径：命中正确 docId 即过（找对文档）\n')

  let ok = 0
  let rr = 0
  const misses: string[] = []

  for (const c of COMPANY_CASES) {
    // 第二参 userQuery=原句：和 tools.searchNotes 一致，时间意图等靠它
    const { hits, mode } = await retrieve(c.query, topK, c.query)
    const rank = hitDoc(c, hits)
    if (rank > 0) {
      ok += 1
      rr += 1 / rank
      console.log(`  ✓ ${c.id}  rank=${rank}  mode=${mode}  top1=${hits[0]?.title ?? '空'}`)
    } else {
      misses.push(
        `  ✗ ${c.id}\n     Q: ${c.query}\n     期望 ${c.docId}∋${c.contains}\n     top: ${hits
          .map((h, i) => `${i + 1}.${h.docId.slice(0, 10)}/${h.title.slice(0, 28)}`)
          .join(' | ') || '空'}`,
      )
      console.log(`  ✗ ${c.id}  mode=${mode}  top1=${hits[0]?.title ?? '空'}`)
    }
  }

  const n = COMPANY_CASES.length
  console.log(
    `\n[eval:online] DocRecall@${topK} = ${ok}/${n} = ${((ok / n) * 100).toFixed(0)}%  MRR = ${(rr / n).toFixed(3)}`,
  )
  if (misses.length) {
    console.log('\n未命中明细：')
    console.log(misses.join('\n'))
  }

  console.log(`
---
这和页面「感觉准不准」还差两层，手测时分开记分：

  A 检索（本脚本）     问句 → retrieve → 对的文档在不在 TopK
  B 工具调用           模型有没有调 search_notes（追问「详细说一下」常偷懒）
  C 答案+引用          事实对不对；[n] 是否对本轮 hits

页面打分表（每题 0/1，10 题算准确率）：
  [ ] 调了 search_notes
  [ ] 工具卡里能看到相关文档名
  [ ] 答案里的关键事实能在 hits 原文对上
  [ ] 引用角标点开不是「未在本轮找到」
`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
