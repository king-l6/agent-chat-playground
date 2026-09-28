/**
 * 分期文档的召回断言集：只看 wiki 周报这一族，不碰黄金集。
 *
 *   npx tsx server/scripts/eval-recency.ts
 *
 * 为什么单独一套：eval:rag 只加载内置 project + 求职补充手册（loadCoreChunks），
 * 周报根本不在黄金集里，改「来源文档名 + 时间软加权」它测不出来。
 *
 * 断言看的是「top1 落在哪一篇」，不是「分数变没变」：
 *   A 最近意图   → top1 必须是现有最新的一两篇，不能被旧篇或无关文档压掉
 *   B 指定期次   → 问到哪一期，top1 就该是哪一期
 *   C 同类不同族 → 「搜索工程周报」不能召回成「平台工作周报」
 *   D 来源可见   → 每条 hit 都得带 docName，否则模型又看不出这是哪一篇
 *
 * 【I 组】为什么单独拆出一组纯函数断言：
 * 上面 A~F 全是**手写 query 直接喂检索**。但线上送进检索的 query 是
 * search_notes 的调用方——**模型自己组的**，它会丢词。实测问「平台工程周报讲了什么」，
 * 模型组出来的是「平台工程周报 讲了什么」，「最近」没了，于是门不触发、
 * 退化成纯语义召回，捞出 2026年1月W2/W4（真正最新的 8月W1 全库排 #193）。
 * 也就是说：老集子测的是**门本身**，故障发生在**门和用户原话之间**，全绿也拦不住。
 * 所以 I 组直接断言「哪句话算数」，并补 G/H 两条端到端。
 *
 * 只读 index.json：不建索引、不编码、不写盘。
 */
import { HYBRID_CANDIDATES, assembleHits, recencyIntent, searchRerank } from '../src/retrieve.js'
import { loadDocNames, loadIndexItems } from './lib/load-index.js'
import type { SearchHit } from '../src/knowledge.js'

const TOP_K = 3

/** 平台工作周报这一族里最新的几篇（按文档名解析出的期次排序） */
function latestWeeklyFamily(names: string[], keep: number): string[] {
  return names
    .filter((n) => n.startsWith('平台工作周报-'))
    .sort((a, b) => weekRank(b) - weekRank(a))
    .slice(0, keep)
}

/** 「平台工作周报-2026年8月W1」→ 可比较的数字；解析不出给 0 */
function weekRank(name: string): number {
  const m = name.match(/(20\d{2})年(\d{1,2})月W(\d)/)
  if (!m) return 0
  return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3])
}

async function retrieveFor(
  query: string,
  items: Awaited<ReturnType<typeof loadIndexItems>>,
  userQuery?: string,
) {
  const fused = await searchRerank(query, items, HYBRID_CANDIDATES(TOP_K))
  return assembleHits(fused, TOP_K, items, query, userQuery)
}

/**
 * I 组：时间意图判定的纯函数断言。不碰索引、不碰模型，跑一次几毫秒。
 *
 * 左列是**送进检索的 query**（线上由模型生成），右列是**用户原话**。
 * 凡是两列不一样的，都是在模拟「模型转述丢了词」这个线上故障。
 */
const INTENT_CASES: Array<{
  query: string
  userQuery?: string
  want: 'none' | 'weak' | 'strong'
  why: string
}> = [
  { query: '查一下平台工程最近的周报', want: 'strong', why: '手写 query：时间词 + 期刊名词都在' },
  {
    query: '平台工程 周报 最近',
    userQuery: '查一下平台工程最近的周报',
    want: 'strong',
    why: '线上常见形态：模型把词序打乱但都留着',
  },
  {
    query: '平台工程周报 讲了什么',
    userQuery: '平台工程周报讲了什么',
    want: 'weak',
    why: '★ 故障复现：内容型问句没有时间词，只靠期刊名词触发',
  },
  {
    query: '平台工作周报 进展',
    userQuery: '平台工程最近的周报',
    want: 'strong',
    why: '★ 模型丢了「最近」，但用户原话里有，必须仍算强意图',
  },
  {
    query: '平台工程 最近 工作',
    userQuery: '平台工程最近在忙什么',
    want: 'none',
    why: '模型把「周报」丢了，用户原话里也没有 → 不碰',
  },
  { query: '平台工程最新进展', want: 'none', why: '两边都没有期刊名词' },
  { query: '最新的技术栈是什么', want: 'none', why: '负向对照 E：有时间词但问的不是期刊' },
  { query: '我最近投 Agent 前端还缺什么', want: 'none', why: '负向对照 F：「最近」只是状语' },
  {
    query: '平台工作周报 2026年8月W1 讲了什么',
    want: 'none',
    why: '已点名期次 → 不是在问「最新」，补召反而会挤掉正主',
  },
  {
    query: '平台工作周报 2025年3月W2 讲了什么',
    want: 'none',
    why: '★ 同上，且问的是旧期：补召会把 2026年8月W1 顶到第一位',
  },
  { query: '搜索工程周报最近写了什么', want: 'strong', why: '别的族也要能触发' },
]

function top1(hits: SearchHit[]): SearchHit | undefined {
  return hits[0]
}

async function main() {
  const items = loadIndexItems()
  const names = Array.from(new Set(loadDocNames().values()))
  const newest = latestWeeklyFamily(names, 2)
  console.log(`索引 ${items.length} 块；平台工作周报最新两期：${newest.join('、')}\n`)

  const cases: Array<{
    label: string
    query: string
    /** 用户原话；不给就是「检索拿不到原话」的退化情况（老集子全是不给的） */
    userQuery?: string
    check: (hits: SearchHit[]) => { ok: boolean; got: string }
  }> = [
    {
      label: 'A 最近意图：问最近，top1 得是最新一两期',
      query: '查一下平台工程最近的周报',
      check: (hits) => {
        const name = top1(hits)?.docName ?? '(空)'
        return { ok: newest.includes(name), got: name }
      },
    },
    {
      label: 'B 指定期次：问到哪一期就该是哪一期',
      query: '平台工作周报 2026年8月W1 讲了什么',
      check: (hits) => {
        const name = top1(hits)?.docName ?? '(空)'
        return { ok: name === '平台工作周报-2026年8月W1', got: name }
      },
    },
    {
      label: 'C 同族不同系：搜索工程周报不能串成平台工作周报',
      query: '搜索工程周报最近写了什么',
      check: (hits) => {
        const name = top1(hits)?.docName ?? '(空)'
        return { ok: name.startsWith('搜索工程周报'), got: name }
      },
    },
    {
      label: 'D 来源可见：每条 hit 都要带 docName',
      query: '平台工程 流水线 班车',
      check: (hits) => {
        const missing = hits.filter((h) => !h.docName).length
        const name = top1(hits)?.docName ?? '(空)'
        return { ok: hits.length > 0 && missing === 0, got: `${name}（缺 docName ${missing} 条 / 共 ${hits.length} 条）` }
      },
    },
    // 负向对照：问句只是碰巧带了「最新/最近」，时间补召不该把周报塞进来挤掉正主
    {
      label: 'E 负向：问技术栈（带「最新」）不该被周报挤掉',
      query: '最新的技术栈是什么',
      check: (hits) => {
        const name = top1(hits)?.docName ?? '(空)'
        return { ok: !name.includes('周报'), got: name }
      },
    },
    {
      label: 'F 负向：问简历缺口（带「最近」）不该被周报挤掉',
      query: '我最近投 Agent 前端还缺什么',
      check: (hits) => {
        const name = top1(hits)?.docName ?? '(空)'
        return { ok: !name.includes('周报'), got: name }
      },
    },
    {
      // 线上真实故障：模型组 query 时把「最近」丢了，只判 query 就整条通道失效
      label: 'G 弱意图：模型丢了时间词，最新一期仍要顶上来',
      query: '平台工程周报 讲了什么',
      userQuery: '平台工程周报讲了什么',
      check: (hits) => {
        const name = top1(hits)?.docName ?? '(空)'
        const injected = hits.some((h) => h.via === 'recency')
        return {
          ok: newest.includes(name) && injected,
          got: injected ? name : `${name}（补召根本没触发）`,
        }
      },
    },
    {
      // 反向保护：问的是旧期，补召不能把最新一期塞到最前面
      label: 'H 点名旧期：补召不该把最新一期顶上来',
      query: '平台工作周报 2025年3月W2 讲了什么',
      userQuery: '平台工作周报-2025年3月W2 讲了什么',
      check: (hits) => {
        const injected = hits.filter((h) => h.via === 'recency')
        const name = top1(hits)?.docName ?? '(空)'
        return {
          ok: injected.length === 0,
          got: injected.length === 0 ? name : `被顶掉：top1 = ${name}`,
        }
      },
    },
  ]

  // —— I 组：意图判定（纯函数，不碰索引）——
  console.log('── I 组：时间意图判定 ──')
  let ok = 0
  for (const c of INTENT_CASES) {
    const got = recencyIntent(c.query, c.userQuery)
    const pass = got === c.want
    if (pass) ok += 1
    console.log(`${pass ? '✓' : '✗'} ${c.why}`)
    console.log(`    query=${JSON.stringify(c.query)}${c.userQuery ? ` 用户原话=${JSON.stringify(c.userQuery)}` : ''}`)
    console.log(`    意图 ${got}（要 ${c.want}）`)
  }
  console.log(`\n── A~H 组：端到端召回 ──`)

  for (const c of cases) {
    const hits = await retrieveFor(c.query, items, c.userQuery)
    const { ok: pass, got } = c.check(hits)
    if (pass) ok += 1
    console.log(`${pass ? '✓' : '✗'} ${c.label}`)
    console.log(`    query: ${c.query}`)
    if (c.userQuery) console.log(`    用户原话: ${c.userQuery}`)
    console.log(`    top1 : ${got}`)
    // 带 (R) 的是时间意图补召进来的，不带的是正常召回
    console.log(
      `    top${TOP_K}: ${hits.map((h) => `${h.docName ?? '?'}${h.via === 'recency' ? '(R)' : ''}`).join(' | ')}`,
    )
    console.log('')
  }

  const total = INTENT_CASES.length + cases.length
  console.log(`[eval-recency] ${ok}/${total} 通过`)
  if (ok < total) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
