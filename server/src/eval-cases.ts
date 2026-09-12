/**
 * 黄金集：gold.json 是原 8 题；EXTRA_CASES 给交付 Agent 加题。
 * 实现角色只准改这个文件和 eval.ts，改不了 agent.ts。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export type GoldCase = {
  id: string
  query: string
  docId: string
  contains: string
}

const GOLD_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../eval/gold.json')

/** 交付竖切往这里追加，不要改 gold.json 里原来的 8 题 */
export const EXTRA_CASES: GoldCase[] = [
  {
    id: 'vite-stack',
    query: 'agent-chat-playground 的技术栈是什么？',
    docId: 'project',
    contains: 'Vite',
  },
]

export function loadGoldCases(): { topK: number; cases: GoldCase[] } {
  const gold = JSON.parse(fs.readFileSync(GOLD_PATH, 'utf8')) as {
    topK?: number
    cases: GoldCase[]
  }
  return { topK: gold.topK || 3, cases: [...gold.cases, ...EXTRA_CASES] }
}
