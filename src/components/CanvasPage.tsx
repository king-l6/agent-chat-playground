/**
 * 编排画布：沿连线执行；分流节点按问题是否含算式只走一条边。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  addEdge,
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  Handle,
  Position,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { streamWorkflow, type WorkflowTrace } from '../api/chat'
import { DEFAULT_QUESTION, loadCanvas, saveCanvas, type CanvasNodeData } from '../canvasStore'
import { looksLikeMath, pipelineFromGraph, type PipeStep } from '../pipelineFromGraph'
import './CanvasPage.css'

type StepData = CanvasNodeData

function StepNode({ id, data }: NodeProps<Node<StepData>>) {
  const { setNodes } = useReactFlow()
  const isRoute = data.kind === 'route'
  return (
    <div className={`wf-node wf-node--${data.status}${isRoute ? ' wf-node--route' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="wf-node__title">{data.title}</div>
      <div className="wf-node__hint">{data.hint}</div>
      {data.kind === 'search' && (
        <div className="wf-search nodrag nopan">
          <label className="wf-topk">
            篇数
            <input
              type="number"
              min={1}
              max={8}
              value={data.topK ?? 3}
              onChange={(e) => {
                const next = Math.min(8, Math.max(1, Number(e.target.value) || 3))
                setNodes((prev) =>
                  prev.map((n) =>
                    n.id === id ? { ...n, data: { ...n.data, topK: next } } : n,
                  ),
                )
              }}
            />
          </label>
          <label className="wf-topk">
            方式
            <select
              value={data.retrieval ?? 'hybrid'}
              onChange={(e) => {
                const retrieval = e.target.value === 'keyword' ? 'keyword' : 'hybrid'
                setNodes((prev) =>
                  prev.map((n) =>
                    n.id === id ? { ...n, data: { ...n.data, retrieval } } : n,
                  ),
                )
              }}
            >
              <option value="hybrid">混合</option>
              <option value="keyword">关键词</option>
            </select>
          </label>
          <input
            className="wf-query"
            value={data.query ?? ''}
            placeholder="检索词，空则用提问"
            onChange={(e) => {
              const query = e.target.value
              setNodes((prev) =>
                prev.map((n) =>
                  n.id === id ? { ...n, data: { ...n.data, query } } : n,
                ),
              )
            }}
          />
        </div>
      )}
      {data.output ? <pre className="wf-node__out">{data.output}</pre> : null}
      {isRoute ? (
        <>
          <div className="wf-ports">
            <span>算式</span>
            <span>其它</span>
          </div>
          <Handle type="source" id="math" position={Position.Right} style={{ top: '42%' }} />
          <Handle type="source" id="text" position={Position.Bottom} />
        </>
      ) : (
        <Handle type="source" position={Position.Right} />
      )}
    </div>
  )
}

const nodeTypes = { step: StepNode }

const initialNodes: Node<StepData>[] = [
  {
    id: 'ask',
    type: 'step',
    position: { x: 40, y: 140 },
    data: { kind: 'ask', title: '提问', hint: '用户原句', status: 'idle', output: '' },
  },
  {
    id: 'search',
    type: 'step',
    position: { x: 300, y: 80 },
    data: {
      kind: 'search',
      title: '检索',
      hint: 'hybrid + rerank',
      status: 'idle',
      output: '',
    },
  },
  {
    id: 'answer',
    type: 'step',
    position: { x: 560, y: 140 },
    data: { kind: 'answer', title: '回答', hint: '根据已有结果生成', status: 'idle', output: '' },
  },
]

const initialEdges: Edge[] = [
  { id: 'e1', source: 'ask', target: 'search', animated: true },
  { id: 'e2', source: 'search', target: 'answer', animated: true },
]

function routeExample(): { nodes: Node<StepData>[]; edges: Edge[] } {
  return {
    nodes: [
      {
        id: 'ask',
        type: 'step',
        position: { x: 40, y: 160 },
        data: { kind: 'ask', title: '提问', hint: '用户原句', status: 'idle', output: '' },
      },
      {
        id: 'route',
        type: 'step',
        position: { x: 280, y: 150 },
        data: {
          kind: 'route',
          title: '分流',
          hint: '有算式走「算式」，否则走「其它」',
          status: 'idle',
          output: '',
        },
      },
      {
        id: 'search',
        type: 'step',
        position: { x: 540, y: 40 },
        data: {
          kind: 'search',
          title: '检索',
          hint: 'hybrid + rerank',
          status: 'idle',
          output: '',
        },
      },
      {
        id: 'calc',
        type: 'step',
        position: { x: 540, y: 280 },
        data: {
          kind: 'calc',
          title: '计算器',
          hint: '运行时从问题里取算式',
          status: 'idle',
          output: '',
        },
      },
      {
        id: 'answer',
        type: 'step',
        position: { x: 800, y: 160 },
        data: { kind: 'answer', title: '回答', hint: '根据已有结果生成', status: 'idle', output: '' },
      },
    ],
    edges: [
      { id: 'e-ask-route', source: 'ask', target: 'route', animated: true },
      { id: 'e-math', source: 'route', sourceHandle: 'math', target: 'calc', animated: true },
      { id: 'e-text', source: 'route', sourceHandle: 'text', target: 'search', animated: true },
      { id: 'e-calc-ans', source: 'calc', target: 'answer', animated: true },
      { id: 'e-search-ans', source: 'search', target: 'answer', animated: true },
    ],
  }
}

function patchNode(
  nodes: Node<StepData>[],
  id: string,
  patch: Partial<StepData>,
): Node<StepData>[] {
  return nodes.map((n) =>
    n.id === id ? { ...n, data: { ...n.data, ...patch } } : n,
  )
}

function guessExpression(question: string) {
  const m = question.replace(/\s+/g, '').match(/[\d.]+(?:[+\-*/()][\d.]+)+/)
  return m?.[0] ?? '123*456'
}

function compileCanvas(nodes: Node<StepData>[], edges: Edge[], question: string) {
  return pipelineFromGraph(
    nodes.map((n) => ({
      id: n.id,
      kind: n.data.kind,
      expression: n.data.expression,
      topK: n.data.topK,
      retrieval: n.data.retrieval,
      query: n.data.query,
    })),
    edges,
    question,
  )
}

const PALETTE: Array<{ kind: StepData['kind']; title: string; hint: string }> = [
  { kind: 'search', title: '检索', hint: 'hybrid + rerank，可改篇数' },
  { kind: 'answer', title: '回答', hint: '根据已有结果生成' },
  { kind: 'calc', title: '计算器', hint: '运行时从问题里取算式' },
  { kind: 'route', title: '分流', hint: '有算式走「算式」，否则走「其它」' },
]

type RunLogItem = {
  id: string
  title: string
  status: 'wait' | 'running' | 'done' | 'error'
  ms?: number
  output: string
  trace?: WorkflowTrace
}

export function CanvasPage() {
  const [boot] = useState(() => loadCanvas())
  const [nodes, setNodes, onNodesChange] = useNodesState(boot?.nodes ?? initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(boot?.edges ?? initialEdges)
  const [question, setQuestion] = useState(boot?.question ?? DEFAULT_QUESTION)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [log, setLog] = useState<RunLogItem[]>([])

  useEffect(() => {
    saveCanvas(question, nodes, edges)
  }, [edges, nodes, question])

  const onConnect = useCallback((c: Connection) => {
    setEdges((eds) => addEdge({ ...c, animated: true }, eds))
  }, [setEdges])

  const addNode = useCallback((kind: StepData['kind']) => {
    const spec = PALETTE.find((item) => item.kind === kind)
    if (!spec) return
    const id = `${kind}-${Date.now().toString(36)}`
    setNodes((prev) => [
      ...prev,
      {
        id,
        type: 'step',
        position: { x: 280 + (prev.length % 3) * 40, y: 80 + prev.length * 28 },
        data: {
          kind,
          title: spec.title,
          hint: spec.hint,
          status: 'idle',
          output: '',
          ...(kind === 'search' ? { topK: 3 } : {}),
        },
      },
    ])
  }, [setNodes])

  const loadRouteExample = useCallback(() => {
    const g = routeExample()
    setNodes(g.nodes)
    setEdges(g.edges)
    setError('')
  }, [setEdges, setNodes])

  const resetGraph = useCallback(() => {
    setNodes(initialNodes)
    setEdges(initialEdges)
    setQuestion(DEFAULT_QUESTION)
    setError('')
  }, [setEdges, setNodes])

  const onRun = useCallback(async () => {
    const q = question.trim()
    if (!q || busy) return
    setError('')
    let pipeline: PipeStep[]
    let reached: Set<string>
    try {
      const compiled = compileCanvas(nodes, edges, q)
      pipeline = compiled.steps
      reached = new Set(compiled.reached)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return
    }

    const expression = guessExpression(q)
    const routeOut = looksLikeMath(q) ? '本轮走：算式 → 计算器' : '本轮走：其它 → 检索'
    const titles = new Map(nodes.map((n) => [n.id, n.data.title]))
    setLog(
      pipeline.map((step) => ({
        id: step.id,
        title: titles.get(step.id) ?? step.kind,
        status: 'wait',
        output: '',
      })),
    )
    setBusy(true)
    setNodes((prev) => {
      let next = patchNode(prev, 'ask', { status: 'done', output: q })
      for (const n of prev) {
        if (n.id === 'ask') continue
        const onThis = reached.has(n.id)
        if (n.data.kind === 'route') {
          next = patchNode(next, n.id, {
            status: onThis ? 'done' : 'skip',
            output: onThis ? routeOut : '未经过（没连到这条路上）',
          })
          continue
        }
        next = patchNode(next, n.id, {
          status: onThis ? 'idle' : 'skip',
          output: onThis ? '' : '未经过（没连到这条路上）',
          ...(n.data.kind === 'calc' && onThis ? { hint: `表达式 ${expression}`, expression } : {}),
        })
      }
      return next
    })
    try {
      const withExpr = pipeline.map((s) =>
        s.kind === 'calc' ? { ...s, expression } : s,
      )
      let failed = ''
      await streamWorkflow({
        question: q,
        pipeline: withExpr,
        onEvent: (event) => {
          if (event.type === 'step_start') {
            setNodes((prev) => patchNode(prev, event.id, { status: 'running', output: '' }))
            setLog((prev) =>
              prev.map((item) => (item.id === event.id ? { ...item, status: 'running' } : item)),
            )
          } else if (event.type === 'step_done') {
            setNodes((prev) =>
              patchNode(prev, event.id, { status: 'done', output: event.output }),
            )
            setLog((prev) =>
              prev.map((item) =>
                item.id === event.id
                  ? {
                      ...item,
                      status: 'done',
                      ms: event.ms,
                      output: event.output,
                      trace: event.trace,
                    }
                  : item,
              ),
            )
          } else if (event.type === 'error') {
            failed = event.message
          }
        },
      })
      if (failed) {
        setError(failed)
        setNodes((prev) =>
          prev.map((n) =>
            n.data.status === 'running'
              ? { ...n, data: { ...n.data, status: 'error', output: failed } }
              : n,
          ),
        )
        setLog((prev) =>
          prev.map((item) =>
            item.status === 'running' || item.status === 'wait'
              ? { ...item, status: 'error', output: failed }
              : item,
          ),
        )
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setNodes((prev) =>
        prev.map((n) =>
          n.data.status === 'running'
            ? { ...n, data: { ...n.data, status: 'error', output: message } }
            : n,
        ),
      )
    } finally {
      setBusy(false)
    }
  }, [busy, edges, nodes, question, setNodes])

  return (
    <div className="wf">
      <aside className="wf-side">
        <h2>编排</h2>
        <p>
          从「提问」连出去，按拓扑序一步一步跑。检索节点和对话里是同一套：改写、向量加关键词、重排。只记住节点和连线。
        </p>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={4}
          disabled={busy}
        />
        <div className="wf-palette">
          {PALETTE.map((item) => (
            <button
              key={item.kind}
              type="button"
              className="wf-add"
              disabled={busy}
              onClick={() => addNode(item.kind)}
            >
              {item.title}
            </button>
          ))}
        </div>
        <button type="button" className="wf-add" disabled={busy} onClick={loadRouteExample}>
          示例：按问题分流
        </button>
        <button type="button" className="wf-add" disabled={busy} onClick={resetGraph}>
          恢复默认图
        </button>
        <button type="button" className="wf-run" disabled={busy || !question.trim()} onClick={() => void onRun()}>
          {busy ? '运行中…' : '运行'}
        </button>
        {error ? <div className="error-banner wf-err">{error}</div> : null}
        {log.length > 0 && (
          <ol className="wf-log">
            {log.map((item, index) => (
              <li key={item.id} className={`wf-log__item wf-log__item--${item.status}`}>
                <div className="wf-log__head">
                  <span>
                    {index + 1}. {item.title}
                  </span>
                  <span>
                    {item.status === 'wait' && '等待'}
                    {item.status === 'running' && '运行中'}
                    {item.status === 'done' && (item.ms != null ? `${item.ms} ms` : '完成')}
                    {item.status === 'error' && '失败'}
                  </span>
                </div>
                {item.trace?.retrieval && (
                  <p className="wf-log__trace">
                    {item.trace.retrieval === 'hybrid' ? '向量 + 关键词' : '关键词'}
                    {item.trace.query ? ` · ${item.trace.query}` : ''}
                  </p>
                )}
                {item.output && item.status !== 'wait' ? (
                  <pre className="wf-log__out">{item.output.slice(0, 280)}</pre>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </aside>
      <div className="wf-board">
        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            fitView
            deleteKeyCode={['Backspace', 'Delete']}
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
    </div>
  )
}
