/**
 * 长期记忆探针：库里有什么、哪句话会命中哪条、最终塞进 system 的那段长什么样。
 *
 *   npx tsx server/scripts/debug-memory.ts                    # 跑内置探针集（含负向）
 *   npx tsx server/scripts/debug-memory.ts "我要准备面试"      # 只跑这几句
 *   npx tsx server/scripts/debug-memory.ts --system "..."     # 额外打印完整 system prompt
 *
 * 为什么要有负向探针：记忆的价值全在**门槛**上。召回一条不相关的记忆，
 * 比不召回还糟——模型会拿着「用户在准备面试」去回答「帮我算 123*456」。
 * 所以脚本最后会统计「负向里漏了几条」，这是唯一用来调 MIN_MEMORY_COSINE 的数。
 *
 * 只读：走 rankMemories 而不是 recallMemories，不建向量、不改 access_count
 * （刷 access_count 会干扰「60 天没被召回就归档」的判断）。
 */
import { MIN_MEMORY_COSINE, MEMORY_TOP_K, memoryPromptBlock, rankMemories } from '../src/memory/recall.js'
import { MEMORY_TYPE_LABEL, listMemories, memoryStats } from '../src/memory/store.js'
import { buildSystemPrompt } from '../src/agent.js'

/** 内置探针集：前两句该命中，后四句都不该命中 */
const POSITIVE = ['我准备面试该从哪下手', '面试要准备哪些内容']
const NEGATIVE = ['帮我算一下 123*456', '今天上海天气怎么样', '这个项目的 SSE 是怎么实现的', '现在几点了']

const argv = process.argv.slice(2)
const wantSystem = argv.includes('--system')
const custom = argv.filter((a) => !a.startsWith('--'))

function fmt(ms: number | null): string {
  return ms === null ? '—' : new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
}

function printLibrary() {
  const stats = memoryStats()
  console.log(`\n=== 记忆库 ===`)
  console.log(
    `共 ${stats.total} 条（active ${stats.active} / archived ${stats.archived} / superseded ${stats.superseded}），` +
      `有向量 ${stats.embedded} 条 @ ${stats.model}`,
  )
  for (const [type, n] of Object.entries(stats.byType)) {
    console.log(`  ${MEMORY_TYPE_LABEL[type as keyof typeof MEMORY_TYPE_LABEL]}(${type})  ${n}`)
  }
  if (stats.topAccessed.length > 0) {
    console.log('  被召回最多：')
    for (const row of stats.topAccessed) {
      console.log(`    ${row.accessCount} 次  ${row.description}`)
    }
  }

  const all = listMemories({ limit: 200 })
  if (all.items.length === 0) {
    console.log('  （空库。手动加一条：POST /api/memory/long 或页面上「手动记录」）')
    return
  }
  console.log('  明细：')
  for (const e of all.items) {
    const hasVec = stats.embedded > 0 ? '' : ' [无向量，走关键词]'
    console.log(
      `    ${e.status === 'active' ? '●' : '○'} ${e.id}${hasVec}\n` +
        `        ${e.description}  [${e.type} salience=${e.salience} 召回${e.accessCount}次 最后访问 ${fmt(e.lastAccess)}]`,
    )
  }
}

async function probe(query: string, kind: '正' | '负') {
  const ranked = await rankMemories(query)
  const passed = ranked.filter((h) => h.cos >= MIN_MEMORY_COSINE).slice(0, MEMORY_TOP_K)
  console.log(`\n[${kind}] 「${query}」`)
  if (ranked.length === 0) {
    console.log('  库里没有 active 记忆，无命中')
    return { leaked: 0, missed: kind === '正' ? 1 : 0 }
  }
  const injected = new Set(passed.map((h) => h.entry.id))
  for (const h of ranked) {
    const mark = injected.has(h.entry.id)
      ? 'PASS'
      : h.cos >= MIN_MEMORY_COSINE
        ? 'CAP ' // 过了门槛但被 topK 截掉
        : '----'
    const note =
      mark === '----'
        ? `(差 ${(MIN_MEMORY_COSINE - h.cos).toFixed(4)} 没过 ${MIN_MEMORY_COSINE})`
        : mark === 'CAP'
          ? `(过了门槛，但只注入 top${MEMORY_TOP_K})`
          : ''
    console.log(
      `  ${mark}  cos=${h.cos.toFixed(4)} score=${h.score.toFixed(4)} via=${h.via}  ${note}  ${h.entry.description}`,
    )
  }
  if (kind === '负' && passed.length > 0) {
    console.log(`  ⚠️  负向漏了 ${passed.length} 条 —— 会把不相关的记忆塞进 system`)
  }
  if (wantSystem) {
    const block = memoryPromptBlock(passed)
    console.log(`  --- 注入 system 的原文 ---`)
    console.log(
      block ? block.split('\n').map((l) => `  | ${l}`).join('\n') : '  | （无命中，不注入）',
    )
  }
  return { leaked: kind === '负' ? passed.length : 0, missed: kind === '正' && passed.length === 0 ? 1 : 0 }
}

async function main() {
  printLibrary()

  const queries: Array<[string, '正' | '负']> = custom.length
    ? custom.map((q) => [q, '正'] as [string, '正'])
    : [...POSITIVE.map((q) => [q, '正'] as [string, '正']), ...NEGATIVE.map((q) => [q, '负'] as [string, '负'])]

  let leaked = 0
  let missed = 0
  for (const [q, kind] of queries) {
    const r = await probe(q, kind)
    leaked += r.leaked
    missed += r.missed
  }

  console.log(`\n=== 汇总 ===`)
  console.log(`负向漏召回 ${leaked} 条（越少越好，0 最好）｜正向漏召回 ${missed} 条`)
  if (!custom.length && leaked > 0) {
    console.log(`说明门槛 ${MIN_MEMORY_COSINE} 偏松：上面的 cos 都是 BGE-small-zh 的绝对值，`)
    console.log(`要调就改 recall.ts 的 MIN_MEMORY_COSINE，然后重跑这个脚本对比。`)
  }

  // P1 验收就是看这一段：记忆真的以「规则 11/12」出现在 system 里（无命中时整段不追加）
  if (wantSystem) {
    const q = custom[0] ?? POSITIVE[0]
    const passed = (await rankMemories(q)).filter((h) => h.cos >= MIN_MEMORY_COSINE).slice(0, MEMORY_TOP_K)
    console.log(`\n=== 完整 system prompt（以「${q}」为例）===`)
    console.log(buildSystemPrompt(memoryPromptBlock(passed)))
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
