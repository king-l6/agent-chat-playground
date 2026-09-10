/**
 * 从「提问」出发，按 DAG 拓扑序得到要执行的步骤。
 * 分流节点按问题是否含算式只保留一条出边；走不到的节点不进 pipeline。
 */
export type GraphKind = 'ask' | 'search' | 'answer' | 'calc' | 'route'

export type GraphNode = {
  id: string
  kind: GraphKind
  expression?: string
}

export type GraphEdge = {
  source: string
  target: string
  sourceHandle?: string | null
}

export type PipeStep = {
  id: string
  kind: 'search' | 'answer' | 'calc'
  expression?: string
}

export function looksLikeMath(question: string) {
  return /[\d.]+(?:[+\-*/()][\d.]+)+/.test(question.replace(/\s+/g, ''))
}

function asStep(node: GraphNode): PipeStep | null {
  if (node.kind !== 'search' && node.kind !== 'answer' && node.kind !== 'calc') return null
  return {
    id: node.id,
    kind: node.kind,
    expression: node.kind === 'calc' ? node.expression : undefined,
  }
}

export function pipelineFromGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  question = '',
): { steps: PipeStep[]; reached: string[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  if (!byId.has('ask')) throw new Error('缺少提问节点')

  const choice = looksLikeMath(question) ? 'math' : 'text'
  const seenEdge = new Set<string>()
  const unique: GraphEdge[] = []
  for (const e of edges) {
    const src = byId.get(e.source)
    if (src?.kind === 'route' && e.sourceHandle !== choice) continue
    const key = `${e.source}\t${e.sourceHandle ?? ''}\t${e.target}`
    if (seenEdge.has(key)) continue
    seenEdge.add(key)
    unique.push(e)
  }

  const outs = new Map<string, string[]>()
  for (const e of unique) {
    const list = outs.get(e.source) ?? []
    list.push(e.target)
    outs.set(e.source, list)
  }

  const reachable = new Set<string>()
  const stack = ['ask']
  while (stack.length) {
    const id = stack.pop()
    if (!id || reachable.has(id) || !byId.has(id)) continue
    reachable.add(id)
    for (const t of outs.get(id) ?? []) stack.push(t)
  }

  const indeg = new Map<string, number>()
  for (const id of reachable) indeg.set(id, 0)
  for (const e of unique) {
    if (!reachable.has(e.source) || !reachable.has(e.target)) continue
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1)
  }

  const queue: string[] = []
  for (const [id, d] of indeg) {
    if (d === 0) queue.push(id)
  }
  queue.sort((a, b) => a.localeCompare(b))

  const steps: PipeStep[] = []
  const done = new Set<string>()
  while (queue.length) {
    const id = queue.shift()
    if (!id) break
    done.add(id)
    const node = byId.get(id)
    if (node) {
      const step = asStep(node)
      if (step) steps.push(step)
    }
    const nexts = [...(outs.get(id) ?? [])].filter((t) => reachable.has(t)).sort((a, b) => a.localeCompare(b))
    for (const t of nexts) {
      const left = (indeg.get(t) ?? 1) - 1
      indeg.set(t, left)
      if (left === 0) queue.push(t)
    }
  }

  if (done.size !== reachable.size) throw new Error('连线有环，检查一下')
  if (steps.length === 0) throw new Error('请从「提问」连出至少一步')
  return { steps, reached: [...reachable] }
}
