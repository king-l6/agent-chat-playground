/**
 * 对话 trace 聚合：把 traces/*.jsonl 读出来打一张命令行报表。
 *
 *   npx tsx server/scripts/trace-report.ts            # 聚合今天
 *   npx tsx server/scripts/trace-report.ts --all      # 聚合所有天
 *   npx tsx server/scripts/trace-report.ts 20261008   # 聚合指定某天
 *
 * 这是「可观测」的人读出口：对标 LangSmith 缺的是 UI，有的是审计原料。
 * 不建图表、不接 SaaS——就把一天里跑了几轮、各工具调了几次、慢不慢、错没错，
 * 算出来打印。要更细直接 tail jsonl。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listTraceFiles, readTraceFile, type ChatTrace } from '../src/trace.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function pickFiles(argv: string[]): string[] {
  const all = listTraceFiles()
  if (argv.includes('--all')) return all
  const day = argv.find((a) => /^\d{8}$/.test(a))
  if (day) return all.filter((f) => path.basename(f).startsWith(day))
  // 默认今天
  const d = new Date()
  const today = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  return all.filter((f) => path.basename(f).startsWith(today))
}

function report(traces: ChatTrace[]) {
  if (traces.length === 0) {
    console.log('[trace:report] 没有 trace。先在对话页跑几轮，再回来看。')
    return
  }
  const total = traces.length
  const okCount = traces.filter((t) => t.ok).length
  const byMode = new Map<string, number>()
  const byTool = new Map<string, number>()
  let durSum = 0
  for (const t of traces) {
    byMode.set(t.mode, (byMode.get(t.mode) ?? 0) + 1)
    durSum += t.durationMs
    for (const name of t.tools) byTool.set(name, (byTool.get(name) ?? 0) + 1)
  }

  console.log(`[trace:report] ${total} 轮对话`)
  console.log(`  成功率   ${okCount}/${total} = ${((okCount / total) * 100).toFixed(0)}%`)
  console.log(`  平均耗时 ${(durSum / total / 1000).toFixed(2)}s`)
  console.log(`  模式     ${[...byMode].map(([m, n]) => `${m}=${n}`).join('  ') || '无'}`)
  console.log('  工具调用次数：')
  const tools = [...byTool].sort((a, b) => b[1] - a[1])
  if (tools.length === 0) {
    console.log('    （本批没有工具调用）')
  } else {
    for (const [name, n] of tools) console.log(`    ${name.padEnd(18)} ${n}`)
  }

  const errs = traces.filter((t) => !t.ok)
  if (errs.length) {
    console.log('\n  出错轮：')
    for (const t of errs) console.log(`    ${t.ts}  ${t.mode}  ${t.error ?? '(无摘要)'}`)
  }
}

function main() {
  const files = pickFiles(process.argv.slice(2))
  if (files.length === 0) {
    console.log('[trace:report] 没找到 trace 文件（server/data/traces/*.jsonl）。')
    console.log('              先 npm run dev，在对话页问一句，再跑本脚本。')
    return
  }
  console.log(`[trace:report] 读取 ${files.map((f) => path.basename(f)).join(', ')}\n`)
  const traces = files.flatMap((f) => readTraceFile(f))
  report(traces)
}

main()
