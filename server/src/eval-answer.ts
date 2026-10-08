/**
 * 答案端评测（LLM-as-judge）：补上 eval:rag / eval:online 证明不了的那层。
 *
 *   npm run eval:answer
 *
 * 三层分开记分（见 eval-online.ts 结尾那张表）：
 *   A 检索   → eval:rag / eval:online：对的文档在不在 TopK
 *   B 工具   → 页面手测：模型有没有调 search_notes
 *   C 答案   → 本脚本：答案忠不忠于检索内容、答没答到点
 *
 * 本脚本只测 C，且刻意手写 judge（不引 RAGAS/langchain），保持「自研」口径：
 *   1) retrieve() 拿 hits（和 search_notes 同链路）
 *   2) 让模型「只依据 hits」作答
 *   3) 再让模型当裁判，对 faithfulness / answer_relevancy 各打 1~5 分
 *
 * 无 Key 时优雅跳过（和 agent.ts 的 mock 一致），不硬失败。
 */
import dotenv from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import OpenAI from 'openai'
import { z } from 'zod'
import { COMPANY_CASES, type GoldCase } from './eval-cases.js'
import { retrieve } from './retrieve.js'
import { resolveLlmFromSettings } from './settings.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')
dotenv.config({ path: path.join(ROOT, '.env'), override: true })

/** 只取前 6 道，评测要调模型、慢且费 token，不新造语料。 */
const CASES: GoldCase[] = COMPANY_CASES.slice(0, 6)
const TOP_K = 3

/** 裁判必须回这个结构；解析失败按 0 分处理（见下） */
const Verdict = z.object({
  faithfulness: z.number().min(0).max(5),
  answer_relevancy: z.number().min(0).max(5),
  reason: z.string(),
})
type Verdict = z.infer<typeof Verdict>

/** 把 hits 拼成「只能用这些」的材料块，带本轮局部编号 [n] */
function contextBlock(hits: Array<{ citation: number; title: string; text: string }>): string {
  if (hits.length === 0) return '（本轮没有检索到任何资料）'
  return hits.map((h) => `[${h.citation}] ${h.title}\n${h.text}`).join('\n\n')
}

/** 作答：严格「只依据 hits」，和页面规则 3/4 同口径 */
async function answerFromHits(client: OpenAI, model: string, query: string, context: string) {
  const res = await client.chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content:
          '你只能依据<资料>里的内容回答，用简洁中文。资料里没有的就说「资料中没有」，不要补充常识或编造。',
      },
      { role: 'user', content: `<资料>\n${context}\n</资料>\n\n问题：${query}` },
    ],
  })
  return res.choices[0]?.message?.content?.trim() ?? ''
}

/** 裁判：对 answer 打两个分，返回严格 JSON */
async function judge(
  client: OpenAI,
  model: string,
  query: string,
  context: string,
  answer: string,
): Promise<Verdict> {
  const res = await client.chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content:
          '你是严格的评测裁判。只输出 JSON，不要任何多余文字、不要代码块围栏。' +
          '字段：faithfulness（答案里的事实是否都能在资料里找到依据，1=大量脱离资料的编造，5=完全有据）、' +
          'answer_relevancy（答案是否正面回答了问题，1=答非所问，5=精准命中）、reason（一句中文说明）。',
      },
      {
        role: 'user',
        content: `问题：${query}\n\n<资料>\n${context}\n</资料>\n\n待评答案：\n${answer}`,
      },
    ],
  })
  const raw = res.choices[0]?.message?.content?.trim() ?? ''
  // 容忍模型偶尔包了 ```json 围栏
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  const parsed = Verdict.safeParse(JSON.parse(cleaned))
  if (!parsed.success) {
    throw new Error(`裁判返回不合格 JSON：${raw.slice(0, 200)}`)
  }
  return parsed.data
}

async function main() {
  const { apiKey, baseURL, model } = resolveLlmFromSettings()
  if (!apiKey) {
    console.log(
      '[eval:answer] 当前是 MOCK / 没有 API Key，答案端评测需要真实模型。\n' +
        '到「配置」页填 Key（或 .env 配 ANTHROPIC_*/OPENAI_*）后再跑。本次跳过，不算失败。',
    )
    return
  }

  const client = new OpenAI({ apiKey, baseURL })
  console.log(
    `[eval:answer] ${CASES.length} 道题 · retrieve topK=${TOP_K} · judge=${model}\n` +
      '[eval:answer] 测的是 C 层（答案忠实度/相关度），不是检索命中率\n',
  )

  let sumFaith = 0
  let sumRel = 0
  let scored = 0
  const lows: string[] = []

  for (const c of CASES) {
    try {
      const { hits } = await retrieve(c.query, TOP_K, c.query)
      const context = contextBlock(hits)
      const answer = await answerFromHits(client, model, c.query, context)
      const v = await judge(client, model, c.query, context, answer)
      sumFaith += v.faithfulness
      sumRel += v.answer_relevancy
      scored += 1
      const flag = v.faithfulness <= 3 || v.answer_relevancy <= 3 ? ' ⚠️' : ''
      console.log(
        `  ${c.id}  忠实=${v.faithfulness} 相关=${v.answer_relevancy}${flag}  ${v.reason}`,
      )
      if (flag) {
        lows.push(
          `  ⚠️ ${c.id}\n     Q: ${c.query}\n     答: ${answer.slice(0, 120)}\n     裁判: ${v.reason}`,
        )
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.log(`  ✗ ${c.id}  评测出错（忠实/相关记 0）：${message}`)
      scored += 1 // 计入分母：出错≈最差，不然平均分会虚高
    }
  }

  const n = CASES.length
  console.log(
    `\n[eval:answer] 平均  忠实度=${(sumFaith / n).toFixed(2)}/5  相关度=${(sumRel / n).toFixed(2)}/5  （${scored}/${n} 题完成）`,
  )
  if (lows.length) {
    console.log('\n低分样例（忠实或相关 ≤3，面试「记一次失败样例」用）：')
    console.log(lows.join('\n'))
  }
  console.log(`
---
口述：eval:rag 证明「检索到对的文档」(A)，本脚本证明「答案没脱离检索内容、答到了点」(C)。
两者分开——检索 100% 不代表答案对，模型可能拿着对的资料答歪；答案好也可能是检索给力。
中间 B（模型到底有没有调 search_notes）仍靠页面手测，三层各记各的分。
`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
