/**
 * 画布跑图：pipeline 是前端按 DAG 拓扑序排好的 { id, kind }[]
 * 结果写进同一块黑板（retrieved / extra），回答读黑板，不是沿边传变量。
 */
import OpenAI from 'openai'
import { resolveLlmConfig } from './agent.js'
import { retrieve, type RetrieveResult } from './retrieve.js'
import { executeTool } from './tools.js'

export type WorkflowKind = 'search' | 'answer' | 'calc'

export type PipelineStep = {
  id: string
  kind: WorkflowKind
  expression?: string
  /** 检索节点的篇数上限，缺省 3，和对话里的 search_notes 一致 */
  topK?: number
  /** Dify RetrievalMethod：hybrid_search 或 keyword_search。缺省混合 */
  retrieval?: 'hybrid' | 'keyword'
  /** 非空时不用用户原句，当作这个节点自己的 query */
  query?: string
}

export type WorkflowTrace = {
  retrieval?: string
  query?: string
  rewriteTerms?: string[]
  hits?: Array<{ citation: number; title: string; score?: number; rerank?: number }>
}

export type WorkflowStep = {
  id: string
  output: string
  ms: number
  trace?: WorkflowTrace
}

export type WorkflowHooks = {
  onStart?: (id: string) => void
  onDone?: (step: WorkflowStep) => void
}

function clampTopK(value: number | undefined) {
  if (value == null || !Number.isFinite(value)) return 3
  return Math.min(8, Math.max(1, Math.round(value)))
}

function formatHits(retrieved: RetrieveResult) {
  const head = [
    retrieved.mode === 'hybrid' ? '向量 + 关键词' : '关键词',
    retrieved.rewrite_terms.length
      ? `改写 ${retrieved.rewrite_terms.slice(0, 8).join(' ')}`
      : '',
  ]
    .filter(Boolean)
    .join(' · ')
  if (!retrieved.hits.length) return `${head}\n未命中`
  const body = retrieved.hits
    .map((h) => {
      const meta = [
        typeof h.score === 'number' ? `融合 ${h.score}` : '',
        typeof h.rerank === 'number' ? `重排 ${h.rerank}` : '',
      ]
        .filter(Boolean)
        .join(' · ')
      return `[${h.citation}] ${h.title}${meta ? `  ${meta}` : ''}\n${(h.context ?? h.text).slice(0, 180)}`
    })
    .join('\n\n')
  return `${head}\n\n${body}`
}

function searchTrace(retrieved: RetrieveResult): WorkflowTrace {
  return {
    retrieval: retrieved.mode,
    query: retrieved.query_used || retrieved.query,
    rewriteTerms: retrieved.rewrite_terms,
    hits: retrieved.hits.slice(0, 5).map((h) => ({
      citation: h.citation,
      title: h.title,
      score: h.score,
      rerank: h.rerank,
    })),
  }
}

async function generateAnswer(
  question: string,
  retrieved: RetrieveResult | null,
  extra: string,
) {
  const hits = retrieved?.hits ?? []
  const { apiKey, baseURL, model } = resolveLlmConfig()
  const ctx = [
    hits
      .map((h) => `[${h.citation}] ${h.title}\n${h.context ?? h.text}`)
      .join('\n\n'),
    extra,
  ]
    .filter(Boolean)
    .join('\n\n')

  if (!apiKey) {
    if (extra && !hits[0]) return `（mock）${extra}`
    if (!hits[0]) {
      return retrieved
        ? '（mock）知识库未命中'
        : '（mock）本路径没有检索片段，也没有工具结果。'
    }
    return `（mock）根据 [${hits[0].citation}] ${hits[0].title}：${(hits[0].context ?? hits[0].text).slice(0, 320)}`
  }
  const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) })
  const res = await client.chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content:
          '根据检索片段和工具结果用简洁中文回答。有引用则句末标 [n]。没有的不要编。',
      },
      {
        role: 'user',
        content: `问题：${question}\n\n上下文：\n${ctx || '（无）'}`,
      },
    ],
  })
  return res.choices[0]?.message?.content?.trim() || '（空回答）'
}

export async function runWorkflow(
  question: string,
  pipeline: PipelineStep[],
  hooks?: WorkflowHooks,
): Promise<{ steps: WorkflowStep[]; answer: string }> {
  const q = question.trim().slice(0, 2000)
  const steps: WorkflowStep[] = []
  let retrieved: RetrieveResult | null = null
  let extra = ''
  let answer = ''

  const finish = (step: WorkflowStep) => {
    steps.push(step)
    hooks?.onDone?.(step)
  }

  for (const step of pipeline) {
    const started = Date.now()
    hooks?.onStart?.(step.id)
    if (step.kind === 'search') {
      const query = String(step.query ?? '').trim() || q
      retrieved = await retrieve(
        query,
        clampTopK(step.topK),
        q,
        step.retrieval === 'keyword' ? 'keyword' : 'hybrid',
      )
      finish({
        id: step.id,
        output: formatHits(retrieved),
        ms: Date.now() - started,
        trace: searchTrace(retrieved),
      })
    } else if (step.kind === 'calc') {
      const expression = String(step.expression ?? '').trim() || '123*456'
      const output = await executeTool(
        'calculator',
        JSON.stringify({ expression }),
      )
      extra = extra ? `${extra}\n${output}` : output
      finish({ id: step.id, output, ms: Date.now() - started })
    } else if (step.kind === 'answer') {
      answer = await generateAnswer(q, retrieved, extra)
      finish({ id: step.id, output: answer, ms: Date.now() - started })
    }
  }

  return { steps, answer }
}
