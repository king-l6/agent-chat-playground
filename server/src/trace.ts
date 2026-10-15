/**
 * 对话 trace 落盘：每轮 /api/chat 结束时追加一行 JSONL。
 *
 * 这是「可观测」的最小底座，对标 LangSmith：缺的是 UI，有的是**可审计原料**。
 * 刻意不进程内聚合、不做采样、不接任何 SaaS——就是一行行事实，供 trace:report
 * 事后聚合，或人直接 tail。
 *
 * 写盘一律 fail-open：trace 出错只 warn，绝不能把一条正常对话带崩。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './paths.js'

const TRACES_DIR = path.join(DATA_DIR, 'traces')

export type ChatTrace = {
  /** ISO 时间戳，落盘那一刻 */
  ts: string
  /** 会话粗 id：前端传了就用，没传生成一个短随机（只为把同一会话串起来） */
  sessionId: string
  /** 默认 Agent 还是代码团队（与 /api/chat 的 chatMode 对齐） */
  mode: 'default' | 'code_team'
  /** 实际用的模型名；mock（无 Key）时为空，可据此判断是否走了真模型 */
  model?: string
  /** 本轮调用过的工具名（按触发顺序，可能重复） */
  tools: string[]
  /** 本轮耗时毫秒：从进 /api/chat 到 finally */
  durationMs: number
  /** 这一轮用户消息条数（粗略的「第几轮」线索） */
  turns: number
  /** 正常收尾为 true；中途 error 事件或抛异常为 false */
  ok: boolean
  /** ok=false 时的错误摘要 */
  error?: string
}

function dayFile(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return path.join(TRACES_DIR, `${y}${m}${day}.jsonl`)
}

/** 没有 sessionId 时给一个短随机，别让同一天的匿名轮全挤成一个 id */
export function shortId(): string {
  return Math.random().toString(36).slice(2, 10)
}

/** 追加一行 trace；任何异常都吞掉只 warn，不影响对话主流程。 */
export function appendChatTrace(trace: ChatTrace): void {
  try {
    fs.mkdirSync(TRACES_DIR, { recursive: true })
    fs.appendFileSync(dayFile(), `${JSON.stringify(trace)}\n`, 'utf8')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[trace] 落盘失败（已忽略，不影响对话）：${message}`)
  }
}

/** trace:report 用：列出 traces 目录下所有 jsonl（按文件名升序）。 */
export function listTraceFiles(): string[] {
  try {
    return fs
      .readdirSync(TRACES_DIR)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .map((f) => path.join(TRACES_DIR, f))
  } catch {
    return []
  }
}

/** 读一个 jsonl 文件，逐行解析成 ChatTrace，坏行跳过。 */
export function readTraceFile(file: string): ChatTrace[] {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const out: ChatTrace[] = []
    for (const line of raw.split('\n')) {
      const s = line.trim()
      if (!s) continue
      try {
        out.push(JSON.parse(s) as ChatTrace)
      } catch {
        // 坏行跳过：trace 是审计原料，不因为一行脏数据就报废整天
      }
    }
    return out
  } catch {
    return []
  }
}
