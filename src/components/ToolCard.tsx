import type { ToolCallView } from '../types'
import './ToolCard.css'

export function ToolCard({ tool }: { tool: ToolCallView }) {
  return (
    <div className={`tool-card tool-card--${tool.status}`}>
      <div className="tool-card__head">
        <span className="tool-card__name">{tool.name}</span>
        <span className="tool-card__status">
          {tool.status === 'running' && '调用中…'}
          {tool.status === 'done' && '完成'}
          {tool.status === 'error' && '失败'}
        </span>
      </div>
      <pre className="tool-card__block">
        <code>{formatJson(tool.arguments)}</code>
      </pre>
      {tool.result != null && (
        <pre className="tool-card__block tool-card__result">
          <code>{formatJson(tool.result)}</code>
        </pre>
      )}
      {tool.error && <div className="tool-card__error">{tool.error}</div>}
    </div>
  )
}

function formatJson(raw: string) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}
