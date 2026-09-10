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
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  Handle,
  Position,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { runWorkflow } from '../api/chat'
import { DEFAULT_QUESTION, loadCanvas, saveCanvas, type CanvasNodeData } from '../canvasStore'
import { looksLikeMath, pipelineFromGraph, type PipeStep } from '../pipelineFromGraph'
import './CanvasPage.css'

type StepData = CanvasNodeData

function StepNode({ data }: NodeProps<Node<StepData>>) {
  const isRoute = data.kind === 'route'
  return (
    <div className={`wf-node wf-node--${data.status}${isRoute ? ' wf-node--route' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="wf-node__title">{data.title}</div>
      <div className="wf-node__hint">{data.hint}</div>
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
    })),
    edges,
    question,
  )
}

export function CanvasPage() {
  const [boot] = useState(() => loadCanvas())
  const [nodes, setNodes, onNodesChange] = useNodesState(boot?.nodes ?? initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(boot?.edges ?? initialEdges)
  const [question, setQuestion] = useState(boot?.question ?? DEFAULT_QUESTION)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    saveCanvas(question, nodes, edges)
  }, [edges, nodes, question])

  const onConnect = useCallback((c: Connection) => {
    setEdges((eds) => addEdge({ ...c, animated: true }, eds))
  }, [setEdges])

  const addCalc = useCallback(() => {
    const id = `calc-${Date.now().toString(36)}`
    setNodes((prev) => [
      ...prev,
      {
        id,
        type: 'step',
        position: { x: 300, y: 280 },
        data: {
          kind: 'calc',
          title: '计算器',
          hint: '运行时从问题里取算式',
          status: 'idle',
          output: '',
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
          status: onThis ? 'running' : 'skip',
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
      const result = await runWorkflow(q, withExpr)
      setNodes((prev) => {
        let next = prev
        for (const step of result.steps) {
          next = patchNode(next, step.id, { status: 'done', output: step.output })
        }
        return next
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setNodes((prev) =>
        patchNode(prev, pipeline[0].id, { status: 'error', output: message }),
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
          图会自动记在本机（刷新还在）。只存节点和连线，不存上一轮回答。换浏览器或清站点数据就没了。
        </p>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={4}
          disabled={busy}
        />
        <button type="button" className="wf-add" disabled={busy} onClick={loadRouteExample}>
          示例：按问题分流
        </button>
        <button type="button" className="wf-add" disabled={busy} onClick={addCalc}>
          添加计算器
        </button>
        <button type="button" className="wf-add" disabled={busy} onClick={resetGraph}>
          恢复默认图
        </button>
        <button type="button" className="wf-run" disabled={busy || !question.trim()} onClick={() => void onRun()}>
          {busy ? '运行中…' : '运行'}
        </button>
        {error ? <div className="error-banner wf-err">{error}</div> : null}
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
