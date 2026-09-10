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
}

export type WorkflowStep = {
  id: string
  output: string
}

function formatHits(retrieved: RetrieveResult) {
  if (!retrieved.hits.length) return '未命中'
  return retrieved.hits
    .map((h) => `[${h.citation}] ${h.title}\n${(h.context ?? h.text).slice(0, 280)}`)
    .join('\n\n')
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
): Promise<{ steps: WorkflowStep[]; answer: string }> {
  const q = question.trim().slice(0, 2000)
  const steps: WorkflowStep[] = []
  let retrieved: RetrieveResult | null = null
  let extra = ''
  let answer = ''

  for (const step of pipeline) {
    if (step.kind === 'search') {
      retrieved = await retrieve(q, 3)
      steps.push({ id: step.id, output: formatHits(retrieved) })
    } else if (step.kind === 'calc') {
      const expression = String(step.expression ?? '').trim() || '123*456'
      const output = await executeTool(
        'calculator',
        JSON.stringify({ expression }),
      )
      extra = extra ? `${extra}\n${output}` : output
      steps.push({ id: step.id, output })
    } else if (step.kind === 'answer') {
      answer = await generateAnswer(q, retrieved, extra)
      steps.push({ id: step.id, output: answer })
    }
  }

  return { steps, answer }
}
