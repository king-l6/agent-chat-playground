/**
 * 长期记忆的召回：用户每问一句，挑几条相关的旧记忆塞进 system prompt。
 *
 * 打分是三样东西的加权，缺一个都不行：
 *   cos      语义相关 —— 只有这条对了，记忆才可能有用
 *   时间衰减 越新写的越可能还成立（30 天半衰期的指数衰减）
 *   salience 当初判定「值得记住」的程度，是先验
 *
 * 但**门槛卡在 cos 上而不是总分上**：光看总分，一条高 salience 的无关记忆会混进来
 * （「用户在准备面试」× 问天气），所以 cos 不到线直接淘汰，总分只用来在过线的里面排序。
 *
 * 全程 fail-open：召回任何一步出错就不注入，聊天照常。
 * 和 ensureIndex 失败降级关键词是同一个哲学——记忆是加分项，不是必需品。
 */
import type { MemoryEntry } from './store.js'
import {
  MEMORY_TYPES,
  MEMORY_TYPE_LABEL,
  activeMemories,
  getMemoryVectors,
  touchMemories,
} from './store.js'
import { embedQuery } from '../embed.js'

/**
 * 余弦下限。**这个数是从实测里来的，不是拍的**（`npx tsx server/scripts/debug-memory.ts` 复现）：
 *
 *   查询                              对全部 4 条记忆的 cos         top1
 *   我准备面试该从哪下手（正）         0.568 / 0.527 / 0.503 / 0.522   0.568
 *   面试要准备哪些内容（正）           0.523 / 0.494 / 0.512 / 0.481   0.523
 *   这个项目的 SSE 是怎么实现的（负）  0.553 / 0.500 / 0.466 / 0.490   0.553  ← 漏
 *   现在几点了（负）                   0.443 / 0.423 / 0.404 / 0.370   0.443  → 卡掉
 *   帮我算一下 123*456（负）           0.414 / 0.385 / 0.390 / 0.364   0.414  → 卡掉
 *   今天上海天气怎么样（负）           0.334 / 0.319 / 0.326 / 0.290   0.334  → 卡掉
 *
 * 关键发现：**同一个 query 对所有条目的 cos 只差 ±0.05，而不同 query 的基线从 0.29 到 0.55**。
 * 也就是说区分度几乎全在 query 一侧（BGE-small-zh 的查询侧基线偏移），条目内容只让分数
 * 在这个基线上小幅摆动。由此两条推论：
 *   1. 换阈值救不了 —— 「现在几点了」的 top1-均值 = +0.033，和正向的 +0.038 一样大。
 *      能用分数分开的那三条，本来就不是靠分数分开的。
 *   2. 所以门槛只当**粗筛**用：卡掉明显在噪声区的（≤0.44 那三条），剩下一条漏网的
 *      （问本项目的 SSE，而库里记的正是这个用户的项目口径）属于可接受的过召回——
 *      代价只是几十个 token，而 system 里那段明确写了「用不上就别用、别复述」。
 *      真正的质量闸门在页面审计上（第三条设计决策：全自动写 + 可审计可回滚）。
 *
 * 想真分开得上 rerank 或让模型当裁判，那是另一个量级的成本，不放这一版。
 * 库大了（几十上百条）要重测这张表再定这个数。
 */
export const MIN_MEMORY_COSINE = 0.45

/** 过召回的成本是 token，所以宁少勿多：最多注入 3 条 */
export const MEMORY_TOP_K = 3

/** 时间衰减的半衰期（天） */
const RECENCY_HALFLIFE_DAYS = 30
const W_COSINE = 0.6
const W_RECENCY = 0.25
const W_SALIENCE = 0.15

export type MemoryHit = {
  entry: MemoryEntry
  cos: number
  score: number
  /** 向量命中还是关键词兜底 —— 页面和脚本要能看出这条为什么进来 */
  via: 'vector' | 'keyword'
}

function cosine(a: number[], b: number[]): number {
  let sum = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 1) sum += a[i] * b[i]
  return sum
}

function recencyFactor(ts: number, now: number): number {
  const days = Math.max(0, (now - ts) / 86400000)
  return Math.exp((-Math.LN2 * days) / RECENCY_HALFLIFE_DAYS)
}

/**
 * 给**所有** active 条目打分并排序，不截断、不写盘。
 *
 * 和 recallMemories 拆开是为了调试脚本：要知道「差多少没过线」，
 * 就得看到被门槛拦掉的那几条 + 它们的 cos。同时保证 debug 脚本跑一百遍
 * 也不会把 access_count 刷上去（那会干扰衰减归档的判断）。
 *
 * @param query 用户这一句；不用自己加指令前缀，embedQuery 内部会加
 */
export async function rankMemories(query: string): Promise<MemoryHit[]> {
  const q = query.trim()
  if (!q) return []
  const entries = activeMemories()
  if (entries.length === 0) return []

  const now = Date.now()
  const stored = getMemoryVectors()

  let queryVector: number[] | null = null
  try {
    queryVector = await embedQuery(q)
  } catch (err) {
    console.warn('[memory] 查询向量失败，退回关键词召回:', err instanceof Error ? err.message : err)
  }

  const lower = q.toLowerCase()
  const hits: MemoryHit[] = []

  for (const entry of entries) {
    const vec = stored.get(entry.id)?.embedding
    let cos = 0
    let via: 'vector' | 'keyword' = 'vector'

    if (queryVector && vec && vec.length > 0) {
      cos = cosine(queryVector, vec)
    } else if (lower.length >= 2) {
      // 没有向量就按字面命中给一个保守分：宁可少召回，也别把不相干的塞进 prompt
      via = 'keyword'
      cos = `${entry.description} ${entry.text}`.toLowerCase().includes(lower) ? MIN_MEMORY_COSINE : 0
    }

    const score =
      W_COSINE * cos + W_RECENCY * recencyFactor(entry.updatedAt, now) + W_SALIENCE * entry.salience
    hits.push({ entry, cos, score, via })
  }

  return hits.sort((a, b) => b.score - a.score)
}

/**
 * 召回 top-k 条长期记忆：先卡 cos 门槛，再按总分取前 k。
 * @param query 用户这一句；不用自己加指令前缀，embedQuery 内部会加
 */
export async function recallMemories(query: string, topK = MEMORY_TOP_K): Promise<MemoryHit[]> {
  const top = (await rankMemories(query))
    .filter((h) => h.cos >= MIN_MEMORY_COSINE)
    .slice(0, Math.max(1, topK))
  // 命中就记账：access_count / last_access 是衰减归档的依据
  touchMemories(top.map((h) => h.entry.id))
  return top
}

/** 给断言脚本和调试用：只要 id，方便打勾 */
export async function recallMemoryIds(query: string, topK = MEMORY_TOP_K): Promise<string[]> {
  return (await recallMemories(query, topK)).map((h) => h.entry.id)
}

/**
 * 拼进 system prompt 的那一段。
 * 必须说清「这是过去会话记下的、可能过时」，否则模型会把记忆当权威事实照念，
 * 或者给它标上 [citation] 编号（编号只属于本轮的 search_notes 结果）。
 */
export function memoryPromptBlock(hits: MemoryHit[]): string {
  if (hits.length === 0) return ''

  const lines: string[] = [
    '以下是从**过去的会话**里记下来的长期记忆（不是本轮检索结果，也不是用户刚说的话）。',
    '用得上的话顺着用户当前问题自然用，不要复述这个列表本身。',
    '如果和用户当前说的冲突，以用户当前说的为准，并指出你之前记的是别的。',
    '不要给这些内容标 [citation] 编号——编号只用于 search_notes 的结果。',
  ]
  // 按 MEMORY_TYPES 的固定顺序分组（不是按命中的先后），同一类聚在一起更好读
  for (const type of MEMORY_TYPES) {
    const list = hits.filter((h) => h.entry.type === type)
    if (list.length === 0) continue
    lines.push(`\n【${MEMORY_TYPE_LABEL[type]}】`)
    for (const hit of list) {
      lines.push(`- ${hit.entry.description}（来源：${hit.entry.sourceSession ?? '手动记录'}）`)
      if (hit.entry.text && hit.entry.text !== hit.entry.description) {
        lines.push(`  ${hit.entry.text.replace(/\n/g, ' ')}`)
      }
    }
  }
  return lines.join('\n')
}

/** 召回 + 拼块一步到位；任何异常都返回空串，绝不阻断聊天 */
export async function memoryBlockFor(query: string): Promise<string> {
  try {
    return memoryPromptBlock(await recallMemories(query))
  } catch (err) {
    console.warn('[memory] 召回失败，本轮不注入记忆:', err instanceof Error ? err.message : err)
    return ''
  }
}
